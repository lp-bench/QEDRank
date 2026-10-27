import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyStatementDiff, completenessFrom, formatCompilerOutput, proofLength, removedImports, screenSolution, gradeSubmission } from '../lib/grade.js';
import { parseQrLine, parseLeanOptions, detectToolchain, LeanRunner } from '../lib/lean.js';
import { selectToolchain } from '../lib/leanenv.js';
import { staticScreen } from '../lib/leansrc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'grade');
const read = (name) => fs.readFile(path.join(FIX, `${name}.lean`), 'utf8');
const qr = (lines) => lines.map(parseQrLine);

test('import policy: only Mathlib and the statement library; the challenge imports must stay', () => {
  const challenge = 'import Mathlib.Combinatorics.SimpleGraph.Basic\nimport ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Minor\n\ntheorem P001 : True := sorry\n';
  const ok = screenSolution(challenge, 'import Mathlib\nimport ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Minor\ntheorem P001 : True := trivial\n');
  assert.equal(ok.imports.ok, true);
  assert.deepEqual(ok.imports.removed_challenge_imports, [], '`import Mathlib` covers every Mathlib module');
  const withHidden = challenge.replace('\n\ntheorem', '\nimport ProofBench.Mathlib.Combinatorics.Secret\n\ntheorem').replace('sorry', 'trivial');
  const hidden = screenSolution(challenge, withHidden);
  assert.deepEqual(hidden.imports.disallowed, ['ProofBench.Mathlib.Combinatorics.Secret']);
  assert.deepEqual(hidden.imports.hidden_library, ['ProofBench.Mathlib.Combinatorics.Secret']);
  const dropped = screenSolution(challenge, 'import Mathlib\ntheorem P001 : True := trivial\n');
  assert.deepEqual(dropped.imports.removed_challenge_imports, ['ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Minor']);
  assert.equal(dropped.imports.ok, false);
  // The search configuration: any library may be added, the hidden one still not.
  const withExtra = challenge.replace('\n\ntheorem', '\nimport SomeGitHubLibrary.Main\n\ntheorem').replace('sorry', 'trivial');
  const extra = screenSolution(challenge, withExtra, { libraryPrefixes: ['ProofBench.Mathlib_Problems'], hiddenPrefixes: ['ProofBench.Mathlib'], allowExtraImports: true });
  assert.equal(extra.imports.ok, true);
  assert.deepEqual(extra.imports.extra, ['SomeGitHubLibrary.Main']);
  assert.deepEqual(removedImports(['Mathlib.Data.Nat.Basic', 'Foo.Bar'], ['Mathlib', 'Foo.Bar']), []);
  assert.deepEqual(removedImports(['Mathlib.Data.Nat.Basic', 'Foo.Bar'], ['Mathlib.Data.Nat.Basic']), ['Foo.Bar']);
});

test('import policy: an import the challenge itself has is allowed whatever its prefix; added ones are judged', () => {
  const challenge = 'import Matroid.Representation.Basic\nimport Archive.Sensitivity\nimport ProofBench.PROBLEMS.P020.P020\nimport Mathlib.Data.Complex.Basic\n\ntheorem P002 : True := sorry\n';
  const kept = screenSolution(challenge, challenge.replace('sorry', 'trivial'));
  assert.equal(kept.imports.ok, true);
  assert.equal(kept.static_screen.ok, true);
  assert.deepEqual(kept.imports.disallowed, []);
  assert.deepEqual(kept.imports.extra, []);
  const added = screenSolution(challenge, challenge.replace('\n\ntheorem', '\nimport Matroid.Minor.Iso\nimport ProofBench.PROBLEMS.P021.P021\n\ntheorem').replace('sorry', 'trivial'));
  assert.deepEqual(added.imports.disallowed, ['Matroid.Minor.Iso', 'ProofBench.PROBLEMS.P021.P021']);
  assert.deepEqual(added.imports.hidden_library, ['ProofBench.PROBLEMS.P021.P021']);
});

