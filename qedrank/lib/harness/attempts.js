// Independent attempts with the ProofBench agent harness, driven from QEDRank.
//
// Attempt a of a run is one Inspect run of the harness (`scripts/run.sh`) over the problems
// that attempt a has not completed yet, logged to <harness>/logs/<run>/attempt-a/. A new
// Inspect run means fresh agent state and fresh sandbox containers per problem. After every
// attempt the logs are imported into runs/<run>/ and the statistics are rebuilt, so a stopped
// run leaves a complete, loadable state; starting it again continues with the missing
// (attempt, problem) pairs and never repeats a completed one. Budgets travel as the harness's
// own environment variables; model keys reach the child process only.

import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { getProvider, resolveModelId, resolveBaseUrl, resolveApiKey } from '../../../lib/providers.js';
import { assertPrivateCorpus } from '../privacy.js';
import { isoNow, readJson, writeJson } from '../util.js';
import { readEvalLogs } from './evallog.js';
import { attemptLogDir, importProofbenchLogs, MAX_ATTEMPTS } from './proofbench.js';
import { proofbenchSettings } from './registry.js';

export const LIMIT_ENV = Object.freeze({
  sessions: 'SESSIONS', sessionOutputTokens: 'SESSION_OUTPUT_TOKENS', sessionTokens: 'SESSION_TOKENS', sessionWorkingTime: 'SESSION_WORKING_TIME',
  noteTokens: 'NOTE_TOKENS', maxTokens: 'MAX_TOKENS', requestTimeout: 'REQUEST_TIMEOUT', attemptTimeout: 'ATTEMPT_TIMEOUT', timeLimit: 'TIME_LIMIT',
  messageLimit: 'MESSAGE_LIMIT', maxSamples: 'MAX_SAMPLES',
});

const envName = (id) => String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * Inspect's model string and the environment it needs for a QEDRank model slot. The key is
 * read from this process's environment and passed to the child only.
 */
export function inspectModelFor(slot, env = process.env) {
  const p = getProvider(slot);
  const modelId = resolveModelId(slot, env);
  const { key } = resolveApiKey(slot, env);
  if (!modelId) throw new Error(`${slot}: no model id configured`);
  const kind = String(p.kind || '').toLowerCase();
  if (kind.includes('anthropic')) return { slot, model: `anthropic/${modelId}`, env: key ? { ANTHROPIC_API_KEY: key } : {}, configured: Boolean(key) };
  const base = resolveBaseUrl(slot, env);
  if (base && /api\.openai\.com/.test(base)) return { slot, model: `openai/${modelId}`, env: key ? { OPENAI_API_KEY: key } : {}, configured: Boolean(key) };
  const name = envName(slot);
  const e = {};
  if (key) e[`${name}_API_KEY`] = key;
  if (base) e[`${name}_BASE_URL`] = base;
  return { slot, model: `openai-api/${slot}/${modelId}`, env: e, configured: Boolean(key) };
}

/** Environment of one attempt's `scripts/run.sh` (no key ever appears in a log). */
export function attemptEnv({ baseEnv = {}, settings, model, ids, runId, attempt, limits = {}, effort = null, search = false, network = null, comparator = true, tags = 'proofbench,qedrank' }) {
  const env = { ...baseEnv };
  const sep = process.platform === 'win32' ? ';' : ':';
  if (settings.venvBin) env.PATH = `${settings.venvBin}${sep}${env.PATH || env.Path || ''}`;
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.MSYS_NO_PATHCONV = '1';
  env.INSPECT_DISPLAY = 'plain';
  env.RUN_ID = `${runId}/attempt-${attempt}`;
  env.IDS = ids.join(' ');
  env.MODEL = model.model;
  Object.assign(env, model.env);
  env.SEARCH = search ? 'true' : 'false';
  if (network !== null && network !== undefined) env.NETWORK = network ? 'true' : 'false';
  env.COMPARATOR = comparator ? 'on' : 'off';
  env.TAGS = tags;
  if (effort) env.EFFORT = String(effort); else delete env.EFFORT;
  for (const [k, name] of Object.entries(LIMIT_ENV)) if (limits[k] !== undefined && limits[k] !== null && limits[k] !== '') env[name] = String(limits[k]);
  env.QEDRANK_ATTEMPT = String(attempt);
  return env;
}

/**
 * State of the planned attempts from the logs on disk: which (attempt, problem) pairs are
 * complete (a sample with a score or a sample error), which are missing.
 */
