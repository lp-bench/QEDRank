import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortOf, effortByDifficulty, difficultyProxies, capabilityByRelease, contaminationSplit, agentSummary } from '../lib/analysis.js';
import { publishedBeforeCutoff } from '../lib/evaluate.js';
import { modelFacts, MODEL_FACTS } from '../../lib/model-facts.js';
import { agentItem, applyManualAudit, protocolMismatches, providerIdOf, modelIdOf } from '../lib/agent.js';

const BOOT = { B: 200, seed: 7 };

function rec(paper, provider, { verified = 0, status = 'established', infra = false, total = 1000, working = 800, out = 500, sessions = 1, solvedAt = null, cutoff = null, published = null, release = null } = {}) {
  return {
    item_key: `${paper}__main_theorem__${provider}`, paper_id: paper, target_kind: 'main_theorem', provider, setting: 'agent', attempt: 1, repair_round: 0,
    mathematical_status: status, model_id: provider,
    eligibility: { statement_track: true, proof_track: status === 'established' },
    outcomes: { infrastructure_failure: infra, verified: infra || status !== 'established' ? null : verified, compiled: 1, audit_clean: verified, statement_faithful: 1 },
    generation: { usage: { inputTokens: 2000, outputTokens: out }, observed_latency_ms: total },
    timing: { total_ms: total, working_ms: working },
    loc: { model: { proof: { code: 10 } }, reference: { proof: { code: 40 } } },
    contamination: { model_training_cutoff: cutoff, problem_publication_date: published, published_before_cutoff: publishedBeforeCutoff(published, cutoff) },
    agent: { sessions_max: 4, sessions_used: sessions, solved_at_session: solvedAt, final_verdict: verified ? 'solved' : 'not_solved', final_reasons: verified ? [] : ['contains_sorry'], web_search: false, totals: { model_calls: 5 * sessions, tool_calls: 4 * sessions, tool_calls_by_tool: { bash: 3 * sessions, text_editor: sessions } }, sessions: Array.from({ length: sessions }, (_, i) => ({ index: i + 1, stop_reason: i + 1 === solvedAt ? 'agent_ended' : 'output_token_budget' })), completeness: { available: !verified, score: verified ? null : 0.25 }, search: { queries: [], urls: [] } },
  };
}

const papers = [
  { paper_id: 'P1', difficulty: 'Calibration', publication_date: '2010' },
  { paper_id: 'P2', difficulty: 'Research', publication_date: '2026-09' },
  { paper_id: 'P3', difficulty: 'Open', publication_date: null },
];
const facts = { old: { released: '2024-07-23', training_cutoff: '2023-12', parameters_b: 8 }, big: { released: '2026-09-01', training_cutoff: '2026-06', parameters_b: null } };
const items = [
  rec('P1', 'old', { verified: 1, solvedAt: 1, sessions: 1, cutoff: '2023-12', published: '2010' }),
  rec('P2', 'old', { verified: 0, sessions: 4, cutoff: '2023-12', published: '2026-09' }),
  rec('P3', 'old', { status: 'open', sessions: 4, cutoff: '2023-12' }),
  rec('P1', 'big', { verified: 1, solvedAt: 1, sessions: 1, cutoff: '2026-06', published: '2010', out: 300, working: 400 }),
  rec('P2', 'big', { verified: 1, solvedAt: 3, sessions: 3, cutoff: '2026-06', published: '2026-09' }),
  rec('P3', 'big', { status: 'open', verified: 1, solvedAt: 2, sessions: 2, cutoff: '2026-06' }),
];
const factsOf = (m) => facts[m];

test('published-before-cutoff compares dates at their shared precision and never guesses', () => {
  assert.equal(publishedBeforeCutoff('2010', '2023-12'), true);
  assert.equal(publishedBeforeCutoff('2026-09', '2026-06'), false);
  assert.equal(publishedBeforeCutoff('2026', '2026-06'), null, 'same year, order unknown');
  assert.equal(publishedBeforeCutoff('2026-06-15', '2026-06-15'), true);
  assert.equal(publishedBeforeCutoff(null, '2026-06'), null);
});

