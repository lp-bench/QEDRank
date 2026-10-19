// ProofBench agent harness (proof-bench/proofbench-eval-apptainer) -> QEDRank run directory.
//
// The harness writes one Inspect log per run with, per sample: the session records under the
// store key `sessions`, and the `lean_check` score whose metadata is layer 1's report
// (check_proof.py: ok, errors, files, lines, proof_lines, axioms, compile_seconds, the
// submission text) plus Comparator's result. One sample is one attempt of one problem by one
// model. Independent attempts live in sibling log directories (attempt-1, attempt-2, ...), as
// the attempts driver writes them.
//
// Every sample becomes one item record with the same shape as the rest of QEDRank, so the
// summary, the page and the LaTeX generators read it unchanged, plus `status`, `failure`,
// `partial` and `harness`. The submission text and the grading record are saved next to the
// record (never in the exports).

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { ITEM_SCHEMA, RUN_SCHEMA, MANIFEST_SCHEMA, STAGES, TARGET_KINDS, itemKey } from '../schema.js';
import { ensureDir, exists, isoNow, readJson, slug, writeJson, writeText } from '../util.js';
import { contaminationOf } from '../evaluate.js';
import { providerIdOf, modelIdOf } from '../agent.js';
import { modelFacts } from '../../../lib/model-facts.js';
import { readEvalLogs } from './evallog.js';
import { classifyAttempt, classifyFailure, isErrorEnd } from './status.js';
import { harnessEntry, proofbenchSettings } from './registry.js';

export const HARNESS_ID = 'proofbench';
export const AGENT_TARGET = 'main_theorem';
export const MAX_ATTEMPTS = 16;
export const PROOF_LINES_RULE = 'check_proof.py: proof_lines = non-blank lines after the line holding the main theorem\'s `:=` (plus one when that line itself carries proof text); lines and non-blank lines are counted over the main file and every Submission file it imports. Generated lines = the whole final file; final verified proof lines = proof_lines of a fully solved attempt.';
export const COUNTING_RULES = Object.freeze({
  attempt: 'One Inspect sample (one problem, one model, one attempt index). Attempts are separate Inspect runs: fresh agent state, fresh sandbox containers, no shared files.',
  fully_solved: 'The final submission passes check_proof.py (statement and definitions unchanged, allowed imports, no sorry/axiom/native_decide/kernel bypass, helper files build, main file compiles, standard axioms only) and Comparator (kernel replay against the trusted statement module). Compilation alone never counts.',
  partially_solved: 'Not solved, but QEDRank\'s independent re-grade of the final file (pinned Lean project, #qr_module_report) finds at least one auxiliary theorem the model wrote that compiles without sorry and depends only on standard axioms. Recorded as evidence; never counted in verified rates or pass@k.',
  infrastructure_error: 'The attempt could not be carried out or graded: Inspect sample error, every session ended in a provider or sandbox error before any model output, the checker itself failed, or the harness scored NOANSWER. Excluded from every denominator and counted separately.',
  cancelled: 'A planned attempt whose Inspect run was stopped before the sample finished leaves no record; it is listed as cancelled in run.attempts and re-run on resume. A sample that finished before the stop is a complete attempt and is kept.',
  retries: 'Inspect retries transient provider errors inside a request; the ProofBench harness retries a session that ended in a provider error without consuming a session (its fix); QEDRank re-runs an attempt only when asked (--retry-infra). No failure is dropped: every record carries its status and failure class.',
  pass_at_k: 'For a problem with n determinate attempts (infrastructure errors excluded) of which c are fully solved: 1 - C(n-c, k)/C(n, k), averaged over proof-track problems with n >= k; a problem with fewer than k attempts is left out of that k and counted in items_short. Never shown as 0 when unavailable.',
  solved_within_k: 'Observed: the share of problems whose first k attempts (by attempt index) contain a fully solved one, over problems with at least k attempts. Kept apart from the pass@k estimate.',
  coverage: 'Models are compared on the same problems; per-model coverage (problems with at least one determinate attempt) and the differences are reported next to every aggregate.',
});

const ms = (s) => (typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 1000) : null);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const STOP_REASON = { submit: 'agent_ended', token: 'output_token_budget', working: 'working_time', time: 'time_limit', message: 'message_limit', operator: 'operator', custom: 'custom_limit' };

function stopReasonOf(endedBy) {
  const s = String(endedBy || '');
  if (/^provider_error/.test(s)) return 'provider_error';
  if (/^error/.test(s)) return 'error';
  return STOP_REASON[s] || s || 'unknown';
}

