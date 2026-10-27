// Start, watch and stop benchmark runs from the local run server, so the web page can do what
// the PowerShell command does. Only allow-listed commands with validated arguments are run,
// never a shell; the GitHub token comes from the environment or `gh auth token`, is passed to the
// child only, and never appears in a log or a response.

import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { PROVIDER_IDS } from '../../lib/providers.js';
import { TARGET_KINDS } from './schema.js';
import { ensureDir, isoNow } from './util.js';

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PAPER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SUBDIR_RE = /^[^\0<>:"|?*\\]{1,500}$/;
const GITHUB_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/.*)?$/;
export const TASKS = ['formalize', 'prove'];
/** Harnesses the page may start through `agent-run` (only the ones with a driver). */
export const AGENT_HARNESSES = ['proofbench'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** A run configuration is a file name under configs/ (never a path). */
const CONFIG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/;
/** Numeric budgets of an agent run: flag, lower and upper bound, integer or not. */
export const AGENT_LIMITS = Object.freeze({
  attempts: ['--attempts', 1, 16, true],
  sessions: ['--sessions', 1, 50, true],
  sessionOutputTokens: ['--session-output-tokens', 1000, 2000000, true],
  sessionTokens: ['--session-tokens', 1000, 50000000, true],
  sessionWorkingTime: ['--session-working-time', 60, 86400, true],
  noteTokens: ['--note-tokens', 100, 100000, true],
  maxTokens: ['--max-tokens', 256, 1000000, true],
  requestTimeout: ['--request-timeout', 10, 86400, true],
  attemptTimeout: ['--attempt-timeout', 10, 86400, true],
  timeLimit: ['--time-limit', 60, 7 * 86400, true],
  messageLimit: ['--message-limit', 2, 100000, true],
  maxSamples: ['--max-samples', 1, 64, true],
  maxCostUsd: ['--max-cost-usd', 0, 1000000, false],
});
const MAX_LOG = 2 * 1024 * 1024;

function listOf(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
}

/**
 * The run configurations under configs/: file name and the settings the page shows (never a
 * secret; the files hold generation, Lean and concurrency settings only).
 */
export async function listRunConfigs(dir) {
  const out = [];
  let names = [];
  try { names = (await fs.readdir(dir)).filter((f) => CONFIG_RE.test(f)).sort(); } catch { return out; }
  for (const file of names) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      const g = j.generation || {};
      out.push({
        file, path: `configs/${file}`, task: j.task ?? null,
        generation: { attempts: g.attempts ?? null, temperature: g.temperature ?? null, topP: g.topP ?? null, effort: g.effort ?? null, maxTokens: g.maxTokens ?? null, timeoutMs: g.timeoutMs ?? null, providerConcurrency: g.providerConcurrency ?? null, retries: g.retries ?? null },
        lean: j.lean ?? null, concurrency: j.concurrency ?? null,
      });
    } catch {
      out.push({ file, path: `configs/${file}`, error: 'not valid JSON' });
    }
  }
  return out;
}

/**
 * Validate a job request and build the CLI arguments. Throws with a plain message on anything
 * outside the allow-list. Returns { argv (after `node cli.js`), run_id, command, summary }.
 * `configs` (file names under configs/) restricts `config` to known files when given.
 */
