// Lean toolchain detection and sandboxed compilation.
//
// Every compile runs the pinned toolchain from lean/ (via `lake env`) on a
// single file inside a scratch root, with a wall-clock timeout, a memory cap
// and a heartbeat cap. The linked corpus' own lakefiles are never executed:
// reference files are copied into a scratch root and compiled with our
// project's LEAN_PATH, exactly like model outputs.

import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { nowMono, isoNow, ensureDir, writeText, readJson, exists, sha256 } from './util.js';

const execFileP = promisify(execFile);

export const INFRA_PATTERNS = [
  /object file .*\bMathlib\b.* does not exist/i,
  /object file .*\bQEDRank[\\/](Prelude|Audit)\b.* does not exist/i,
  /unknown package/i,
  /failed to load dynamic library/i,
  /could not find native implementation/i,
];

/**
 * Inspect the pinned Lean project. Never throws: `available=false` with a
 * reason means every compile will be recorded as infrastructure_failure.
 */
export async function detectToolchain(leanDir, { log = () => {} } = {}) {
  const info = {
    lean_dir: path.resolve(leanDir),
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
    detected_at: isoNow(),
  };
  try {
    info.toolchain = (await fs.readFile(path.join(info.lean_dir, 'lean-toolchain'), 'utf8')).trim();
  } catch (err) {
    info.reason = `lean-toolchain not readable: ${err.message}`;
    return info;
  }
  const manifest = await readJson(path.join(info.lean_dir, 'lake-manifest.json'), null);
  if (manifest && Array.isArray(manifest.packages)) {
    const m = manifest.packages.find((p) => p.name === 'mathlib');
    if (m) info.mathlib = { rev: m.rev || null, input_rev: m.inputRev || null, url: m.url || null };
  }
  if (!info.mathlib) info.mathlib = { rev: null, input_rev: null, url: null, note: 'lake-manifest.json missing or without mathlib; run `lake update` in lean/' };
  let envText;
  try {
    const { stdout } = await execFileP('lake', ['env'], { cwd: info.lean_dir, timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    envText = stdout;
  } catch (err) {
    info.reason = `lake env failed: ${err.message}`;
    return info;
  }
  const env = {};
  for (const line of envText.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  info.lean_exe = env.LEAN || null;
  info.lean_path = env.LEAN_PATH || null;
  info.sysroot = env.LEAN_SYSROOT || null;
  info.path_env = env.PATH || env.Path || null;
  if (!info.lean_exe || !info.lean_path) {
    info.reason = 'lake env did not report LEAN / LEAN_PATH';
    return info;
  }
  try {
    const { stdout } = await execFileP(info.lean_exe, ['--version'], { timeout: 60000, windowsHide: true });
    info.lean_version = stdout.trim();
  } catch (err) {
    info.reason = `lean --version failed: ${err.message}`;
    return info;
  }
  const libDirs = info.lean_path.split(path.delimiter);
  for (const d of libDirs) {
    if (await exists(path.join(d, 'Mathlib.olean'))) info.mathlib_built = true;
    if (await exists(path.join(d, 'QEDRank', 'Audit.olean'))) info.audit_built = true;
  }
  info.available = true;
  if (!info.mathlib_built) info.reason = 'Mathlib.olean not found on LEAN_PATH; run `lake exe cache get && lake build` in lean/. Files importing Mathlib will fail as infrastructure_failure.';
  else if (!info.audit_built) info.reason = 'QEDRank.Audit not built; run `lake build` in lean/. Statement comparison and axiom audits will be infrastructure_failure.';
  log(`lean: ${info.lean_version}; mathlib ${info.mathlib.rev || 'unknown'}; built=${info.mathlib_built}; audit=${info.audit_built}`);
  return info;
}

/** Parse `lean --json` output lines into message objects. */
export function parseJsonMessages(stdout) {
  const messages = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const m = JSON.parse(t);
      messages.push({
        severity: m.severity || 'info',
        line: m.pos?.line ?? null,
        column: m.pos?.column ?? null,
        file: m.fileName || null,
        text: typeof m.data === 'string' ? m.data : JSON.stringify(m.data),
      });
    } catch {
      /* non-JSON noise */
    }
  }
  return messages;
}

/** Parse a `QR_TAG key=value key=[a,b]` line. */
export function parseQrLine(text) {
  const t = text.trim();
  if (!t.startsWith('QR_')) return null;
  const sp = t.indexOf(' ');
  const tag = sp === -1 ? t : t.slice(0, sp);
  const rest = sp === -1 ? '' : t.slice(sp + 1);
  const fields = {};
  const re = /([A-Za-z_]+)=(\[[^\]]*\]|\S+)/g;
  let m;
  while ((m = re.exec(rest))) {
    const [, k, raw] = m;
    let v = raw;
    if (raw.startsWith('[')) v = raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else if (raw === 'true') v = true;
    else if (raw === 'false') v = false;
    else if (/^-?\d+$/.test(raw)) v = Number(raw);
    fields[k] = v;
  }
  return { tag, fields };
}

export class LeanRunner {
  /**
   * @param {object} toolchain result of detectToolchain
   * @param {{timeoutMs?:number, memoryMb?:number, maxHeartbeats?:number, log?:Function}} opts
   */
  constructor(toolchain, { timeoutMs = 600000, memoryMb = 8192, maxHeartbeats = 400000, log = () => {} } = {}) {
    this.tc = toolchain;
    this.timeoutMs = timeoutMs;
    this.memoryMb = memoryMb;
    this.maxHeartbeats = maxHeartbeats;
    this.log = log;
  }

