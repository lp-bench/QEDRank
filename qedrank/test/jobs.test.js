import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { buildRunArgv, JobManager } from '../lib/jobs.js';
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
