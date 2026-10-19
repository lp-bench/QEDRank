import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leanTokens, signatureOf, pickTarget, measureFile, measureFileWithImports, summarizeMeasurements, clopperPearson, isStandardImport, fileStructure, summarizeStructure } from '../lib/compare/measure.js';
import { findDeclarations } from '../lib/leansrc.js';

test('tokens: dotted names, numbers, operators and unicode count as single tokens', () => {
  assert.deepEqual(leanTokens('∀ n : ℕ, n.succ ≤ 2 ^ n := by'), ['∀', 'n', ':', 'ℕ', ',', 'n.succ', '≤', '2', '^', 'n', ':=', 'by']);
  assert.deepEqual(leanTokens('Finset.sum (Finset.range 10) fun i => i'), ['Finset.sum', '(', 'Finset.range', '10', ')', 'fun', 'i', '=>', 'i']);
  assert.deepEqual(leanTokens('x₁ ≠ x₂ → G.Adj u v'), ['x₁', '≠', 'x₂', '→', 'G.Adj', 'u', 'v']);
});

test('signature excludes keyword, name, attributes, doc comment and proof', () => {
  const src = '/-- doc -/\n@[simp] theorem foo (a b : ℕ) : a + b = b + a := by\n  omega\n';
  const [d] = findDeclarations(src);
  assert.equal(signatureOf(d), '(a b : ℕ) : a + b = b + a');
});

test('target: named, else the last sorry-proved theorem', () => {
  const src = 'theorem helper : True := trivial\n\ntheorem main : 1 = 1 := by sorry\n\ntheorem other : 2 = 2 := rfl\n';
  const decls = findDeclarations(src);
  assert.equal(pickTarget(decls).name, 'main');
  assert.equal(pickTarget(decls, 'other').name, 'other');
});

test('closure follows same-file definitions transitively and the variables they use', () => {
  const src = `import Mathlib
import ProofBench.Lib.Minor

variable {V : Type*} [Fintype V]

noncomputable def hNum (G : SimpleGraph V) : ℕ := Fintype.card V

def Conj (G : SimpleGraph V) : Prop :=
  G.chromaticNumber ≤ (hNum G : ℕ∞)

def unused : ℕ := 3

/-- the problem -/
theorem P001 : ¬ ∀ (V : Type) [Fintype V] (G : SimpleGraph V), Conj G := sorry
`;
  const [m] = measureFile(src, ['P001']);
  assert.equal(m.ok, true);
  assert.equal(m.target, 'P001');
  assert.equal(m.defs_used, 2, 'Conj and, through it, hNum; not `unused`');
  assert.equal(m.defs_in_file, 3);
  assert.ok(m.closure_tokens > m.stmt_tokens + 20);
  assert.equal(m.uses_project_library, true);
  assert.deepEqual(m.project_imports, ['ProofBench.Lib.Minor']);
});

test('several problems in one file are measured separately; a self-contained statement has an empty closure', () => {
  const src = 'import Mathlib\n\ntheorem a1 (x : ℝ) (h : 0 < x) : 0 < x ^ 2 := by sorry\n\ntheorem a2 : (2 : ℕ) + 2 = 4 := by sorry\n';
  const rows = measureFile(src, ['a1', 'a2']);
  assert.deepEqual(rows.map((r) => r.target), ['a1', 'a2']);
  assert.equal(rows[0].defs_used, 0);
  assert.equal(rows[0].closure_tokens, rows[0].stmt_tokens);
  assert.equal(rows[1].uses_project_library, false);
  const s = summarizeMeasurements([...rows, { ok: false, reason: 'x' }]);
  assert.equal(s.problems, 3);
  assert.equal(s.measured, 2);
  assert.equal(s.share_with_local_defs, 0);
});

test('imports of the benchmark library are followed; external packages are listed as unresolved', async () => {
  const lib = {
    'Bench.Lib.Graph': 'import Mathlib\nimport Bench.Lib.Base\n\ndef bigDeg (G : SimpleGraph V) : Prop := base G\n\ntheorem libThm : True := trivial\n',
    'Bench.Lib.Base': 'import Mathlib\n\ndef base (G : SimpleGraph V) : Prop := True\n\ndef unrelated : ℕ := 0\n',
  };
  const src = 'import Mathlib\nimport Bench.Lib.Graph\nimport Matroid.Minor\n\ntheorem P018 : ∀ G : SimpleGraph (Fin 3), bigDeg G := sorry\n';
  const [m] = await measureFileWithImports(src, ['P018'], async (mod) => lib[mod] ?? null);
  assert.equal(m.file_defs_used, 0);
  assert.equal(m.library_defs_used, 2, 'bigDeg and, through it, base; not `unrelated`, not the library theorem');
  assert.deepEqual(m.library_modules_used.sort(), ['Bench.Lib.Base', 'Bench.Lib.Graph']);
  assert.deepEqual(m.unresolved_imports, ['Matroid.Minor']);
  assert.ok(m.closure_tokens > m.closure_tokens_file_only);
  assert.equal(m.closure_tokens_file_only, m.stmt_tokens);
});

