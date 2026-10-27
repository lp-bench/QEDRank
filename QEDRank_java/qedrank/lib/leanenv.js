// Lean environments: where the pinned Lean project lives and how `lean` is executed.
//
//   host       a built project directory on this machine (`lake env` + lean, as before)
//   docker     the project inside an image built by `node qedrank/cli.js lean-env build`; one
//              `docker run --rm` per Lean process, the run folders bind-mounted read-write
//   apptainer  the same image as a .sif for HPC nodes without root or Docker
//
// `verification.backend` in the config (or --backend) is one of auto | host | docker | apptainer;
// `auto` takes the first usable one in that order, so a machine with a built project behaves
// exactly as it did. The grader, the statistics and the page never see the difference: a
// LeanRunner bound to a container environment maps the host paths of the files it compiles to
// their paths inside the container and wraps every process in the container command.
//
// The image is benchmark-neutral: one Dockerfile (lean-env/Dockerfile) builds whatever Lean
// project it is pointed at (toolchain from its lean-toolchain, Mathlib from the cache when the
// project depends on it, everything else from source) and records the project's commit in
// /project/.qedrank-lean-env.json. The evaluator module QEDRank.Audit is not part of the image:
// grade.js compiles it on first use into runs/.grade-cache, which is mounted.

import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { detectToolchain, parseLeanOptions } from './lean.js';
import { exists, isoNow } from './util.js';

const execFileP = promisify(execFile);

export const BACKENDS = ['auto', 'host', 'docker', 'apptainer'];
export const CONTAINER_PROJECT = '/project';
export const DEFAULT_IMAGE = 'qedrank-lean:latest';
export const LEAN_ENV_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lean-env');

/** `lean-cli` was the only backend before containers existed; it is the host. */
export function normalizeBackend(b) {
  if (b === undefined || b === null || b === '' || b === 'lean-cli') return 'host';
  if (!BACKENDS.includes(b)) throw new Error(`unknown Lean backend ${b} (${BACKENDS.join(' | ')})`);
  return b;
}

/** The verification settings with defaults filled in. */
export function verificationSettings(config = {}) {
  const v = config.verification || {};
  return {
    backend: v.backend === undefined ? 'auto' : v.backend,
    image: v.image || DEFAULT_IMAGE,
    sif: v.sif ? path.resolve(v.sif) : null,
    mounts: v.mounts || null,
    dockerArgs: Array.isArray(v.dockerArgs) ? v.dockerArgs : [],
    apptainerArgs: Array.isArray(v.apptainerArgs) ? v.apptainerArgs : [],
  };
}

/**
 * Host directories a container sees, and where. The run folders (and runs/.grade-cache) are the
 * working trees of every compile; the system temp directory covers `grade --scratch`, lean-bench
 * and the harness re-grader. `verification.mounts` adds more ("host:container" or {host, container}).
 */
export function containerMounts(config = {}) {
  const v = verificationSettings(config);
  const out = [];
  for (const m of v.mounts || []) {
    if (typeof m === 'string') {
      const i = m.lastIndexOf(':');
      if (i <= 0) throw new Error(`verification.mounts entry "${m}" is not host:container`);
      out.push({ host: path.resolve(m.slice(0, i)), container: m.slice(i + 1) });
    } else if (m && m.host && m.container) out.push({ host: path.resolve(m.host), container: m.container });
  }
  out.push({ host: path.resolve(config.runsDir || 'runs'), container: '/work' });
  out.push({ host: path.resolve(os.tmpdir()), container: '/work-tmp' });
  return out;
}

/** A host path as the container sees it, or an error naming the mounted roots. */
export function mapHostPath(mounts, hostPath) {
  const abs = path.resolve(hostPath);
  for (const m of mounts) {
    const rel = path.relative(m.host, abs);
    if (rel === '') return m.container;
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.posix.join(m.container, ...rel.split(path.sep));
  }
  throw new Error(`${abs} is outside the directories mounted into the Lean container (${mounts.map((m) => m.host).join(', ')}); put it under runs/ or add verification.mounts`);
}

/**
 * The host command that runs `exe args` inside the environment.
 * @param {{kind:'docker'|'apptainer', image?:string, sif?:string, mounts:object[], extraArgs?:string[]}} env
 */
