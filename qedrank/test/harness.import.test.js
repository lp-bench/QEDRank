import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { importProofbenchLogs, proofbenchItem, harnessProtocolOf, discoverSources, compileStatusFromLayer1 } from '../lib/harness/proofbench.js';
import { openRun, stageStatistics, collectItems } from '../lib/run.js';
import { writeZip } from '../lib/harness/zip.js';
import { normalizeSample } from '../lib/harness/evallog.js';
import { sampleFixture as rawSample, logFixture, MANIFEST } from './helpers/harnesslog.js';

/** Samples as the importer sees them: raw Inspect shape normalised by the log reader. */
const sampleFixture = (id, opts) => normalizeSample(rawSample(id, opts));

const session = (ended_by, extra = {}) => ({ session: 1, ended_by, output_tokens: 10, total_tokens: 100, working_seconds: 5, passed: false, errors: [], counted: true, ...extra });

async function writeLog(dir, log, { zip = false, name = 'log' } = {}) {
  await fs.mkdir(dir, { recursive: true });
  if (!zip) return fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(log));
  const { samples, ...header } = log;
  return fs.writeFile(path.join(dir, `${name}.eval`), writeZip([{ name: 'header.json', data: JSON.stringify(header), deflate: true }, ...samples.map((s) => ({ name: `samples/${s.id}_epoch_${s.epoch}.json`, data: JSON.stringify(s), deflate: true }))]));
}

async function tmpConfig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-import-'));
  const config = await loadConfig({ cwd: dir, overrides: { runsDir: path.join(dir, 'runs'), bootstrap: { B: 40, seed: 3 }, pricing: { 'qwen3-30b': { input: 1, output: 2 } }, harnesses: { proofbench: { dir: null } } } });
  return { dir, config };
}

test('one harness sample becomes one item record with status, failure class, partial state and provenance', () => {
  const harness = harnessProtocolOf(MANIFEST, logFixture());
  const ctx = { model: 'openai-api/qwen/qwen3-30b', attempt: 2, harness, pricing: { 'qwen3-30b': { input: 1, output: 2 } }, labels: {} };
  const solved = proofbenchItem(sampleFixture('P001', { value: 'C', ok: true }), ctx);
  assert.equal(solved.status, 'fully_solved'); assert.equal(solved.outcomes.verified, 1); assert.equal(solved.failure, null); assert.equal(solved.compile.status, 'compiler_success');
  assert.equal(solved.attempt, 2); assert.equal(solved.setting, 'agent'); assert.equal(solved.harness, 'proofbench'); assert.equal(solved.provider, 'openai-api_qwen_qwen3-30b');
  assert.equal(solved.agent.totals.cost_usd, (1200 / 1e6) * 1 + (300 / 1e6) * 2); assert.match(solved.agent.totals.cost_basis, /estimated/);
  assert.equal(solved.agent.sessions_max, 2); assert.equal(solved.agent.totals.tool_calls, 3); assert.equal(solved.loc.model.proof.code, 3);
  assert.equal(solved.artifacts.submission, 'submission-a2.lean'); assert.equal(solved.artifacts.grade, 'grade-a2.json');
  assert.equal(solved.generation.prompt_template_version, 'proofbench-eval-apptainer@2803e81aaa');

  const sorry = proofbenchItem(sampleFixture('P002'), ctx);
  assert.equal(sorry.status, 'failed'); assert.equal(sorry.failure.class, 'incomplete_proof'); assert.equal(sorry.outcomes.verified, 0); assert.equal(sorry.outcomes.compiled, null, 'layer 1 stops before compiling a file with sorry'); assert.equal(sorry.partial.assessed, false);

  const altered = proofbenchItem(sampleFixture('P004', { errors: ['theorem statement altered'] }), ctx);
  assert.equal(altered.failure.class, 'statement_mismatch'); assert.equal(altered.outcomes.statement_faithful, 0); assert.equal(altered.statement_match, 'different');

  const cmpRejected = proofbenchItem(sampleFixture('P005', { value: 'I', ok: true, errors: [] }), ctx);
  assert.equal(cmpRejected.status, 'failed'); assert.equal(cmpRejected.failure.class, 'statement_mismatch'); assert.equal(cmpRejected.outcomes.compiled, 1); assert.equal(cmpRejected.outcomes.audit_clean, 1); assert.equal(cmpRejected.outcomes.verified, 0, 'compiling and passing layer 1 is not a success');
  assert.ok(cmpRejected.notes.includes('layer 1 passed, Comparator rejected'));

  const compileErr = proofbenchItem(sampleFixture('P006', { errors: ['compile error: 7:2: error: unsolved goals\n⊢ 1 = 2'] }), ctx);
  assert.equal(compileErr.failure.class, 'tactic'); assert.equal(compileErr.compile.status, 'compiler_failure'); assert.equal(compileErr.outcomes.compiled, 0);

  const infra = proofbenchItem(sampleFixture('P007', { value: 'N', sessions: [session('provider_error: RateLimitError: 429', { counted: false, output_tokens: 0 }), session('provider_error: RateLimitError: 429', { counted: false, output_tokens: 0 })] }), ctx);
  assert.equal(infra.status, 'infrastructure_error'); assert.equal(infra.outcomes.infrastructure_failure, true); assert.equal(infra.outcomes.verified, null); assert.equal(infra.failure.class, 'provider');

  const crashed = proofbenchItem(sampleFixture('P008', { value: null, error: 'RuntimeError: sandbox died' }), ctx);
  assert.equal(crashed.status, 'infrastructure_error'); assert.equal(crashed.failure.class, 'infrastructure');

  const open = proofbenchItem(sampleFixture('P003', { value: 'C', ok: true }), ctx);
  assert.equal(open.mathematical_status, 'open'); assert.equal(open.eligibility.proof_track, false); assert.equal(open.outcomes.verified, null); assert.ok(open.notes.some((n) => n.startsWith('ESCALATE')));

  const partial = proofbenchItem(sampleFixture('P009'), { ...ctx, regrade: { verdict: 'not_solved', reasons: ['contains_sorry'], checks: { compile: { status: 'compiler_success' }, sorry: { declarations_with_sorry: ['P009'] } }, completeness: { available: true, score: 0.5, lemmas_written: 2, lemmas_written_sorry_free: 2, open_steps: ['P009'] }, toolchain: { lean_project: 'C:/pinned' } } });
  assert.equal(partial.status, 'partially_solved'); assert.equal(partial.partial.verified_aux_lemmas, 2); assert.match(partial.partial.method, /qr_module_report/); assert.equal(partial.outcomes.verified, 0, 'partial progress never counts as verified'); assert.equal(partial.outcomes.compiled, 1);

  assert.equal(compileStatusFromLayer1(false, ['compile timeout']), 'timeout');
  assert.equal(compileStatusFromLayer1(false, ['helper build error: x']), 'compiler_failure');
});