export async function scanAttempts({ harnessDir, runId, attempts, problems, retryInfra = false }) {
  const out = [];
  for (let a = 1; a <= attempts; a += 1) {
    const dir = attemptLogDir(harnessDir, runId, a);
    const logs = await readEvalLogs(dir);
    const completed = new Set();
    const infra = new Set();
    const states = [];
    for (const lg of logs) {
      states.push({ file: path.basename(lg.file), status: lg.status, samples: lg.samples.length, model: lg.eval?.model ?? null });
      for (const s of lg.samples) {
        const score = s.scores?.lean_check;
        if (score && score.value !== 'N' && !s.error) completed.add(s.id);
        else if (score || s.error) { completed.add(s.id); infra.add(s.id); }
      }
    }
    const redo = retryInfra ? infra : new Set();
    const missing = problems.filter((p) => !completed.has(p) || redo.has(p));
    const statuses = states.map((s) => s.status);
    const status = !states.length ? 'pending' : !missing.length ? 'done' : statuses.includes('started') ? 'interrupted' : statuses.includes('cancelled') ? 'cancelled' : 'partial';
    out.push({ attempt: a, dir, logs: states, completed: [...completed].sort(), infrastructure: [...infra].sort(), missing, status });
  }
  return out;
}

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } } }
}