export function containerInvocation(env, { exe, args = [], cwd = CONTAINER_PROJECT, envVars = {}, name = null, stdin = false }) {
  const vars = Object.entries(envVars).filter(([, v]) => v !== undefined && v !== null);
  if (env.kind === 'docker') {
    const a = ['run', '--rm', '--network', 'none'];
    if (stdin) a.push('-i'); // keep stdin open for the process (lists too long for a command line)
    if (name) a.push('--name', name);
    for (const m of env.mounts) a.push('-v', `${m.host}:${m.container}`);
    a.push('-w', cwd);
    for (const [k, v] of vars) a.push('-e', `${k}=${v}`);
    a.push(...(env.extraArgs || []), env.image, exe, ...args);
    return { exe: 'docker', args: a };
  }
  if (env.kind === 'apptainer') {
    const a = ['exec', '--containall', '--cleanenv'];
    for (const m of env.mounts) a.push('--bind', `${m.host}:${m.container}`);
    a.push('--pwd', cwd);
    for (const [k, v] of vars) a.push('--env', `${k}=${v}`);
    a.push(...(env.extraArgs || []), env.sif, exe, ...args);
    return { exe: 'apptainer', args: a };
  }
  throw new Error(`not a container environment: ${env.kind}`);
}

// --- probing the project inside an image -------------------------------------------------------

/** Printed by the image, parsed by parseProbe. `lake env` with a command runs it in the project's environment. */
export const PROBE_SCRIPT = [
  `cd ${CONTAINER_PROJECT} || { echo '---QR:ERROR---'; echo "no ${CONTAINER_PROJECT} in the image"; exit 3; }`,
  "echo '---QR:TOOLCHAIN---'; cat lean-toolchain 2>/dev/null",
  "echo '---QR:MANIFEST---'; cat lake-manifest.json 2>/dev/null",
  "echo '---QR:LAKEFILE---'; cat lakefile.toml 2>/dev/null",
  "echo '---QR:ENV---'; lake env sh -c 'printf \"LEAN=%s\\nLEAN_PATH=%s\\nLEAN_SYSROOT=%s\\n\" \"$LEAN\" \"$LEAN_PATH\" \"$LEAN_SYSROOT\"' || echo '---QR:ERROR---'",
  "echo '---QR:VERSION---'; lake env sh -c '\"$LEAN\" --version' 2>/dev/null",
  "echo '---QR:FLAGS---'; lake env sh -c 'IFS=:; for d in $LEAN_PATH; do [ -e \"$d/Mathlib.olean\" ] && echo mathlib_built; [ -e \"$d/QEDRank/Audit.olean\" ] && echo audit_built; done; true' 2>/dev/null",
  "echo '---QR:IMAGEINFO---'; cat .qedrank-lean-env.json 2>/dev/null",
  "echo '---QR:WARNINGS---'; cat .qedrank-build-warnings.txt 2>/dev/null",
  "echo '---QR:END---'",
].join('\n');

/** Sections of the probe output, keyed by name. */
export function parseProbe(stdout) {
  const sections = {};
  let current = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^---QR:([A-Z]+)---$/.exec(line.trim());
    if (m) { current = m[1]; if (!(current in sections)) sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const text = (k) => (sections[k] || []).join('\n').trim();
  const env = {};
  for (const line of sections.ENV || []) { const i = line.indexOf('='); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1); }
  let manifest = null;
  try { manifest = text('MANIFEST') ? JSON.parse(text('MANIFEST')) : null; } catch { manifest = null; }
  let imageInfo = null;
  try { imageInfo = text('IMAGEINFO') ? JSON.parse(text('IMAGEINFO')) : null; } catch { imageInfo = null; }
  const flags = new Set((sections.FLAGS || []).map((s) => s.trim()).filter(Boolean));
  return {
    complete: 'END' in sections,
    error: 'ERROR' in sections ? text('ERROR') || 'probe failed' : null,
    toolchain: text('TOOLCHAIN') || null,
    env,
    lean_version: text('VERSION') || null,
    lakefile: text('LAKEFILE'),
    manifest,
    mathlib_built: flags.has('mathlib_built'),
    audit_built: flags.has('audit_built'),
    image_info: imageInfo,
    build_warnings: (sections.WARNINGS || []).map((s) => s.trim()).filter(Boolean),
  };
}

