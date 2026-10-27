import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  normalizeBackend, verificationSettings, containerMounts, mapHostPath, containerInvocation, parseProbe, PROBE_SCRIPT,
  detectDocker, detectApptainer, probeContainer, selectToolchain, environmentRecord, CONTAINER_PROJECT,
} from '../lib/leanenv.js';
import { LeanRunner } from '../lib/lean.js';
import { checkChallengeImports } from '../lib/preflight.js';

const RUNS = path.resolve('runs');
const config = { runsDir: RUNS, verification: { backend: 'docker', image: 'qedrank-lean:test', sif: null } };

test('backend names: lean-cli is the host, unknown names are refused', () => {
  assert.equal(normalizeBackend(undefined), 'host');
  assert.equal(normalizeBackend('lean-cli'), 'host');
  assert.equal(normalizeBackend('auto'), 'auto');
  assert.throws(() => normalizeBackend('podman'), /unknown Lean backend podman/);
  assert.equal(verificationSettings({}).backend, 'auto');
  assert.equal(verificationSettings({}).image, 'qedrank-lean:latest');
});

test('mounts: runs/ and the temp directory always, extra ones first; paths map or are refused', () => {
  const mounts = containerMounts({ runsDir: RUNS, verification: { mounts: ['/data/corpus:/corpus', { host: '/scratch', container: '/scr' }] } });
  assert.deepEqual(mounts.map((m) => m.container), ['/corpus', '/scr', '/work', '/work-tmp']);
  assert.equal(mounts[2].host, RUNS);
  assert.equal(mounts[3].host, path.resolve(os.tmpdir()));
  assert.equal(mapHostPath(mounts, path.join(RUNS, 'r1', 'items', 'x', 'a.lean')), '/work/r1/items/x/a.lean');
  assert.equal(mapHostPath(mounts, RUNS), '/work');
  assert.equal(mapHostPath(mounts, path.join(os.tmpdir(), 'qedrank-grade-abc', 'f.lean')), '/work-tmp/qedrank-grade-abc/f.lean');
  assert.throws(() => mapHostPath(mounts, path.resolve('/elsewhere/f.lean')), /outside the directories mounted/);
  assert.throws(() => containerMounts({ runsDir: RUNS, verification: { mounts: ['nocolon'] } }), /host:container/);
});

test('container invocation: docker run and apptainer exec with mounts, cwd and environment', () => {
  const mounts = [{ host: RUNS, container: '/work' }];
  const d = containerInvocation({ kind: 'docker', image: 'img:1', mounts, extraArgs: ['--memory', '16g'] }, { exe: '/opt/elan/bin/lean', args: ['--json', '/work/a.lean'], cwd: '/work', envVars: { LEAN_PATH: '/work:/project/.lake/build/lib/lean', LEAN_SYSROOT: '' }, name: 'qr-1' });
  assert.equal(d.exe, 'docker');
  assert.deepEqual(d.args, ['run', '--rm', '--network', 'none', '--name', 'qr-1', '-v', `${RUNS}:/work`, '-w', '/work', '-e', 'LEAN_PATH=/work:/project/.lake/build/lib/lean', '-e', 'LEAN_SYSROOT=', '--memory', '16g', 'img:1', '/opt/elan/bin/lean', '--json', '/work/a.lean']);
  const a = containerInvocation({ kind: 'apptainer', sif: '/img/x.sif', mounts }, { exe: 'sh', args: ['-c', 'true'], cwd: '/', envVars: { LEAN_PATH: '/p' } });
  assert.equal(a.exe, 'apptainer');
  assert.deepEqual(a.args, ['exec', '--containall', '--cleanenv', '--bind', `${RUNS}:/work`, '--pwd', '/', '--env', 'LEAN_PATH=/p', '/img/x.sif', 'sh', '-c', 'true']);
  assert.throws(() => containerInvocation({ kind: 'host' }, { exe: 'lean' }), /not a container environment/);
});