test('import: attempts, pass@k for every k, observed vs estimate, unavailable k, status and failure counts, coverage differences, cancelled attempt, idempotent re-import', async () => {
  const { dir, config } = await tmpConfig();
  const root = path.join(dir, 'logs', 'r1');
  const A = 'openai-api/qwen/qwen3-30b';
  const B = 'openai-api/kimi/kimi-k3';
  // Model A: P001 solved in attempts 1 and 3, P002 never, P003 open (statement track only), P004 solved in attempt 2.
  const a1 = [rawSample('P001', { value: 'C', ok: true }), rawSample('P002'), rawSample('P003'), rawSample('P004', { errors: ['compile error: 1:1: error: unknown identifier \'foo\''] })];
  const a2 = [rawSample('P001'), rawSample('P002', { value: 'N', sessions: [session('provider_error: APIStatusError: 503', { counted: false, output_tokens: 0 })] }), rawSample('P003'), rawSample('P004', { value: 'C', ok: true })];
  const a3 = [rawSample('P001', { value: 'C', ok: true }), rawSample('P002')]; // cancelled before P003 and P004
  // Model B: two attempts, no P004 at all (coverage difference), P001 solved once.
  const b1 = [rawSample('P001'), rawSample('P002'), rawSample('P003')];
  const b2 = [rawSample('P001', { value: 'C', ok: true }), rawSample('P002', { errors: ['compile error: 2:2: error: type mismatch'] }), rawSample('P003')];
  await writeLog(path.join(root, 'attempt-1'), logFixture({ model: A, samples: a1 }), { zip: true, name: 'a' });
  await writeLog(path.join(root, 'attempt-1'), logFixture({ model: B, samples: b1 }), { name: 'b' });
  await writeLog(path.join(root, 'attempt-2'), logFixture({ model: A, samples: a2 }), { name: 'a' });
  await writeLog(path.join(root, 'attempt-2'), logFixture({ model: B, samples: b2 }), { name: 'b' });
  await writeLog(path.join(root, 'attempt-3'), logFixture({ model: A, samples: a3, status: 'cancelled' }), { name: 'a' });
  for (const a of [1, 2, 3]) await fs.writeFile(path.join(root, `attempt-${a}`, 'manifest.json'), JSON.stringify(MANIFEST));
  const sources = await discoverSources(root);
  assert.deepEqual(sources.map((s) => s.attempt), [1, 2, 3]);
  const logLines = [];
  const res = await importProofbenchLogs({ config, runId: 'r1', sources, attemptsPlanned: 4, log: (m) => logLines.push(m) });
  assert.equal(res.items, 4 + 4 + 2 + 3 + 3);
  assert.deepEqual(res.models.sort(), ['openai-api_kimi_kimi-k3', 'openai-api_qwen_qwen3-30b']);
  assert.equal(res.run.attempts.planned, 4);
  assert.equal(res.run.attempts.by_attempt[3].status, 'cancelled');
  assert.deepEqual(res.run.attempts.by_attempt[3].problems_missing, ['P003', 'P004']);
  assert.equal(res.run.attempts.by_attempt[4].status, 'pending');
  assert.deepEqual(res.run.attempts.by_attempt[4].problems_missing, ['P001', 'P002', 'P003', 'P004']);
  assert.equal(res.run.harness_protocol.commit, MANIFEST.harness_commit);
  assert.equal(res.run.harness_protocol.limits.sessions, 2);
  assert.deepEqual(res.run.protocol_mismatches, [], 'same manifest everywhere');
  // Artifacts next to the record, never in the exports.
  const itemDir = path.join(config.runsDir, 'r1', 'items', 'P001__main_theorem__openai-api_qwen_qwen3-30b');
  assert.ok((await fs.readFile(path.join(itemDir, 'submission-a1.lean'), 'utf8')).includes('theorem X'));
  const grade = JSON.parse(await fs.readFile(path.join(itemDir, 'grade-a1.json'), 'utf8'));
  assert.equal(grade.score, 'C'); assert.equal(grade.metadata.submission_text, undefined); assert.equal(grade.original_statement, 'theorem P001 : True := sorry');

  const ctx = await openRun({ config, runId: 'r1', log: () => {} });
  const { summary, items } = await stageStatistics(ctx);
  const qa = summary.by_target.all['openai-api_qwen_qwen3-30b'];
  const kb = summary.by_target.all['openai-api_kimi_kimi-k3'];
  assert.equal(summary.settings.attempts, 4);
  assert.equal(summary.models.find((m) => m.id === 'openai-api_qwen_qwen3-30b').harness, 'proofbench');
  // Status counts over all attempts of A: solved P001a1, P004a2, P001a3 = 3; infra P002a2 = 1; failed = 6.
  assert.deepEqual([qa.status_counts.fully_solved, qa.status_counts.partially_solved, qa.status_counts.failed, qa.status_counts.infrastructure_error, qa.status_counts.attempts], [3, 0, 6, 1, 10]);
  assert.equal(qa.failure_counts.incomplete_proof, 5); assert.equal(qa.failure_counts.elaboration, 1); assert.equal(qa.failure_counts.provider, 1);
  // Leaderboard pass@1 = attempt 1 only, proof track (P003 is open): A solved 1 of 3.
  assert.equal(qa.verified_pass1.num, 1); assert.equal(qa.verified_pass1.den, 3);
  // pass@k curve: every integer k up to 4; A's proof-track items: P001 n=3 c=2, P002 n=2 c=0 (infra attempt excluded), P004 n=2 c=1.
  const curve = Object.fromEntries(qa.pass_at_k.curve.map((c) => [c.k, c]));
  assert.deepEqual(Object.keys(curve).map(Number), [1, 2, 3, 4]);
  const close = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
  close(curve[1].value, (2 / 3 + 0 + 1 / 2) / 3);
  close(curve[2].value, ((1 - 0) + 0 + (1 - 0)) / 3); // P001: C(1,2)/C(3,2)=0 -> 1; P004: C(1,2)/C(2,2)=0 -> 1
  assert.equal(curve[2].items, 3); assert.equal(curve[2].items_short, 0);
  assert.equal(curve[3].items, 1, 'only P001 has three attempts'); assert.equal(curve[3].items_short, 2); close(curve[3].value, 1);
  assert.equal(curve[4].value, null, 'no item has four attempts: unavailable, never zero'); assert.equal(curve[4].items, 0);
  assert.deepEqual([curve[1].prominent, curve[2].prominent, curve[3].prominent, curve[4].prominent], [true, true, false, true]);
  // Observed solved-within-k is kept apart from the estimate: within 1 attempt A solved P001 only (1/3); within 2, P001 and P004 (2/3).
  assert.deepEqual(curve[1].observed_within_k, { num: 1, den: 3, value: 1 / 3 });
  assert.deepEqual(curve[2].observed_within_k, { num: 2, den: 3, value: 2 / 3 });
  assert.equal(qa.pass_at_k.den, 0, 'observed pass@4: no item has four attempts');
  // B: P001 n=2 c=1, P002 n=2 c=0 -> pass@1 = 0.25, pass@2 = 0.5, pass@3 unavailable.
  const cb = Object.fromEntries(kb.pass_at_k.curve.map((c) => [c.k, c]));
  close(cb[1].value, 0.25); close(cb[2].value, 0.5); assert.equal(cb[3].value, null);
  // Coverage: B never saw P004.
  assert.deepEqual(summary.coverage.problems_by_model['openai-api_kimi_kimi-k3'], ['P001', 'P002', 'P003']);
  assert.deepEqual(summary.coverage.coverage_differences, [{ model: 'openai-api_kimi_kimi-k3', covered: 3, of: 4, missing: ['P004'] }]);
  assert.deepEqual(summary.coverage.common_problems, ['P001', 'P002', 'P003']);
  assert.ok(summary.counting_rules.pass_at_k.includes('never shown as 0'.replace('never shown as 0', 'Never shown as 0')) || summary.counting_rules.pass_at_k.includes('not 0'));
  assert.equal(summary.attempts.planned, 4);
  // Exports carry the new columns and no proof text.
  const exported = JSON.parse(await fs.readFile(path.join(config.runsDir, 'r1', 'exports', 'items.json'), 'utf8')).items;
  const row = exported.find((r) => r.paper_id === 'P004' && r.attempt === 1 && r.provider === 'openai-api_qwen_qwen3-30b');
  assert.equal(row.status, 'failed'); assert.equal(row.failure_class, 'elaboration'); assert.equal(row.harness, 'proofbench'); assert.equal(row.submission_artifact, 'submission-a1.lean'); assert.match(row.compile_first_error, /unknown identifier/);
  assert.ok(!JSON.stringify(exported).includes('theorem X : True := trivial'), 'proof text stays out of the exports');
  // Re-import is idempotent.
  const again = await importProofbenchLogs({ config, runId: 'r1', sources, attemptsPlanned: 4, force: true, log: () => {} });
  assert.equal(again.items, res.items);
  assert.equal((await collectItems(ctx)).length, res.items);
  await fs.rm(dir, { recursive: true, force: true });
});