/** `execFile` as a promise that never rejects: { ok, stdout, stderr, error }. */
async function run(exe, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(exe, args, { timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts });
    return { ok: true, stdout: String(stdout), stderr: String(stderr), error: null };
  } catch (err) {
    return { ok: false, stdout: String(err.stdout || ''), stderr: String(err.stderr || ''), error: err };
  }
}

function toolchainShell(kind, settings) {
  return {
    lean_dir: CONTAINER_PROJECT,
    available: false,
    reason: null,
    toolchain: null,
    lean_version: null,
    lean_exe: null,
    lean_path: null,
    sysroot: null,
    path_env: null,
    mathlib: null,
    mathlib_built: false,
    audit_built: false,
    lean_options: [],
    detected_at: isoNow(),
    environment: { kind, image: kind === 'docker' ? settings.image : null, image_id: null, sif: kind === 'apptainer' ? settings.sif : null, sif_bytes: null, mounts: [], project: CONTAINER_PROJECT, image_info: null },
  };
}

/** Is Docker usable here, and is the image present? Never throws. */
export async function detectDocker({ image }, { exec = run } = {}) {
  const out = { binary: 'docker', usable: false, reason: null, server_version: null, image, image_id: null, image_present: false };
  const v = await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 20000 });
  if (!v.ok) {
    const msg = (v.stderr || v.error?.message || '').trim().split('\n')[0];
    out.reason = /ENOENT|not found|not recognized/i.test(msg) ? 'docker not on PATH' : `docker daemon not reachable (${msg || 'docker version failed'})`;
    return out;
  }
  out.server_version = v.stdout.trim();
  const i = await exec('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 20000 });
  if (!i.ok) { out.reason = `image ${image} not found; build it with: node qedrank/cli.js lean-env build --project <lean project> --tag ${image}`; return out; }
  out.image_id = i.stdout.trim();
  out.image_present = true;
  out.usable = true;
  return out;
}

/** Is Apptainer usable here, and does the .sif exist? Never throws. */
export async function detectApptainer({ sif }, { exec = run } = {}) {
  const out = { binary: 'apptainer', usable: false, reason: null, version: null, sif, sif_present: false, sif_bytes: null };
  const v = await exec('apptainer', ['--version'], { timeout: 20000 });
  if (!v.ok) { out.reason = 'apptainer not on PATH'; return out; }
  out.version = v.stdout.trim();
  if (!sif) { out.reason = 'no .sif configured (verification.sif or --sif)'; return out; }
  try { out.sif_bytes = (await fs.stat(sif)).size; out.sif_present = true; } catch { out.reason = `${sif} not found; build it with: node qedrank/cli.js lean-env build --project <lean project> --apptainer --sif ${sif}`; return out; }
  out.usable = true;
  return out;
}

/**
 * Probe the project inside a container image and return what detectToolchain returns for a host
 * project, with `environment` describing the container. Never throws.
 */