const PROBE_OUT = [
  '---QR:TOOLCHAIN---', 'leanprover/lean4:v4.33.1',
  '---QR:MANIFEST---', '{"version": "1.2.0", "packages": [{"name": "mathlib", "rev": "0df444a", "inputRev": "v4.33.1", "url": "https://github.com/leanprover-community/mathlib4"}]}',
  '---QR:LAKEFILE---', 'name = "p"', '[leanOptions]', 'relaxedAutoImplicit = false', 'maxSynthPendingDepth = 3',
  '---QR:ENV---', 'LEAN=/opt/elan/toolchains/x/bin/lean', 'LEAN_PATH=/project/.lake/build/lib/lean:/project/.lake/packages/mathlib/.lake/build/lib/lean', 'LEAN_SYSROOT=/opt/elan/toolchains/x',
  '---QR:VERSION---', 'Lean (version 4.33.1, x86_64-unknown-linux-gnu, commit abc, Release)',
  '---QR:FLAGS---', 'mathlib_built',
  '---QR:IMAGEINFO---', '{"schema":"qedrank-lean-env-v1","built_at":"2026-10-27T00:00:00Z","tag":"qedrank-lean:test","project":{"commit":"466b32a95dfb","dirty":false}}',
  '---QR:WARNINGS---',
  '---QR:END---', '',
].join('\n');

test('probe output parses into the toolchain fields', () => {
  const p = parseProbe(PROBE_OUT);
  assert.equal(p.complete, true);
  assert.equal(p.error, null);
  assert.equal(p.toolchain, 'leanprover/lean4:v4.33.1');
  assert.equal(p.env.LEAN, '/opt/elan/toolchains/x/bin/lean');
  assert.equal(p.manifest.packages[0].name, 'mathlib');
  assert.equal(p.mathlib_built, true);
  assert.equal(p.audit_built, false);
  assert.equal(p.image_info.project.commit, '466b32a95dfb');
  assert.deepEqual(p.build_warnings, []);
  assert.ok(PROBE_SCRIPT.includes(`cd ${CONTAINER_PROJECT}`));
  const warned = parseProbe(PROBE_OUT.replace('---QR:WARNINGS---\n', '---QR:WARNINGS---\nProofBench.Mathlib_Problems.Broken\n'));
  assert.deepEqual(warned.build_warnings, ['ProofBench.Mathlib_Problems.Broken']);
  const bad = parseProbe('---QR:ERROR---\nno /project in the image\n');
  assert.equal(bad.complete, false);
  assert.match(bad.error, /no \/project/);
});

/** A fake exec: answers by command prefix. */
function fakeExec(table) {
  return async (exe, args) => {
    for (const [prefix, answer] of table) {
      if (`${exe} ${args.join(' ')}`.startsWith(prefix)) return typeof answer === 'function' ? answer(exe, args) : answer;
    }
    return { ok: false, stdout: '', stderr: `${exe}: ENOENT`, error: new Error(`spawn ${exe} ENOENT`) };
  };
}

test('docker and apptainer detection report the reason when they are not usable', async () => {
  const down = await detectDocker({ image: 'qedrank-lean:test' }, { exec: fakeExec([['docker version', { ok: false, stdout: '', stderr: 'failed to connect to the docker API at npipe', error: new Error('x') }]]) });
  assert.equal(down.usable, false);
  assert.match(down.reason, /daemon not reachable/);
  const noImage = await detectDocker({ image: 'qedrank-lean:test' }, { exec: fakeExec([['docker version', { ok: true, stdout: '28.0.1\n', stderr: '' }], ['docker image inspect', { ok: false, stdout: '', stderr: 'No such image', error: new Error('x') }]]) });
  assert.equal(noImage.usable, false);
  assert.match(noImage.reason, /lean-env build/);
  const ok = await detectDocker({ image: 'qedrank-lean:test' }, { exec: fakeExec([['docker version', { ok: true, stdout: '28.0.1\n', stderr: '' }], ['docker image inspect', { ok: true, stdout: 'sha256:abc\n', stderr: '' }]]) });
  assert.deepEqual([ok.usable, ok.image_id, ok.server_version], [true, 'sha256:abc', '28.0.1']);
  const noApptainer = await detectApptainer({ sif: '/x.sif' }, { exec: fakeExec([]) });
  assert.equal(noApptainer.reason, 'apptainer not on PATH');
  const noSif = await detectApptainer({ sif: null }, { exec: fakeExec([['apptainer --version', { ok: true, stdout: 'apptainer version 1.3.0', stderr: '' }]]) });
  assert.match(noSif.reason, /no \.sif configured/);
});