/** Compile status from layer 1: it compiles only after the textual checks pass. */
export function compileStatusFromLayer1(ok, errors) {
  if (ok) return 'compiler_success';
  const j = errors.join('\n');
  if (/compile timeout|build timeout/i.test(j)) return 'timeout';
  if (/^compile error:|helper build error/im.test(j)) return 'compiler_failure';
  return 'not_attempted';
}

function normSession(s, i) {
  return {
    index: num(s.session) ?? i + 1,
    ended_by: String(s.ended_by ?? ''),
    stop_reason: stopReasonOf(s.ended_by),
    error_kind: s.error_kind ?? null,
    output_tokens: num(s.output_tokens),
    total_tokens: num(s.total_tokens),
    working_ms: ms(num(s.working_seconds)),
    passed: Boolean(s.passed),
    errors: Array.isArray(s.errors) ? s.errors.slice(0, 3).map((e) => String(e).slice(0, 300)) : [],
    note_chars: typeof s.note === 'string' ? s.note.length : null,
  };
}

/**
 * One harness sample -> one QEDRank item record.
 * @param {object} sample  normalised sample (evallog.js)
 * @param {object} ctx     { model, attempt, harness, pricing, modelFactsExtra, labels, regrade, providerSuffix, displaySuffix }
 */
