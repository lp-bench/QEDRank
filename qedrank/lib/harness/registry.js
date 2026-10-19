// The evaluation harnesses QEDRank can drive or import, with their integration state. The
// state is deliberately explicit: a harness is offered on the page only when its code is on
// this machine and its integration has been executed here; the others are listed as what they
// are (not integrated, or a fallback whose setup has not been validated).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';

export const HARNESSES = Object.freeze([
  {
    id: 'qedrank-single',
    label: 'QEDRank single call (no tools)',
    kind: 'single_call',
    integration: 'operational',
    command: 'run',
    repo: 'https://github.com/vaibhav-baj/QEDRank',
    protocol: 'One request per problem and attempt, no tools; the whole file is graded by QEDRank: compile in the pinned project, no sorry, standard axioms, statement and definitions unchanged as compiled declarations, kernel replay.',
    limits: ['max_tokens', 'timeout_ms', 'attempts'],
    tools: [],
    notes: 'The baseline. Pass@k from independent sampled attempts (temperature above 0).',
  },
  {
    id: 'proofbench',
    label: 'ProofBench agent harness (proofbench-eval-apptainer)',
    kind: 'agent',
    integration: 'integrated',
    command: 'agent-run',
    repo: 'https://github.com/proof-bench/proofbench-eval-apptainer',
    protocol: 'Inspect AI ReAct agent with bash, python, text_editor and lean-lsp-mcp in a Docker or Apptainer sandbox; up to N fresh sessions per attempt chained by handoff notes; graded in a second untouched container by check_proof.py (layer 1) and Comparator (layer 2, kernel replay against the trusted statement module).',
    limits: ['sessions', 'session_output_tokens', 'session_tokens', 'session_working_time', 'note_tokens', 'max_tokens', 'request_timeout', 'attempt_timeout', 'time_limit', 'message_limit', 'max_samples', 'max_cost_usd'],
    tools: ['bash', 'python', 'text_editor', 'lean-lsp-mcp', 'web_search (optional)'],
    notes: 'Independent attempts are separate Inspect runs (fresh agent state, fresh sandboxes); QEDRank drives them, imports every log, and resumes without repeating completed attempts. message_limit caps Inspect messages (about two per tool call) and max_cost_usd is enforced by QEDRank between attempts from reported usage and configured prices.',
    config: { dir: 'path of the harness checkout', statements: 'statements clone inside it (default proofbench-statements)', python: 'optional Python of its venv', bash: 'optional bash.exe on Windows', leanProject: 'optional pinned Lean project for the partial-progress re-grade' },
  },
  {
    id: 'matharena-arxivlean',
    label: 'MathArena ArXivLean harness (eth-sri/matharena)',
    kind: 'agent',
    integration: 'not_integrated',
    command: null,
    repo: 'https://github.com/eth-sri/matharena',
    protocol: 'MathArena agent with local Lean execution, Loogle and LeanExplore search, a pre-submission check and a persistent lemma file; up to 200 tool calls and a per-attempt cost cap; graded by the Lean checker plus Comparator (September 2026 setup, Lean 4.34.1).',
    limits: ['tool_calls (200)', 'cost per attempt (USD)'],
    tools: ['lean_execution', 'loogle', 'lean_explore', 'verify', 'lemma file'],
    notes: 'Not integrated: no run has been executed from QEDRank and no importer exists. Only its September configuration runs Lean locally; the earlier editions send proofs to the external Axle service and must not be used with private statements. Its Lean 4.34.1 / Mathlib environment differs from ProofBench\'s 4.33.1 + Matroid fork, so it must run in its own project. Runs on datasets other than ArXivLean are "adapted", never official MathArena results.',
    config: { dir: 'path of the matharena checkout', datasetMode: 'official | adapted' },
  },
  {
    id: 'qedrank-harness',
    label: 'QEDRank harness/ (fallback)',
    kind: 'agent',
    integration: 'fallback_untested',
    command: null,
    repo: 'https://github.com/vaibhav-baj/QEDRank/tree/QEDRank/harness',
    protocol: 'QEDRank\'s own Inspect AI harness (sessions with HANDOFF.md, QEDRank grade after every session).',
    limits: ['sessions', 'session_output_tokens'],
    tools: ['bash', 'python', 'lean', 'file edit', 'web_search (optional)'],
    notes: 'Fallback only. Its Docker image and compose files have never been built or run on this machine; it is not presented as operational until they are.',
    config: { dir: 'harness' },
  },
]);

export function harnessEntry(id) {
  const h = HARNESSES.find((x) => x.id === id);
  if (!h) throw new Error(`unknown harness ${id}`);
  return h;
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000, windowsHide: true, ...opts }, (err, stdout) => resolve(err ? null : String(stdout).trim())));
const isFile = async (p) => { try { return (await fs.stat(p)).isFile(); } catch { return false; } };
const isDir = async (p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } };

