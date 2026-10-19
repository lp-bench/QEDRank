import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReports, toolOptions, theoremRecords, summarizeProofs, summarizeStatements, slimProofMetrics, measureProjectFiles, PROOF_METRICS_SCHEMA } from '../lib/proofmetrics.js';
import { linterOf, countLinterWarnings } from '../lib/lean.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('tool output: only QR_METRICS lines, and lakefile options become --opt arguments', () => {
  const out = 'warning: deprecated\nQR_METRICS={"file":"a.lean","decls":[]}\nnoise\nQR_METRICS={"file":"b.lean","error":"x"}\nQR_METRICS={"trunc';
  assert.deepEqual(parseReports(out).map((r) => r.file), ['a.lean', 'b.lean']);
  assert.deepEqual(toolOptions(['-DmaxSynthPendingDepth=3', '-Dweak.linter.mathlibStandardSet=true', '--other']), ['--opt', 'maxSynthPendingDepth=3', '--opt', 'weak.linter.mathlibStandardSet=true']);
});

test('linter warnings are counted by the linter their note names', () => {
  assert.equal(linterOf('unused variable `h`\nNote: This linter can be disabled with `set_option linter.unusedVariables false`'), 'linter.unusedVariables');
  assert.equal(linterOf('declaration uses `sorry`'), null);
  const msgs = [
    { severity: 'warning', text: 'x `set_option linter.unusedVariables false`' },
    { severity: 'warning', text: 'y `set_option linter.unusedVariables false`' },
    { severity: 'warning', text: 'z `set_option linter.style.longLine false`' },
    { severity: 'error', text: 'e `set_option linter.unusedVariables false`' },
    { severity: 'warning', text: 'declaration uses `sorry`' },
  ];
  assert.deepEqual(countLinterWarnings(msgs), { 'linter.unusedVariables': 2, 'linter.style.longLine': 1 });
});

// A report as the Lean tool writes it, for three theorems of one file.
const TEXT = 'theorem a (n : Nat) (h : n = 1) (h2 : True) : n + 0 = n := by\n  simp\n\ntheorem b (p : Prop) (hp : p) : p := by\n  exact hp\n\ntheorem c : True := by sorry\n';
const at = (s) => Buffer.byteLength(TEXT.slice(0, TEXT.indexOf(s)), 'utf8');
const end = (s) => at(s) + Buffer.byteLength(s, 'utf8');
const REPORT = {
  file: 'X.lean',
  text: TEXT,
  header_errors: false,
  commands: [
    { index: 0, start_line: 1, end_line: 2, value_start_byte: at(':= by\n  simp'), value_end_byte: end(':= by\n  simp'), tactics: 1, tactics_by_name: { simp: 1 } },
    { index: 1, start_line: 4, end_line: 5, value_start_byte: at(':= by\n  exact hp'), value_end_byte: end(':= by\n  exact hp'), tactics: 1, tactics_by_name: { exact: 1 } },
    { index: 2, start_line: 7, end_line: 7, value_start_byte: at(':= by sorry'), value_end_byte: end(':= by sorry'), tactics: 1, tactics_by_name: { sorry: 1 } },
  ],
  decls: [
    { name: 'a', kind: 'theorem', command: 0, start: [1, 0], end: [2, 6], term_size: 30, has_sorry: false, hypotheses: [{ name: 'h', used: false }, { name: 'h2', used: false }] },
    { name: 'b', kind: 'theorem', command: 1, start: [4, 0], end: [5, 10], term_size: 10, has_sorry: false, hypotheses: [{ name: 'hp', used: true }] },
    { name: 'c', kind: 'theorem', command: 2, start: [7, 0], end: [7, 30], term_size: 5, has_sorry: true, hypotheses: [] },
    { name: 'f', kind: 'def', command: null, start: [9, 0], end: [9, 5], term_size: 3, has_sorry: false, hypotheses: [] },
    { name: 'S.pos', kind: 'theorem', command: 0, written: false, start: [1, 0], end: [1, 5], term_size: 3, has_sorry: false, hypotheses: [] },
  ],
  messages: [
    { severity: 'warning', line: 1, column: 20, linter: 'linter.unusedVariables', text: 'unused h' },
    { severity: 'warning', line: 1, column: 30, linter: 'linter.unusedVariables', text: 'unused h2' },
    { severity: 'warning', line: 7, column: 8, linter: null, text: 'declaration uses `sorry`' },
  ],
  targets: [],
};

test('theorem records: proof length, tactics without sorry, automation, unused hypotheses, linters in range', () => {
  const r = theoremRecords(REPORT, { source: 'library', file: 'X.lean' });
  assert.deepEqual(r.map((x) => x.name), ['a', 'b', 'c'], 'written theorems only (no definitions, no generated field theorems)');
  const [a, b, c] = r;
  assert.equal(a.complete, true);
  assert.equal(a.proof_lines, 2);
  assert.equal(a.proof_tokens, 2);
  assert.equal(a.tactics, 1);
  assert.equal(a.automation, 1);
  assert.deepEqual(a.unused_hypotheses, ['h', 'h2']);
  assert.deepEqual(a.linter_warnings, { 'linter.unusedVariables': 2 });
  assert.equal(b.automation, 0);
  assert.deepEqual(b.unused_hypotheses, []);
  assert.equal(c.complete, false);
  assert.equal(c.tactics, 0, 'a sorry is not a tactic');
});