/** A LeanRunner stand-in: `challenge` and `solution` say what compiling each does. */
function fakeRunner({ challenge, solution }) {
  const calls = [];
  const result = (status, text) => ({ status, duration_ms: 1, error_count: status === 'compiler_success' ? 0 : 1, warning_count: 0, messages: text ? [{ severity: 'error', line: 1, column: 0, text }] : [] });
  return {
    calls,
    maxHeartbeats: 400000,
    limits: () => ({}),
    async runLean({ olean }) { if (olean) await fs.writeFile(olean, ''); return result('compiler_success'); },
    async compileModule({ label, scratchDir, moduleName }) {
      calls.push(label);
      const [status, text] = label === 'challenge' ? challenge : solution;
      await fs.mkdir(scratchDir, { recursive: true });
      const olean = path.join(scratchDir, `${moduleName}.olean`);
      if (status === 'compiler_success') await fs.writeFile(olean, '');
      return { ...result(status, text), olean: status === 'compiler_success' ? olean : null };
    },
  };
}

test('a challenge that does not compile in the grader is a grader error, decided before the solution is compiled', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-grade-'));
  const toolchain = { available: true, lean_version: 'fake', toolchain: 'fake', lean_dir: scratch, lean_options: [] };
  const challengeSrc = 'import ProofBench.Mathlib_Problems.Foo\n\ntheorem P001 : True := sorry\n';
  const solutionSrc = challengeSrc.replace('sorry', 'trivial');
  const missing = fakeRunner({ challenge: ['compiler_failure', "unknown module prefix 'ProofBench'"], solution: ['compiler_success'] });
  const g = await gradeSubmission({ runner: missing, toolchain, challengeSrc, solutionSrc, scratchDir: path.join(scratch, 'a'), cacheDir: path.join(scratch, 'cache') });
  assert.equal(g.verdict, 'grader_error');
  assert.deepEqual(g.reasons, ['challenge_import_unavailable']);
  assert.deepEqual(missing.calls, ['challenge'], 'the solution is never compiled');
  const broken = fakeRunner({ challenge: ['compiler_failure', 'type mismatch'], solution: ['compiler_success'] });
  const b = await gradeSubmission({ runner: broken, toolchain, challengeSrc, solutionSrc, scratchDir: path.join(scratch, 'b'), cacheDir: path.join(scratch, 'cache') });
  assert.deepEqual(b.reasons, ['challenge_does_not_compile']);
  // A compiling challenge is cached: the second grading compiles only the solution.
  const fine = fakeRunner({ challenge: ['compiler_success'], solution: ['compiler_failure', 'unsolved goals'] });
  const c1 = await gradeSubmission({ runner: fine, toolchain, challengeSrc, solutionSrc, scratchDir: path.join(scratch, 'c1'), cacheDir: path.join(scratch, 'cache') });
  const c2 = await gradeSubmission({ runner: fine, toolchain, challengeSrc, solutionSrc, scratchDir: path.join(scratch, 'c2'), cacheDir: path.join(scratch, 'cache') });
  assert.deepEqual([c1.verdict, c1.reasons, c2.verdict, c2.reasons], ['not_solved', ['compile_error'], 'not_solved', ['compile_error']]);
  assert.deepEqual(fine.calls, ['challenge', 'solution', 'solution']);
  assert.equal(c2.checks.challenge.cached, true);
  // Two gradings of the same challenge at the same time share one compilation.
  const parallel = fakeRunner({ challenge: ['compiler_success'], solution: ['compiler_success'] });
  const other = challengeSrc.replace('True', '1 = 1');
  await Promise.all([1, 2, 3].map((i) => gradeSubmission({ runner: parallel, toolchain, challengeSrc: other, solutionSrc: other, scratchDir: path.join(scratch, `p${i}`), cacheDir: path.join(scratch, 'cache') }).catch(() => null)));
  assert.equal(parallel.calls.filter((c) => c === 'challenge').length, 1);
  await fs.rm(scratch, { recursive: true, force: true });
});