export function proofbenchItem(sample, ctx) {
  const { model, attempt, harness, pricing = {}, modelFactsExtra = {}, labels = {}, regrade = null } = ctx;
  const provider = providerIdOf(model) + (ctx.providerSuffix || '');
  const modelId = modelIdOf(model);
  const facts = modelFacts(modelId, modelFactsExtra);
  const md = sample.metadata || {};
  const paperId = String(sample.id);
  const sc = sample.scores?.lean_check || null;
  const sm = sc?.metadata || {};
  const sessions = (Array.isArray(sample.store?.sessions) ? sample.store.sessions : []).map(normSession);
  const ends = sessions.map((s) => s.ended_by);
  const errors = Array.isArray(sm.errors) ? sm.errors.map((e) => String(e)) : [];
  const noModelOutput = sessions.length > 0 && sessions.every((s) => isErrorEnd(s.ended_by)) && !sessions.some((s) => (s.output_tokens || 0) > 0);
  const checkerBroke = sm.checker_error === true || /checker failed|checker did not finish/i.test(errors.join(' '));
  const infra = Boolean(sample.error) || !sc || sc.value === 'N' || sm.infrastructure_error === true || noModelOutput || checkerBroke || Boolean(sample.store?.provider_abort);
  const solved = !infra && sc.value === 'C';
  const comparator = sm.comparator === 'off' ? 'off' : sm.comparator && typeof sm.comparator === 'object' ? { ok: Boolean(sm.comparator.ok), returncode: sm.comparator.returncode ?? null, ran_as: sm.comparator.ran_as ?? null, tail: String(sm.comparator.stderr || sm.comparator.stdout || '').slice(-600) } : null;
  const comparatorRejected = !infra && sm.ok === true && comparator && comparator !== 'off' && !comparator.ok;
  const failErrors = comparatorRejected ? [...errors, `comparator rejected: ${comparator.tail}`] : errors;
  const compileStatus = infra ? 'not_attempted' : compileStatusFromLayer1(Boolean(sm.ok), errors);
  const compiled = infra ? null : compileStatus === 'compiler_success' ? 1 : ['compiler_failure', 'timeout'].includes(compileStatus) ? 0 : regrade?.checks?.compile?.status === 'compiler_success' ? 1 : regrade?.checks?.compile?.status ? 0 : null;
  const stmtBad = errors.some((e) => /theorem statement altered|no longer states theorem|reference line missing or altered|line added before the theorem/i.test(e)) || Boolean(comparatorRejected);
  const statementFaithful = infra ? null : stmtBad ? 0 : sc ? 1 : null;
  const sorryErr = errors.some((e) => /contains sorry|declaration uses sorry/i.test(e));
  const auditStatus = infra ? 'not_audited' : solved || (sm.ok === true) ? 'clean'
    : sorryErr ? 'placeholder' : errors.some((e) => /declares an axiom|non-standard axioms/i.test(e)) ? 'user_axiom'
      : errors.some((e) => /native_decide/.test(e)) ? 'native_decide' : errors.some((e) => /disallowed import/.test(e)) ? 'disallowed_import'
        : errors.some((e) => /# command|elaboration time|implemented_by|bypasses the kernel/.test(e)) ? 'forbidden_command' : 'not_audited';
  const status = labels.mathematical_status || (String(labels.difficulty || md.difficulty || '').toLowerCase() === 'open' ? 'open' : 'established');
  const proofTrack = status === 'established';
  const partial = regrade
    ? { assessed: true, method: `QEDRank grade (#qr_module_report) of the final file in ${regrade.toolchain?.lean_project || 'the pinned Lean project'}: auxiliary theorems the model wrote that are sorry-free and depend only on standard axioms`, compiles: regrade.checks?.compile?.status === 'compiler_success', verified_aux_lemmas: num(regrade.completeness?.lemmas_written_sorry_free) ?? 0, lemmas_written: num(regrade.completeness?.lemmas_written) ?? 0, completeness_score: num(regrade.completeness?.score), open_steps: regrade.completeness?.open_steps ?? [], declarations_with_sorry: regrade.checks?.sorry?.declarations_with_sorry ?? [], regrade_verdict: regrade.verdict, regrade_reasons: regrade.reasons ?? [] }
    : { assessed: false, reason: 'not re-graded: run import-harness --regrade with a pinned Lean project to assess verified partial progress', layer1_compiles: compileStatus === 'compiler_success' };
  const attemptStatus = classifyAttempt({ infrastructure: infra, solved, partial });
  const failure = solved ? null : classifyFailure({ errors: failErrors, sessionEnds: ends, sampleError: sample.error?.message ?? null, limit: sample.limit, infrastructure: checkerBroke, compilerOutput: regrade?.compiler_output || '' , reasons: regrade?.reasons || [] });
  const usage = sample.usage;
  const price = pricing[modelId];
  const cost = price && usage ? (usage.input_tokens / 1e6) * (price.input ?? 0) + (usage.output_tokens / 1e6) * (price.output ?? 0) : null;
  const notes = [];
  if (sample.error) notes.push(`sample_error: ${sample.error.message.slice(0, 300)}`);
  if (noModelOutput) notes.push('every session ended in an error before any model output');
  if (comparatorRejected) notes.push('layer 1 passed, Comparator rejected');
  if (status === 'open' && solved) notes.push('ESCALATE: apparent proof of an open claim - independent mathematical review required');
  if (sample.limit) notes.push(`sample limit reached: ${sample.limit.type}`);
  const solvedAt = solved ? ((sessions.findIndex((s) => s.passed) + 1) || sessions.length || 1) : null;

  return {
    schema: ITEM_SCHEMA,
    item_key: itemKey(paperId, AGENT_TARGET, provider),
    paper_id: paperId,
    target_kind: AGENT_TARGET,
    provider,
    model_display_name: `${modelId}${ctx.displaySuffix || ''}`,
    model_id: modelId,
    model_label: model,
    api_host: harness.model_host ?? null,
    response_model: usage?.models?.length === 1 ? usage.models[0] : null,
    task: 'prove',
    setting: 'agent',
    attempt,
    repair_round: 0,
    harness: HARNESS_ID,
    status: attemptStatus,
    failure,
    partial,
    mathematical_status: status,
    mathematical_status_source: labels.mathematical_status ? 'dataset' : 'difficulty label (Open = open problem, otherwise established)',
    reference_proof_status: null,
    reference_statement_available: true,
    contamination: contaminationOf({ publication_date: labels.publication_date ?? null, public_formal_proof: null }, { facts }),
    generation: {
      mode: 'agent',
      error: sample.error ? { kind: 'sample_error', message: sample.error.message, http_status: null } : noModelOutput ? { kind: 'provider_error', message: ends[0] || 'provider error', http_status: null } : null,
      observed_latency_ms: ms(sample.total_time_s),
      working_ms: ms(sample.working_time_s),
      usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, reasoningTokens: usage.reasoning_tokens || null, cachedInputTokens: usage.input_tokens_cache_read || null, cacheWriteTokens: usage.input_tokens_cache_write || null } : null,
      effort: harness.effort ?? null,
      temperature: harness.model_generate_config?.temperature ?? null,
      max_tokens: harness.limits?.max_tokens ?? null,
      prompt_template_version: `proofbench-eval-apptainer@${(harness.commit || '').slice(0, 10) || 'unknown'}`,
      truncated: false,
    },
    parse: null,
    confidence: { statement: null, proof: null },
    abstained: false,
    static_screen: null,
    compile: { status: compileStatus, error_count: null, duration_ms: ms(num(sm.compile_seconds)), messages: [] },
    audit: { status: auditStatus, axioms: Array.isArray(sm.axioms) ? sm.axioms : [], kernel_replay: comparator === 'off' ? 'skipped' : comparator ? (comparator.ok ? 'passed' : 'failed') : null, file_sorry_free: sc ? !sorryErr : null },
    ab_consistency: null,
    comparison: sc ? { method: 'check_proof.py textual statement comparison + Comparator elaborated statement', evidence: { notes: stmtBad ? errors.filter((e) => /statement|reference line|line added/i.test(e)) : [] } } : null,
    statement_match: statementFaithful === 1 ? 'definitionally_identical' : statementFaithful === 0 ? 'different' : 'not_evaluated',
    statement_match_source: sc ? 'harness_grader' : null,
    loc: sc ? { model: { total: num(sm.lines), code: num(sm.nonblank_lines), proof: { code: num(sm.proof_lines) } }, reference: null, rule: PROOF_LINES_RULE } : null,
    timing: { lean_compile_ms: ms(num(sm.compile_seconds)), lean_total_ms: null, evaluation_total_ms: null, total_ms: ms(sample.total_time_s), working_ms: ms(sample.working_time_s), model_ms: null, tool_ms: null, waiting_ms: null },
    eligibility: { statement_track: true, proof_track: proofTrack, reasons: proofTrack ? [] : [`mathematical_status_${status}`] },
    outcomes: {
      infrastructure_failure: infra,
      compiled,
      audit_clean: infra ? null : auditStatus === 'clean' ? 1 : compiled === null && !sc ? null : 0,
      statement_faithful: statementFaithful,
      verified: infra || !proofTrack ? null : solved ? 1 : 0,
    },
    agent: {
      harness: HARNESS_ID,
      epoch: sample.epoch,
      attempt,
      sessions_max: harness.limits?.sessions ?? null,
      sessions_used: sessions.length,
      solved_at_session: solvedAt,
      final_verdict: infra ? 'not_graded' : solved ? 'solved' : 'not_solved',
      final_reasons: failErrors.slice(0, 10),
      web_search: harness.search ?? null,
      network: harness.network ?? null,
      limits: harness.limits ?? null,
      tools: harness.tools ?? [],
      sessions,
      totals: { model_calls: sample.events?.model_calls ?? null, tool_calls: sample.events?.tool_calls ?? null, tool_errors: sample.events?.tool_errors ?? null, tool_calls_by_tool: sample.events?.tool_calls_by_tool ?? {}, cost_usd: cost, cost_basis: price ? `estimated from reported usage x configured price (USD ${price.input}/${price.output} per M input/output tokens)` : null },
      completeness: regrade?.completeness ?? { available: false, reason: 'not_regraded' },
      comparator,
      graded_in: sm.graded_in ?? null,
      layer1: sc ? { ok: sm.ok ?? null, errors: errors.slice(0, 10), files: sm.files ?? null, compile_seconds: num(sm.compile_seconds), axioms: sm.axioms ?? [] } : null,
      search: { queries: [], lean_search_queries: [], urls: [], result_urls: [] },
      manual_audit: null,
      inspect: { total_time_s: sample.total_time_s, working_time_s: sample.working_time_s, sample_limit: sample.limit, error_retries: sample.error_retries ?? 0, log: ctx.logFile ?? null, uuid: sample.uuid ?? null },
    },
    artifacts: { submission: sm.submission_text ? `submission-a${attempt}.lean` : null, helper_files: sm.submission_files ? Object.keys(sm.submission_files).length : 0, grade: sc ? `grade-a${attempt}.json` : null, regrade: regrade ? `regrade-a${attempt}.json` : null },
    notes,
    evaluation_complete: true,
  };
}

