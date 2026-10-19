import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subjectGroup, proofbenchPerformance, matchProofMetrics } from '../lib/compare/build.js';
import { difficultyLevel, mscArea, mscSection } from '../lib/compare/proofbench.js';
import { comparisonTex, tex } from '../lib/compare/latex.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('subject groups: MSC codes by area, domain names by keyword', () => {
  assert.equal(subjectGroup('05C15'), 'combinatorics');
  assert.equal(subjectGroup('68R10'), 'combinatorics');
  assert.equal(subjectGroup('11B30'), 'number_theory');
  assert.equal(subjectGroup('52C10'), 'geometry_topology');
  assert.equal(subjectGroup('90C25'), 'applied');
  assert.equal(subjectGroup('81P68'), 'applied', 'mathematical physics sits with applied mathematics');
  assert.equal(subjectGroup('01A60'), 'other');
  assert.equal(subjectGroup('number_theory'), 'number_theory', 'snake_case tags (PutnamBench)');
  assert.equal(subjectGroup('AlgebraicGeometry'), 'algebra', 'CamelCase topics (LeanEval)');
  assert.equal(subjectGroup('Trigonometry'), 'analysis');
  assert.equal(subjectGroup('Number Theory'), 'number_theory');
  assert.equal(subjectGroup('Discrete Mathematics'), 'combinatorics');
  assert.equal(subjectGroup('Linear Algebra'), 'algebra');
  assert.equal(subjectGroup('Probability'), 'probability');
  assert.equal(subjectGroup('Calculus'), 'analysis');
  assert.equal(subjectGroup(null), null);
});

test('ProofBench difficulty labels collapse to shared levels; open claims are open whatever the label', () => {
  assert.equal(difficultyLevel('Research', 'established'), 'research');
  assert.equal(difficultyLevel('Research (open until Oct 2026; disproved ...)', 'established'), 'research');
  assert.equal(difficultyLevel('Research', 'open'), 'open');
  assert.equal(difficultyLevel('Calibration (elementary; full Lean reference proof)', 'established'), 'calibration');
  assert.equal(difficultyLevel(null, 'established'), 'unlabeled');
  assert.equal(mscArea('05C15'), '05');
  assert.equal(mscSection('05c15'), '05C');
});

test('pass rates come from run summaries with exact intervals', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-cmp-'));
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({
    run: { run_id: 'r1', source: { commit: 'abc' } },
    models: [{ id: 'qwen', label: 'Qwen', model_id: 'q' }, { id: 'kimi', label: 'Kimi', model_id: 'k' }],
    by_target: { main_theorem: { qwen: { verified_pass1: { num: 0, den: 80 }, n_records: 111, infrastructure_failures: 0 }, kimi: { verified_pass1: { num: 0, den: 0 }, n_records: 111, infrastructure_failures: 94 } } },
  }));
  const perf = await proofbenchPerformance([dir]);
  assert.equal(perf.length, 2);
  assert.equal(perf[0].den, 80);
  assert.ok(Math.abs(perf[0].ci[1] - 0.0451) < 1e-3);
  assert.equal(perf[1].ci, null);
});

