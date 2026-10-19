import { test } from 'node:test';
import assert from 'node:assert/strict';
import { texEscape, buildLatexReport } from '../../src/evaluation/latex.js';

const rate = (num, den, lo = null, hi = null) => ({ num, den, value: den ? num / den : null, ci_lo: lo, ci_hi: hi });

function summaryFixture() {
  const qwen = {
    n_records: 111, eligible_statement: 109, eligible_proof: 80, infrastructure_failures: 2,
    statement_faithful: rate(0, 0), compile: rate(8, 109), audit_clean: rate(0, 8), verified_pass1: rate(0, 80, 0, 0.045),
    time: { observed_model_latency_ms: { median: 41000 }, lean_total_ms: { median: 950 }, total_item_ms: { median: 52000 } },
    tokens: { median_input: 2300, median_output: 16384 }, cost: { available: false, total_usd: null, per_verified_success_usd: null },
  };
  const kimi = { ...qwen, n_records: 111, infrastructure_failures: 94, eligible_proof: 0, compile: rate(0, 2), verified_pass1: rate(0, 0) };
  return {
    schema: 'qedrank-summary-v1', generated_at: '2026-10-12T09:15:00.000Z',
    run: { run_id: 'pilot_run-1', protocol: 'single_call', source: { url: 'https://github.com/owner/bench_mark', commit: '466b32a95dfb0549', commit_date: '2026-10-08T10:15:52Z' }, toolchain: { toolchain: 'leanprover/lean4:v4.33.1', mathlib: { rev: '0df444a' } }, harness: { commit: 'bfc8df88f2', dirty: true } },
    primary_endpoint: { description: 'Strict verified success at pass@1 & no sorry' },
    settings: { k: 1, repair_rounds: 0, temperature: 0, max_tokens: 16384, bootstrap: { B: 2000, seed: 20260930 } },
    coverage: { papers_discovered: 111, expected_count: 108, items_total: 222, items_infrastructure_failed: 96 },
    models: [
      { id: 'qwen', label: 'Qwen3 30B-A3B', model_id: 'qwen3-30b-a3b-instruct-2507', host: 'chat-ai.academiccloud.de', facts: { released: '2025-07-30', parameters_b: 30.5, active_parameters_b: 3.3 } },
      { id: 'kimi', label: 'Kimi K3', model_id: 'kimi-k3', host: 'api.moonshot.ai', effort: 'max', facts: {} },
    ],
    by_target: { all: { qwen, kimi }, main_theorem: { qwen, kimi } },
    model_comparison: { n_common_papers: 2, cochran_q: { Q: null, note: 'fewer than two determinate models' }, pairwise: [], statistically_supported_pairs: [] },
    caveats: ['Statement fidelity and verified proof success are separate measurements; a compile pass alone is never a success.'],
  };
}

function balanced(tex) {
  const begins = tex.match(/\\begin\{[a-z]+\}/g) || [];
  const ends = tex.match(/\\end\{[a-z]+\}/g) || [];
  return begins.length === ends.length;
}

test('texEscape escapes every LaTeX special character', () => {
  assert.equal(texEscape('a_b & 50% #1 {x} $y'), 'a\\_b \\& 50\\% \\#1 \\{x\\} \\$y');
  assert.equal(texEscape('~^\\|'), '\\textasciitilde{}\\textasciicircum{}\\textbackslash{}\\textbar{}');
  assert.equal(texEscape(null), '');
  assert.equal(texEscape('line\nbreak'), 'line break');
});

test('texEscape maps known symbols and replaces unknown ones', () => {
  assert.equal(texEscape('a ≤ b'), 'a \\ensuremath{\\le} b');
  assert.equal(texEscape('Kimi — K3'), 'Kimi --- K3');
  assert.equal(texEscape('Mathlib · Lean'), 'Mathlib · Lean'); // Latin-1: inputenc handles it
  assert.equal(texEscape('定理'), '??');
});