test('static screen: code execution, kernel-skipping options and module headers are rejected', () => {
  const challenge = 'theorem P900 : True := sorry\n';
  const s = screenSolution(challenge, '#eval IO.FS.writeFile "x" "y"\ntheorem P900 : True := trivial\n');
  assert.equal(s.static_screen.ok, false);
  assert.deepEqual(s.static_screen.rejections.map((r) => r.code), ['forbidden_command']);
  assert.deepEqual(staticScreen('set_option debug.skipKernelTC true in\ntheorem t : False := by sorry\n').rejections.map((r) => r.code), ['forbidden_option']);
  assert.deepEqual(staticScreen('module\n\nimport Mathlib\ntheorem t : True := trivial\n').rejections.map((r) => r.code), ['module_header']);
  assert.equal(staticScreen('-- a comment\n\nimport Mathlib\ntheorem t : True := trivial\n').ok, true);
});

test('statement check: the target and every definition must compile to the same declarations', () => {
  const base = [
    'QR_OLEAN_DECL name=weight user=weight kind=def aux=false status=same',
    'QR_OLEAN_DECL name=_private.QRSubmission.0.shift user=shift kind=def aux=false status=same',
    'QR_OLEAN_DECL name=Pair kind=inductive user=Pair aux=false status=same',
    'QR_OLEAN_DECL name=Pair.rec kind=rec user=Pair.rec aux=false status=same',
    'QR_OLEAN_DECL name=P900 user=P900 kind=theorem aux=false status=same',
    'QR_OLEAN_IMPORTS ref=[Init,Mathlib] sol=[Init,Mathlib]',
    'QR_OLEAN_DIFF_DONE ref_count=20 sol_count=25 same=20 changed=0 missing=0 ref_is_module=false sol_is_module=false',
  ];
  const same = classifyStatementDiff(qr(base), 'P900');
  assert.equal(same.status, 'unchanged');
  assert.equal(same.target, 'P900');
  assert.equal(same.counts.challenge_declarations, 20);

  const changed = classifyStatementDiff(qr([...base.slice(0, 4), 'QR_OLEAN_DECL name=P900 user=P900 kind=theorem aux=false status=type_changed', ...base.slice(5)]), 'P900');
  assert.equal(changed.status, 'changed');
  assert.equal(changed.target_status, 'type_changed');

  const defChanged = classifyStatementDiff(qr([base[0].replace('same', 'value_changed'), ...base.slice(1)]), 'P900');
  assert.equal(defChanged.status, 'changed');
  assert.deepEqual(defChanged.definitions_changed, [{ name: 'weight', kind: 'def', status: 'value_changed' }]);

  const privateChanged = classifyStatementDiff(qr([base[0], base[1].replace('same', 'value_changed'), ...base.slice(2)]), 'P900');
  assert.deepEqual(privateChanged.definitions_changed, [{ name: 'shift', kind: 'def', status: 'value_changed' }]);

  const removed = classifyStatementDiff(qr([base[0], base[1], 'QR_OLEAN_DECL name=Pair kind=inductive user=Pair aux=false status=missing', ...base.slice(3)]), 'P900');
  assert.deepEqual(removed.definitions_removed, [{ name: 'Pair', kind: 'inductive' }]);
  assert.equal(removed.status, 'changed');

  // A lemma of the challenge that was changed or removed is reported, not a failure; a missing
  // auxiliary declaration is ignored.
  const lemma = classifyStatementDiff(qr([...base.slice(0, 5), 'QR_OLEAN_DECL name=helper user=helper kind=theorem aux=false status=missing', 'QR_OLEAN_DECL name=weight._eq_1 user=weight._eq_1 kind=theorem aux=true status=missing', 'QR_OLEAN_DECL name=weight.match_1 user=weight.match_1 kind=def aux=true status=missing', ...base.slice(5)]), 'P900');
  assert.equal(lemma.status, 'unchanged');
  assert.deepEqual(lemma.lemmas_changed, [{ name: 'helper', status: 'missing' }]);
  assert.equal(lemma.auxiliary_missing, 1);

  // Namespaced targets resolve by suffix; an import of the challenge dropped from the object file is a change.
  const ns = classifyStatementDiff(qr(base.map((l) => l.replace('name=P900 user=P900', 'name=Paper.P900 user=Paper.P900'))), 'P900');
  assert.equal(ns.target, 'Paper.P900');
  const imp = classifyStatementDiff(qr(base.map((l) => l.replace('sol=[Init,Mathlib]', 'sol=[Init]'))), 'P900');
  assert.equal(imp.status, 'changed');
  assert.deepEqual(imp.object_imports_removed, ['Mathlib']);
  assert.equal(classifyStatementDiff(qr(base), 'Other').target_status, 'not_in_challenge');
  assert.equal(classifyStatementDiff([], 'P900').status, 'not_checked');
});

