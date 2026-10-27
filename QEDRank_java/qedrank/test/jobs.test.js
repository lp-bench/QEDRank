import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { buildRunArgv, JobManager, listRunConfigs } from '../lib/jobs.js';
import { createServer, originAllowed } from '../lib/serve.js';

const REPO = 'https://github.com/owner/ProofBench';

test('job requests become allow-listed CLI arguments; anything else is refused', () => {
  const b = buildRunArgv({ command: 'run', repo: REPO, ref: 'bd5dd8e', subdir: '/ProofBench/PROBLEMS/', models: 'kimi,qwen', targets: ['main_theorem'], papers: 'P013, P026', runId: 'eval-1', task: 'prove', leanProject: 'C:\\ProofBench', dryRun: true });
  assert.deepEqual(b.argv, ['run', '--run-id', 'eval-1', '--repo', REPO, '--ref', 'bd5dd8e', '--subdir', 'ProofBench/PROBLEMS', '--models', 'kimi,qwen', '--targets', 'main_theorem', '--papers', 'P013,P026', '--task', 'prove', '--lean-project', 'C:\\ProofBench', '--dry-run']);
  assert.equal(b.run_id, 'eval-1');
  assert.deepEqual(buildRunArgv({ command: 'resume', runId: 'eval-1', retryFailed: true }).argv, ['resume', '--run-id', 'eval-1', '--retry-failed']);
  assert.throws(() => buildRunArgv({ command: 'run', repo: REPO, models: 'kimi', runId: '../x' }), /runId/);
  assert.throws(() => buildRunArgv({ command: 'run', repo: REPO, models: 'kimi,nope', runId: 'r' }), /unknown model/);
  assert.throws(() => buildRunArgv({ command: 'run', repo: REPO, models: 'kimi', targets: 'main', runId: 'r' }), /unknown target/);
  assert.throws(() => buildRunArgv({ command: 'run', repo: 'file:///etc/passwd', models: 'kimi', runId: 'r' }), /repo must be/);
  assert.throws(() => buildRunArgv({ command: 'run', repo: REPO, models: 'kimi', runId: 'r', subdir: '../../x' }), /subdir/);
  assert.throws(() => buildRunArgv({ command: 'run', repo: REPO, models: 'kimi', runId: 'r', papers: 'P1;rm -rf' }), /paper id/);
  assert.throws(() => buildRunArgv({ command: 'run', repo: REPO, models: 'kimi', runId: 'r', task: 'hack' }), /task/);
  assert.throws(() => buildRunArgv({ command: 'delete', runId: 'r' }), /command/);
  assert.throws(() => buildRunArgv({ command: 'run', repo: REPO, runId: 'r' }), /at least one model/);
  // a token in the request is ignored: it never becomes an argument
  assert.ok(!buildRunArgv({ command: 'run', repo: REPO, models: 'kimi', runId: 'r', token: 'ghp_x' }).argv.join(' ').includes('ghp_x'));
  // agent runs: harness allow-list, explicit problems, attempts 1-16, bounded budgets, no shell
  const a = buildRunArgv({ command: 'agent-run', harness: 'proofbench', runId: 'ag-1', ref: '0a4a476', models: 'qwen', papers: 'P109,P110', attempts: 4, sessions: 10, sessionOutputTokens: 30000, sessionWorkingTime: 1800, maxTokens: 16000, maxSamples: 2, maxCostUsd: 12.5, effort: 'high', comparator: true, retryInfra: true, regrade: true });
  assert.deepEqual(a.argv, ['agent-run', '--run-id', 'ag-1', '--harness', 'proofbench', '--models', 'qwen', '--problems', 'P109,P110', '--ref', '0a4a476', '--attempts', '4', '--sessions', '10', '--session-output-tokens', '30000', '--session-working-time', '1800', '--max-tokens', '16000', '--max-samples', '2', '--max-cost-usd', '12.5', '--effort', 'high', '--retry-infra', '--regrade']);
  assert.deepEqual(buildRunArgv({ command: 'agent-run', runId: 'ag-2', models: 'qwen', papers: 'P109', comparator: false }).argv, ['agent-run', '--run-id', 'ag-2', '--harness', 'proofbench', '--models', 'qwen', '--problems', 'P109', '--attempts', '1', '--comparator', 'off']);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen', papers: 'P1', attempts: 17 }), /attempts must be/);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen', papers: 'P1', attempts: 0 }), /attempts must be/);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen', papers: 'P1', sessions: 1.5 }), /sessions must be a whole number/);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen', papers: 'P1', maxCostUsd: -1 }), /maxCostUsd/);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen', papers: 'P1', effort: 'extreme' }), /effort/);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen', papers: 'P1', harness: 'matharena-arxivlean' }), /harness must be one of proofbench/);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen' }), /select at least one problem/);
  assert.throws(() => buildRunArgv({ command: 'agent-run', runId: 'r', models: 'qwen', papers: 'P1; rm -rf /' }), /paper id/);
});