/** Problem labels from the statements' Database.json (id "110" for P110), when the clone is present. */
export async function loadDatabaseLabels(statementsDir) {
  if (!statementsDir) return {};
  const file = path.join(statementsDir, 'ProofBench', 'DATABASE', 'Database.json');
  const db = await readJson(file, null);
  if (!Array.isArray(db)) return {};
  const out = {};
  for (const e of db) {
    const id = String(e.id ?? '').padStart(3, '0');
    if (!id) continue;
    const msc = e.msc ?? e.MSC ?? e.msc_primary ?? null;
    const tags = Array.isArray(msc) ? msc : msc ? String(msc).split(/[,;\s]+/).filter(Boolean) : [];
    out[`P${id}`] = { name: e.name ?? null, difficulty: e.difficulty ?? null, subject_tags: tags.map((t) => String(t).slice(0, 2)).filter((t, i, a) => a.indexOf(t) === i), msc: tags, publication_date: e.publication_date ?? e.date ?? null };
  }
  return out;
}

/** Protocol block of one log directory: manifest.json (run.sh) merged with the log's own spec. */
export function harnessProtocolOf(manifest = {}, log = null) {
  const meta = log?.eval?.metadata || {};
  const ta = log?.eval?.task_args || {};
  const cfg = log?.eval?.config || {};
  const n = (v) => (v === undefined || v === null || v === '' ? null : Number.isNaN(Number(v)) ? v : Number(v));
  const bool = (v) => (v === undefined || v === null || v === '' ? null : v === true || v === 'true' || v === 'on');
  const search = bool(meta.search ?? manifest.search);
  return {
    id: HARNESS_ID,
    label: harnessEntry(HARNESS_ID).label,
    repo: harnessEntry(HARNESS_ID).repo,
    commit: manifest.harness_commit || log?.eval?.revision?.commit || null,
    dirty: manifest.harness_dirty ?? null,
    inspect_version: manifest.inspect_version || log?.eval?.packages?.inspect_ai || null,
    image_id: manifest.image_id || manifest.image || null,
    sandbox: meta.sandbox_type || manifest.sandbox || ta.sandbox || null,
    lean_toolchain: manifest.lean_toolchain || null,
    mathlib_commit: manifest.mathlib_commit || null,
    statements_commit: manifest.statements_commit || null,
    proofbench_commit: manifest.proofbench_commit || null,
    tools: ['bash', 'python', 'text_editor', ...(bool(meta.lean_mcp ?? true) !== false ? ['lean-lsp-mcp'] : []), ...(search ? [`web_search:${meta.search_provider || manifest.search_provider || 'tavily'}`] : [])],
    network: bool(meta.network ?? manifest.network),
    search,
    comparator: bool(meta.comparator ?? manifest.comparator),
    effort: manifest.effort || log?.eval?.model_generate_config?.reasoning_effort || null,
    model_generate_config: log?.eval?.model_generate_config || null,
    model_host: null,
    limits: {
      sessions: n(meta.sessions ?? manifest.sessions),
      session_output_tokens: n(meta.session_output_tokens ?? manifest.session_output_tokens),
      session_tokens: n(meta.session_tokens ?? manifest.session_tokens),
      session_working_time: n(meta.session_working_time ?? manifest.session_working_time),
      note_tokens: n(meta.note_tokens ?? manifest.note_tokens),
      max_tokens: n(cfg.max_tokens ?? manifest.max_tokens),
      request_timeout: n(manifest.request_timeout),
      attempt_timeout: n(manifest.attempt_timeout),
      time_limit: n(cfg.time_limit ?? manifest.time_limit),
      message_limit: n(cfg.message_limit ?? manifest.message_limit),
      max_samples: n(cfg.max_samples ?? manifest.max_samples),
      epochs: n(cfg.epochs ?? manifest.epochs) ?? 1,
    },
    dataset_mode: 'official',
    task_args: ta,
    run_sh_manifest: manifest,
  };
}

