// Analyses that sit on top of the item records: effort by difficulty, difficulty proxies
// per problem, capability across model generations, the contamination split, and the
// session metrics of agent runs. Pure functions shared by the runner and the browser UI.
//
// Nothing here fits a curve or extrapolates. The tables are the inputs a forecast would
// need; whether the data support one is a decision for whoever reads them.

import { quantile, groupBy, round } from './util.js';
import { rate, bootstrapByPaper, timeSummary } from './stats.js';

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const nums = (xs) => xs.map(num).filter((x) => x !== null);
const med = (xs) => quantile(nums(xs), 0.5);
const sum = (xs) => { const v = nums(xs); return v.length ? v.reduce((a, b) => a + b, 0) : null; };

export const totalMsOf = (r) => num(r.timing?.total_ms) ?? ((r.generation?.observed_latency_ms ?? 0) + (r.timing?.evaluation_total_ms ?? 0));
export const workingMsOf = (r) => num(r.timing?.working_ms);

function rateWithCI(records, numFn, denFn, bootOpts) {
  const byPaper = groupBy(records, (r) => r.paper_id);
  const n = records.filter((r) => denFn(r) && numFn(r)).length;
  const d = records.filter(denFn).length;
  const ci = bootstrapByPaper([...byPaper.keys()], (sample) => {
    let a = 0;
    let b = 0;
    for (const p of sample) for (const r of byPaper.get(p)) { if (denFn(r)) { b += 1; if (numFn(r)) a += 1; } }
    return b > 0 ? a / b : null;
  }, bootOpts);
  return { num: n, den: d, value: d > 0 ? n / d : null, ci_lo: ci.lo, ci_hi: ci.hi };
}

const eligible = (r) => !r.outcomes?.infrastructure_failure && r.eligibility?.proof_track;
const solved = (r) => r.outcomes?.verified === 1;

/**
 * Effort of one group of records (analysis ii: difficulty against runtime, sessions and tokens).
 * Medians are over every attempt in the group, solved or not; the solved-only medians are separate
 * because an unsolved item usually runs to its budget.
 */
export function effortOf(records) {
  const ok = records.filter((r) => !r.outcomes?.infrastructure_failure);
  const won = ok.filter(solved);
  const pick = (rs) => ({
    n: rs.length,
    median_total_ms: round(med(rs.map(totalMsOf)), 0),
    median_working_ms: round(med(rs.map(workingMsOf)), 0),
    median_input_tokens: med(rs.map((r) => r.generation?.usage?.inputTokens)),
    median_output_tokens: med(rs.map((r) => r.generation?.usage?.outputTokens)),
    median_sessions: med(rs.map((r) => r.agent?.sessions_used)),
    median_tool_calls: med(rs.map((r) => r.agent?.totals?.tool_calls)),
    median_model_calls: med(rs.map((r) => r.agent?.totals?.model_calls)),
    median_proof_lines: med(rs.map((r) => r.loc?.model?.proof?.code)),
  });
  return { all: pick(ok), solved: pick(won), total_input_tokens: sum(ok.map((r) => r.generation?.usage?.inputTokens)), total_output_tokens: sum(ok.map((r) => r.generation?.usage?.outputTokens)) };
}

/** Effort by difficulty label and model. */
export function effortByDifficulty(records, models, papers) {
  const diffOf = new Map(papers.map((p) => [p.paper_id, p.difficulty || 'unlabeled']));
  const keys = [...new Set(papers.map((p) => p.difficulty || 'unlabeled'))].sort();
  const out = {};
  for (const key of keys) {
    out[key] = {};
    const inGroup = records.filter((r) => (diffOf.get(r.paper_id) || 'unlabeled') === key);
    for (const m of models) out[key][m] = effortOf(inGroup.filter((r) => r.provider === m));
    out[key].all_models = effortOf(inGroup);
  }
  return { by_difficulty: out, note: 'Medians over all attempts in the group ("all") and over solved attempts only ("solved"); unsolved attempts usually run to their budget, so the two answer different questions.' };
}

/**
 * Difficulty proxies per problem, from what the models did (section 2.4.1 of the protocol):
 * who solved it, the earliest-released and the smallest model that did, and the least effort a solve took.
 * A problem no model solved has null proxies; that is a lower bound on difficulty, not a measurement.
 */