function fakeSpawn(record) {
  return (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => { record.killed = sig; setTimeout(() => child.emit('close', null, sig), 5); return true; };
    record.calls.push({ exe, args, env: opts.env, cwd: opts.cwd });
    setTimeout(() => { child.stdout.emit('data', '[qedrank] run started\n'); if (!record.hang) child.emit('close', 0, null); }, 10);
    return child;
  };
}

test('the job manager starts the CLI with the token in the child environment only, keeps a log, and can stop a job', async () => {
  const record = { calls: [] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-jobs-'));
  const jobs = new JobManager({ cwd: dir, cliPath: 'cli.js', logDir: dir, spawnImpl: fakeSpawn(record), tokenResolver: async () => ({ token: 'ghp_secret', source: 'gh auth token' }), env: { PATH: 'x' }, nodeExe: 'node' });
  const j = await jobs.start({ command: 'run', repo: REPO, models: 'kimi', runId: 'r1', papers: 'P013' });
  assert.equal(j.status, 'running');
  assert.equal(record.calls[0].env.GITHUB_TOKEN, 'ghp_secret');
  assert.deepEqual(record.calls[0].args.slice(0, 4), ['cli.js', 'run', '--run-id', 'r1']);
  await assert.rejects(jobs.start({ command: 'run', repo: REPO, models: 'kimi', runId: 'r1' }), /already running/);
  await new Promise((r) => setTimeout(r, 40));
  const got = jobs.get(j.id, 0);
  assert.equal(got.status, 'done');
  assert.equal(got.exit_code, 0);
  assert.ok(got.log.includes('run started') && got.log.includes('exited with code 0'));
  assert.ok(!got.log.includes('ghp_secret'), 'the token never reaches the log');
  assert.equal(got.token_source, 'gh auth token');
  assert.equal(jobs.get(j.id, got.next).log, '');
  assert.equal(jobs.get('nope'), null);
  const text = await fs.readFile(got.log_file, 'utf8');
  assert.ok(text.includes('run started'));

  record.hang = true;
  const h = await jobs.start({ command: 'resume', runId: 'r2' });
  await new Promise((r) => setTimeout(r, 20));
  jobs.stop(h.id);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.get(h.id).status, 'stopped');
  assert.equal(record.killed, 'SIGTERM');
  await fs.rm(dir, { recursive: true, force: true });
});