test('a proposition stated as `def ... := by sorry`, or an indented theorem, is still measured', () => {
  const asDef = 'import Mathlib\n\ndef other_5539 {p : Polynomial ℝ} (hp : p.natDegree ≤ 2) :\n    p.eval 1 = 1 := by sorry\n';
  const [a] = measureFile(asDef, ['olymid-ref-base_5539']);
  assert.equal(a.ok, true);
  assert.equal(a.target, 'other_5539');
  const indented = 'import Mathlib\n\ndef f (n : ℕ) : ℕ := n\n\n theorem imo_2022_p1 (n : ℕ) : f n = n := by sorry\n';
  const [b] = measureFile(indented, ['imo_2022_p1']);
  assert.equal(b.ok, true);
  assert.equal(b.target, 'imo_2022_p1');
  assert.equal(b.defs_used, 1);
});

test('an answer slot (`abbrev x_solution := sorry`) is not counted as a definition', () => {
  const src = 'import Mathlib\n\nabbrev putnam_2000_a1_solution : Set ℝ := sorry\n-- Set.Ioo 0 1\n\ndef helper (x : ℝ) : ℝ := x ^ 2\n\ntheorem putnam_2000_a1 : {x : ℝ | helper x < 1} = putnam_2000_a1_solution := sorry\n';
  const [m] = measureFile(src, ['putnam_2000_a1']);
  assert.equal(m.defs_used, 1, 'helper only');
  assert.equal(m.answer_slots, 1);
  assert.ok(m.closure_tokens > m.stmt_tokens, 'the slot type still belongs to the statement text');
});

test('standard imports are recognised; anything else is a project library', () => {
  assert.ok(isStandardImport('Mathlib.Combinatorics.SimpleGraph.Basic'));
  assert.ok(isStandardImport('Archive.Imo.Imo1959Q1'));
  assert.ok(!isStandardImport('ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Minor'));
  assert.ok(!isStandardImport('CombiBench.Utils'));
});

test('Clopper-Pearson matches tabulated values', () => {
  const [lo0, hi0] = clopperPearson(0, 111);
  assert.equal(lo0, 0);
  assert.ok(Math.abs(hi0 - 0.03268) < 2e-4, `0/111 upper bound ${hi0}`);
  const [lo, hi] = clopperPearson(7, 100);
  assert.ok(Math.abs(lo - 0.0286) < 5e-4 && Math.abs(hi - 0.1389) < 5e-4, `7/100: ${lo} ${hi}`);
  assert.equal(clopperPearson(0, 0), null);
});

test('file structure: theorems, definitions, and the proofs a file ships', () => {
  const src = `import Mathlib

def f (n : ℕ) : ℕ := n + 1

structure S where
  x : ℕ

axiom ax : True

lemma helper (n : ℕ) : f n = n + 1 := by
  -- a comment
  rfl

theorem target : True := by sorry

theorem other (n : ℕ) : n = n :=
sorry
`;
  const s = fileStructure(src);
  assert.equal(s.theorems, 3);
  assert.equal(s.definitions, 2, 'def and structure; an axiom is not a definition');
  assert.equal(s.unproved_theorems, 2);
  assert.deepEqual(s.proved.map((p) => [p.name, p.proof_lines, p.proof_tokens]), [['helper', 2, 2]]);
  const [m] = measureFile(src, ['target']);
  assert.equal(m.theorems_in_file, 3);
  assert.equal(m.definitions_in_file, 2);
  assert.equal(m.proved_lemmas.length, 1);
});

test('structure summary: count histograms per file, library modules counted once', () => {
  const rows = [
    { id: 'a', ok: true, theorems_in_file: 1, definitions_in_file: 0, unproved_theorems_in_file: 1, proved_lemmas: [] },
    { id: 'b', ok: true, theorems_in_file: 3, definitions_in_file: 4, unproved_theorems_in_file: 2, proved_lemmas: [{ name: 'h', proof_lines: 5, proof_tokens: 20 }] },
    { id: 'c', ok: false },
  ];
  const st = summarizeStructure(rows, [{ module: 'Lib.A', text: 'theorem l : True := trivial\n\ndef g := 1\n' }]);
  assert.equal(st.files, 2);
  assert.equal(st.files_with_several_theorems, 1);
  assert.equal(st.files_with_several_unproved, 1);
  assert.deepEqual(st.theorems_histogram.map((h) => h.count), [1, 0, 1, 0]);
  assert.deepEqual(st.definitions_histogram.map((h) => h.count), [1, 0, 1, 0, 0]);
  assert.equal(st.proved_lemmas, 1);
  assert.equal(st.proof_lines.median, 5);
  assert.deepEqual(st.proved_lemma_list, [{ problem: 'b', name: 'h', proof_lines: 5, proof_tokens: 20 }]);
  assert.equal(st.library.modules, 1);
  assert.equal(st.library.proved_lemmas, 1);
  assert.equal(st.library.definitions, 1);
});
