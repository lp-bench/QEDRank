import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { scanAttempts, attemptEnv, inspectModelFor, runAttempts } from '../lib/harness/attempts.js';
import { proofbenchSettings, describeHarnesses } from '../lib/harness/registry.js';
import { sampleFixture, logFixture } from './helpers/harnesslog.js';

const session = (ended_by, extra = {}) => ({ session: 1, ended_by, output_tokens: 0, total_tokens: 0, working_seconds: 0, passed: false, errors: [], counted: false, ...extra });

test('inspectModelFor maps QEDRank slots to Inspect model strings and child-only environment', () => {
  const env = { GWDG_API_KEY: 'k-gwdg', ANTHROPIC_API_KEY: 'k-ant', OPENAI_API_KEY: 'k-oai' };
  const q = inspectModelFor('qwen', env);
  assert.equal(q.model, 'openai-api/qwen/qwen3-30b-a3b-instruct-2507');
  assert.deepEqual(q.env, { QWEN_API_KEY: 'k-gwdg', QWEN_BASE_URL: 'https://chat-ai.academiccloud.de/v1' });
  assert.equal(q.configured, true);
  const self = inspectModelFor('qwen', { ...env, QEDRANK_BASEURL_QWEN: 'http://127.0.0.1:8080/v1', QEDRANK_MODEL_QWEN: 'qwen3-30b-local' });
  assert.equal(self.model, 'openai-api/qwen/qwen3-30b-local'); assert.equal(self.env.QWEN_BASE_URL, 'http://127.0.0.1:8080/v1');
  assert.equal(inspectModelFor('fable', env).model, 'anthropic/claude-fable-5-1');
  assert.deepEqual(inspectModelFor('fable', env).env, { ANTHROPIC_API_KEY: 'k-ant' });
  assert.equal(inspectModelFor('gpt54', env).model, 'openai/gpt-5.4');
  assert.equal(inspectModelFor('kimi', {}).configured, false);
  // The GWDG slots added on 2026-10-23: the slot id becomes Inspect's openai-api service name and the variable prefix.
  const f = inspectModelFor('deepseek_flash', env);
  assert.equal(f.model, 'openai-api/deepseek_flash/deepseek-v4-flash-0731');
  assert.deepEqual(f.env, { DEEPSEEK_FLASH_API_KEY: 'k-gwdg', DEEPSEEK_FLASH_BASE_URL: 'https://chat-ai.academiccloud.de/v1' });
  assert.equal(inspectModelFor('glm', env).model, 'openai-api/glm/glm-5.3-flash');
  assert.equal(inspectModelFor('qwen35', env).model, 'openai-api/qwen35/qwen3.5-397b-a17b');
  assert.equal(inspectModelFor('qwen35', { LLAMA_API_KEY: 'old' }).env.QWEN35_API_KEY, 'old', 'the older GWDG key name still works');
});

test('attemptEnv carries budgets as the harness variables, the key only in the child env, no secrets in RUN_ID or IDS', () => {
  const env = attemptEnv({ baseEnv: { PATH: '/usr/bin' }, settings: { venvBin: '/h/.venv/bin' }, model: { model: 'openai-api/qwen/m', env: { QWEN_API_KEY: 'secret' } }, ids: ['P001', 'P002'], runId: 'r1', attempt: 3, limits: { sessions: 4, sessionOutputTokens: 20000, maxCostUsd: 5, messageLimit: 80 }, effort: 'high', search: false, network: false, comparator: true });
  assert.equal(env.RUN_ID, 'r1/attempt-3'); assert.equal(env.IDS, 'P001 P002'); assert.equal(env.MODEL, 'openai-api/qwen/m');
  assert.equal(env.SESSIONS, '4'); assert.equal(env.SESSION_OUTPUT_TOKENS, '20000'); assert.equal(env.MESSAGE_LIMIT, '80'); assert.equal(env.MAX_COST_USD, undefined, 'the cost cap is QEDRank\'s, not the harness\'s');
  assert.equal(env.EFFORT, 'high'); assert.equal(env.NETWORK, 'false'); assert.equal(env.COMPARATOR, 'on'); assert.equal(env.QWEN_API_KEY, 'secret');
  assert.ok(env.PATH.startsWith('/h/.venv/bin')); assert.equal(env.EPOCHS, undefined, 'epochs stay at the harness default of 1: attempts are separate runs');
});