test('import: a run from another harness merges in with its own provider ids for a cross-harness grid', async () => {
  const { dir, config } = await tmpConfig();
  // A tiny single-call run (prove task) made by hand.
  const other = path.join(config.runsDir, 'single');
  const rec = { schema: 'qedrank-item-v1', item_key: 'P001__main_theorem__qwen', paper_id: 'P001', target_kind: 'main_theorem', provider: 'qwen', model_display_name: 'Qwen3 30B-A3B', model_id: 'qwen3-30b', task: 'prove', setting: 'pass@1', attempt: 1, repair_round: 0, mathematical_status: 'established', eligibility: { statement_track: true, proof_track: true, reasons: [] }, outcomes: { infrastructure_failure: false, compiled: 0, audit_clean: null, statement_faithful: null, verified: 0 }, compile: { status: 'compiler_failure', messages: [] }, audit: { status: 'not_audited', axioms: [] }, statement_match: 'not_evaluated', generation: { usage: { inputTokens: 10, outputTokens: 20 }, observed_latency_ms: 1000 }, timing: {}, grade: { reasons: ['compile_error'] }, compiler_output: '1:1: error: unsolved goals', notes: [], evaluation_complete: true };
  await fs.mkdir(path.join(other, 'items', 'P001__main_theorem__qwen'), { recursive: true });
  await fs.writeFile(path.join(other, 'items', 'P001__main_theorem__qwen', 'attempt-a1r0.json'), JSON.stringify(rec));
  await fs.writeFile(path.join(other, 'run.json'), JSON.stringify({ schema: 'qedrank-run-v1', run_id: 'single', protocol: 'single_call', task: 'prove', models: ['qwen'] }));
  await fs.writeFile(path.join(other, 'manifest.json'), JSON.stringify({ papers: [{ paper_id: 'P001', difficulty: 'Research', subject_tags: ['05'] }] }));
  const root = path.join(dir, 'logs', 'r2');
  await writeLog(path.join(root, 'attempt-1'), logFixture({ samples: [rawSample('P001', { value: 'C', ok: true })] }));
  const res = await importProofbenchLogs({ config, runId: 'r2', sources: await discoverSources(root), mergeRuns: ['single'], log: () => {} });
  assert.deepEqual(res.models.sort(), ['openai-api_qwen_qwen3-30b', 'qwen__qedrank-single']);
  const ctx = await openRun({ config, runId: 'r2', log: () => {} });
  const { summary } = await stageStatistics(ctx);
  const byId = Object.fromEntries(summary.models.map((m) => [m.id, m]));
  assert.equal(byId['qwen__qedrank-single'].harness, 'qedrank-single');
  assert.equal(byId['openai-api_qwen_qwen3-30b'].harness, 'proofbench');
  assert.equal(summary.by_target.all['qwen__qedrank-single'].failure_counts.tactic, 1, 'merged single-call records get a failure class from their grade');
  assert.equal(summary.by_target.all['openai-api_qwen_qwen3-30b'].status_counts.fully_solved, 1);
  assert.deepEqual(summary.run.merged_runs, ['single']);
  await fs.rm(dir, { recursive: true, force: true });
});