test('proof summary: complete proofs only; tactic shares and hypotheses', () => {
  const records = theoremRecords(REPORT, { source: 'library', file: 'X.lean' });
  const s = summarizeProofs(records, [REPORT]);
  assert.equal(s.theorems, 3);
  assert.equal(s.proofs, 2);
  assert.equal(s.with_sorry, 1);
  assert.equal(s.tactic_calls, 2);
  assert.equal(s.automation_share, 0.5);
  assert.deepEqual(s.tactic_counts, { simp: 1, exact: 1 });
  assert.deepEqual(s.hypotheses, { proofs_with_hypotheses: 2, proofs_with_unused: 1, unused: 2, total: 3, undecided: 0 });
  assert.equal(s.linter_warnings.total, 2);
  assert.equal(s.linter_warnings.files_with_warnings, 1);
  assert.equal(s.term_mode_proofs, 0);
  assert.equal(s.proof_lines.median, 2);
});

test('statement checks: probe outcomes, files that did not elaborate, targets not found', () => {
  const probe = (x) => ({ found: true, name: 'Ns.P1', portfolio: ['omega', 'simp_all', 'decide', 'contradiction'], prop_hypotheses: 1, closed_by: null, contradictory_by: null, ...x });
  const s = summarizeStatements([
    { id: 'P1', report: { targets: [probe({ closed_by: 'omega', contradictory_by: 'omega' })], messages: [{ severity: 'warning', linter: 'linter.unusedVariables' }] } },
    { id: 'P2', report: { targets: [probe({})], messages: [] } },
    { id: 'P3', report: { targets: [{ found: false, name: 'P3' }], messages: [] } },
    { id: 'P4', report: { header_errors: true, targets: [], messages: [] } },
  ]);
  assert.equal(s.files, 4);
  assert.equal(s.measured, 3);
  assert.deepEqual(s.not_elaborated, ['P4']);
  assert.equal(s.targets_found, 2);
  assert.deepEqual(s.targets_not_found, ['P3']);
  assert.equal(s.closed_by_automation, 1);
  assert.equal(s.contradictory, 1);
  assert.deepEqual(s.flagged, [{ id: 'P1', target: 'Ns.P1', closed_by: 'omega', contradictory_by: 'omega' }]);
  assert.deepEqual(s.linter_warnings.by_linter, { 'linter.unusedVariables': 1 });
});

test('the page gets no source text and no names from private solutions', () => {
  const rec = theoremRecords(REPORT, { source: 'solutions', file: 'ProofBench/P012_sol.lean', problem: 'P012' });
  const slim = slimProofMetrics({ schema: PROOF_METRICS_SCHEMA, generated_at: 't', rules: {}, projects: [], failures: [{ key: 'x' }], sources: { solutions: { private: true, summary: {}, records: rec.map((r) => ({ ...r, text: 'secret' })) }, library: { summary: {}, records: [{ name: 'lib_lemma', text: 'code' }] } } });
  assert.deepEqual(slim.sources.solutions.records.map((r) => r.name), ['P012 lemma 1', 'P012 lemma 2', 'P012 lemma 3']);
  assert.ok(slim.sources.solutions.records.every((r) => r.file === 'P012' && !('text' in r)));
  assert.equal(slim.sources.library.records[0].name, 'lib_lemma');
  assert.equal(slim.failures, 1);
  assert.equal(slimProofMetrics({ schema: 'other' }), null);
});

// End to end with Lean on the dependency-free fixture project (opt-in, like the grader's).
test('Lean tool on a core-Lean file (QEDRANK_LEAN_TESTS=1)', { skip: !process.env.QEDRANK_LEAN_TESTS }, async () => {
  const project = path.join(here, 'fixtures', 'lean-core');
  const file = path.join(here, 'fixtures', 'proof-metrics', 'Sample.lean');
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-pm-'));
  const { reports, failures } = await measureProjectFiles({ project, files: [{ key: 'sample', file, targets: ['triv', 'contra', 'used_h'] }], cacheDir, jobs: 1 });
  assert.deepEqual(failures, []);
  const rep = reports.get('sample');
  const rec = Object.fromEntries(theoremRecords(rep, { source: 'library', file: 'Sample.lean' }).map((r) => [r.name, r]));
  assert.deepEqual(rec.unused_h.unused_hypotheses, ['h', 'h2']);
  assert.deepEqual(rec.used_h.unused_hypotheses, []);
  assert.equal(rec.used_h.tactics, 0, 'term-mode proof');
  assert.deepEqual(rec.tac_mix.tactics_by_name, { constructor: 1, exact: 2 }, 'the focusing dot is not a tactic');
  assert.equal(rec.withSorry.complete, false);
  assert.equal(rec.unused_h.linter_warnings['linter.unusedVariables'], 2);
  const probes = Object.fromEntries(rep.targets.map((t) => [t.name, t]));
  assert.equal(probes.triv.closed_by, 'omega');
  assert.equal(probes.contra.contradictory_by, 'omega');
  assert.equal(probes.used_h.contradictory_by, null);
  await fs.rm(cacheDir, { recursive: true, force: true });
});
