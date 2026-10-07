import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDeclarations, stripProofs, staticScreen, countLines, parseImports, wrapNamespace, rewriteImports, theoremNames, stripComments } from '../lib/leansrc.js';
import { definitionsOnly } from '../lib/evaluate.js';

const SRC = `import Mathlib
import Defs
/-- doc -/
open Nat

namespace Paper
def f (n : ℕ) : ℕ := n + 1 -- trailing comment

/-- main -/
@[simp]
theorem main_theorem (n : ℕ) (h : 0 < n) : f n > 1 := by
  unfold f
  omega

lemma aux : ∀ x : ℕ, x ≤ x + 1 := fun x => Nat.le_succ x

/-- an example -/
example : True := trivial
end Paper
`;

test('parseImports reads only the header block', () => {
  assert.deepEqual(parseImports(SRC), ['Mathlib', 'Defs']);
  assert.deepEqual(parseImports('-- c\nimport A\nimport B\ntheorem x : True := trivial\nimport C'), ['A', 'B']);
});

test('findDeclarations locates kinds, names and top-level :=', () => {
  const d = findDeclarations(SRC);
  assert.deepEqual(d.map((x) => [x.kind, x.name]), [['def', 'f'], ['theorem', 'main_theorem'], ['lemma', 'aux'], ['example', null]]);
  const main = d[1];
  assert.equal(SRC.slice(main.assignIndex, main.assignIndex + 2), ':=');
  assert.match(main.header, /theorem main_theorem \(n : ℕ\) \(h : 0 < n\) : f n > 1 $/);
});

test('stripProofs keeps definitions, sorries theorem bodies, drops examples with their doc comments', () => {
  const out = stripProofs(SRC);
  assert.match(out, /def f \(n : ℕ\) : ℕ := n \+ 1/);
  assert.match(out, /theorem main_theorem \(n : ℕ\) \(h : 0 < n\) : f n > 1 := sorry/);
  assert.match(out, /lemma aux : ∀ x : ℕ, x ≤ x \+ 1 := sorry/);
  assert.doesNotMatch(out, /omega/);
  assert.doesNotMatch(out, /example/);
  assert.doesNotMatch(out, /an example/);
});

test('stripProofs attaches sorry to a bare statement', () => {
  assert.match(stripProofs('theorem t (n : ℕ) : n = n\n'), /theorem t \(n : ℕ\) : n = n := sorry/);
});

test('definitionsOnly removes theorems and their doc comments', () => {
  const out = definitionsOnly(SRC);
  assert.match(out, /def f/);
  assert.doesNotMatch(out, /main_theorem|aux|example|\/-- main -\//);
});

test('staticScreen rejects code execution, disallowed imports and heartbeat overrides; flags trust markers', () => {
  const r = staticScreen('import Lean\nimport QEDRank.Audit\n#eval IO.println "x"\nelab "a" : tactic => pure ()\nset_option maxHeartbeats 0\ntheorem t : 1 = 1 := by native_decide\naxiom bad : False\nlemma l : True := by sorry\n', { allowedImports: [] });
  assert.equal(r.ok, false);
  const codes = r.rejections.map((x) => x.code);
  assert.ok(codes.includes('forbidden_command'));
  assert.ok(codes.includes('disallowed_import'));
  assert.ok(codes.includes('heartbeat_cap_exceeded'));
  const flags = r.flags.map((x) => x.code);
  assert.ok(flags.includes('native_decide'));
  assert.ok(flags.includes('user_axiom'));
  assert.ok(flags.includes('placeholder'));
  const ok = staticScreen('import Mathlib\nimport QEDRank.Prelude\ntheorem t : 1 = 1 := rfl\n', { allowedImports: ['QEDRank.Prelude'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.flags.length, 0);
});

test('staticScreen ignores markers inside comments', () => {
  const r = staticScreen('import Mathlib\n-- sorry not really\n/- #eval nope -/\ntheorem t : 1 = 1 := rfl\n');
  assert.equal(r.ok, true);
  assert.equal(r.flags.length, 0);
});

test('countLines follows the documented rule', () => {
  const c = countLines(SRC, 'main_theorem');
  assert.equal(c.total, SRC.split('\n').length);
  assert.equal(c.proof.total, 3);
  assert.equal(c.proof.code, 3);
  assert.ok(c.code < c.total);
});

test('wrapNamespace keeps imports first', () => {
  const w = wrapNamespace(SRC, 'QRRef');
  const lines = w.split('\n');
  assert.equal(lines[0], 'import Mathlib');
  assert.equal(lines[1], 'import Defs');
  assert.ok(w.includes('namespace QRRef'));
  assert.ok(w.trim().endsWith('end QRRef'));
});

test('rewriteImports maps and drops modules', () => {
  const out = rewriteImports(SRC, (m) => (m === 'Defs' ? 'QEDRank.Papers.P' : m === 'Mathlib' ? m : null));
  assert.deepEqual(parseImports(out), ['Mathlib', 'QEDRank.Papers.P']);
});

test('a comment banner before the imports belongs to the header; a doc comment after them does not', () => {
  // ProofBench files open with `/- Paper: … -/`; a multi-line banner must not stop the header either.
  const banner = '/- Paper: Dirac for linear hypergraphs\n   (Im–Lee, arXiv:2403.14269). -/\n-- note\nimport Mathlib.A\nimport Mathlib.B -- trailing\n\nopen scoped BigOperators\n\n/-- the doc of f -/\ndef f := 1\n\ntheorem t : f = 1 := rfl\n';
  assert.deepEqual(parseImports(banner), ['Mathlib.A', 'Mathlib.B']);
  const w = wrapNamespace(banner, 'QRRef');
  const lines = w.split('\n');
  assert.ok(lines.indexOf('namespace QRRef') > lines.findIndex((l) => l === 'import Mathlib.B'), 'imports stay before the namespace');
  assert.ok(lines.indexOf('namespace QRRef') < lines.indexOf('open scoped BigOperators'));
  assert.ok(w.includes('/-- the doc of f -/\ndef f := 1'), 'the doc comment stays attached to its declaration');
  const out = rewriteImports(banner, (m) => (m === 'Mathlib.B' ? null : m));
  assert.deepEqual(parseImports(out), ['Mathlib.A']);
  assert.ok(out.startsWith('/- Paper: Dirac'), 'the banner is kept');
});

test('theoremNames and stripComments', () => {
  assert.deepEqual(theoremNames(SRC), ['main_theorem', 'aux']);
  assert.equal(stripComments('a -- b\n/- c -/ d', { blank: true }).length, 'a -- b\n/- c -/ d'.length);
});