test('completeness: steps are the target plus the lemmas and axioms its proof uses', () => {
  const report = qr([
    'QR_MODULE_DECL name=weight user=weight kind=def target=false used=true sorry_free=true own_sorry=false axioms_ok=true',
    'QR_MODULE_DECL name=P900 user=P900 kind=theorem target=true used=true sorry_free=false own_sorry=false axioms_ok=false',
    'QR_MODULE_DECL name=weight_eq user=weight_eq kind=theorem target=false used=true sorry_free=true own_sorry=false axioms_ok=true',
    'QR_MODULE_DECL name=next_eq user=next_eq kind=theorem target=false used=true sorry_free=false own_sorry=true axioms_ok=false',
    'QR_MODULE_DECL name=not_used user=not_used kind=theorem target=false used=false sorry_free=true own_sorry=false axioms_ok=true',
    'QR_MODULE_DECL name=Pair.mk.injEq user=Pair.mk.injEq kind=theorem target=false used=false sorry_free=true own_sorry=false axioms_ok=true',
    'QR_MODULE_DECL name=cheat user=cheat kind=axiom target=false used=true sorry_free=true own_sorry=false axioms_ok=false',
    'QR_MODULE_REPORT_DONE module=QRSubmission target=P900 count=7',
  ]);
  const src = 'theorem weight_eq : True := trivial\ntheorem next_eq : True := sorry\ntheorem not_used : True := trivial\naxiom cheat : True\ntheorem P900 : True := trivial\n';
  const c = completenessFrom(report, { target: 'P900', challengeNames: ['weight', 'P900', 'Pair.mk.injEq'], solutionSrc: src });
  assert.equal(c.available, true);
  assert.equal(c.steps, 4, 'target + weight_eq + next_eq + the axiom');
  assert.equal(c.steps_done, 2);
  assert.equal(c.score, 0.5);
  assert.deepEqual(c.open_steps, ['next_eq', 'cheat']);
  assert.equal(c.lemmas_written, 3, 'not_used counts as written, Pair.mk.injEq (generated) does not');
  assert.equal(c.lemmas_used, 2);
  assert.equal(c.axioms_assumed, 1);
  assert.equal(completenessFrom(report, { target: 'Nope', challengeNames: [], solutionSrc: src }).available, true, 'the target flag in the report wins');
  assert.equal(completenessFrom([], { target: 'P900' }).available, false);
});

test('proof length and compiler output formatting', () => {
  const chal = 'import Mathlib\n\n/-- doc -/\ndef weight (n : Nat) : Nat := n + n\n\ntheorem P900 (n : Nat) : weight n = 2 * n := sorry\n';
  const sol = 'import Mathlib\n\ndef weight (n : Nat) : Nat := n + n\n\ntheorem weight_eq (n : Nat) : weight n = 2 * n := by\n  unfold weight\n  omega\n\ntheorem P900 (n : Nat) : weight n = 2 * n :=\n  weight_eq n\n';
  const p = proofLength(chal, sol, 'P900');
  assert.equal(p.challenge_code_lines, 3);
  assert.equal(p.solution_code_lines, 7);
  assert.equal(p.proof_lines, 5, 'everything beyond the statement and definitions');
  assert.equal(p.target_proof_lines, 2);
  assert.equal(proofLength(chal, chal.replace('sorry', 'by simp [weight]; omega'), 'P900').proof_lines, 1);
  const out = formatCompilerOutput([
    { severity: 'warning', line: 9, column: 2, text: 'declaration uses `sorry`' },
    { severity: 'error', line: 12, column: 4, text: 'unsolved goals\n⊢ False' },
    { severity: 'info', line: 1, column: 0, text: 'ignored' },
  ]);
  assert.equal(out, '12:4: error: unsolved goals\n⊢ False\n9:2: warning: declaration uses `sorry`');
  assert.match(formatCompilerOutput(Array.from({ length: 50 }, (_, i) => ({ severity: 'error', line: i, column: 0, text: 'e' })), { maxMessages: 3 }), /47 more diagnostics/);
});