test('probing the image yields a toolchain record that LeanRunner can use', async () => {
  const exec = fakeExec([
    ['docker version', { ok: true, stdout: '28.0.1', stderr: '' }],
    ['docker image inspect', { ok: true, stdout: 'sha256:abc', stderr: '' }],
    ['docker run', { ok: true, stdout: PROBE_OUT, stderr: '' }],
  ]);
  const tc = await probeContainer('docker', config, { exec });
  assert.equal(tc.available, true, tc.reason);
  assert.equal(tc.lean_dir, '/project');
  assert.equal(tc.lean_exe, '/opt/elan/toolchains/x/bin/lean');
  assert.equal(tc.mathlib.rev, '0df444a');
  assert.deepEqual(tc.lean_options, ['-DrelaxedAutoImplicit=false', '-DmaxSynthPendingDepth=3']);
  assert.equal(tc.environment.kind, 'docker');
  assert.equal(tc.environment.image_id, 'sha256:abc');
  assert.equal(tc.environment.mounts[0].container, '/work');
  const rec = environmentRecord({ ...tc, environment: { ...tc.environment, backend_requested: 'docker' } });
  assert.equal(rec.kind, 'docker');
  assert.equal(rec.image_info.project.commit, '466b32a95dfb');
  assert.ok(rec.mounts[0].endsWith(':/work'));
  assert.deepEqual(environmentRecord({ environment: { kind: 'host', backend_requested: 'auto' } }), { kind: 'host', backend_requested: 'auto' });

  const failing = await probeContainer('docker', config, { exec: fakeExec([['docker version', { ok: true, stdout: '28', stderr: '' }], ['docker image inspect', { ok: true, stdout: 'sha256:abc', stderr: '' }], ['docker run', { ok: false, stdout: '', stderr: 'docker: Error response from daemon: oops', error: new Error('x') }]]) });
  assert.equal(failing.available, false);
  assert.match(failing.reason, /probe of qedrank-lean:test failed: .*oops/);
  // An image whose module sweep left gaps is usable, with the gap stated.
  const gaps = await probeContainer('docker', config, { exec: fakeExec([['docker version', { ok: true, stdout: '28', stderr: '' }], ['docker image inspect', { ok: true, stdout: 'sha256:abc', stderr: '' }], ['docker run', { ok: true, stdout: PROBE_OUT.replace('---QR:WARNINGS---\n', '---QR:WARNINGS---\nProofBench.Mathlib_Problems.Broken\n'), stderr: '' }]]) });
  assert.equal(gaps.available, true);
  assert.match(gaps.reason, /1 module\(s\) of the project did not build/);
  assert.deepEqual(gaps.environment.build_warnings, ['ProofBench.Mathlib_Problems.Broken']);
});