test('scanAttempts: completed pairs come from logs (graded or errored samples); the rest is missing; cancelled and in-progress logs are recognised', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-scan-'));
  const logs = path.join(dir, 'logs', 'r1');
  const put = async (a, log, name) => { await fs.mkdir(path.join(logs, `attempt-${a}`), { recursive: true }); await fs.writeFile(path.join(logs, `attempt-${a}`, `${name}.json`), JSON.stringify(log)); };
  await put(1, logFixture({ samples: [sampleFixture('P001', { value: 'C', ok: true }), sampleFixture('P002'), sampleFixture('P003', { value: 'N', sessions: [session('provider_error: RateLimitError: 429')] })] }), 'a');
  await put(2, logFixture({ status: 'cancelled', samples: [sampleFixture('P001')] }), 'a');
  const st = await scanAttempts({ harnessDir: dir, runId: 'r1', attempts: 3, problems: ['P001', 'P002', 'P003'] });
  assert.deepEqual(st.map((s) => [s.attempt, s.status, s.completed, s.missing]), [
    [1, 'done', ['P001', 'P002', 'P003'], []],
    [2, 'cancelled', ['P001'], ['P002', 'P003']],
    [3, 'pending', [], ['P001', 'P002', 'P003']],
  ]);
  assert.deepEqual(st[0].infrastructure, ['P003']);
  const retry = await scanAttempts({ harnessDir: dir, runId: 'r1', attempts: 1, problems: ['P001', 'P002', 'P003'], retryInfra: true });
  assert.deepEqual(retry[0].missing, ['P003'], 'with --retry-infra the infrastructure error is run again, completed attempts never');
  await fs.rm(dir, { recursive: true, force: true });
});

test('describeHarnesses reports integration state and readiness without secrets', async () => {
  const config = await loadConfig({ cwd: os.tmpdir(), overrides: { harnesses: { proofbench: { dir: null } } } });
  const rows = await describeHarnesses(config);
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, ['qedrank-single', 'proofbench', 'matharena-arxivlean', 'qedrank-harness']);
  const pb = rows.find((r) => r.id === 'proofbench');
  assert.equal(pb.ready, false); assert.match(pb.reason, /not configured/);
  assert.equal(rows.find((r) => r.id === 'matharena-arxivlean').integration, 'not_integrated');
  assert.equal(rows.find((r) => r.id === 'qedrank-harness').integration, 'fallback_untested');
  const text = JSON.stringify(rows);
  assert.ok(!/"[A-Z0-9_]*API_KEY"\s*:/.test(text) && !/sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{12,}/.test(text), 'the listing holds no key names with values and no key-shaped strings');
  const s = await proofbenchSettings({ harnesses: { proofbench: { dir: 'C:/h' } } }, { platform: 'win32', env: { LOCALAPPDATA: 'C:/la' } });
  assert.equal(s.python, path.resolve('C:/h/.venv/Scripts/python.exe')); assert.equal(s.statements, path.resolve('C:/h/proofbench-statements'));
});

