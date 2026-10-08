// Item-level and matrix exports (CSV + JSON).

import path from 'node:path';
import { toCsv, writeJson, writeText, round } from './util.js';
import { matrixRows } from './metrics.js';

export const ITEM_COLUMNS = [
  'run_id', 'harness_commit', 'source_commit', 'item_key', 'paper_id', 'target_kind', 'provider', 'model', 'model_id', 'api_host', 'response_model', 'task', 'setting', 'attempt', 'repair_round',
  'difficulty', 'model_released', 'model_training_cutoff', 'model_parameters_b', 'problem_publication_date', 'published_before_cutoff',
  'mathematical_status', 'reference_proof_status', 'reference_statement_available', 'eligible_statement_track', 'eligible_proof_track', 'eligibility_reasons',
  'infrastructure_failure', 'generation_error', 'abstained', 'statement_confidence', 'proof_confidence',
  'compile_status', 'compile_error_count', 'compile_first_error', 'lean_diagnostics', 'static_screen_rejections',
  'audit_status', 'axioms', 'audit_static_flags', 'ab_consistent',
  'statement_match', 'statement_match_source', 'statement_match_method', 'comparison_notes',
  'compiled', 'audit_clean', 'statement_faithful', 'verified',
  'observed_latency_ms', 'lean_compile_ms', 'lean_total_ms', 'evaluation_total_ms', 'total_item_ms', 'working_item_ms',
  'sessions_max', 'sessions_used', 'solved_at_session', 'model_calls', 'tool_calls', 'completeness', 'web_search', 'search_queries', 'urls_fetched',
  'input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_tokens', 'reasoning_chars', 'provider_attempts', 'retry_wait_ms', 'output_truncated', 'cost_usd',
  'model_total_lines', 'model_code_lines', 'model_proof_lines', 'reference_code_lines', 'reference_proof_lines',
  'prompt_hash', 'prompt_template_version', 'temperature', 'max_tokens', 'notes',
];