export async function probeContainer(kind, config, { exec = run, log = () => {} } = {}) {
  const settings = verificationSettings(config);
  const info = toolchainShell(kind, settings);
  info.environment.mounts = containerMounts(config);
  const det = kind === 'docker' ? await detectDocker({ image: settings.image }, { exec }) : await detectApptainer({ sif: settings.sif }, { exec });
  if (kind === 'docker') info.environment.image_id = det.image_id;
  else info.environment.sif_bytes = det.sif_bytes;
  if (!det.usable) { info.reason = det.reason; return info; }
  const env = { kind, image: settings.image, sif: settings.sif, mounts: [], extraArgs: kind === 'docker' ? settings.dockerArgs : settings.apptainerArgs };
  const inv = containerInvocation(env, { exe: 'sh', args: ['-c', PROBE_SCRIPT], cwd: '/', name: null });
  const r = await exec(inv.exe, inv.args, { timeout: 180000 });
  const probe = parseProbe(r.stdout);
  if (!r.ok && !probe.complete) {
    info.reason = `probe of ${kind === 'docker' ? settings.image : settings.sif} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-1)[0] || 'no output'}`;
    return info;
  }
  if (probe.error) { info.reason = `probe: ${probe.error}`; return info; }
  info.toolchain = probe.toolchain;
  info.lean_exe = probe.env.LEAN || null;
  info.lean_path = probe.env.LEAN_PATH || null;
  info.sysroot = probe.env.LEAN_SYSROOT || null;
  info.lean_version = probe.lean_version;
  const m = probe.manifest?.packages?.find?.((p) => p.name === 'mathlib');
  info.mathlib = m ? { rev: m.rev || null, input_rev: m.inputRev || null, url: m.url || null } : { rev: null, input_rev: null, url: null, note: 'lake-manifest.json missing or without mathlib' };
  info.lean_options = parseLeanOptions(probe.lakefile || '');
  info.mathlib_built = probe.mathlib_built;
  info.audit_built = probe.audit_built;
  info.environment.image_info = probe.image_info;
  info.environment.build_warnings = probe.build_warnings;
  if (!info.lean_exe || !info.lean_path) { info.reason = 'lake env inside the image did not report LEAN / LEAN_PATH'; return info; }
  if (!info.lean_version) { info.reason = 'lean --version failed inside the image'; return info; }
  info.available = true;
  if (!info.mathlib_built && info.mathlib?.rev) info.reason = 'Mathlib.olean not found on the image LEAN_PATH; rebuild the image';
  else if (probe.build_warnings.length) info.reason = `${probe.build_warnings.length} module(s) of the project did not build in the image (see lean-env status); files importing them will be infrastructure failures`;
  log(`lean (${kind}${kind === 'docker' ? ` ${settings.image}` : ` ${path.basename(settings.sif)}`}): ${info.lean_version}; mathlib ${info.mathlib.rev || 'none'}; built=${info.mathlib_built}; project ${probe.image_info?.project?.commit?.slice(0, 10) || 'unknown commit'}`);
  return info;
}

async function hostToolchain(leanDir, { log }) {
  const tc = await detectToolchain(leanDir, { log });
  tc.environment = { kind: 'host' };
  return tc;
}

/**
 * The toolchain (what LeanRunner takes) of the configured backend. `auto` = host if its project is
 * usable, else docker, else apptainer; when nothing is usable the host answer is returned with the
 * other candidates' reasons, so a run degrades exactly as an unbuilt project did before.
 */
export async function selectToolchain(config, { leanDir, log = () => {}, backend = null, probes = {} } = {}) {
  const settings = verificationSettings(config);
  const requested = normalizeBackend(backend || settings.backend);
  const host = probes.host || hostToolchain;
  const container = probes.container || probeContainer;
  const dir = leanDir || config.leanDir || 'lean';
  if (requested === 'host') return withBackend(await host(dir, { log }), requested);
  if (requested !== 'auto') return withBackend(await container(requested, config, { log }), requested);
  const h = await host(dir, { log: () => {} });
  if (h.available) { log(`lean (host): ${h.lean_version}; mathlib ${h.mathlib?.rev || 'unknown'}; built=${h.mathlib_built}; audit=${h.audit_built}`); return withBackend(h, requested); }
  const candidates = { host: h.reason };
  for (const kind of ['docker', 'apptainer']) {
    const c = await container(kind, config, { log });
    if (c.available) { c.environment.auto_candidates = candidates; return withBackend(c, requested); }
    candidates[kind] = c.reason;
  }
  h.environment.auto_candidates = candidates;
  h.reason = `no usable Lean environment: host: ${candidates.host}; docker: ${candidates.docker}; apptainer: ${candidates.apptainer}`;
  return withBackend(h, requested);
}

function withBackend(tc, requested) {
  tc.environment = { ...(tc.environment || { kind: 'host' }), backend_requested: requested };
  return tc;
}