export function difficultyProxies(records, models, papers, factsOf) {
  const paperById = new Map(papers.map((p) => [p.paper_id, p]));
  const rows = [];
  for (const [key, recs] of groupBy(records.filter(eligible), (r) => `${r.paper_id}__${r.target_kind}`)) {
    const first = recs[0];
    const paper = paperById.get(first.paper_id);
    const winners = recs.filter(solved);
    const withFacts = winners.map((r) => ({ r, f: factsOf(r.provider) || {} }));
    const earliest = withFacts.filter((x) => x.f.released).sort((a, b) => String(a.f.released).localeCompare(String(b.f.released)))[0] || null;
    const smallest = withFacts.filter((x) => num(x.f.parameters_b) !== null).sort((a, b) => a.f.parameters_b - b.f.parameters_b)[0] || null;
    const least = (fn) => { const xs = winners.map((r) => ({ r, v: num(fn(r)) })).filter((x) => x.v !== null).sort((a, b) => a.v - b.v); return xs[0] ? { model: xs[0].r.provider, value: xs[0].v } : null; };
    rows.push({
      key,
      paper_id: first.paper_id,
      target_kind: first.target_kind,
      human_difficulty: paper?.difficulty ?? null,
      reference_proof_lines: num(first.loc?.reference?.proof?.code),
      publication_date: paper?.publication_date ?? null,
      models_attempted: recs.length,
      models_solved: winners.length,
      solved_by: winners.map((r) => r.provider),
      earliest_solver: earliest ? { model: earliest.r.provider, released: earliest.f.released } : null,
      smallest_solver: smallest ? { model: smallest.r.provider, parameters_b: smallest.f.parameters_b } : null,
      solvers_without_release_date: withFacts.filter((x) => !x.f.released).map((x) => x.r.provider),
      solvers_without_parameter_count: withFacts.filter((x) => num(x.f.parameters_b) === null).map((x) => x.r.provider),
      least_working_ms: least(workingMsOf),
      least_output_tokens: least((r) => r.generation?.usage?.outputTokens),
      least_sessions: least((r) => r.agent?.solved_at_session),
      shortest_proof_lines: least((r) => r.loc?.model?.proof?.code),
    });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return {
    items: rows,
    note: 'Proxies only cover the models in this run. "Smallest solver" ignores models whose parameter count is not published, so it is the smallest among open-weight solvers. A problem with models_solved = 0 has no proxy values.',
  };
}

/**
 * Capability against release date (analysis iii): one row per model, oldest first.
 * Descriptive only. A trend needs several generations run under one protocol; the rows say how many there are.
 */
export function capabilityByRelease(records, models, factsOf, bootOpts, labelOf = (m) => m) {
  const rows = models.map((m) => {
    const f = factsOf(m) || {};
    const recs = records.filter((r) => r.provider === m);
    return {
      model: m,
      label: labelOf(m),
      released: f.released ?? null,
      training_cutoff: f.training_cutoff ?? null,
      parameters_b: num(f.parameters_b),
      active_parameters_b: num(f.active_parameters_b),
      verified: rateWithCI(recs, solved, eligible, bootOpts),
    };
  }).sort((a, b) => String(a.released ?? '9999').localeCompare(String(b.released ?? '9999')));
  const dated = rows.filter((r) => r.released && r.verified.den > 0);
  return {
    rows,
    models_with_release_date: dated.length,
    release_span: dated.length ? { from: dated[0].released, to: dated[dated.length - 1].released } : null,
    forecast: null,
    note: 'No trend is fitted and no forecast is made. Rows are comparable only when every model ran under the same protocol, budget and problem set; models released before a problem was published and models released after it are not the same experiment (see contamination).',
  };
}

/** Verified rate split by whether the problem's source was public before the model's training cutoff. */
export function contaminationSplit(records, models, bootOpts) {
  const out = {};
  for (const m of models) {
    const recs = records.filter((r) => r.provider === m);
    const part = (v) => recs.filter((r) => (r.contamination?.published_before_cutoff ?? null) === v);
    out[m] = {
      training_cutoff: recs.find((r) => r.contamination?.model_training_cutoff)?.contamination.model_training_cutoff ?? null,
      published_before_cutoff: rateWithCI(part(true), solved, eligible, bootOpts),
      published_after_cutoff: rateWithCI(part(false), solved, eligible, bootOpts),
      unknown: rateWithCI(part(null), solved, eligible, bootOpts),
      public_formal_proof_known: rateWithCI(recs.filter((r) => r.contamination?.public_formal_proof === true), solved, eligible, bootOpts),
    };
  }
  const dated = records.filter((r) => r.contamination?.problem_publication_date).length;
  return {
    by_model: out,
    items_with_publication_date: dated,
    items_total: records.length,
    note: 'A problem counts as possibly seen in training when its source was public before the model\'s training cutoff. "unknown" means the publication date or the cutoff is missing. A higher rate on problems published before the cutoff is a warning sign, not proof of memorisation.',
  };
}

/** Evaluation tiers reported side by side when the session limit reaches them. */
export const SESSION_TIERS = Object.freeze([1, 4, 16]);

/**
 * Session metrics of agent runs. `records` are primary agent records (one per problem and model).
 * solved_within[k] counts a problem as solved when the independent check passed in one of its first k sessions.
 */
export function agentSummary(records, models, bootOpts) {
  const agentRecs = records.filter((r) => r.setting === 'agent' && r.agent);
  if (!agentRecs.length) return null;
  const maxSessions = Math.max(...agentRecs.map((r) => r.agent.sessions_max || 1));
  const tiers = [...new Set([...SESSION_TIERS.filter((t) => t <= maxSessions), maxSessions])].sort((a, b) => a - b);
  const byModel = {};
  for (const m of models) {
    const recs = agentRecs.filter((r) => r.provider === m);
    const ok = recs.filter((r) => !r.outcomes?.infrastructure_failure);
    const won = ok.filter(solved);
    const tools = {};
    for (const r of ok) for (const [k, v] of Object.entries(r.agent.totals?.tool_calls_by_tool || {})) tools[k] = (tools[k] || 0) + v;
    const sessions = ok.flatMap((r) => r.agent.sessions || []);
    const unsolvedCompiling = ok.filter((r) => !solved(r) && num(r.agent.completeness?.score) !== null);
    byModel[m] = {
      problems: recs.length,
      infrastructure_failures: recs.length - ok.length,
      solved_within: Object.fromEntries(tiers.map((k) => [k, rateWithCI(recs, (r) => solved(r) && (r.agent.solved_at_session ?? Infinity) <= k, eligible, bootOpts)])),
      sessions_to_success: { ...timeSummary(won.map((r) => r.agent.solved_at_session)), distribution: countBy(won.map((r) => r.agent.solved_at_session)) },
      sessions_used: timeSummary(ok.map((r) => r.agent.sessions_used)),
      session_stop_reasons: countBy(sessions.map((s) => s.stop_reason || 'unknown')),
      sessions_ended_by_output_budget: rate(sessions.filter((s) => s.stop_reason === 'output_token_budget').length, sessions.length),
      verdict_reasons: countBy(ok.filter((r) => !solved(r)).flatMap((r) => r.agent.final_reasons || [])),
      totals: {
        input_tokens: sum(ok.map((r) => r.generation?.usage?.inputTokens)),
        output_tokens: sum(ok.map((r) => r.generation?.usage?.outputTokens)),
        total_ms: sum(ok.map(totalMsOf)),
        working_ms: sum(ok.map(workingMsOf)),
        model_calls: sum(ok.map((r) => r.agent.totals?.model_calls)),
        tool_calls: sum(ok.map((r) => r.agent.totals?.tool_calls)),
        tool_calls_by_tool: tools,
      },
      per_problem: {
        total_ms: timeSummary(ok.map(totalMsOf)),
        working_ms: timeSummary(ok.map(workingMsOf)),
        output_tokens: timeSummary(ok.map((r) => r.generation?.usage?.outputTokens)),
        tool_calls: timeSummary(ok.map((r) => r.agent.totals?.tool_calls)),
        model_calls: timeSummary(ok.map((r) => r.agent.totals?.model_calls)),
        proof_lines_solved: timeSummary(won.map((r) => r.loc?.model?.proof?.code)),
      },
      completeness_unsolved: {
        n: unsolvedCompiling.length,
        mean: unsolvedCompiling.length ? unsolvedCompiling.reduce((s, r) => s + r.agent.completeness.score, 0) / unsolvedCompiling.length : null,
        not_available: ok.filter((r) => !solved(r)).length - unsolvedCompiling.length,
        note: 'Mean completeness over unsolved problems whose final file compiles; a file that does not compile has no score.',
      },
      search: {
        problems_with_search: ok.filter((r) => (r.agent.search?.queries?.length || 0) > 0).length,
        queries: sum(ok.map((r) => r.agent.search?.queries?.length ?? 0)),
        urls: sum(ok.map((r) => r.agent.search?.urls?.length ?? 0)),
      },
      open_claim_escalations: ok.filter((r) => r.mathematical_status === 'open' && r.agent.final_verdict === 'solved').map((r) => r.item_key),
      awaiting_manual_audit: won.filter((r) => !r.agent.manual_audit).map((r) => r.item_key),
    };
  }
  const any = agentRecs[0].agent;
  return {
    sessions_max: maxSessions,
    tiers,
    web_search: any.web_search ?? null,
    network: any.network ?? null,
    limits: any.limits ?? null,
    by_model: byModel,
    note: 'Continued-session success: a later session starts from the previous session\'s file, compiler output and handoff note. These are not independent restarts.',
  };
}

function countBy(xs) {
  const out = {};
  for (const x of xs) { if (x === null || x === undefined) continue; out[x] = (out[x] || 0) + 1; }
  return out;
}