export function flattenItem(r, { runId = null, sourceCommit = null, pricing = {}, harnessCommit = null, facts = null, difficulty = null } = {}) {
  const firstErr = (r.compile?.messages || []).find((m) => m.severity === 'error');
  const diags = (r.compile?.messages || []).filter((m) => m.severity === 'error').slice(0, 10).map((m) => `${m.line}:${m.column}: ${m.text}`).join(' || ');
  const price = pricing[r.model_id];
  const u = r.generation?.usage;
  const cost = typeof r.agent?.totals?.cost_usd === 'number' ? r.agent.totals.cost_usd
    : price && u && u.inputTokens !== null && u.outputTokens !== null ? (u.inputTokens / 1e6) * (price.input ?? 0) + (u.outputTokens / 1e6) * (price.output ?? 0) : null;
  return {
    run_id: runId,
    harness_commit: harnessCommit,
    source_commit: sourceCommit,
    item_key: r.item_key,
    paper_id: r.paper_id,
    target_kind: r.target_kind,
    provider: r.provider,
    model: r.model_display_name,
    model_id: r.model_id,
    api_host: r.api_host ?? null,
    response_model: r.response_model ?? null,
    task: r.task ?? (r.setting === 'agent' ? 'agent' : 'formalize'),
    setting: r.setting,
    attempt: r.attempt,
    repair_round: r.repair_round,
    difficulty,
    model_released: facts?.released ?? null,
    model_training_cutoff: facts?.training_cutoff ?? r.contamination?.model_training_cutoff ?? null,
    model_parameters_b: facts?.parameters_b ?? null,
    problem_publication_date: r.contamination?.problem_publication_date ?? null,
    published_before_cutoff: r.contamination?.published_before_cutoff ?? null,
    mathematical_status: r.mathematical_status,
    reference_proof_status: r.reference_proof_status,
    reference_statement_available: r.reference_statement_available,
    eligible_statement_track: r.eligibility?.statement_track,
    eligible_proof_track: r.eligibility?.proof_track,
    eligibility_reasons: (r.eligibility?.reasons || []).join('|'),
    infrastructure_failure: r.outcomes?.infrastructure_failure,
    generation_error: r.generation?.error ? `${r.generation.error.kind}: ${r.generation.error.message}` : null,
    abstained: r.abstained,
    statement_confidence: r.confidence?.statement ?? null,
    proof_confidence: r.confidence?.proof ?? null,
    compile_status: r.compile?.status ?? null,
    compile_error_count: r.compile?.error_count ?? null,
    compile_first_error: firstErr ? `${firstErr.line}:${firstErr.column}: ${firstErr.text.slice(0, 300)}` : null,
    lean_diagnostics: diags.slice(0, 4000),
    static_screen_rejections: (r.static_screen?.rejections || []).map((x) => `${x.code}:${x.text}`).join('|'),
    audit_status: r.audit?.status ?? null,
    axioms: (r.audit?.axioms || []).join('|'),
    audit_static_flags: (r.audit?.static_flags || []).join('|'),
    ab_consistent: r.ab_consistency?.consistent ?? null,
    statement_match: r.statement_match,
    statement_match_source: r.statement_match_source,
    statement_match_method: r.comparison?.method ?? null,
    comparison_notes: (r.comparison?.evidence?.notes || []).join(' | '),
    compiled: r.outcomes?.compiled,
    audit_clean: r.outcomes?.audit_clean,
    statement_faithful: r.outcomes?.statement_faithful,
    verified: r.outcomes?.verified,
    observed_latency_ms: round(r.generation?.observed_latency_ms, 0),
    lean_compile_ms: round(r.timing?.lean_compile_ms, 0),
    lean_total_ms: round(r.timing?.lean_total_ms, 0),
    evaluation_total_ms: round(r.timing?.evaluation_total_ms, 0),
    total_item_ms: round(r.timing?.total_ms ?? ((r.generation?.observed_latency_ms ?? 0) + (r.timing?.evaluation_total_ms ?? 0)), 0),
    working_item_ms: round(r.timing?.working_ms, 0),
    sessions_max: r.agent?.sessions_max ?? null,
    sessions_used: r.agent?.sessions_used ?? null,
    solved_at_session: r.agent?.solved_at_session ?? null,
    model_calls: r.agent?.totals?.model_calls ?? null,
    tool_calls: r.agent?.totals?.tool_calls ?? null,
    completeness: r.agent?.completeness?.score ?? r.grade?.completeness?.score ?? null,
    web_search: r.agent?.web_search ?? null,
    search_queries: r.agent?.search?.queries?.length ?? null,
    urls_fetched: r.agent?.search?.urls?.length ?? null,
    input_tokens: u?.inputTokens ?? null,
    output_tokens: u?.outputTokens ?? null,
    cached_input_tokens: u?.cachedInputTokens ?? null,
    reasoning_tokens: u?.reasoningTokens ?? null,
    reasoning_chars: r.generation?.reasoning_chars ?? null,
    provider_attempts: r.generation?.provider_attempts ?? null,
    retry_wait_ms: r.generation?.retry_wait_ms ?? null,
    output_truncated: r.generation?.truncated ?? null,
    cost_usd: cost === null ? null : round(cost, 6),
    model_total_lines: r.loc?.model?.total ?? null,
    model_code_lines: r.loc?.model?.code ?? null,
    model_proof_lines: r.loc?.model?.proof?.code ?? null,
    reference_code_lines: r.loc?.reference?.code ?? null,
    reference_proof_lines: r.loc?.reference?.proof?.code ?? null,
    prompt_hash: r.generation?.prompt_hash ?? null,
    prompt_template_version: r.generation?.prompt_template_version ?? null,
    temperature: r.generation?.temperature ?? null,
    max_tokens: r.generation?.max_tokens ?? null,
    notes: (r.notes || []).join(' | '),
  };
}

export async function writeExports(runDir, { items, summary, run, config, manifest = null }) {
  const dir = path.join(runDir, 'exports');
  const difficultyOf = new Map((manifest?.papers || []).map((p) => [p.paper_id, p.difficulty ?? null]));
  const factsOf = new Map((summary.models || []).map((m) => [m.id, m.facts ?? null]));
  const rows = items.map((r) => flattenItem(r, { runId: run.run_id, sourceCommit: run.source?.commit ?? null, pricing: config.pricing || {}, harnessCommit: run.harness?.commit ?? null, facts: factsOf.get(r.provider) ?? null, difficulty: difficultyOf.get(r.paper_id) ?? null }));
  await writeText(path.join(dir, 'items.csv'), toCsv(rows, ITEM_COLUMNS));
  await writeJson(path.join(dir, 'items.json'), { schema: 'qedrank-items-v1', run_id: run.run_id, source_commit: run.source?.commit ?? null, count: rows.length, items: rows });
  const mrows = matrixRows(summary);
  await writeText(path.join(dir, 'matrix.csv'), toCsv(mrows));
  await writeJson(path.join(dir, 'matrix.json'), { schema: 'qedrank-matrix-v1', run_id: run.run_id, rows: mrows });
  await writeJson(path.join(dir, 'summary.json'), summary);
  return { items_csv: path.join(dir, 'items.csv'), items_json: path.join(dir, 'items.json'), matrix_csv: path.join(dir, 'matrix.csv'), matrix_json: path.join(dir, 'matrix.json') };
}