/** Default locations of the ProofBench harness's interpreter and of bash on this platform. */
export function proofbenchDefaults(dir, { platform = process.platform, env = process.env } = {}) {
  const win = platform === 'win32';
  return {
    python: dir ? path.join(dir, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python') : null,
    venvBin: dir ? path.join(dir, '.venv', win ? 'Scripts' : 'bin') : null,
    bash: win ? [path.join(env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe'] : ['bash'],
  };
}

/** Effective ProofBench harness settings from the config (paths resolved, defaults filled). */
export async function proofbenchSettings(config, { platform = process.platform, env = process.env } = {}) {
  const cfg = config.harnesses?.proofbench || {};
  const dir = cfg.dir ? path.resolve(cfg.dir) : null;
  const d = proofbenchDefaults(dir, { platform, env });
  let bash = cfg.bash || null;
  if (!bash) for (const c of d.bash) if (c === 'bash' || (await isFile(c))) { bash = c; break; }
  return {
    dir,
    bash,
    python: cfg.python ? path.resolve(cfg.python) : d.python,
    venvBin: d.venvBin,
    statements: dir ? path.resolve(dir, cfg.statements || 'proofbench-statements') : null,
    leanProject: cfg.leanProject ? path.resolve(cfg.leanProject) : null,
    image: cfg.image || 'proofbench-sandbox:latest',
    statementsUrl: cfg.statementsUrl || 'https://github.com/proof-bench/proofbench-statements',
  };
}

/**
 * Every harness with what this machine has of it: configured paths, whether its files exist,
 * the statements commit. Nothing here starts a container or calls a model.
 */
export async function describeHarnesses(config, opts = {}) {
  const out = [];
  for (const h of HARNESSES) {
    const entry = { id: h.id, label: h.label, kind: h.kind, integration: h.integration, command: h.command, repo: h.repo, protocol: h.protocol, limits: h.limits, tools: h.tools, notes: h.notes, ready: false, checks: {}, reason: null };
    if (h.id === 'qedrank-single') { entry.ready = true; entry.checks = { command: 'node qedrank/cli.js run' }; }
    else if (h.id === 'proofbench') {
      const s = await proofbenchSettings(config, opts);
      const checks = {
        dir: s.dir, dir_exists: s.dir ? await isDir(s.dir) : false,
        run_sh: s.dir ? await isFile(path.join(s.dir, 'scripts', 'run.sh')) : false,
        python: s.python, python_exists: s.python ? await isFile(s.python) : false,
        bash: s.bash, bash_exists: s.bash ? (s.bash === 'bash' || (await isFile(s.bash))) : false,
        statements: s.statements, statements_exists: s.statements ? await isDir(s.statements) : false,
        statements_commit: s.statements && (await isDir(s.statements)) ? await run('git', ['-C', s.statements, 'rev-parse', 'HEAD']) : null,
        statements_dirty: null,
        harness_commit: s.dir && (await isDir(s.dir)) ? await run('git', ['-C', s.dir, 'rev-parse', 'HEAD']) : null,
        lean_project: s.leanProject, lean_project_exists: s.leanProject ? await isDir(s.leanProject) : false,
        image: s.image,
      };
      if (checks.statements_exists) { const st = await run('git', ['-C', s.statements, 'status', '--porcelain', '--untracked-files=no']); checks.statements_dirty = st === null ? null : st.length > 0; }
      entry.checks = checks;
      entry.ready = Boolean(checks.dir_exists && checks.run_sh && checks.python_exists && checks.bash_exists && checks.statements_exists);
      entry.reason = !s.dir ? 'not configured: set harnesses.proofbench.dir in qedrank.config.json' : !checks.dir_exists ? 'harness directory not found' : !checks.run_sh ? 'scripts/run.sh missing' : !checks.python_exists ? 'harness venv not found (.venv)' : !checks.bash_exists ? 'bash not found' : !checks.statements_exists ? 'statements clone not found' : checks.statements_dirty ? 'statements clone has uncommitted changes (the harness refuses to run)' : null;
      if (checks.statements_dirty) entry.ready = false;
    } else if (h.id === 'matharena-arxivlean') {
      const cfg = config.harnesses?.['matharena-arxivlean'] || {};
      entry.checks = { dir: cfg.dir ? path.resolve(cfg.dir) : null, dir_exists: cfg.dir ? await isDir(path.resolve(cfg.dir)) : false, dataset_mode: cfg.datasetMode || 'adapted' };
      entry.reason = 'not integrated (no driver, no importer); see docs/agent-evaluation.md';
    } else if (h.id === 'qedrank-harness') {
      const dir = path.resolve(config.harnesses?.['qedrank-harness']?.dir || 'harness');
      entry.checks = { dir, dir_exists: await isDir(dir), docker_validated: false };
      entry.reason = 'fallback: Docker image and compose not validated on this machine';
    }
    out.push(entry);
  }
  return out;
}