test('lakefile leanOptions become -D arguments', () => {
  assert.deepEqual(parseLeanOptions('name = "x"\n[leanOptions]\npp.unicode.fun = true # pretty\nrelaxedAutoImplicit = false\nweak.linter.mathlibStandardSet = true\nmaxSynthPendingDepth = 3\n\n[[require]]\nname = "m"\n'),
    ['-Dpp.unicode.fun=true', '-DrelaxedAutoImplicit=false', '-Dweak.linter.mathlibStandardSet=true', '-DmaxSynthPendingDepth=3']);
  assert.deepEqual(parseLeanOptions('[leanOptions]\nbad = "needs quoting; dropped"\n'), []);
  assert.deepEqual(parseLeanOptions('name = "x"\n'), []);
});

// End to end against the dependency-free Lean project in test/fixtures/lean-core. Needs elan and
// the pinned toolchain; several minutes on a slow machine, so it is opt-in: QEDRANK_LEAN_TESTS=1.
const EXPECTED = {
  solved: { verdict: 'solved', reasons: [], completeness: 1 },
  partial: { verdict: 'not_solved', reasons: ['contains_sorry'], completeness: 2 / 3 },
  untouched: { verdict: 'not_solved', reasons: ['contains_sorry'], completeness: 0 },
  changed_definition: { verdict: 'not_solved', reasons: ['definition_changed'] },
  changed_private_definition: { verdict: 'not_solved', reasons: ['definition_changed'] },
  changed_statement: { verdict: 'not_solved', reasons: ['statement_changed'] },
  context_trick: { verdict: 'not_solved', reasons: ['statement_changed'], escalate: true },
  reformatted: { verdict: 'solved', reasons: [], text_identical: false },
  axiom_cheat: { verdict: 'not_solved', reasons: ['non_standard_axioms'], completeness: 0.5 },
  unused_sorry: { verdict: 'not_solved', reasons: ['sorry_in_file'] },
  removed_definition: { verdict: 'not_solved', reasons: ['definition_removed'] },
  compile_error: { verdict: 'not_solved', reasons: ['compile_error'] },
  forbidden_command: { verdict: 'not_solved', reasons: ['static_screen_rejected'] },
  hidden_import: { verdict: 'not_solved', reasons: ['disallowed_import'] },
};

