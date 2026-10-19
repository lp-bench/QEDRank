// Agent runs: results of the Inspect AI harness (harness/) brought into a QEDRank run
// directory, so that the same statistics apply to them as to the single-call baseline.
//
// One record per problem, model and epoch: the whole session chain. `verified` means the
// independent Lean check passed in one of the sessions; a check that could not be carried
// out is an infrastructure failure, excluded from every denominator and counted.

import path from 'node:path';
import { ITEM_SCHEMA, RUN_SCHEMA, MANIFEST_SCHEMA, STAGES, TARGET_KINDS, itemKey } from './schema.js';
import { ensureDir, exists, isoNow, readJson, slug, writeJson } from './util.js';
import { contaminationOf } from './evaluate.js';
import { modelFacts } from '../../lib/model-facts.js';

export const AGENT_BUNDLE_SCHEMA = 'proofbench-agent-bundle-v1';
export const AGENT_TARGET = 'main_theorem';

/** 'anthropic/claude-fable-5-1' -> 'anthropic_claude-fable-5-1' (safe as a key and a directory name). */
export function providerIdOf(model) {
  return slug(String(model).replace(/\//g, '_'));
}

/** The model id as the vendor writes it: the part after the provider prefix. */
export function modelIdOf(model) {
  const s = String(model);
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
}

const ms = (seconds) => (typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null);
const SCREEN_REASONS = ['static_screen_rejected', 'disallowed_import', 'challenge_import_removed'];

function compileStatusOf(grade) {
  const s = grade?.checks?.compile?.status;
  if (s === 'not_attempted' && (grade.reasons || []).some((r) => SCREEN_REASONS.includes(r))) return 'rejected_by_static_screen';
  return s || 'not_attempted';
}

/**
 * One harness sample -> one item record.
 * @param {object} sample   entry of bundle.samples
 * @param {object} bundle   the bundle it came from (model, run metadata)
 * @param {object} [opts]
 * @param {object} [opts.modelFactsExtra]  "modelFacts" of the run config
 */
export function agentItem(sample, bundle, { modelFactsExtra = {} } = {}) {
  const provider = providerIdOf(bundle.model);
  const modelId = modelIdOf(bundle.model);
  const facts = modelFacts(modelId, modelFactsExtra);
  const problem = sample.problem || {};
  const paperId = String(problem.problem_id);
  const chain = sample.chain || null;
  const grade = chain?.final_grade || null;
  const verdict = chain?.final_verdict ?? 'not_graded';
  const totals = chain?.totals || {};
  const status = problem.mathematical_status || 'uncertain';
  const infra = !chain || Boolean(sample.error) || verdict === 'grader_error' || verdict === 'not_graded';
  const proofTrack = status === 'established';
  const compileStatus = compileStatusOf(grade);
  const compiled = compileStatus === 'compiler_success' ? 1 : ['compiler_failure', 'timeout', 'rejected_by_static_screen'].includes(compileStatus) ? 0 : null;
  const statement = grade?.checks?.statement?.status ?? null;
  const axioms = grade?.checks?.axioms || null;
  const sorryFree = grade?.checks?.sorry ? grade.checks.sorry.file_sorry_free || (grade.policy?.allowUnusedSorry && grade.checks.sorry.target_sorry_free) : null;
  const notes = [...(grade?.warnings || [])];
  if (sample.error) notes.push(`sample_error: ${String(sample.error).slice(0, 300)}`);
  if (verdict === 'grader_error') notes.push(`grader_error: ${(grade?.reasons || []).join(', ')}`);
  if (status === 'open' && verdict === 'solved') notes.push('ESCALATE: apparent proof of an open claim - independent mathematical review required');
  const eligReasons = [];
  if (!proofTrack) eligReasons.push(`mathematical_status_${status}`);
  return {
    schema: ITEM_SCHEMA,
    item_key: itemKey(paperId, AGENT_TARGET, provider),
    paper_id: paperId,
    target_kind: AGENT_TARGET,
    provider,
    model_display_name: bundle.model,
    model_id: modelId,
    model_label: bundle.model,
    api_host: null,
    response_model: null,
    setting: 'agent',
    attempt: sample.epoch ?? 1,
    repair_round: 0,
    mathematical_status: status,
    reference_proof_status: null,
    reference_statement_available: true,
    contamination: contaminationOf({ publication_date: problem.publication_date ?? null, public_formal_proof: problem.public_formal_proof ?? null }, { facts }),
    generation: {
      mode: 'agent',
      error: sample.error ? { kind: 'sample_error', message: String(sample.error).slice(0, 1000), http_status: null } : null,
      observed_latency_ms: ms(totals.total_s),
      working_ms: ms(totals.working_s),
      // Inspect counts cached prompt tokens apart from input_tokens.
      usage: chain ? { inputTokens: totals.input_tokens ?? null, outputTokens: totals.output_tokens ?? null, reasoningTokens: totals.reasoning_tokens ?? null, cachedInputTokens: totals.cache_read_tokens ?? null, cacheWriteTokens: totals.cache_write_tokens ?? null } : null,
      effort: chain?.model?.reasoning_effort ?? bundle.model_generate_config?.reasoning_effort ?? null,
      temperature: chain?.model?.temperature ?? null,
      prompt_template_version: chain?.prompt_version ?? null,
      truncated: false,
    },
    parse: null,
    confidence: { statement: null, proof: null },
    abstained: false,
    static_screen: grade?.checks?.static_screen ?? null,
    compile: { status: compileStatus, error_count: grade?.checks?.compile?.error_count ?? null, duration_ms: grade?.timing?.compile_ms ?? null, messages: [] },
    audit: { status: axioms?.status === 'placeholder' ? 'placeholder' : axioms?.status ?? 'not_audited', axioms: axioms?.axioms ?? [], kernel_replay: grade?.checks?.kernel_replay?.status ?? null, file_sorry_free: grade?.checks?.sorry?.file_sorry_free ?? null },
    ab_consistency: null,
    comparison: grade?.checks?.statement ? { method: 'compiled_declarations', evidence: { notes: [] }, ...grade.checks.statement } : null,
    statement_match: statement === 'unchanged' ? 'definitionally_identical' : statement === 'changed' ? 'different' : 'not_evaluated',
    statement_match_source: statement ? 'compiled_declarations' : null,
    loc: grade?.proof ? { model: { total: grade.proof.solution_total_lines, code: grade.proof.solution_code_lines, proof: { code: grade.proof.proof_lines } }, reference: null, rule: grade.proof.rule } : null,
    timing: { lean_compile_ms: grade?.timing?.compile_ms ?? null, lean_total_ms: ms(totals.grade_s), evaluation_total_ms: ms(totals.grade_s), total_ms: ms(totals.total_s), working_ms: ms(totals.working_s), model_ms: ms(totals.model_s), tool_ms: ms(totals.tool_s), waiting_ms: ms(totals.waiting_s) },
    eligibility: { statement_track: true, proof_track: proofTrack, reasons: eligReasons },
    outcomes: {
      infrastructure_failure: infra,
      compiled: infra ? null : compiled,
      audit_clean: infra || compiled !== 1 ? null : axioms?.status === 'clean' && sorryFree ? 1 : 0,
      statement_faithful: infra ? null : statement === 'unchanged' ? 1 : 0,
      verified: infra || !proofTrack ? null : verdict === 'solved' ? 1 : 0,
    },
    agent: {
      epoch: sample.epoch ?? 1,
      sessions_max: chain?.sessions_max ?? null,
      sessions_used: chain?.sessions_used ?? null,
      solved_at_session: chain?.solved_at_session ?? null,
      final_verdict: verdict,
      final_reasons: chain?.final_reasons ?? [],
      web_search: chain?.web_search ?? bundle.run_metadata?.web_search ?? null,
      network: chain?.network ?? bundle.run_metadata?.network ?? null,
      limits: chain?.limits ?? null,
      tools: chain?.tools ?? [],
      sessions: (chain?.sessions || []).map((s) => ({ ...s, working_ms: ms(s.working_s), total_ms: ms(s.total_s) })),
      totals: { model_calls: totals.model_calls ?? null, tool_calls: totals.tool_calls ?? null, tool_calls_by_tool: totals.tool_calls_by_tool ?? {}, cost_usd: totals.cost_usd ?? null },
      completeness: grade?.completeness ?? { available: false, reason: 'not_graded' },
      search: { queries: chain?.search?.queries ?? [], lean_search_queries: chain?.search?.lean_search_queries ?? [], urls: chain?.search?.urls ?? [], result_urls: chain?.search?.result_urls ?? [] },
      manual_audit: null,
      inspect: { total_time_s: sample.inspect_total_time_s ?? null, working_time_s: sample.inspect_working_time_s ?? null, sample_limit: sample.sample_limit ?? null },
    },
    notes,
    evaluation_complete: true,
  };
}

/** Fields that must agree between bundles for their models to be comparable. */
function protocolOf(bundle) {
  const m = bundle.run_metadata || {};
  return {
    harness_commit: m.harness?.commit ?? null,
    problem_set_commit: m.problem_set?.commit ?? null,
    lean_toolchain: m.lean?.lean_toolchain ?? null,
    mathlib_commit: m.lean?.mathlib_commit ?? null,
    sandbox_image: m.sandbox?.id ?? m.sandbox?.image ?? null,
    web_search: m.web_search ?? null,
    max_sessions: m.max_sessions ?? null,
    session_output_tokens: m.limits?.session_output_tokens ?? null,
    prompt_version: m.prompt_version ?? null,
    grader: JSON.stringify(m.grader ?? null),
  };
}

export function protocolMismatches(bundles) {
  const first = protocolOf(bundles[0]);
  const out = [];
  for (const b of bundles.slice(1)) {
    const p = protocolOf(b);
    for (const k of Object.keys(first)) if (p[k] !== first[k]) out.push({ field: k, model: b.model, value: p[k], reference_model: bundles[0].model, reference_value: first[k] });
  }
  return out;
}

function unpack(file) {
  if (file?.schema !== AGENT_BUNDLE_SCHEMA) throw new Error(`not a ${AGENT_BUNDLE_SCHEMA} file`);
  return Array.isArray(file.bundles) ? file.bundles : [file];
}

/**
 * Create a run directory from harness bundles: run.json, manifest.json and one item record per
 * problem, model and epoch. Statistics are then computed by the ordinary `stats` stage.
 */
export async function importAgentBundles({ config, runId, files, force = false, log = () => {} }) {
  const bundles = [];
  for (const f of files) bundles.push(...unpack(await readJson(f)));
  if (!bundles.length) throw new Error('no bundles to import');
  const runDir = path.join(config.runsDir, runId);
  if ((await exists(path.join(runDir, 'run.json'))) && !force) throw new Error(`Run already exists: ${runDir} (use --force to replace its agent records)`);
  await ensureDir(runDir);

  const models = [...new Set(bundles.map((b) => providerIdOf(b.model)))];
  const items = bundles.flatMap((b) => (b.samples || []).map((s) => agentItem(s, b, { modelFactsExtra: config.modelFacts || {} })));
  for (const it of items) await writeJson(path.join(runDir, 'items', slug(it.item_key), `attempt-a${it.attempt}r0.json`), it);

  // Problems: the union over bundles, labels as the harness recorded them.
  const problems = new Map();
  for (const b of bundles) for (const s of b.samples || []) if (!problems.has(String(s.problem.problem_id))) problems.set(String(s.problem.problem_id), s.problem);
  const papers = [...problems.values()].sort((a, b) => String(a.problem_id).localeCompare(String(b.problem_id))).map((p) => ({
    paper_id: String(p.problem_id),
    title: p.title ?? null,
    difficulty: p.difficulty ?? null,
    subject_tags: p.subject ? [String(p.subject).split(/\s+/)[0]] : [],
    publication_date: p.publication_date ?? null,
    public_formal_proof: p.public_formal_proof ?? null,
    requires_figures: 'unknown',
    bridge_checks: [],
    flags: (p.notes || []).map((n) => ({ code: 'harness_note', message: n, paths: [] })),
    targets: Object.fromEntries(TARGET_KINDS.map((k) => [k, k === AGENT_TARGET ? { target_kind: k, mathematical_status: p.mathematical_status || 'uncertain', declaration_name: p.target ?? null } : null])),
  }));
  const meta = bundles[0].run_metadata || {};
  const manifest = {
    schema: MANIFEST_SCHEMA,
    source: { kind: 'proofbench_harness', commit: meta.problem_set?.commit ?? null, dirty: meta.problem_set?.dirty ?? null, path: meta.problem_set?.path ?? null },
    papers,
    counts: { papers: papers.length, expected_count: null, expected_count_matches: null, papers_with_pdf: null, targets: { [AGENT_TARGET]: papers.length } },
  };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);

  const mismatches = protocolMismatches(bundles);
  if (mismatches.length) log(`WARNING: the bundles differ in ${[...new Set(mismatches.map((m) => m.field))].join(', ')}; their models did not run under one protocol`);
  const maxSessions = meta.max_sessions ?? Math.max(1, ...items.map((i) => i.agent.sessions_max || 1));
  const run = {
    schema: RUN_SCHEMA,
    run_id: runId,
    created_at: isoNow(),
    updated_at: isoNow(),
    protocol: 'agent',
    mode: 'agent',
    models,
    model_ids: Object.fromEntries(bundles.map((b) => [providerIdOf(b.model), modelIdOf(b.model)])),
    model_facts: Object.fromEntries(bundles.map((b) => [providerIdOf(b.model), modelFacts(modelIdOf(b.model), config.modelFacts || {})])),
    harness: meta.harness ?? null,
    sandbox: meta.sandbox ?? null,
    source: manifest.source,
    toolchain: { toolchain: meta.lean?.lean_toolchain ?? null, mathlib: { rev: meta.lean?.mathlib_commit ?? null }, dependencies: meta.lean?.dependencies ?? null },
    prompt_template_version: meta.prompt_version ?? null,
    settings: { max_sessions: maxSessions, limits: meta.limits ?? null, web_search: meta.web_search ?? null, network: meta.network ?? null, grader: meta.grader ?? null, tools: meta.tools_requested ?? null },
    primary_endpoint: {
      id: 'solved_within_sessions',
      description: `Solved within ${maxSessions} session${maxSessions === 1 ? '' : 's'}: after one of them the independent Lean check passed (the file compiles in a clean environment without errors or sorry, the main theorem depends only on the standard axioms, its statement and every definition of the challenge are unchanged, and the declarations replay through the kernel). Claims that are not established are excluded.`,
    },
    protocol_mismatches: mismatches,
    bundles: bundles.map((b) => ({ model: b.model, inspect: b.inspect ?? null, model_generate_config: b.model_generate_config ?? null, samples: (b.samples || []).length })),
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: s === 'statistics' ? 'pending' : 'done', updated_at: isoNow(), imported: true }])),
    selection: { papers: papers.map((p) => p.paper_id), models, targets: [AGENT_TARGET] },
  };
  await writeJson(path.join(runDir, 'run.json'), run);
  await writeJson(path.join(runDir, 'progress.json'), { items: { total: items.length, done: items.length }, updated_at: isoNow() });
  log(`imported ${items.length} agent record(s) for ${models.length} model(s) and ${papers.length} problem(s) into ${runDir}`);
  return { runDir, run, items: items.length, models, mismatches };
}

/**
 * Apply the hand audit of solved problems (runs/<id>/review/audit.json):
 *   { "<item_key>": { "status": "confirmed" | "rejected", "reviewer": "…", "note": "…", "date": "…" } }
 * A rejected solve no longer counts; an unaudited solve still counts and is listed as awaiting audit.
 */
export function applyManualAudit(items, audit = {}) {
  for (const r of items) {
    if (r.setting !== 'agent' || !r.agent) continue;
    const d = audit[r.item_key];
    if (!d || !['confirmed', 'rejected'].includes(d.status)) continue;
    r.agent.manual_audit = { status: d.status, reviewer: d.reviewer ?? null, note: d.note ?? null, date: d.date ?? null };
    if (d.status === 'rejected' && r.outcomes.verified === 1) {
      r.outcomes.verified = 0;
      r.notes = [...(r.notes || []), `manual audit rejected the solve${d.note ? `: ${d.note}` : ''}`];
    }
  }
  return items;
}