test('LaTeX: special characters are escaped and the document is complete', () => {
  assert.equal(tex('5% & $x_1$ #2'), '5\\% \\& \\$x\\_1\\$ \\#2');
  const stats = { n: 3, p10: 2, q1: 3, median: 4, q3: 8, p90: 12, max: 20 };
  const statements = { problems: 3, measured: 3, stmt_tokens: stats, closure_tokens: stats, defs_used: stats, share_with_local_defs: 1 / 3, count_with_local_defs: 1, count_with_project_library: 0 };
  const data = {
    generated_at: '2026-10-14T00:00:00Z', method: { summary: 'One rule.' }, subject_groups: [{ id: 'combinatorics', label: 'Combinatorics' }], msc_names: { '05C': 'Graph theory' },
    proofbench: { problems: 3, source: { commit: 'abcdef1234' }, msc_section: { '05C': 3 }, msc_unlabeled: 0 },
    benchmarks: [
      { id: 'proofbench', name: 'ProofBench', facts: { problems: 3, languages: ['Lean 4'], best: { solved: 0, of: 2, ci: [0, 0.84], model: 'Qwen' } }, measured: { available: true, statements }, subjects: { combinatorics: 3 }, levels: { research: 2, open: 1 } },
      { id: 'x', name: 'Bench_X', cite_key: 'x2025', facts: { problems: 100, languages: ['Lean 4'], best: { rate: 0.07, model: 'M', budget: 'pass@32', budget_class: 'sampled' } }, measured: { available: false, reason: 'private' }, levels: { competition: 100 }, levels_source: 'stated', subjects: { combinatorics: 100 }, subjects_source: 'stated' },
    ],
  };
  const doc = comparisonTex(data);
  assert.match(doc, /\\begin\{document\}[\s\S]*\\end\{document\}\s*$/);
  assert.match(doc, /Bench\\_X \\cite\{x2025\}/, 'a breakable space before the citation');
  assert.match(doc, /boxplot prepared=\{lower whisker=2\.0, lower quartile=3\.0, median=4\.0/);
  assert.match(doc, /semilogxaxis/);
  assert.match(doc, /mark=square\*[^\n]*\(100,7\.00\)/);
  assert.match(doc, /\\node\[font=\\scriptsize, anchor=(west|east|north|south)[^\]]*\] at \(axis cs:100,7\.00\) \{Bench\\_X\};/, 'direct label as its own node');
  assert.match(doc, /\\legend\{\{pass@2--64\}/, 'legend entries are braced so commas inside them survive');
  assert.ok(doc.includes('Bench\\_X$^{*}$ & '), 'stated subject counts are marked');
  assert.ok(doc.includes('(3,0.00) += (0,84.00) -= (0,0.00)'), 'ProofBench interval runs from its lower to its upper bound');
  // An unrecognised budget class still plots, as "budget not reported".
  const odd = comparisonTex({ ...data, benchmarks: [data.benchmarks[0], { ...data.benchmarks[1], facts: { ...data.benchmarks[1].facts, best: { rate: 0.5, budget_class: 'mystery' } } }] });
  assert.match(odd, /mark=diamond\*[^\n]*\(100,50\.00\)/);
  assert.doesNotMatch(doc, /undefined|NaN/);
});

test('LaTeX: file-structure and Lean proof tables appear when the comparison has them', () => {
  const stats = { n: 3, p10: 1, q1: 2, median: 3, q3: 4, p90: 5, max: 9 };
  const statements = { problems: 3, measured: 3, stmt_tokens: stats, closure_tokens: stats, defs_used: stats, share_with_local_defs: 0, count_with_local_defs: 0, count_with_project_library: 0 };
  const structure = { rule: 'One rule_for files.', files: 3, theorems: 4, theorems_per_file: stats, definitions_per_file: stats, files_with_several_theorems: 1, proved_lemmas: 0, proof_lines: { n: 0 }, library: { modules: 2, proved_lemmas: 5, proof_lines: stats } };
  const proofs = { proofs: 5, proof_lines: stats, tactics: stats, automation_share: 0.4, hypotheses: { proofs_with_unused: 1, proofs_with_hypotheses: 4 }, linter_warnings: { total: 2 } };
  const data = {
    generated_at: 't', method: { summary: 'x' }, subject_groups: [], msc_names: {},
    proofbench: { problems: 3, source: { commit: 'abc' } },
    proof_metrics: { rules: { tactics: 'tactic nodes', automation: 'simp, omega', unused_hypothesis: 'not in the term' }, sources: { library: { summary: proofs }, statements: { summary: { closed_by_automation: 1, targets_found: 3, contradictory: 0, portfolio: ['omega'], linter_warnings: { total: 0, files_with_warnings: 0 }, measured: 3 } } } },
    benchmarks: [
      { id: 'proofbench', name: 'ProofBench', facts: { problems: 3 }, measured: { available: true, statements, structure } },
      { id: 'y', name: 'Bench_Y', facts: { problems: 9 }, measured: { available: true, statements, structure: { ...structure, library: null, proved_lemmas: 2, proof_lines: stats } } },
    ],
  };
  const doc = comparisonTex(data);
  assert.match(doc, /\\label\{tab:bench-structure\}/);
  assert.match(doc, /\\label\{tab:bench-proofs\}/);
  assert.ok(doc.includes('One rule\\_for files.'), 'the rule is escaped');
  assert.ok(doc.includes('Own library & 5 & 3'), 'library proofs with their median length');
  assert.ok(doc.includes('Bench\\_Y ship statements only'), 'benchmarks without proofs are named');
  assert.ok(doc.includes('1 of 3 proved outright'));
  assert.doesNotMatch(doc, /undefined|NaN/);
  const without = comparisonTex({ ...data, proof_metrics: null });
  assert.doesNotMatch(without, /tab:bench-proofs/);
});

test('proof metrics attach only to the corpus they were measured on; another commit is flagged', () => {
  const pm = { projects: [{ dir: 'C:\proofbench-statements', remote: 'https://github.com/vaibhav-baj/proofbench-statements.git', commit: '466b32a95dfb' }], sources: { statements: { project: 'C:\proofbench-statements' } } };
  const same = matchProofMetrics(pm, { kind: 'github', url: 'https://github.com/vaibhav-baj/proofbench-statements', commit: '466b32a95dfb' });
  assert.ok(same.metrics);
  assert.equal(same.note, null);
  assert.equal(same.metrics.corpus.same_commit, true);
  const later = matchProofMetrics(pm, { kind: 'github', url: 'https://github.com/vaibhav-baj/proofbench-statements/tree/main', commit: '0a4a476aaaa' });
  assert.ok(later.metrics);
  assert.match(later.note, /from commit 466b32a; the benchmark compared here is at 0a4a476/);
  const other = matchProofMetrics(pm, { kind: 'github', url: 'https://github.com/vaibhav-baj/ProofBench', commit: 'e631e6a' });
  assert.equal(other.metrics, null);
  assert.match(other.note, /a different corpus/);
  const local = matchProofMetrics(pm, { kind: 'local', url: 'file://C:\proofbench-statements', commit: 'treehash', head_commit: '466b32a95dfb' });
  assert.ok(local.metrics);
  assert.equal(local.note, null);
  assert.deepEqual(matchProofMetrics(null, {}), { metrics: null, note: null });
});