test('auto picks the host project when it is built, else the first usable container, else explains', async () => {
  const hostOk = async () => ({ available: true, lean_version: 'Lean 4.34.1', mathlib: { rev: 'm' }, mathlib_built: true, audit_built: true, environment: { kind: 'host' } });
  const hostNo = async () => ({ available: false, reason: 'lake env failed', environment: { kind: 'host' } });
  const containers = (answers) => async (kind) => ({ available: Boolean(answers[kind]), reason: answers[kind] ? null : `${kind} missing`, environment: { kind, mounts: [] } });
  const auto = { runsDir: RUNS, verification: { backend: 'auto' } };
  let tc = await selectToolchain(auto, { leanDir: 'lean', probes: { host: hostOk, container: containers({ docker: true }) } });
  assert.deepEqual([tc.environment.kind, tc.environment.backend_requested], ['host', 'auto']);
  tc = await selectToolchain(auto, { leanDir: 'lean', probes: { host: hostNo, container: containers({ docker: false, apptainer: true }) } });
  assert.equal(tc.environment.kind, 'apptainer');
  assert.deepEqual(tc.environment.auto_candidates, { host: 'lake env failed', docker: 'docker missing' });
  tc = await selectToolchain(auto, { leanDir: 'lean', probes: { host: hostNo, container: containers({}) } });
  assert.equal(tc.available, false);
  assert.match(tc.reason, /no usable Lean environment: host: lake env failed; docker: docker missing; apptainer: apptainer missing/);
  tc = await selectToolchain({ runsDir: RUNS, verification: { backend: 'docker' } }, { probes: { host: hostOk, container: containers({ docker: false }) } });
  assert.deepEqual([tc.available, tc.environment.kind, tc.environment.backend_requested], [false, 'docker', 'docker']);
  tc = await selectToolchain({ runsDir: RUNS, verification: { backend: 'lean-cli' } }, { probes: { host: hostOk, container: containers({}) } });
  assert.deepEqual([tc.environment.kind, tc.environment.backend_requested], ['host', 'host']);
  await assert.rejects(selectToolchain({ runsDir: RUNS, verification: { backend: 'podman' } }, { probes: { host: hostOk } }), /unknown Lean backend/);
});