test('job endpoints answer only to the app origins with the client header; run files stay public', async () => {
  assert.equal(originAllowed('http://localhost:3000'), true);
  assert.equal(originAllowed('https://qedrank.vercel.app'), true);
  assert.equal(originAllowed('https://evil.example'), false);
  assert.equal(originAllowed('https://evil.example', ['https://evil.example']), true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-serve-'));
  const record = { calls: [] };
  const jobs = new JobManager({ cwd: dir, cliPath: 'cli.js', logDir: dir, spawnImpl: fakeSpawn(record), tokenResolver: async () => ({ token: null, source: null }), env: {}, nodeExe: 'node' });
  const server = createServer({ runsDir: dir, jobs });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, { origin, client = true, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(client ? { 'X-QEDRank-Client': 'web' } : {}), 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null, headers: res.headers })); });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  // Preflight from the deployed (https) page to the loopback server: private-network access granted.
  const pre = await call('OPTIONS', '/jobs', { origin: 'https://qedrank.vercel.app' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-private-network'], 'true');
  assert.equal(pre.headers['access-control-allow-origin'], 'https://qedrank.vercel.app');
  assert.match(pre.headers['access-control-allow-headers'], /X-QEDRank-Client/);
  const good = { command: 'run', repo: REPO, models: 'kimi', runId: 'web-1' };
  assert.equal((await call('POST', '/jobs', { origin: 'https://evil.example', body: good })).status, 403);
  assert.equal((await call('POST', '/jobs', { origin: 'http://localhost:3000', client: false, body: good })).status, 403);
  const created = await call('POST', '/jobs', { origin: 'http://localhost:3000', body: good });
  assert.equal(created.status, 201);
  assert.equal(created.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal((await call('POST', '/jobs', { origin: 'http://localhost:3000', body: { command: 'run', repo: REPO, models: 'nope', runId: 'x' } })).status, 400);
  await new Promise((r) => setTimeout(r, 40));
  const got = await call('GET', `/jobs/${created.body.job.id}?from=0`, { origin: 'http://localhost:3000' });
  assert.equal(got.body.job.status, 'done');
  const list = await call('GET', '/runs', {});
  assert.equal(list.status, 200);
  assert.equal(list.body.jobs, true);
  assert.equal(list.headers['access-control-allow-origin'], '*');
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('run requests carry the run configuration and generation settings as validated flags', () => {
  const base = { command: 'run', repo: REPO, models: 'glm', runId: 'r', task: 'prove' };
  const b = buildRunArgv({ ...base, config: 'glm-prove-pass4.json', attempts: 16, temperature: 1, effort: 'max', maxTokens: 65536, timeoutMs: 1800000, providerConcurrency: 2 }, { configs: ['glm-prove-pass4.json'] });
  assert.deepEqual(b.argv.slice(-14), ['--attempts', '16', '--config', 'configs/glm-prove-pass4.json', '--temperature', '1', '--max-tokens', '65536', '--timeout-ms', '1800000', '--provider-concurrency', '2', '--effort', 'max']);
  assert.throws(() => buildRunArgv({ ...base, config: '../qedrank.config.json' }), /config must be/);
  assert.throws(() => buildRunArgv({ ...base, config: 'other.json' }, { configs: ['glm-prove-pass4.json'] }), /unknown run configuration/);
  assert.throws(() => buildRunArgv({ ...base, temperature: 5 }), /temperature must be/);
  assert.throws(() => buildRunArgv({ ...base, providerConcurrency: 0 }), /providerConcurrency must be/);
  assert.throws(() => buildRunArgv({ ...base, effort: 'ultra' }), /effort must be/);
  // without a known list any well-formed name passes; the CLI fails fast when the file is missing
  assert.ok(buildRunArgv({ ...base, config: 'x.json' }).argv.includes('configs/x.json'));
  // empty fields are not flags
  assert.ok(!buildRunArgv({ ...base, temperature: '', effort: '', config: '' }).argv.some((a) => /--temperature|--effort|--config/.test(a)));
});

test('listRunConfigs reads the settings of every configs/*.json and marks a broken one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-configs-'));
  await fs.writeFile(path.join(dir, 'glm-prove-pass4.json'), JSON.stringify({ task: 'prove', generation: { attempts: 4, temperature: 1.0, effort: 'max', maxTokens: 65536, timeoutMs: 1800000, providerConcurrency: 2 }, lean: { concurrency: 3 } }));
  await fs.writeFile(path.join(dir, 'broken.json'), '{ not json');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
  const list = await listRunConfigs(dir);
  assert.deepEqual(list.map((c) => c.file), ['broken.json', 'glm-prove-pass4.json']);
  assert.equal(list[0].error, 'not valid JSON');
  assert.deepEqual(list[1].generation, { attempts: 4, temperature: 1, topP: null, effort: 'max', maxTokens: 65536, timeoutMs: 1800000, providerConcurrency: 2, retries: null });
  assert.equal(list[1].path, 'configs/glm-prove-pass4.json');
  assert.deepEqual(await listRunConfigs(path.join(dir, 'missing')), []);
  await fs.rm(dir, { recursive: true, force: true });
});