/** The environment as stored in run.json (no mount internals beyond the host roots). */
export function environmentRecord(tc) {
  const e = tc?.environment || { kind: 'host' };
  const rec = { kind: e.kind, backend_requested: e.backend_requested || null };
  if (e.kind === 'docker') Object.assign(rec, { image: e.image || null, image_id: e.image_id || null });
  if (e.kind === 'apptainer') Object.assign(rec, { sif: e.sif || null, sif_bytes: e.sif_bytes ?? null });
  if (e.kind !== 'host') {
    rec.project = e.project || CONTAINER_PROJECT;
    rec.mounts = (e.mounts || []).map((m) => `${m.host}:${m.container}`);
    rec.image_info = e.image_info ? { built_at: e.image_info.built_at || null, tag: e.image_info.tag || null, project: e.image_info.project || null } : null;
  }
  if (e.auto_candidates) rec.auto_candidates = e.auto_candidates;
  return rec;
}

/** Every backend with what this machine has of it (for `lean-env status` and the page). */
export async function describeEnvironments(config, { leanDir, log = () => {} } = {}) {
  const settings = verificationSettings(config);
  const dir = leanDir || config.leanDir || 'lean';
  const host = await hostToolchain(dir, { log: () => {} });
  const docker = await probeContainer('docker', config, { log: () => {} });
  const apptainer = await probeContainer('apptainer', config, { log: () => {} });
  const summary = (tc) => ({ usable: tc.available, reason: tc.reason, toolchain: tc.toolchain, lean_version: tc.lean_version, mathlib: tc.mathlib?.rev || null, mathlib_built: tc.mathlib_built, audit_built: tc.audit_built, lean_options: tc.lean_options });
  const order = ['host', 'docker', 'apptainer'];
  const usable = { host: host.available, docker: docker.available, apptainer: apptainer.available };
  const requested = normalizeBackend(settings.backend);
  const selected = requested === 'auto' ? order.find((k) => usable[k]) || null : usable[requested] ? requested : null;
  return {
    backend_requested: requested,
    selected,
    mounts: containerMounts(config),
    host: { ...summary(host), lean_project: host.lean_dir },
    docker: { ...summary(docker), image: settings.image, image_id: docker.environment.image_id, image_info: docker.environment.image_info, build_warnings: docker.environment.build_warnings || [] },
    apptainer: { ...summary(apptainer), sif: settings.sif, sif_bytes: apptainer.environment.sif_bytes, image_info: apptainer.environment.image_info, build_warnings: apptainer.environment.build_warnings || [] },
  };
}

// --- building the image ---------------------------------------------------------------------

async function gitInfo(dir) {
  const g = async (args) => { const r = await run('git', ['-C', dir, ...args], { timeout: 30000 }); return r.ok ? r.stdout.trim() : null; };
  const commit = await g(['rev-parse', 'HEAD']);
  if (!commit) return { commit: null, dirty: null, remote: null };
  const status = await g(['status', '--porcelain', '--untracked-files=no']);
  return { commit, dirty: status === null ? null : status.length > 0, remote: await g(['remote', 'get-url', 'origin']) };
}

/** Spawn with the output streamed to `log`; resolves with the exit code. */
function stream(exe, args, { log, stdin = null, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1); if (line) log(line); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => { if (buf.trim()) log(buf.trim()); resolve(code); });
    if (stdin) { stdin.on('error', reject); stdin.pipe(child.stdin); }
  });
}

/**
 * Build the image for one Lean project: tar the project without .lake and .git, stream it as the
 * build context, record the project's git state in the image. With `apptainer`, also produce the
 * .sif (here when Apptainer is installed, otherwise a docker-archive tar with the command to run
 * on the cluster). Returns what was built; throws on failure.
 */