/** Fields that must agree for two logs to be comparable (same protocol). */
function protocolKey(p) {
  return { harness_commit: p.commit, image_id: p.image_id, statements_commit: p.statements_commit, lean_toolchain: p.lean_toolchain, mathlib_commit: p.mathlib_commit, sandbox: p.sandbox, network: p.network, search: p.search, comparator: p.comparator, tools: (p.tools || []).join(','), limits: JSON.stringify(p.limits || {}) };
}

/** Where attempt logs live: <harnessDir>/logs/<runId>/attempt-<n>/ (one Inspect run each). */
export function attemptLogDir(harnessDir, runId, attempt) {
  return path.join(harnessDir, 'logs', runId, `attempt-${attempt}`);
}

/**
 * Discover the attempt log directories of a run: `root` is either a directory holding
 * attempt-<n>/ subdirectories or a single Inspect log directory (attempt 1).
 */
export async function discoverSources(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name)).map((e) => ({ dir: path.join(root, e.name), attempt: Number(e.name.slice(8)) })).sort((a, b) => a.attempt - b.attempt);
  if (dirs.length) return dirs;
  return [{ dir: root, attempt: 1 }];
}

async function machineInfo() {
  const gpu = await new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim().split(/\r?\n/).filter(Boolean)))).catch(() => resolve(null));
  });
  return { platform: os.platform(), release: os.release(), cpus: os.cpus().length, total_memory_mb: Math.round(os.totalmem() / 1048576), node: process.version, gpus: gpu, note: 'host of the import; per-attempt CPU, GPU and memory use are not measured by the harness and are reported as unavailable' };
}

/**
 * Import attempt logs into runs/<runId>. Re-importing is idempotent: records are rewritten from
 * the logs. `regrade` = { leanProject } turns on the partial-progress re-grade of every unsolved
 * final file with QEDRank's grader (slow: one Lean compile per file).
 */