/** A spawn that records the command and answers like lean --json would. */
function fakeSpawn(record, { code = 0, stdout = '', stderr = '' } = {}) {
  return (exe, args, opts) => {
    record.push({ exe, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { on: () => {}, end: (data) => { record.at(-1).stdin = data === undefined ? null : String(data); } };
    proc.pid = 4242;
    proc.kill = () => {};
    setImmediate(() => { if (stdout) proc.stdout.emit('data', Buffer.from(stdout)); if (stderr) proc.stderr.emit('data', Buffer.from(stderr)); proc.emit('close', code, null); });
    return proc;
  };
}

const containerToolchain = {
  available: true, lean_dir: '/project', lean_exe: '/opt/elan/toolchains/x/bin/lean', lean_path: '/project/.lake/build/lib/lean:/mathlib/lib', sysroot: '/opt/elan/toolchains/x', lean_version: 'Lean 4.33.1',
  environment: { kind: 'docker', image: 'qedrank-lean:test', mounts: [{ host: RUNS, container: '/work' }, { host: path.resolve(os.tmpdir()), container: '/work-tmp' }] },
};

test('LeanRunner in a container: one docker run per compile, host paths mapped, no host environment inside', async () => {
  const calls = [];
  const runner = new LeanRunner(containerToolchain, { timeoutMs: 1000, spawnImpl: fakeSpawn(calls, { stdout: '{"severity":"error","pos":{"line":1,"column":0},"data":"unknown identifier"}\n', code: 1 }) });
  assert.equal(runner.isContainer(), true);
  const scratch = path.join(RUNS, 'unit-leanenv', 'scratch');
  const r = await runner.compileModule({ src: 'theorem t : True := trivial', moduleName: 'QRS_x', scratchDir: scratch, extraLeanPath: [path.join(RUNS, '.grade-cache', 'audit-1')] });
  assert.equal(r.status, 'compiler_failure');
  assert.equal(r.error_count, 1);
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.exe, 'docker');
  assert.equal(c.args[0], 'run');
  assert.ok(c.args.includes('--network') && c.args.includes('none'));
  assert.ok(c.args.includes(`${RUNS}:/work`));
  const w = c.args.indexOf('-w');
  assert.equal(c.args[w + 1], '/work/unit-leanenv/scratch');
  const envArg = c.args[c.args.indexOf('-e') + 1];
  assert.equal(envArg, 'LEAN_PATH=/work/unit-leanenv/scratch:/work/.grade-cache/audit-1:/project/.lake/build/lib/lean:/mathlib/lib');
  const img = c.args.indexOf('qedrank-lean:test');
  assert.deepEqual(c.args.slice(img + 1, img + 3), ['/opt/elan/toolchains/x/bin/lean', '--json']);
  assert.ok(c.args.includes('-o') && c.args[c.args.indexOf('-o') + 1] === '/work/unit-leanenv/scratch/QRS_x.olean');
  assert.equal(c.args.at(-1), '/work/unit-leanenv/scratch/QRS_x.lean');
  assert.equal(c.opts.cwd, undefined);
  assert.equal(c.opts.env.LEAN_PATH, undefined, 'the host process environment is not the container environment');
  assert.ok(!Object.keys(c.opts.env).some((k) => /_API_KEY$/.test(k)));
  await fs.rm(path.join(RUNS, 'unit-leanenv'), { recursive: true, force: true });

  // A file outside the mounted roots cannot be compiled, and says so instead of hanging.
  const outside = await runner.runLean({ file: path.resolve('/nowhere/f.lean'), cwd: path.resolve('/nowhere') });
  assert.equal(outside.status, 'infrastructure_failure');
  assert.match(outside.infra_reason, /outside the directories mounted/);
  assert.equal(calls.length, 1);

  // lake build is a host-only operation and is reported, not attempted.
  const lb = await runner.lakeBuild('QEDRank.Papers.P1', { cwd: '/project' });
  assert.equal(lb.status, 'infrastructure_failure');
  assert.match(lb.infra_reason, /not supported in a docker environment/);
  assert.equal(calls.length, 1);
});

test('LeanRunner on the host is unchanged: lean spawned directly with the project environment', async () => {
  const calls = [];
  const tc = { available: true, lean_dir: '/p', lean_exe: '/p/lean', lean_path: '/p/lib', sysroot: '/p', lean_version: 'Lean 4.34.1', path_env: null, environment: { kind: 'host' } };
  const runner = new LeanRunner(tc, { timeoutMs: 1000, spawnImpl: fakeSpawn(calls, { code: 0 }) });
  assert.equal(runner.isContainer(), false);
  const r = await runner.runLean({ file: path.join(RUNS, 'x.lean'), cwd: RUNS, extraLeanPath: [RUNS] });
  assert.equal(r.status, 'compiler_success');
  assert.equal(calls[0].exe, '/p/lean');
  assert.equal(calls[0].opts.cwd, RUNS);
  assert.equal(calls[0].opts.env.LEAN_PATH, [RUNS, '/p/lib'].join(path.delimiter));
});

test('existsMany and the import check use one sh call inside the container', async () => {
  const calls = [];
  const found = ['/project/.lake/build/lib/lean/ProofBench/Mathlib_Problems/A.olean', '/mathlib/lib/Mathlib/Tactic.olean', '/project/.lake/build/lib/lean/ProofBench'].join('\n');
  const runner = new LeanRunner(containerToolchain, { timeoutMs: 1000, spawnImpl: fakeSpawn(calls, { stdout: `${found}\n`, code: 0 }) });
  const challenge = (paper_id, imports) => ({ paper_id, src: `${imports.map((i) => `import ${i}`).join('\n')}\n\ntheorem t : True := by sorry\n` });
  const check = await checkChallengeImports({ challenges: [challenge('P001', ['ProofBench.Mathlib_Problems.A', 'Mathlib.Tactic']), challenge('P002', ['ProofBench.Mathlib_Problems.B'])], toolchain: containerToolchain, runner });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'docker');
  assert.ok(calls[0].args.includes('sh'));
  assert.ok(calls[0].args.includes('-i'), 'stdin kept open for the path list');
  assert.ok(!calls[0].args.some((a) => a.endsWith('.olean')), 'no path on the command line (Windows caps it at 32 KB)');
  assert.ok(calls[0].stdin.split('\n').includes('/project/.lake/build/lib/lean/ProofBench/Mathlib_Problems/B.olean'));
  assert.equal(check.modules, 3);
  assert.equal(check.available, 2);
  assert.deepEqual(check.missing, [{ module: 'ProofBench.Mathlib_Problems.B', papers: ['P002'] }]);
  assert.equal(check.fatal, false, 'the prefix exists, so a single missing module is not fatal');
  assert.equal(check.lean_project, '/project');
});