test('model facts come from the table by model id, with sources, and can be extended', () => {
  const llama = modelFacts('meta-llama-3.1-8b-instruct');
  assert.equal(llama.released, '2024-07-23');
  assert.equal(llama.parameters_b, 8);
  assert.match(llama.sources.released, /^https:\/\//);
  for (const [id, f] of Object.entries(MODEL_FACTS)) {
    for (const k of ['released', 'training_cutoff', 'parameters_b']) if (f[k] !== null) assert.ok(f.sources[k], `${id}: ${k} has a value but no source`);
    if (f.released) assert.match(f.released, /^\d{4}(-\d{2}){0,2}$/, `${id}: release date is ISO`);
  }
  assert.equal(modelFacts('unknown-model').released, null);
  assert.equal(modelFacts('unknown-model', { 'unknown-model': { released: '2027-01-01' } }).released, '2027-01-01');
});

test('effort by difficulty: medians over all attempts and over solved attempts', () => {
  const e = effortOf(items.filter((r) => r.provider === 'big'));
  assert.equal(e.all.n, 3);
  assert.equal(e.all.median_sessions, 2);
  assert.equal(e.solved.n, 2, 'the open problem has no verified outcome');
  assert.equal(e.all.median_output_tokens, 500);
  const byD = effortByDifficulty(items, ['old', 'big'], papers).by_difficulty;
  assert.deepEqual(Object.keys(byD).sort(), ['Calibration', 'Open', 'Research']);
  assert.equal(byD.Research.old.all.median_sessions, 4);
  assert.equal(byD.Research.big.solved.median_sessions, 3);
  assert.equal(byD.Calibration.all_models.all.n, 2);
});

test('difficulty proxies: earliest and smallest solver, least effort, open problems excluded', () => {
  const d = difficultyProxies(items, ['old', 'big'], papers, factsOf);
  const byId = Object.fromEntries(d.items.map((r) => [r.paper_id, r]));
  assert.deepEqual(Object.keys(byId), ['P1', 'P2'], 'the open problem is not in the proof track');
  assert.deepEqual(byId.P1.solved_by, ['old', 'big']);
  assert.deepEqual(byId.P1.earliest_solver, { model: 'old', released: '2024-07-23' });
  assert.deepEqual(byId.P1.smallest_solver, { model: 'old', parameters_b: 8 });
  assert.deepEqual(byId.P1.solvers_without_parameter_count, ['big']);
  assert.deepEqual(byId.P1.least_working_ms, { model: 'big', value: 400 });
  assert.deepEqual(byId.P2.earliest_solver, { model: 'big', released: '2026-09-01' });
  assert.equal(byId.P2.smallest_solver, null, 'a closed model has no parameter count');
  assert.equal(byId.P2.human_difficulty, 'Research');
  assert.equal(byId.P2.reference_proof_lines, 40);
});

test('capability by release is descriptive and fits nothing', () => {
  const g = capabilityByRelease(items, ['big', 'old'], factsOf, BOOT);
  assert.deepEqual(g.rows.map((r) => r.model), ['old', 'big'], 'oldest first');
  assert.equal(g.rows[0].verified.value, 0.5);
  assert.equal(g.rows[1].verified.value, 1);
  assert.equal(g.forecast, null);
  assert.deepEqual(g.release_span, { from: '2024-07-23', to: '2026-09-01' });
});

test('contamination split by publication date against the training cutoff', () => {
  const c = contaminationSplit(items, ['old', 'big'], BOOT);
  assert.equal(c.by_model.old.published_before_cutoff.den, 1);
  assert.equal(c.by_model.old.published_after_cutoff.den, 1);
  assert.equal(c.by_model.old.published_after_cutoff.value, 0);
  assert.equal(c.by_model.big.published_before_cutoff.value, 1);
  assert.equal(c.items_with_publication_date, 4);
});

test('agent summary: solved within k sessions, sessions to success, tool calls, escalations', () => {
  const a = agentSummary(items, ['old', 'big'], BOOT);
  assert.deepEqual(a.tiers, [1, 4]);
  assert.equal(a.by_model.old.solved_within[1].value, 0.5);
  assert.equal(a.by_model.big.solved_within[1].value, 0.5);
  assert.equal(a.by_model.big.solved_within[4].value, 1);
  assert.deepEqual(a.by_model.big.sessions_to_success.distribution, { 1: 1, 3: 1 });
  assert.equal(a.by_model.big.totals.tool_calls, 24);
  assert.deepEqual(a.by_model.big.totals.tool_calls_by_tool, { bash: 18, text_editor: 6 });
  assert.deepEqual(a.by_model.big.open_claim_escalations, ['P3__main_theorem__big']);
  assert.deepEqual(a.by_model.old.verdict_reasons, { contains_sorry: 2 }, 'P2 and the open P3');
  assert.equal(a.by_model.old.completeness_unsolved.mean, 0.25);
  assert.equal(a.by_model.old.sessions_ended_by_output_budget.num, 8);
  assert.equal(agentSummary(items.map((r) => ({ ...r, setting: 'pass@1' })), ['old'], BOOT), null);
});

test('harness samples become item records; the hand audit can withdraw a solve', () => {
  const bundle = { model: 'anthropic/claude-fable-5-1', run_metadata: { web_search: false, network: false, harness: { commit: 'abc' } }, model_generate_config: { reasoning_effort: 'high' } };
  const sample = {
    problem: { problem_id: 'P004', target: 'P004', difficulty: 'Research', mathematical_status: 'established', publication_date: '2026-09' },
    epoch: 1,
    chain: {
      sessions_max: 4, sessions_used: 2, solved_at_session: 2, final_verdict: 'solved', final_reasons: [], web_search: false, network: false, prompt_version: 'v1',
      model: { reasoning_effort: 'high' }, limits: { session_output_tokens: 64000 }, tools: ['bash'],
      sessions: [{ index: 1, stop_reason: 'output_token_budget', working_s: 100, total_s: 120 }, { index: 2, stop_reason: 'agent_ended', working_s: 50, total_s: 60 }],
      totals: { input_tokens: 10000, output_tokens: 4000, cache_read_tokens: 3000, reasoning_tokens: 1000, cost_usd: 1.25, total_s: 180, working_s: 150, grade_s: 30, model_calls: 12, tool_calls: 9, tool_calls_by_tool: { bash: 9 } },
      search: { queries: [], urls: [] },
      final_grade: { verdict: 'solved', reasons: [], warnings: [], checks: { compile: { status: 'compiler_success', error_count: 0 }, statement: { status: 'unchanged' }, axioms: { status: 'clean', axioms: ['propext'] }, sorry: { file_sorry_free: true, target_sorry_free: true }, kernel_replay: { status: 'passed' } }, completeness: { available: true, score: 1 }, proof: { proof_lines: 12, solution_code_lines: 30, solution_total_lines: 40, rule: 'r' }, timing: { compile_ms: 2500 } },
    },
    error: null,
  };
  const it = agentItem(sample, bundle);
  assert.equal(it.provider, 'anthropic_claude-fable-5-1');
  assert.equal(it.model_id, 'claude-fable-5-1');
  assert.equal(it.setting, 'agent');
  assert.deepEqual(it.outcomes, { infrastructure_failure: false, compiled: 1, audit_clean: 1, statement_faithful: 1, verified: 1 });
  assert.equal(it.statement_match, 'definitionally_identical');
  assert.equal(it.timing.working_ms, 150000);
  assert.equal(it.generation.usage.cachedInputTokens, 3000);
  assert.equal(it.generation.effort, 'high');
  assert.equal(it.contamination.model_training_cutoff, '2026-06');
  assert.equal(it.contamination.published_before_cutoff, false);
  assert.equal(it.loc.model.proof.code, 12);
  assert.equal(it.agent.totals.cost_usd, 1.25);
  assert.equal(it.eligibility.proof_track, true);

  const errored = agentItem({ ...sample, chain: { ...sample.chain, final_verdict: 'grader_error', final_grade: { verdict: 'grader_error', reasons: ['toolchain_unavailable'] } } }, bundle);
  assert.equal(errored.outcomes.infrastructure_failure, true);
  assert.equal(errored.outcomes.verified, null);
  const open = agentItem({ ...sample, problem: { ...sample.problem, mathematical_status: 'open' } }, bundle);
  assert.equal(open.outcomes.verified, null);
  assert.ok(open.notes.some((n) => n.startsWith('ESCALATE')));
  const screened = agentItem({ ...sample, chain: { ...sample.chain, final_verdict: 'not_solved', final_reasons: ['static_screen_rejected'], final_grade: { verdict: 'not_solved', reasons: ['static_screen_rejected'], checks: { compile: { status: 'not_attempted' } } } } }, bundle);
  assert.equal(screened.compile.status, 'rejected_by_static_screen');
  assert.equal(screened.outcomes.compiled, 0);

  const audited = applyManualAudit([it], { [it.item_key]: { status: 'rejected', reviewer: 'r', note: 'meaning changed' } });
  assert.equal(audited[0].outcomes.verified, 0);
  assert.equal(audited[0].agent.manual_audit.status, 'rejected');
  assert.equal(providerIdOf('openai/gpt-6-astra'), 'openai_gpt-6-astra');
  assert.equal(modelIdOf('mockllm/model'), 'model');
  const mm = protocolMismatches([{ model: 'a', run_metadata: { web_search: false, max_sessions: 4 } }, { model: 'b', run_metadata: { web_search: true, max_sessions: 4 } }]);
  assert.deepEqual(mm.map((m) => m.field), ['web_search']);
});