export async function importProofbenchLogs({ config, runId, sources, attemptsPlanned = null, force = false, regrade = null, mergeRuns = [], extraModels = [], log = () => {} }) {
  const settings = await proofbenchSettings(config);
  const runDir = path.join(config.runsDir, runId);
  const existing = await readJson(path.join(runDir, 'run.json'), null);
  if (existing && !force && existing.protocol !== 'agent') throw new Error(`Run already exists: ${runDir} (use --force to replace it)`);
  await ensureDir(runDir);
  const labels = await loadDatabaseLabels(settings.statements);
  const grader = regrade?.leanProject ? await makeRegrader({ config, leanProject: regrade.leanProject, cacheDir: path.join(config.runsDir, '.grade-cache'), log }) : null;

  const items = [];
  const problems = new Map();
  const protocols = [];
  const byAttempt = {};
  const modelsSeen = new Map();
  let logsRead = 0;
  for (const src of sources) {
    const manifest = (await readJson(path.join(src.dir, 'manifest.json'), null)) || {};
    const logs = await readEvalLogs(src.dir);
    const a = src.attempt;
    byAttempt[a] = byAttempt[a] || { attempt: a, dir: src.dir, logs: [], problems_completed: [], status: 'pending' };
    for (const lg of logs) {
      logsRead += 1;
      byAttempt[a].logs.push({ file: path.basename(lg.file), status: lg.status, samples: lg.samples.length, model: lg.eval?.model ?? null, error: lg.error?.message ?? null });
      if (!lg.eval?.model) continue;
      const protocol = harnessProtocolOf(manifest, lg);
      protocols.push({ model: lg.eval.model, attempt: a, protocol });
      modelsSeen.set(lg.eval.model, protocol);
      for (const sample of lg.samples) {
        let regradeRec = null;
        const sm = sample.scores?.lean_check?.metadata || {};
        if (grader && sample.scores?.lean_check && sample.scores.lean_check.value !== 'C' && sm.submission_text && sample.metadata?.reference) {
          if (sm.submission_files && Object.keys(sm.submission_files).length) log(`regrade ${sample.id} a${a}: skipped (imports helper files; the re-grade handles single files)`);
          else regradeRec = await grader.grade({ challengeSrc: sample.metadata.reference, solutionSrc: sm.submission_text, target: sample.metadata.theorem, id: `${sample.id}-a${a}` }).catch((err) => { log(`regrade ${sample.id} a${a}: ${err.message}`); return null; });
        }
        const it = proofbenchItem(sample, { model: lg.eval.model, attempt: a, harness: protocol, pricing: config.pricing || {}, modelFactsExtra: config.modelFacts || {}, labels: labels[String(sample.id)] || { difficulty: sample.metadata?.difficulty ?? null }, regrade: regradeRec, logFile: path.basename(lg.file) });
        items.push(it);
        byAttempt[a].problems_completed.push(it.paper_id);
        const dir = path.join(runDir, 'items', slug(it.item_key));
        await ensureDir(dir);
        await writeJson(path.join(dir, `attempt-a${a}r0.json`), it);
        if (sm.submission_text) await writeText(path.join(dir, `submission-a${a}.lean`), sm.submission_text);
        if (sample.scores?.lean_check) { const { submission_text, submission_files, ...rest } = sm; await writeJson(path.join(dir, `grade-a${a}.json`), { score: sample.scores.lean_check.value, explanation: sample.scores.lean_check.explanation, metadata: rest, helper_files: submission_files || {}, original_statement: sample.metadata?.reference ?? null, theorem: sample.metadata?.theorem ?? null }); }
        if (regradeRec) await writeJson(path.join(dir, `regrade-a${a}.json`), regradeRec);
        if (!problems.has(it.paper_id)) problems.set(it.paper_id, { paper_id: it.paper_id, title: labels[it.paper_id]?.name ?? sample.metadata?.name ?? null, difficulty: labels[it.paper_id]?.difficulty ?? sample.metadata?.difficulty ?? null, subject_tags: labels[it.paper_id]?.subject_tags ?? [], msc: labels[it.paper_id]?.msc ?? [], publication_date: labels[it.paper_id]?.publication_date ?? null, mathematical_status: it.mathematical_status, declaration_name: sample.metadata?.theorem ?? null });
      }
    }
    byAttempt[a].problems_completed = [...new Set(byAttempt[a].problems_completed)].sort();
    const statuses = byAttempt[a].logs.map((l) => l.status);
    byAttempt[a].status = !byAttempt[a].logs.length ? 'pending' : statuses.includes('started') ? 'running' : statuses.includes('cancelled') ? 'cancelled' : statuses.every((s) => s === 'success') ? 'done' : statuses.includes('error') ? 'error' : 'done';
  }
  if (grader) await grader.close();
  if (!items.length && !mergeRuns.length) throw new Error(`no graded samples found under ${sources.map((s) => s.dir).join(', ')}`);

  // Other QEDRank runs merged in for a cross-harness comparison: their records keep their
  // own harness label and get a distinct provider id.
  const merged = [];
  for (const other of mergeRuns) {
    const otherDir = path.join(config.runsDir, other);
    const otherRun = await readJson(path.join(otherDir, 'run.json'), null);
    if (!otherRun) throw new Error(`merge run not found: ${otherDir}`);
    const otherManifest = (await readJson(path.join(otherDir, 'manifest.json'), null)) || { papers: [] };
    const hid = otherRun.protocol === 'agent' ? (otherRun.harness_protocol?.id || 'agent') : 'qedrank-single';
    const suffix = `__${slug(hid)}`;
    const itemsDir = path.join(otherDir, 'items');
    for (const key of await fs.readdir(itemsDir).catch(() => [])) {
      for (const f of await fs.readdir(path.join(itemsDir, key)).catch(() => [])) {
        if (!/^attempt-a\d+r\d+\.json$/.test(f)) continue;
        const r = await readJson(path.join(itemsDir, key, f));
        if (r.target_kind !== AGENT_TARGET) continue;
        r.provider = `${r.provider}${suffix}`;
        r.item_key = itemKey(r.paper_id, r.target_kind, r.provider);
        r.model_display_name = `${r.model_display_name} · ${hid}`;
        r.harness = r.harness || hid;
        r.status = r.status || classifyAttempt({ infrastructure: Boolean(r.outcomes?.infrastructure_failure), solved: r.outcomes?.verified === 1, partial: r.partial ?? null });
        if (!r.failure && r.status !== 'fully_solved') r.failure = classifyFailure({ reasons: r.grade?.reasons || [], compilerOutput: r.compiler_output || '', abstained: Boolean(r.abstained), truncated: Boolean(r.generation?.truncated), infrastructure: Boolean(r.outcomes?.infrastructure_failure) && !r.generation?.error, sampleError: r.generation?.error?.kind === 'timeout' || r.generation?.error?.kind === 'rate_limited' ? `${r.generation.error.kind}: ${r.generation.error.message}` : null });
        r.merged_from = other;
        merged.push(r);
        const dir = path.join(runDir, 'items', slug(r.item_key));
        await ensureDir(dir);
        await writeJson(path.join(dir, f), r);
        if (!problems.has(r.paper_id)) {
          const p = otherManifest.papers?.find((x) => x.paper_id === r.paper_id);
          problems.set(r.paper_id, { paper_id: r.paper_id, title: p?.title ?? null, difficulty: p?.difficulty ?? null, subject_tags: p?.subject_tags ?? [], msc: [], publication_date: p?.publication_date ?? null, mathematical_status: r.mathematical_status, declaration_name: null });
        }
      }
    }
    log(`merged ${merged.filter((r) => r.merged_from === other).length} record(s) from run ${other} as harness ${hid}`);
  }

  const all = [...items, ...merged];
  const models = [...new Set(all.map((r) => r.provider))];
  const papers = [...problems.values()].sort((a, b) => a.paper_id.localeCompare(b.paper_id)).map((p) => ({
    paper_id: p.paper_id, title: p.title, difficulty: p.difficulty ?? null, subject_tags: p.subject_tags || [], msc: p.msc || [], publication_date: p.publication_date ?? null, public_formal_proof: null, requires_figures: 'unknown', bridge_checks: [], flags: [],
    targets: Object.fromEntries(TARGET_KINDS.map((k) => [k, k === AGENT_TARGET ? { target_kind: k, mathematical_status: p.mathematical_status, declaration_name: p.declaration_name } : null])),
  }));
  const first = protocols[0]?.protocol || null;
  const mismatches = [];
  if (first) {
    const ref = protocolKey(first);
    for (const { model, attempt, protocol } of protocols.slice(1)) { const k = protocolKey(protocol); for (const f of Object.keys(ref)) if (k[f] !== ref[f]) mismatches.push({ field: f, model, attempt, value: k[f], reference_model: protocols[0].model, reference_value: ref[f] }); }
  }
  if (mismatches.length) log(`WARNING: the logs differ in ${[...new Set(mismatches.map((m) => m.field))].join(', ')}; not every attempt ran under one protocol`);
  const planned = attemptsPlanned ?? Math.max(1, ...Object.keys(byAttempt).map(Number), ...all.map((r) => r.attempt));
  const problemIds = papers.map((p) => p.paper_id);
  for (let a = 1; a <= planned; a += 1) {
    byAttempt[a] = byAttempt[a] || { attempt: a, dir: null, logs: [], problems_completed: [], status: 'pending' };
    byAttempt[a].problems_missing = problemIds.filter((p) => !byAttempt[a].problems_completed.includes(p));
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    source: { kind: 'proofbench_harness', url: settings.statementsUrl, commit: first?.statements_commit ?? null, dirty: null, path: settings.statements, subdir: 'ProofBench' },
    papers,
    counts: { papers: papers.length, expected_count: null, expected_count_matches: null, papers_with_pdf: null, targets: { [AGENT_TARGET]: papers.length } },
  };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  const sessionsMax = first?.limits?.sessions ?? Math.max(1, ...items.map((i) => i.agent?.sessions_max || 1));
  const run = {
    schema: RUN_SCHEMA,
    run_id: runId,
    created_at: existing?.created_at || isoNow(),
    updated_at: isoNow(),
    protocol: 'agent',
    mode: 'agent',
    task: 'prove',
    models,
    model_ids: Object.fromEntries(all.map((r) => [r.provider, r.model_id])),
    model_facts: Object.fromEntries(all.map((r) => [r.provider, modelFacts(r.model_id, config.modelFacts || {})])),
    harness: { commit: first?.commit ?? null, short: (first?.commit || '').slice(0, 10) || null, dirty: first?.dirty ?? null, source: 'proofbench-eval-apptainer', branch: null, changed_files: [] },
    harness_protocol: first,
    harnesses: [HARNESS_ID, ...mergeRuns.map(() => null)].filter(Boolean).concat([...new Set(merged.map((r) => r.harness))]),
    sandbox: first ? { id: first.image_id, image: settings.image, type: first.sandbox } : null,
    source: manifest.source,
    toolchain: { toolchain: first?.lean_toolchain ?? null, mathlib: { rev: first?.mathlib_commit ?? null }, dependencies: null },
    prompt_template_version: first ? `proofbench-eval-apptainer@${(first.commit || '').slice(0, 10)}` : null,
    settings: { attempts: planned, max_sessions: sessionsMax, limits: first?.limits ?? null, web_search: first?.search ?? null, network: first?.network ?? null, comparator: first?.comparator ?? null, grader: { layer1: 'image/check_proof.py', layer2: first?.comparator === false ? 'off' : 'leanprover/comparator' }, tools: first?.tools ?? null, effort: first?.effort ?? null, temperature: first?.model_generate_config?.temperature ?? null, max_tokens: first?.limits?.max_tokens ?? null },
    primary_endpoint: { id: 'fully_solved_attempt1', description: `Fully solved at attempt 1: the final submission passes check_proof.py (statement and definitions unchanged, allowed imports, no sorry/axiom/native_decide, helper files build, main file compiles, standard axioms only) and ${first?.comparator === false ? 'Comparator was off in this run' : 'Comparator (kernel replay against the trusted statement module)'}. Claims that are not established are excluded. Attempts are independent Inspect runs; pass@k uses all of them.` },
    attempts: { planned, by_attempt: byAttempt, logs_read: logsRead },
    protocol_mismatches: mismatches,
    bundles: null,
    counting_rules: COUNTING_RULES,
    machine: await machineInfo(),
    regrade: regrade ? { lean_project: regrade.leanProject, assessed: items.filter((i) => i.partial?.assessed).length } : null,
    merged_runs: mergeRuns,
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: s === 'statistics' ? 'pending' : 'done', updated_at: isoNow(), imported: true }])),
    selection: { papers: problemIds, models, targets: [AGENT_TARGET] },
  };
  await writeJson(path.join(runDir, 'run.json'), run);
  await writeJson(path.join(runDir, 'progress.json'), { items: { total: all.length, done: all.length, by_status: countBy(all, (r) => r.status) }, attempts: Object.fromEntries(Object.values(byAttempt).map((b) => [b.attempt, { status: b.status, completed: b.problems_completed.length, missing: b.problems_missing?.length ?? 0 }])), updated_at: isoNow() });
  log(`imported ${items.length} attempt record(s) (${logsRead} log(s), ${Object.keys(byAttempt).length} attempt slot(s)) for ${models.length} model(s) and ${papers.length} problem(s) into ${runDir}`);
  return { runDir, run, items: all.length, models, mismatches, byAttempt };
}

function countBy(xs, fn) {
  const out = {};
  for (const x of xs) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

/** QEDRank's grader bound to a pinned Lean project, for the partial-progress assessment. */
export async function makeRegrader({ config, leanProject, cacheDir, log }) {
  const { detectToolchain, LeanRunner } = await import('../lean.js');
  const { gradeSubmission, DEFAULT_GRADE_POLICY } = await import('../grade.js');
  const toolchain = await detectToolchain(leanProject, { log });
  const runner = new LeanRunner(toolchain, { ...config.lean, log });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qedrank-regrade-'));
  const policy = { ...DEFAULT_GRADE_POLICY, libraryPrefixes: ['ProofBench.Mathlib_Problems', 'Matroid', 'Archive.Sensitivity'], kernelReplay: false };
  return {
    async grade({ challengeSrc, solutionSrc, target, id }) {
      const dir = path.join(scratch, slug(id));
      await ensureDir(dir);
      log(`regrade ${id}: compiling the final file in ${leanProject}`);
      return gradeSubmission({ runner, toolchain, challengeSrc, solutionSrc, target, scratchDir: dir, cacheDir, policy, allowedAxioms: config.allowedAxioms, log: () => {} });
    },
    async close() { await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); },
  };
}

export { exists };