function runHarness({ settings, env, log, state }) {
  return new Promise((resolve) => {
    const child = spawn(settings.bash, ['scripts/run.sh'], { cwd: settings.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    state.child = child;
    let tail = '';
    const onData = (chunk) => { const t = String(chunk); tail = (tail + t).slice(-4000); for (const line of t.split(/\r?\n/)) if (line.trim()) log(`[harness] ${line}`); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => resolve({ code: null, signal: null, error: err.message, tail }));
    child.on('close', (code, signal) => { state.child = null; resolve({ code, signal, error: null, tail }); });
  });
}

function estimatedCost(items) {
  let usd = 0;
  let priced = 0;
  for (const r of items) if (typeof r.agent?.totals?.cost_usd === 'number') { usd += r.agent.totals.cost_usd; priced += 1; }
  return { usd, priced };
}

/**
 * Run (or continue) up to `attempts` independent attempts for `problems` with `slots` and import
 * everything into runs/<runId>. Returns the final attempt states and the stop reason.
 */
export async function runAttempts({ config, runId, slots, problems, attempts = 1, limits = {}, effort = null, search = false, network = null, comparator = true, retryInfra = false, maxCostUsd = null, datasetRef = null, regrade = null, log = () => {}, signal = null }) {
  if (!(attempts >= 1 && attempts <= MAX_ATTEMPTS)) throw new Error(`attempts must be between 1 and ${MAX_ATTEMPTS}`);
  if (!problems.length) throw new Error('no problems selected');
  const settings = await proofbenchSettings(config);
  if (!settings.dir) throw new Error('the ProofBench harness is not configured: set harnesses.proofbench.dir in qedrank.config.json');
  if (!settings.bash) throw new Error('bash not found: set harnesses.proofbench.bash');
  const statementsCommit = await new Promise((resolve) => execFile('git', ['-C', settings.statements, 'rev-parse', 'HEAD'], { timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim())));
  if (datasetRef && statementsCommit && !statementsCommit.startsWith(datasetRef)) throw new Error(`the statements clone is at ${statementsCommit.slice(0, 10)}, not at the pinned commit ${datasetRef}: check it out first (git -C "${settings.statements}" checkout ${datasetRef})`);
  const models = slots.map((s) => inspectModelFor(s));
  const privacy = assertPrivateCorpus({ config, slots, env: process.env });
  if (privacy.enforced) log(`private corpus: every slot resolves to an allowed host (${privacy.slots.map((s) => `${s.slot}@${s.host}`).join(', ')})`);
  for (const m of models) if (!m.configured) throw new Error(`${m.slot}: no API key in the environment (${getProvider(m.slot).envKey})`);
  const runDir = path.join(config.runsDir, runId);
  const state = { child: null, stopped: false };
  const stop = () => { state.stopped = true; if (state.child) killTree(state.child); };
  if (signal) signal.addEventListener('abort', stop, { once: true });
  const onSig = () => { log('stop requested: ending the current Inspect run (completed samples are kept)'); stop(); };
  process.once('SIGTERM', onSig);
  process.once('SIGINT', onSig);
  const planFile = path.join(runDir, 'attempts-plan.json');
  const plan = { schema: 'qedrank-attempts-plan-v1', run_id: runId, privacy, harness: 'proofbench', harness_dir: settings.dir, statements_commit: statementsCommit, dataset_ref: datasetRef, problems, models: models.map((m) => ({ slot: m.slot, model: m.model })), attempts, limits, effort, search, network, comparator, max_cost_usd: maxCostUsd, started_at: isoNow(), events: [] };
  const importAll = async () => {
    const sources = [];
    for (let a = 1; a <= attempts; a += 1) sources.push({ dir: attemptLogDir(settings.dir, runId, a), attempt: a });
    return importProofbenchLogs({ config, runId, sources, attemptsPlanned: attempts, force: true, regrade, log });
  };
  let stopReason = 'completed';
  let imported = null;
  try {
    await (await import('../util.js')).ensureDir(runDir);
    plan.events.push({ at: isoNow(), event: 'start' });
    await writeJson(planFile, plan);
    for (let a = 1; a <= attempts && !state.stopped; a += 1) {
      for (const model of models) {
        if (state.stopped) break;
        const scan = (await scanAttempts({ harnessDir: settings.dir, runId: `${runId}`, attempts: a, problems, retryInfra })).at(-1);
        const done = new Set(scan.completed.filter((p) => !(retryInfra && scan.infrastructure.includes(p))));
        // Problems this model has completed in this attempt slot (logs may hold several models).
        const logsHere = await readEvalLogs(scan.dir);
        const mine = new Set();
        for (const lg of logsHere) if (lg.eval?.model === model.model) for (const s of lg.samples) if ((s.scores?.lean_check && (!retryInfra || s.scores.lean_check.value !== 'N')) || (s.error && !retryInfra)) mine.add(s.id);
        const ids = problems.filter((p) => !mine.has(p));
        if (!ids.length) { log(`attempt ${a} · ${model.slot}: complete, nothing to run`); continue; }
        log(`attempt ${a} · ${model.slot} (${model.model}): running ${ids.length} problem(s): ${ids.join(' ')}`);
        plan.events.push({ at: isoNow(), event: 'attempt_start', attempt: a, slot: model.slot, problems: ids });
        await writeJson(planFile, plan);
        const env = attemptEnv({ baseEnv: process.env, settings, model, ids, runId, attempt: a, limits, effort, search, network, comparator });
        const res = await runHarness({ settings, env, log, state });
        plan.events.push({ at: isoNow(), event: state.stopped ? 'attempt_cancelled' : 'attempt_end', attempt: a, slot: model.slot, exit_code: res.code, signal: res.signal, error: res.error });
        imported = await importAll().catch((err) => { log(`import after attempt ${a}: ${err.message}`); return null; });
        if (imported) {
          const { stageStatistics, openRun } = await import('../run.js');
          const ctx = await openRun({ config, runId, log });
          await stageStatistics(ctx).catch((err) => log(`statistics: ${err.message}`));
          const { collectItems } = await import('../run.js');
          const cost = estimatedCost(await collectItems(ctx));
          plan.cost_estimate = { usd: Math.round(cost.usd * 1e4) / 1e4, priced_attempts: cost.priced, basis: 'reported usage x configured prices; estimated, not billed' };
          if (maxCostUsd !== null && maxCostUsd !== undefined && cost.priced > 0 && cost.usd >= maxCostUsd) { stopReason = 'cost_cap'; log(`estimated cost ${cost.usd.toFixed(2)} USD reached the cap ${maxCostUsd} USD: no further attempts`); state.stopped = true; }
        }
        await writeJson(planFile, plan);
        if (res.error) { stopReason = 'harness_error'; log(`the harness could not be started: ${res.error}`); state.stopped = true; }
      }
    }
    if (state.stopped && stopReason === 'completed') stopReason = 'stopped';
  } finally {
    process.off('SIGTERM', onSig);
    process.off('SIGINT', onSig);
    plan.ended_at = isoNow();
    plan.stop_reason = stopReason;
    plan.events.push({ at: isoNow(), event: 'end', reason: stopReason });
    await writeJson(planFile, plan).catch(() => {});
  }
  const final = await scanAttempts({ harnessDir: settings.dir, runId, attempts, problems, retryInfra: false });
  const run = await readJson(path.join(runDir, 'run.json'), null);
  if (run) {
    for (const st of final) if (run.attempts?.by_attempt?.[st.attempt]) run.attempts.by_attempt[st.attempt].status = st.status === 'partial' && stopReason !== 'completed' ? 'cancelled' : st.status === 'interrupted' ? 'cancelled' : st.status;
    run.privacy = privacy;
    run.attempts = { ...(run.attempts || {}), stop_reason: stopReason, plan_file: 'attempts-plan.json' };
    run.updated_at = isoNow();
    await writeJson(path.join(runDir, 'run.json'), run);
  }
  return { attempts: final, stop_reason: stopReason, imported };
}