const bashAvailable = await new Promise((resolve) => execFile(process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe') : 'bash', ['-c', 'echo ok'], { windowsHide: true }, (err, out) => resolve(!err && String(out).includes('ok'))));

test('runAttempts drives a (fake) harness attempt by attempt, imports after each, resumes without repeating, and stops at the cost cap', { skip: bashAvailable ? false : 'bash not available' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-drive-'));
  const harness = path.join(dir, 'harness');
  await fs.mkdir(path.join(harness, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(harness, 'proofbench-statements'), { recursive: true });
  // The fake run.sh writes one Inspect-shaped JSON log for $IDS under logs/$RUN_ID, solving P001
  // in attempt 2 only, and records which env it saw. It never prints the key.
  const script = `#!/usr/bin/env bash
set -eu
mkdir -p "logs/$RUN_ID"
echo "model=$MODEL ids=$IDS sessions=\${SESSIONS:-} attempt=\${QEDRANK_ATTEMPT:-} keyset=\${QWEN_API_KEY:+yes}" >> "logs/$RUN_ID/seen.txt"
node "${path.join(dir, 'mklog.mjs').replace(/\\/g, '/')}" "logs/$RUN_ID/log.json" "$MODEL" "$IDS" "$QEDRANK_ATTEMPT"
`;
  await fs.writeFile(path.join(harness, 'scripts', 'run.sh'), script.replace(/\r\n/g, '\n'));
  await fs.writeFile(path.join(dir, 'mklog.mjs'), `
import fs from 'node:fs';
const [out, model, ids, attempt] = process.argv.slice(2);
const sample = (id, solved) => ({ id, epoch: 1, metadata: { name: id, difficulty: 'Research', theorem: id, submission: '/opt/proofbench/Submission/' + id + '.lean', project_dir: '/opt/proofbench', reference: 'theorem ' + id + ' : True := sorry' }, store: { sessions: [{ session: 1, ended_by: 'submit', output_tokens: 50, total_tokens: 500, working_seconds: 3, passed: solved, errors: solved ? [] : ['contains sorry'], counted: true }] }, scores: { lean_check: { value: solved ? 'C' : 'I', explanation: '', metadata: { ok: solved, errors: solved ? [] : ['contains sorry'], files: [], lines: 5, nonblank_lines: 5, proof_lines: solved ? 1 : 0, axioms: [], compile_seconds: 1, submission_text: 'theorem ' + id + ' : True := trivial', submission_files: {}, comparator: solved ? { ok: true, returncode: 0, ran_as: 'verifier', stdout: '', stderr: '' } : null, graded_in: 'verifier' } } }, events: [], model_usage: { m: { input_tokens: 100000, output_tokens: 1000, total_tokens: 101000 } }, total_time: 10, working_time: 5 });
const samples = ids.split(/\\s+/).filter(Boolean).map((id) => sample(id, id === 'P001' && attempt === '2'));
fs.writeFileSync(out, JSON.stringify({ version: 2, status: 'success', eval: { run_id: 'x', task: 'proofbench', model, created: 'now', task_args: {}, metadata: { sessions: 2 }, config: { epochs: 1 } }, plan: {}, samples }));
`);
  const config = await loadConfig({ cwd: dir, overrides: { runsDir: path.join(dir, 'runs'), bootstrap: { B: 20, seed: 1 }, pricing: { 'qwen3-30b-a3b-instruct-2507': { input: 10, output: 10 } }, harnesses: { proofbench: { dir: harness, bash: process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe') : 'bash' } } } });
  process.env.GWDG_API_KEY = process.env.GWDG_API_KEY || 'test-key';
  const lines = [];
  const r1 = await runAttempts({ config, runId: 'drive', slots: ['qwen'], problems: ['P001', 'P002'], attempts: 3, limits: { sessions: 2 }, maxCostUsd: 2.5, log: (m) => lines.push(m) });
  // Attempt 1 costs 2 problems x (100000*10 + 1000*10)/1e6 = 2.02 USD; attempt 2 pushes the estimate over the 2.5 cap.
  assert.equal(r1.stop_reason, 'cost_cap');
  assert.deepEqual(r1.attempts.map((a) => [a.attempt, a.status]), [[1, 'done'], [2, 'done'], [3, 'pending']]);
  const seen = await fs.readFile(path.join(harness, 'logs', 'drive', 'attempt-1', 'seen.txt'), 'utf8');
  assert.match(seen, /model=openai-api\/qwen\/qwen3-30b-a3b-instruct-2507 ids=P001 P002 sessions=2 attempt=1 keyset=yes/);
  assert.ok(!lines.join('\n').includes('test-key'), 'the key never reaches the log');
  const run = JSON.parse(await fs.readFile(path.join(config.runsDir, 'drive', 'run.json'), 'utf8'));
  assert.equal(run.attempts.planned, 3); assert.equal(run.attempts.stop_reason, 'cost_cap');
  const summary = JSON.parse(await fs.readFile(path.join(config.runsDir, 'drive', 'summary.json'), 'utf8'));
  const mm = summary.by_target.all['openai-api_qwen_qwen3-30b-a3b-instruct-2507'];
  assert.equal(mm.status_counts.fully_solved, 1); assert.equal(mm.status_counts.attempts, 4);
  // Resume with the cap lifted: attempts 1 and 2 are complete and are not run again; only attempt 3 runs.
  const r2 = await runAttempts({ config, runId: 'drive', slots: ['qwen'], problems: ['P001', 'P002'], attempts: 3, limits: { sessions: 2 }, log: (m) => lines.push(m) });
  assert.equal(r2.stop_reason, 'completed');
  assert.deepEqual(r2.attempts.map((a) => a.status), ['done', 'done', 'done']);
  const seen1 = await fs.readFile(path.join(harness, 'logs', 'drive', 'attempt-1', 'seen.txt'), 'utf8');
  assert.equal(seen1.trim().split('\n').length, 1, 'attempt 1 ran once');
  assert.ok(lines.some((l) => /attempt 1 · qwen: complete, nothing to run/.test(l)));
  await fs.rm(dir, { recursive: true, force: true });
});