export function buildRunArgv(req = {}, { configs = null } = {}) {
  const command = ['run', 'resume', 'agent-run'].includes(req.command) ? req.command : null;
  if (!command) throw new Error('command must be "run", "resume" or "agent-run"');
  const runId = String(req.runId || '').trim();
  if (!RUN_ID_RE.test(runId)) throw new Error('runId must be 1-80 characters: letters, digits, ".", "_", "-"');
  const argv = [command, '--run-id', runId];
  const models = listOf(req.models);
  const bad = models.filter((m) => !PROVIDER_IDS.includes(m));
  if (bad.length) throw new Error(`unknown model slot(s): ${bad.join(', ')}`);
  const targets = listOf(req.targets);
  const badT = targets.filter((t) => !TARGET_KINDS.includes(t));
  if (badT.length) throw new Error(`unknown target kind(s): ${badT.join(', ')}`);
  const papers = listOf(req.papers);
  const badP = papers.filter((p) => !PAPER_RE.test(p));
  if (badP.length) throw new Error(`invalid paper id(s): ${badP.join(', ')}`);
  if (command === 'run') {
    const repo = String(req.repo || '').trim();
    if (!GITHUB_RE.test(repo)) throw new Error('repo must be an https://github.com/<owner>/<repo>[/tree/...] link');
    argv.push('--repo', repo);
    if (req.ref !== undefined && req.ref !== null && String(req.ref).trim()) {
      const ref = String(req.ref).trim();
      if (!REF_RE.test(ref)) throw new Error('ref contains characters that are not allowed');
      argv.push('--ref', ref);
    }
    if (req.subdir !== undefined && req.subdir !== null && String(req.subdir).trim()) {
      const subdir = String(req.subdir).trim().replace(/^\/+|\/+$/g, '');
      if (!SUBDIR_RE.test(subdir) || subdir.includes('..')) throw new Error('subdir is not a valid folder path');
      argv.push('--subdir', subdir);
    }
    if (!models.length) throw new Error('at least one model is required');
    argv.push('--models', models.join(','));
    if (targets.length) argv.push('--targets', targets.join(','));
    if (papers.length) argv.push('--papers', papers.join(','));
    if (req.limit !== undefined && req.limit !== null && req.limit !== '') {
      const n = Number(req.limit);
      if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error('limit must be a whole number between 1 and 10000');
      argv.push('--limit', String(n));
    }
    const task = req.task ? String(req.task) : 'formalize';
    if (!TASKS.includes(task)) throw new Error(`task must be one of ${TASKS.join(', ')}`);
    if (task !== 'formalize') argv.push('--task', task);
    if (req.leanProject !== undefined && req.leanProject !== null && String(req.leanProject).trim()) {
      const lp = String(req.leanProject).trim();
      if (/[\0<>"|?*]/.test(lp) || lp.length > 500) throw new Error('leanProject is not a valid path');
      argv.push('--lean-project', lp);
    }
    for (const [key, flag] of [['attempts', '--attempts'], ['repairRounds', '--repair-rounds']]) {
      if (req[key] !== undefined && req[key] !== null && req[key] !== '') {
        const n = Number(req[key]);
        if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error(`${key} must be a whole number between 0 and 20`);
        argv.push(flag, String(n));
      }
    }
    // A run configuration (configs/*.json) and generation settings, as the CLI flags they become.
    if (req.config !== undefined && req.config !== null && req.config !== '') {
      const name = String(req.config).trim();
      if (!CONFIG_RE.test(name) || name.includes('..')) throw new Error('config must be the file name of a configs/*.json file');
      if (Array.isArray(configs) && !configs.includes(name)) throw new Error(`unknown run configuration ${name}; the run server lists the files under configs/`);
      argv.push('--config', `configs/${name}`);
    }
    const num = (key, flag, lo, hi, integer) => {
      if (req[key] === undefined || req[key] === null || req[key] === '') return;
      const n = Number(req[key]);
      if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < lo || n > hi) throw new Error(`${key} must be a ${integer ? 'whole ' : ''}number between ${lo} and ${hi}`);
      argv.push(flag, String(n));
    };
    num('temperature', '--temperature', 0, 2, false);
    num('topP', '--top-p', 0, 1, false);
    num('maxTokens', '--max-tokens', 256, 1000000, true);
    num('timeoutMs', '--timeout-ms', 10000, 7200000, true);
    num('providerConcurrency', '--provider-concurrency', 1, 16, true);
    if (req.effort !== undefined && req.effort !== null && req.effort !== '') {
      if (!EFFORTS.includes(String(req.effort))) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
      argv.push('--effort', String(req.effort));
    }
    if (req.dryRun) argv.push('--dry-run');
  } else if (command === 'agent-run') {
    const harness = String(req.harness || 'proofbench');
    if (!AGENT_HARNESSES.includes(harness)) throw new Error(`harness must be one of ${AGENT_HARNESSES.join(', ')} (the others have no driver yet)`);
    argv.push('--harness', harness);
    if (!models.length) throw new Error('at least one model is required');
    argv.push('--models', models.join(','));
    if (!papers.length) throw new Error('select at least one problem');
    argv.push('--problems', papers.join(','));
    if (req.ref !== undefined && req.ref !== null && String(req.ref).trim()) {
      const ref = String(req.ref).trim();
      if (!REF_RE.test(ref)) throw new Error('ref contains characters that are not allowed');
      argv.push('--ref', ref);
    }
    const seen = { attempts: false };
    for (const [key, [flag, lo, hi, integer]] of Object.entries(AGENT_LIMITS)) {
      if (req[key] === undefined || req[key] === null || req[key] === '') continue;
      const n = Number(req[key]);
      if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < lo || n > hi) throw new Error(`${key} must be a ${integer ? 'whole ' : ''}number between ${lo} and ${hi}`);
      argv.push(flag, String(n));
      if (key === 'attempts') seen.attempts = true;
    }
    if (!seen.attempts) argv.push('--attempts', '1');
    if (req.effort !== undefined && req.effort !== null && req.effort !== '') {
      if (!EFFORTS.includes(String(req.effort))) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
      argv.push('--effort', String(req.effort));
    }
    if (req.comparator === false || req.comparator === 'off') argv.push('--comparator', 'off');
    if (req.search) argv.push('--search');
    if (req.retryInfra) argv.push('--retry-infra');
    if (req.regrade) argv.push('--regrade');
  } else {
    if (papers.length) argv.push('--papers', papers.join(','));
    if (req.retryFailed) argv.push('--retry-failed');
    if (req.reevaluate) argv.push('--reevaluate');
  }
  return { argv, run_id: runId, command, summary: `node qedrank/cli.js ${argv.join(' ')}` };
}

