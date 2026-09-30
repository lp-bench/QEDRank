import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, matrixRows, fmtRate } from '../lib/metrics.js';
import { flattenItem, ITEM_COLUMNS } from '../lib/export.js';

function rec({ paper, kind = 'main_theorem', provider, verified = 0, faithful = 1, compiled = 1, audit = 'clean', infra = false, conf = 80, status = 'established', attempt = 1, setting = 'pass@1', repair = 0, match = 'definitionally_identical' }) {
  return {
    schema: 'qedrank-item-v1', item_key: `${paper}__${kind}__${provider}`, paper_id: paper, target_kind: kind, provider, model_display_name: provider.toUpperCase(), model_id: `${provider}-1`,
    setting, attempt, repair_round: repair, mathematical_status: status, reference_proof_status: 'complete', reference_statement_available: true,
    generation: { observed_latency_ms: 1200, usage: { inputTokens: 1000, outputTokens: 200 }, error: null },
    confidence: { statement: conf, proof: conf }, abstained: false,
    compile: { status: compiled ? 'compiler_success' : 'compiler_failure', messages: [] }, audit: { status: audit }, ab_consistency: { consistent: true },
    statement_match: faithful ? match : 'unresolved', statement_match_source: 'automated', comparison: { method: 'automated', evidence: { notes: [] } },
    loc: { model: { code: 10, proof: { code: 4 } }, reference: { code: 12, proof: { code: 6 } } },
    timing: { lean_compile_ms: 5000, lean_total_ms: 9000, evaluation_total_ms: 10000 },
    eligibility: { statement_track: true, proof_track: status === 'established', reasons: [] },
    outcomes: { infrastructure_failure: infra, compiled: infra ? null : compiled, audit_clean: infra ? null : (audit === 'clean' ? 1 : 0), statement_faithful: infra ? null : faithful, verified: infra ? null : (status === 'established' ? verified : null) },
    notes: [],
  };
}

const manifest = {
  counts: { papers: 3, expected_count: 108, expected_count_matches: false, papers_with_pdf: 3, targets: { main_theorem: 3, upper_bound: 0, lower_bound: 0, disproof: 0 } },
  papers: [
    { paper_id: 'p1', subject_tags: ['05A'], difficulty: 'easy', requires_figures: false, targets: { main_theorem: { mathematical_status: 'established' } }, bridge_checks: [] },
    { paper_id: 'p2', subject_tags: ['05A'], difficulty: 'hard', requires_figures: false, targets: { main_theorem: { mathematical_status: 'established' } }, bridge_checks: [] },
    { paper_id: 'p3', subject_tags: ['11B'], difficulty: 'hard', requires_figures: 'unknown', targets: { main_theorem: { mathematical_status: 'open' } }, bridge_checks: [] },
  ],
};
const references = {
  p1__main_theorem: { paper_id: 'p1', target_kind: 'main_theorem', statement_available: true, reference_proof_status: 'complete' },
  p2__main_theorem: { paper_id: 'p2', target_kind: 'main_theorem', statement_available: true, reference_proof_status: 'complete' },
  p3__main_theorem: { paper_id: 'p3', target_kind: 'main_theorem', statement_available: true, reference_proof_status: 'contains_placeholder' },
};
const config = { bootstrap: { B: 200, seed: 3 }, generation: { attempts: 1, repairRounds: 0, temperature: 0, maxTokens: 100 }, pricing: { 'a-1': { input: 10, output: 30 } }, exploratoryThreshold: 10, primaryEndpoint: { id: 'x', description: 'y' } };

test('buildSummary produces numerator/denominator rates with paper-cluster CIs and excludes ineligible items', () => {
  const items = [
    rec({ paper: 'p1', provider: 'a', verified: 1 }), rec({ paper: 'p2', provider: 'a', verified: 1 }), rec({ paper: 'p3', provider: 'a', verified: 1, status: 'open' }),
    rec({ paper: 'p1', provider: 'b', verified: 0, faithful: 0, compiled: 0, audit: 'not_audited' }), rec({ paper: 'p2', provider: 'b', verified: 1 }), rec({ paper: 'p3', provider: 'b', infra: true, status: 'open' }),
  ];
  const s = buildSummary({ items, manifest, references, config, models: ['a', 'b'], run: { run_id: 'r' } });
  const a = s.by_target.main_theorem.a;
  const b = s.by_target.main_theorem.b;
  assert.equal(a.verified_pass1.num, 2);
  assert.equal(a.verified_pass1.den, 2); // p3 is open: excluded from the proof track
  assert.equal(a.eligible_statement, 3);
  assert.equal(b.infrastructure_failures, 1);
  assert.equal(b.eligible_statement, 2);
  assert.equal(b.verified_pass1.den, 2);
  assert.equal(b.verified_pass1.num, 1);
  assert.equal(b.compile.num, 1);
  assert.equal(b.compile.den, 2);
  assert.ok(a.verified_pass1.ci_lo !== null && a.verified_pass1.ci_hi !== null);
  assert.ok(a.cost.available && a.cost.per_verified_success_usd > 0);
  assert.equal(b.cost.available, false);
  assert.ok(s.coverage.open_claim_escalations.includes('p3__main_theorem__a'));
  assert.equal(s.five_model_comparison.n_common_papers, 2);
  assert.equal(s.five_model_comparison.pairwise.length, 1);
  assert.equal(s.subgroups.by_subject['05A'].a.exploratory, true);
  assert.equal(s.subsets.a.common_input_set.n_items, 2);
  assert.equal(s.paper_level.a.sandwich_coverage.den, 0); // no upper/lower references -> unavailable, not a failure
  const rows = matrixRows(s);
  assert.ok(rows.find((r) => r.scope === 'main_theorem' && r.model === 'A').verified_pass1.startsWith('2/2'));
  assert.equal(fmtRate({ num: 0, den: 0 }), '0/0 (unavailable)');
});

test('pass@k and repair are reported separately and only when enabled', () => {
  const cfg = { ...config, generation: { attempts: 2, repairRounds: 1, temperature: 0, maxTokens: 100 } };
  const items = [
    rec({ paper: 'p1', provider: 'a', verified: 0, attempt: 1 }), rec({ paper: 'p1', provider: 'a', verified: 1, attempt: 2 }),
    rec({ paper: 'p2', provider: 'a', verified: 0, attempt: 1 }), rec({ paper: 'p2', provider: 'a', verified: 0, attempt: 2 }),
    rec({ paper: 'p1', provider: 'a', verified: 1, setting: 'repair', repair: 1 }),
  ];
  const s = buildSummary({ items, manifest, references, config: cfg, models: ['a'], run: {} });
  const a = s.by_target.main_theorem.a;
  assert.equal(a.verified_pass1.num, 0);
  assert.equal(a.pass_at_k.k, 2);
  assert.equal(a.pass_at_k.num, 1);
  assert.equal(a.pass_at_k.den, 2);
  assert.equal(a.repair.num, 1);
  assert.equal(a.repair.den, 1);
});

test('flattenItem covers the required export columns', () => {
  const row = flattenItem(rec({ paper: 'p1', provider: 'a', verified: 1 }), { runId: 'r', sourceCommit: 'abc', pricing: config.pricing });
  for (const c of ITEM_COLUMNS) assert.ok(c in row, `missing column ${c}`);
  assert.equal(row.source_commit, 'abc');
  assert.equal(row.verified, 1);
  assert.ok(row.cost_usd > 0);
});