// With QEDRANK_LEAN_BACKEND=docker (and QEDRANK_LEAN_IMAGE, built from fixtures/lean-core with
// `node qedrank/cli.js lean-env build --project qedrank/test/fixtures/lean-core --tag <image>`) the
// same fixtures are graded inside the container: the end-to-end check of the container runner.
test('grade fixtures end to end (QEDRANK_LEAN_TESTS=1)', { skip: !process.env.QEDRANK_LEAN_TESTS }, async (t) => {
  const leanDir = path.join(here, 'fixtures', 'lean-core');
  const backend = process.env.QEDRANK_LEAN_BACKEND || 'host';
  const toolchain = backend === 'host'
    ? await detectToolchain(leanDir)
    : await selectToolchain({ runsDir: path.join(here, '..', '..', 'runs'), verification: { backend, image: process.env.QEDRANK_LEAN_IMAGE || 'qedrank-lean:lean-core', sif: process.env.QEDRANK_LEAN_SIF || null } }, { leanDir, log: (m) => t.diagnostic(m) });
  assert.equal(toolchain.available, true, toolchain.reason);
  assert.deepEqual(toolchain.lean_options, ['-DrelaxedAutoImplicit=false']);
  t.diagnostic(`environment: ${toolchain.environment.kind}${toolchain.environment.image ? ` ${toolchain.environment.image}` : ''}`);
  const runner = new LeanRunner(toolchain, { timeoutMs: 900000 });
  const challenge = await read('challenge');
  const scratch = await fs.mkdtemp(path.join(here, '..', '..', 'runs', 'grade-test-'));
  const only = process.env.QEDRANK_LEAN_TESTS_ONLY ? process.env.QEDRANK_LEAN_TESTS_ONLY.split(',') : Object.keys(EXPECTED);
  for (const name of only) {
    const want = EXPECTED[name];
    const g = await gradeSubmission({ runner, toolchain, challengeSrc: challenge, solutionSrc: await read(name), scratchDir: path.join(scratch, name), cacheDir: path.join(scratch, 'cache') });
    t.diagnostic(`${name}: ${g.verdict} [${g.reasons.join(', ')}] completeness=${g.completeness.available ? g.completeness.score.toFixed(2) : g.completeness.reason}`);
    assert.equal(g.verdict, want.verdict, `${name}: ${JSON.stringify(g.reasons)} ${JSON.stringify(g.grader_error ?? null)}`);
    assert.deepEqual(g.reasons, want.reasons, name);
    if (want.completeness !== undefined) assert.ok(Math.abs(g.completeness.score - want.completeness) < 1e-9, `${name}: completeness ${g.completeness.score}`);
    if (want.escalate) assert.ok(g.warnings.some((w) => w.startsWith('ESCALATE')), `${name}: expected an escalation warning`);
    if (want.text_identical === false) assert.equal(g.checks.statement.text_identical, false, name);
    if (g.checks.kernel_replay) assert.equal(g.checks.kernel_replay.status, g.verdict === 'solved' ? 'passed' : g.checks.kernel_replay.status, name);
  }
  await fs.rm(scratch, { recursive: true, force: true });
});

// Regression: #qr_olean_diff instantiated the solution's universe parameters, which also
// simplifies levels (max 1 (u+1) -> u+1), but not the reference's, so a definition whose
// elaborated value carries such a level compared as value_changed between byte-identical
// object files (ProofBench P001, hadwigerNumber). Core Lean normalises such levels away, so
// the case needs a Mathlib-based statement: opt-in with QEDRANK_LEAN_TESTS=1 and
// QEDRANK_PROOFBENCH_PROJECT=<built proofbench-statements checkout>; several minutes.
test('grade: a ProofBench challenge graded against itself keeps its definitions (QEDRANK_PROOFBENCH_PROJECT)', { skip: !process.env.QEDRANK_LEAN_TESTS || !process.env.QEDRANK_PROOFBENCH_PROJECT }, async (t) => {
  const project = process.env.QEDRANK_PROOFBENCH_PROJECT;
  const toolchain = await detectToolchain(project);
  assert.equal(toolchain.available, true, toolchain.reason);
  const runner = new LeanRunner(toolchain, { timeoutMs: 900000 });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qedrank-grade-levels-'));
  try {
    for (const id of (process.env.QEDRANK_PROOFBENCH_IDS || 'P001').split(',')) {
      const src = await fs.readFile(path.join(project, 'ProofBench', 'PROBLEMS', id, `${id}.lean`), 'utf8');
      const g = await gradeSubmission({ runner, toolchain, challengeSrc: src, solutionSrc: src, target: id, scratchDir: path.join(scratch, id), cacheDir: path.join(scratch, 'cache'), policy: { libraryPrefixes: ['ProofBench.Mathlib_Problems', 'Matroid', 'Archive.Sensitivity'], allowUnusedSorry: true, kernelReplay: false } });
      t.diagnostic(`${id}: ${g.verdict} [${g.reasons.join(', ')}] ${JSON.stringify(g.checks.statement?.counts)}`);
      assert.deepEqual(g.reasons, ['contains_sorry'], `${id}: ${JSON.stringify(g.checks.statement)}`);
      assert.deepEqual(g.checks.statement.definitions_changed, [], id);
      assert.equal(g.checks.statement.target_status, 'same', id);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