  limits() {
    return { timeout_ms: this.timeoutMs, memory_mb: this.memoryMb, max_heartbeats: this.maxHeartbeats };
  }

  /**
   * Run `lean` on one file. Returns a result record; never throws.
   * @param {{file:string, cwd:string, extraLeanPath?:string[], olean?:string, ilean?:string, label?:string}} opts
   */
  async runLean({ file, cwd, extraLeanPath = [], olean = null, ilean = null, label = null }) {
    const started = { iso: isoNow(), mono: nowMono() };
    const result = {
      label,
      file,
      status: 'not_attempted',
      exit_code: null,
      timed_out: false,
      duration_ms: null,
      messages: [],
      error_count: 0,
      warning_count: 0,
      stdout_tail: '',
      stderr_tail: '',
      started_at: started.iso,
      ended_at: null,
      limits: this.limits(),
      lean_version: this.tc.lean_version,
      infra_reason: null,
    };
    if (!this.tc.available) {
      result.status = 'infrastructure_failure';
      result.infra_reason = this.tc.reason || 'toolchain unavailable';
      result.ended_at = isoNow();
      result.duration_ms = 0;
      return result;
    }
    const args = ['--json', `-M${this.memoryMb}`, `-DmaxHeartbeats=${this.maxHeartbeats}`];
    if (olean) args.push('-o', olean);
    if (ilean) args.push('-i', ilean);
    args.push(file);
    const leanPath = [...extraLeanPath, this.tc.lean_path].filter(Boolean).join(path.delimiter);
    const env = { ...process.env, LEAN_PATH: leanPath, LEAN_SYSROOT: this.tc.sysroot || '' };
    if (this.tc.path_env) env.PATH = this.tc.path_env;
    // Never leak provider credentials into the compiler subprocess.
    for (const k of Object.keys(env)) if (/_API_KEY$|^GITHUB_TOKEN$/.test(k)) delete env[k];

    const { code, stdout, stderr, timedOut, spawnError } = await new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      let proc;
      try {
        proc = spawn(this.tc.lean_exe, args, { cwd, env, windowsHide: true });
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: e });
        return;
      }
      const timer = setTimeout(() => {
        if (done) return;
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        setTimeout(() => { if (!done) { done = true; resolve({ code: null, stdout: out, stderr: err, timedOut: true, spawnError: null }); } }, 2000);
      }, this.timeoutMs);
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: null, stdout: out, stderr: err, timedOut: false, spawnError: e }); } });
      proc.on('close', (c, signal) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err, timedOut: signal === 'SIGKILL' && c === null, spawnError: null });
      });
    });

    result.duration_ms = nowMono() - started.mono;
    result.ended_at = isoNow();
    result.exit_code = code;
    result.messages = parseJsonMessages(stdout);
    result.error_count = result.messages.filter((m) => m.severity === 'error').length;
    result.warning_count = result.messages.filter((m) => m.severity === 'warning').length;
    result.stdout_tail = stdout.slice(-4000);
    result.stderr_tail = stderr.slice(-4000);
    if (spawnError) {
      result.status = 'infrastructure_failure';
      result.infra_reason = `spawn failed: ${spawnError.message}`;
    } else if (timedOut) {
      result.status = 'timeout';
    } else if (code === 0) {
      result.status = 'compiler_success';
    } else {
      const infra = result.messages.some((m) => INFRA_PATTERNS.some((re) => re.test(m.text))) || INFRA_PATTERNS.some((re) => re.test(stderr));
      if (infra) {
        result.status = 'infrastructure_failure';
        result.infra_reason = 'missing build artifacts or toolchain fault (see messages)';
      } else if (result.error_count === 0 && /out of memory|memory limit|std::bad_alloc/i.test(stderr + stdout)) {
        result.status = 'compiler_failure';
        result.resource_limit = 'memory';
      } else if (result.error_count === 0) {
        result.status = 'infrastructure_failure';
        result.infra_reason = `lean exited ${code} without diagnostics`;
      } else {
        result.status = 'compiler_failure';
      }
    }
    return result;
  }

  /**
   * Write `src` as `<scratchDir>/<moduleName>.lean` and compile it to an .olean in place
   * so later scripts can `import <moduleName>` with scratchDir on LEAN_PATH.
   */
  async compileModule({ src, moduleName, scratchDir, extraLeanPath = [], label = null }) {
    await ensureDir(scratchDir);
    const file = path.join(scratchDir, `${moduleName}.lean`);
    await writeText(file, src);
    const olean = path.join(scratchDir, `${moduleName}.olean`);
    const ilean = path.join(scratchDir, `${moduleName}.ilean`);
    const r = await this.runLean({ file, cwd: scratchDir, extraLeanPath: [scratchDir, ...extraLeanPath], olean, ilean, label: label || moduleName });
    r.module = moduleName;
    r.src_sha256 = sha256(src);
    r.olean = r.status === 'compiler_success' ? olean : null;
    return r;
  }

  /** Run an evaluator script (no .olean) and collect its QR_ records. */
  async runScript({ src, name, scratchDir, extraLeanPath = [], label = null }) {
    await ensureDir(scratchDir);
    const file = path.join(scratchDir, `${name}.lean`);
    await writeText(file, src);
    const r = await this.runLean({ file, cwd: scratchDir, extraLeanPath: [scratchDir, ...extraLeanPath], label: label || name });
    r.qr = r.messages.map((m) => parseQrLine(m.text)).filter(Boolean);
    r.qr_errors = r.messages.filter((m) => m.severity === 'error' && /QR_ERROR/.test(m.text)).map((m) => m.text);
    return r;
  }
}