test('report carries metadata, models and result tables', () => {
  const tex = buildLatexReport({ summary: summaryFixture() });
  assert.match(tex, /^% QEDRank evaluation report/);
  assert.match(tex, /\\documentclass/);
  assert.ok(tex.trimEnd().endsWith('\\end{document}'));
  assert.ok(balanced(tex), 'every \\begin has an \\end');
  assert.match(tex, /\\texttt\{pilot\\_run-1\}/);
  assert.match(tex, /\\texttt\{https:\/\/github.com\/owner\/bench\\_mark\}/);
  assert.match(tex, /Strict verified success at pass@1 \\& no sorry/);
  assert.match(tex, /uncommitted changes at run time/);
  assert.match(tex, /Qwen3 30B-A3B/);
  assert.match(tex, /\\subsection\*\{Main theorem\}/);
  assert.doesNotMatch(tex, /\\subsection\*\{Upper bound\}/, 'scopes without records are left out');
  assert.doesNotMatch(tex, /\\subsection\*\{All targets\}/, 'a single-target run has no separate "all" table');
  const two = summaryFixture();
  two.by_target.upper_bound = two.by_target.main_theorem;
  assert.match(buildLatexReport({ summary: two }), /\\subsection\*\{All targets\}[\s\S]*\\subsection\*\{Main theorem\}[\s\S]*\\subsection\*\{Upper bound\}/);
  assert.match(tex, /8\/109 \(7\.3\\%\)/);
  assert.match(tex, /0\/80 \(0\.0\\%\)\\newline \[0\.0, 4\.5\]/);
  assert.match(tex, /Cochran's Q: fewer than two determinate models/);
  assert.match(tex, /\\section\{Caveats\}/);
  assert.doesNotMatch(tex, /undefined|NaN|\[object Object\]/);
});

test('failed and empty evaluations are stated, not left blank', () => {
  const tex = buildLatexReport({ summary: summaryFixture() });
  // Kimi: 94 infrastructure failures and no eligible proof item -> "---", not 0%.
  assert.match(tex, /Kimi K3 & 111 & 109 \/ 0 & 94 & --- & 0\/2 \(0\.0\\%\) & 0\/8 \(0\.0\\%\) & --- \\\\/);
  const empty = buildLatexReport({ summary: { ...summaryFixture(), models: [], by_target: {}, model_comparison: null, caveats: [] } });
  assert.match(empty, /No models were evaluated in this run\./);
  assert.ok(balanced(empty));
  const none = buildLatexReport({});
  assert.match(none, /No results are loaded/);
  assert.match(none, /No run metadata is loaded|\\texttt\{unnamed run\}/);
  assert.ok(balanced(none));
});

test('items-only export counts failures per model', () => {
  const items = [
    { model: 'Kimi K3', infrastructure_failure: true, generation_error: 'rate_limited' },
    { model: 'Kimi K3', infrastructure_failure: false, abstained: true },
    { model: 'Qwen3 30B-A3B', compiled: true, verified: false, output_truncated: true },
  ];
  const tex = buildLatexReport({ items, run: { run_id: 'r1', task: 'prove' } });
  assert.match(tex, /no summary\.json loaded/);
  assert.match(tex, /Kimi K3 & 2 & 1 & 1 & 1 & 0 & 0 & 0 \\\\/);
  assert.match(tex, /Qwen3 30B-A3B & 1 & 0 & 0 & 0 & 1 & 1 & 0 \\\\/);
  assert.ok(balanced(tex));
  // With a summary, items are labelled like the other tables (by model slot).
  const withSummary = buildLatexReport({ summary: summaryFixture(), items: [{ provider: 'kimi', model: 'Kimi K3 · kimi-k3', infrastructure_failure: true }] });
  assert.match(withSummary, /\\section\{Item outcomes\}[\s\S]*Kimi K3 & 1 & 1 & 0/);
  assert.doesNotMatch(withSummary, /Kimi K3 · kimi-k3/);
});