/** GITHUB_TOKEN from the environment, else from the GitHub CLI's login; null when neither exists. */
export async function resolveGithubToken({ env = process.env, execFileImpl = execFile } = {}) {
  if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()) return { token: env.GITHUB_TOKEN.trim(), source: 'GITHUB_TOKEN' };
  const out = await new Promise((resolve) => execFileImpl('gh', ['auth', 'token'], { timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout))));
  const t = out.trim();
  return t ? { token: t, source: 'gh auth token' } : { token: null, source: null };
}

export class JobManager {
  /**
   * @param {object} p
   * @param {string} p.cwd        repository root (where `node qedrank/cli.js` runs)
   * @param {string} p.cliPath    path of qedrank/cli.js
   * @param {string} p.logDir     where job logs are written
   * @param {Function} [p.spawnImpl]
   * @param {Function} [p.tokenResolver]
   */
  constructor({ cwd, cliPath, logDir, spawnImpl = spawn, tokenResolver = resolveGithubToken, env = process.env, nodeExe = process.execPath }) {
    this.cwd = cwd;
    this.cliPath = cliPath;
    this.logDir = logDir;
    this.spawnImpl = spawnImpl;
    this.tokenResolver = tokenResolver;
    this.env = env;
    this.nodeExe = nodeExe;
    this.jobs = new Map();
    this.seq = 0;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.describe(j));
  }

  describe(j) {
    return { id: j.id, command: j.command, run_id: j.run_id, summary: j.summary, status: j.status, exit_code: j.exit_code, started_at: j.started_at, ended_at: j.ended_at, log_bytes: j.log.length, token_source: j.token_source, log_file: j.log_file };
  }

  get(id, from = 0) {
    const j = this.jobs.get(id);
    if (!j) return null;
    const start = Math.max(0, Math.min(Number(from) || 0, j.log.length));
    return { ...this.describe(j), log: j.log.slice(start), next: j.log.length };
  }

  running() {
    return [...this.jobs.values()].filter((j) => j.status === 'running');
  }

  async start(req) {
    const known = (await listRunConfigs(path.join(this.cwd, 'configs'))).map((c) => c.file);
    const built = buildRunArgv(req, { configs: known });
    if (this.running().some((j) => j.run_id === built.run_id)) throw new Error(`a job for run ${built.run_id} is already running`);
    const id = `job-${Date.now()}-${(this.seq += 1)}`;
    await ensureDir(this.logDir);
    const job = { id, command: built.command, run_id: built.run_id, summary: built.summary, status: 'running', exit_code: null, started_at: isoNow(), ended_at: null, log: '', log_file: path.join(this.logDir, `${id}.log`), token_source: null, child: null };
    const env = { ...this.env };
    const { token, source } = await this.tokenResolver({ env: this.env });
    if (token) env.GITHUB_TOKEN = token;
    job.token_source = source;
    const append = (chunk) => {
      const text = String(chunk);
      job.log = (job.log + text).slice(-MAX_LOG);
      fs.appendFile(job.log_file, text).catch(() => {});
    };
    append(`[jobs] ${built.summary}\n[jobs] token: ${source || 'none (public repositories only)'}\n`);
    let child;
    try {
      child = this.spawnImpl(this.nodeExe, [this.cliPath, ...built.argv], { cwd: this.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      job.status = 'failed';
      job.ended_at = isoNow();
      append(`[jobs] could not start: ${err.message}\n`);
      this.jobs.set(id, job);
      return this.describe(job);
    }
    job.child = child;
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => { append(`[jobs] error: ${err.message}\n`); job.status = 'failed'; job.ended_at = isoNow(); });
    child.on('close', (code, signal) => {
      job.exit_code = code;
      job.ended_at = isoNow();
      if (job.status === 'stopping') job.status = 'stopped';
      else job.status = code === 0 ? 'done' : 'failed';
      append(`[jobs] exited with ${signal ? `signal ${signal}` : `code ${code}`}\n`);
    });
    this.jobs.set(id, job);
    return this.describe(job);
  }

  stop(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    if (j.status === 'running' && j.child) {
      j.status = 'stopping';
      try { j.child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { if (j.status === 'stopping') { try { j.child.kill('SIGKILL'); } catch { /* ignore */ } } }, 5000).unref?.();
    }
    return this.describe(j);
  }
}