export async function buildImage({ project, tag = DEFAULT_IMAGE, modules = [], apptainer = false, sif = null, noCache = false, platform = null, dockerfile = path.join(LEAN_ENV_DIR, 'Dockerfile'), log = () => {} }) {
  const dir = path.resolve(project);
  if (!(await exists(path.join(dir, 'lean-toolchain')))) throw new Error(`${dir} has no lean-toolchain; --project must be a Lean project directory`);
  if (!(await exists(dockerfile))) throw new Error(`Dockerfile not found: ${dockerfile}`);
  const git = await gitInfo(dir);
  if (git.dirty) log(`note: ${dir} has uncommitted changes; the image is built from the working tree and marked dirty`);
  const manifest = {
    schema: 'qedrank-lean-env-v1',
    built_at: isoNow(),
    tag,
    project: { dir, commit: git.commit, dirty: git.dirty, remote: git.remote, toolchain: (await fs.readFile(path.join(dir, 'lean-toolchain'), 'utf8')).trim() },
    modules: modules.length ? modules : 'all libraries',
    qedrank: await gitInfo(path.resolve(LEAN_ENV_DIR, '..')),
    builder: { platform: os.platform(), node: process.version },
  };
  // Build context, as a tar on stdin: the project's sources under project/ (`.lake` is the build
  // output the image recreates, gigabytes; `.git` is recorded in the manifest instead) and the
  // Dockerfile with its helper under qedrank/, so the project layers change only with the project.
  const stage = path.join(os.tmpdir(), `qedrank-lean-env-${process.pid}-${Date.now()}`);
  const ctx = `${stage}.tar`;
  const skip = new Set(['.lake', '.git', '.qedrank-lean-env.json', '.qedrank-build-warnings.txt']);
  await fs.cp(dir, path.join(stage, 'project'), { recursive: true, filter: (src) => !skip.has(path.basename(src)) || path.resolve(src) === dir });
  await fs.mkdir(path.join(stage, 'qedrank'), { recursive: true });
  await fs.copyFile(dockerfile, path.join(stage, 'qedrank', 'Dockerfile'));
  await fs.copyFile(path.join(path.dirname(dockerfile), 'build-modules.sh'), path.join(stage, 'qedrank', 'build-modules.sh'));
  let code = await stream('tar', ['-cf', ctx, '-C', stage, '.'], { log: (l) => log(`tar: ${l}`) });
  await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  if (code !== 0) throw new Error(`tar exited ${code} while packing ${dir}`);
  try {
    const args = ['build', '-t', tag, '-f', 'qedrank/Dockerfile', '--build-arg', `QEDRANK_LEAN_ENV_MANIFEST=${JSON.stringify(manifest)}`, '--build-arg', `LEAN_MODULES=${modules.join(' ')}`];
    if (noCache) args.push('--no-cache');
    if (platform) args.push('--platform', platform);
    args.push('-');
    log(`docker ${args.slice(0, -1).join(' ')} - < ${path.basename(ctx)}  (project ${git.commit ? git.commit.slice(0, 10) : 'no git'}${git.dirty ? ', dirty' : ''})`);
    code = await stream('docker', args, { log: (l) => log(`docker: ${l}`), stdin: createReadStream(ctx), env: { ...process.env, DOCKER_BUILDKIT: '1' } });
    if (code !== 0) throw new Error(`docker build exited ${code}`);
  } finally {
    await fs.rm(ctx, { force: true }).catch(() => {});
  }
  const inspect = await run('docker', ['image', 'inspect', tag, '--format', '{{.Id}} {{.Size}}']);
  const [imageId, size] = inspect.ok ? inspect.stdout.trim().split(' ') : [null, null];
  const result = { tag, image_id: imageId, size_bytes: size ? Number(size) : null, manifest, sif: null, sif_archive: null, next: null };
  log(`image ${tag} ${imageId ? imageId.slice(0, 19) : ''}${size ? ` (${(Number(size) / 1073741824).toFixed(1)} GB)` : ''}`);
  if (!apptainer) return result;
  const sifPath = path.resolve(sif || path.join(LEAN_ENV_DIR, `${tag.replace(/[^A-Za-z0-9_.-]+/g, '-')}.sif`));
  const have = await run('apptainer', ['--version'], { timeout: 20000 });
  if (have.ok) {
    code = await stream('apptainer', ['build', '--force', sifPath, `docker-daemon://${tag}`], { log: (l) => log(`apptainer: ${l}`) });
    if (code !== 0) throw new Error(`apptainer build exited ${code}`);
    result.sif = sifPath;
    log(`sif ${sifPath}`);
  } else {
    const archive = sifPath.replace(/\.sif$/i, '') + '.docker.tar';
    code = await stream('docker', ['save', '-o', archive, tag], { log: (l) => log(`docker: ${l}`) });
    if (code !== 0) throw new Error(`docker save exited ${code}`);
    result.sif_archive = archive;
    result.next = `apptainer is not installed here; copy ${archive} to the cluster and run: apptainer build ${path.basename(sifPath)} docker-archive://${path.basename(archive)}`;
    log(result.next);
  }
  return result;
}
