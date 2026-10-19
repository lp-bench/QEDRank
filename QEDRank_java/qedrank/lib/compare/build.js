// Builds the benchmark comparison: ProofBench measured from its corpus, the public benchmarks
// measured from their own repositories with the same rules, ProofBench pass rates from QEDRank
// runs, and the facts each benchmark reports (qedrank/data/benchmark-literature.json).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJson, exists, pLimit, sha256 } from '../util.js';
import { measureFileWithImports, summarizeMeasurements, summarizeStructure, clopperPearson, STRUCTURE_RULE } from './measure.js';
import { slimProofMetrics } from '../proofmetrics.js';
import { parseGitHubUrl } from '../source.js';
import { proofbenchStats, mscArea } from './proofbench.js';
import { SOURCES } from './sources.js';
import { customSource } from './custom.js';

export const COMPARISON_SCHEMA = 'qedrank-benchmark-comparison-v1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LITERATURE_FILE = path.resolve(HERE, '..', '..', 'data', 'benchmark-literature.json');

// Common subject groups for benchmarks labelled by MSC code or by a domain name.
export const SUBJECT_GROUPS = [
  { id: 'logic', label: 'Logic and foundations', short: 'Logic', msc: ['03'], re: /logic|set theory|foundation|model theory/i },
  { id: 'combinatorics', label: 'Combinatorics and discrete mathematics', short: 'Combinatorics', msc: ['05', '68'], re: /combinator|discrete|graph theory|counting/i },
  { id: 'number_theory', label: 'Number theory', short: 'Number theory', msc: ['11'], re: /number theory|arithmetic/i },
  { id: 'algebra', label: 'Algebra', short: 'Algebra', msc: ['06', '08', '12', '13', '14', '15', '16', '17', '18', '19', '20', '22'], re: /algebra|group|ring|field|polynomial|linear|matri|categor|representation/i },
  { id: 'analysis', label: 'Analysis and calculus', short: 'Analysis', msc: ['26', '28', '30', '31', '32', '33', '34', '35', '37', '39', '40', '41', '42', '43', '44', '45', '46', '47', '49'], re: /analysis|calculus|differential|integral|real|complex|measure|function|inequalit|sequence|series|dynamic|convex|trigonometr/i },
  { id: 'geometry_topology', label: 'Geometry and topology', short: 'Geometry/topology', msc: ['51', '52', '53', '54', '55', '57', '58'], re: /geometr|topolog|manifold|knot/i },
  { id: 'probability', label: 'Probability and statistics', short: 'Probability', msc: ['60', '62'], re: /probab|statistic|random/i },
  { id: 'applied', label: 'Applied mathematics, physics and optimization', short: 'Applied', msc: ['65', '70', '74', '76', '78', '80', '81', '82', '83', '85', '86', '90', '91', '92', '93', '94'], re: /optimi|numerical|applied|operations|game theory|physic|mechanic/i },
  { id: 'other', label: 'Other', short: 'Other', msc: [], re: null },
];
// Order in which domain names are matched (specific before broad).
const MATCH_ORDER = ['logic', 'probability', 'number_theory', 'combinatorics', 'geometry_topology', 'applied', 'algebra', 'analysis'];
// Checked before the order above: names that would otherwise land in a neighbouring group.
const SPECIAL = [[/algebraic geometry/i, 'algebra'], [/convex geometry/i, 'geometry_topology'], [/convex analysis/i, 'analysis']];

export function subjectGroup(label) {
  if (label == null || label === '') return null;
  const area = mscArea(label);
  if (area && /^\d{2}[A-Z]?\d*$/i.test(String(label).trim())) {
    const g = SUBJECT_GROUPS.find((x) => x.msc.includes(area));
    return g ? g.id : 'other';
  }
  const text = String(label).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  for (const [re, id] of SPECIAL) if (re.test(text)) return id;
  for (const id of MATCH_ORDER) if (SUBJECT_GROUPS.find((g) => g.id === id).re.test(text)) return id;
  return 'other';
}

export const MSC_NAMES = {
  '03E': 'Set theory', '05A': 'Enumerative combinatorics', '05B': 'Designs and configurations', '05C': 'Graph theory',
  '05D': 'Extremal combinatorics', '05E': 'Algebraic combinatorics', '06A': 'Ordered sets', '11B': 'Sequences and sets',
  '11K': 'Probabilistic number theory', '11M': 'Zeta and L-functions', '15A': 'Basic linear algebra', '20F': 'Special aspects of groups',
  '52A': 'General convexity', '52C': 'Discrete geometry', '57Q': 'PL-topology', '60B': 'Probability on algebraic and topological structures',
  '68R': 'Discrete mathematics in computer science',
};

const countBy = (xs) => xs.reduce((a, k) => { if (k != null) a[k] = (a[k] || 0) + 1; return a; }, {});

/** Subject groups per problem; a problem with several labels counts 1/k towards each. */
function subjectCounts(labels) {
  const out = {};
  for (const l of labels) {
    const groups = [...new Set((Array.isArray(l) ? l : [l]).map(subjectGroup).filter(Boolean))];
    for (const g of groups) out[g] = (out[g] || 0) + 1 / groups.length;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

/** Per-model verified rates on main theorems from QEDRank run directories. */
export async function proofbenchPerformance(runDirs) {
  const out = [];
  for (const dir of runDirs) {
    const summary = await readJson(path.join(dir, 'summary.json'), null);
    if (!summary) continue;
    for (const m of summary.models || []) {
      const mm = summary.by_target?.main_theorem?.[m.id];
      const v = mm?.verified_pass1;
      if (!v) continue;
      out.push({
        run_id: summary.run?.run_id || path.basename(dir),
        corpus_commit: summary.run?.source?.commit || null,
        model: m.label || m.display_name || m.id,
        model_id: m.model_id,
        verified: v.num,
        den: v.den,
        records: mm.n_records,
        infra: mm.infrastructure_failures,
        ci: clopperPearson(v.num, v.den),
        // Coverage of this model: problems with at least one determinate attempt, and the
        // problems other models of the run covered that this one lacks.
        covered: summary.coverage?.problems_by_model?.[m.id]?.length ?? null,
        missing: (summary.coverage?.coverage_differences || []).find((c) => c.model === m.id)?.missing?.length ?? 0,
        problems_discovered: summary.coverage?.papers_discovered ?? null,
      });
    }
  }
  return out;
}

/**
 * Run-level facts of the base corpus from the newest run summary that has them: the reference
 * defects found or recorded, and the coverage differences between the run's models.
 */
export async function proofbenchRunFacts(runDirs) {
  let out = { reference_defects: null, coverage: null, run_id: null };
  for (const dir of runDirs) {
    const summary = await readJson(path.join(dir, 'summary.json'), null);
    if (!summary) continue;
    const newer = !out.run_id || String(summary.generated_at || '') > String(out.generated_at || '');
    if (!newer) continue;
    out = {
      run_id: summary.run?.run_id || path.basename(dir),
      generated_at: summary.generated_at || null,
      reference_defects: summary.reference_defects || null,
      coverage: summary.coverage ? { papers_discovered: summary.coverage.papers_discovered ?? null, common_problems: summary.coverage.common_problems?.length ?? null, differences: summary.coverage.coverage_differences || [] } : null,
    };
  }
  return out;
}

/** The best ProofBench result: highest verified rate, ties broken by the larger denominator. */
function bestOf(perf) {
  const rows = perf.filter((p) => p.den > 0);
  if (!rows.length) return null;
  rows.sort((a, b) => b.verified / b.den - a.verified / a.den || b.den - a.den);
  const r = rows[0];
  return { solved: r.verified, of: r.den, evaluated_on: r.den, rate: r.verified / r.den, ci: r.ci, model: r.model, budget: 'one attempt (pass@1)', budget_class: 'single', run_id: r.run_id };
}

// Bump when the measurement rules change, so cached measurements are recomputed.
// 3: file structure (theorems, definitions, shipped proofs); column-0 `sorry` stays in its declaration.
export const MEASURE_VERSION = 3;

/** Measure one benchmark through its source adapter (cached per source commit and rule version). */
async function measureBenchmark(spec, { cacheDir, refresh, log }) {
  const got = await spec.problems({ cacheDir, refresh, log });
  const cacheFile = got.source?.commit ? path.join(cacheDir, 'measured', `${spec.cacheKey || spec.id}@${String(got.source.commit).slice(0, 16)}@m${MEASURE_VERSION}.json`) : null;
  if (cacheFile && !refresh) {
    const hit = await readJson(cacheFile, null);
    if (hit) return hit;
  }
  const measured = await measureProblems(got);
  if (cacheFile) { await fs.mkdir(path.dirname(cacheFile), { recursive: true }); await fs.writeFile(cacheFile, JSON.stringify(measured)); }
  return measured;
}

async function measureProblems(got) {
  const limit = pLimit(16);
  // Library modules the problems import, each distinct text once (per-problem dependency files
  // share a module name but not their text).
  const library = new Map();
  const onModule = (module, text) => { const key = `${module}\0${sha256(text)}`; if (!library.has(key)) library.set(key, { module, text }); };
  const rows = await Promise.all(got.problems.map((p) => limit(async () => {
    try {
      const reader = got.readModuleFor ? got.readModuleFor(p) : got.readModule || (async () => null);
      const [m] = await measureFileWithImports(p.text, p.target ? [p.target] : null, reader, { onModule });
      return { ...m, id: p.id, subject: p.subject ?? null, level: p.level ?? null, split: p.split ?? null };
    } catch (err) {
      return { id: p.id, ok: false, reason: err.message, subject: p.subject ?? null, level: p.level ?? null, split: p.split ?? null };
    }
  })));
  const subjects = subjectCounts(rows.map((r) => r.subject).filter((s) => s != null && (!Array.isArray(s) || s.length)));
  const levels = countBy(rows.map((r) => r.level).filter(Boolean));
  return {
    available: true,
    source: got.source,
    problems: rows.length,
    splits: countBy(rows.map((r) => r.split).filter(Boolean)),
    statements: summarizeMeasurements(rows),
    structure: summarizeStructure(rows, [...library.values()]),
    subjects: Object.keys(subjects).length ? subjects : null,
    subjects_labelled: rows.filter((r) => r.subject != null && (!Array.isArray(r.subject) || r.subject.length)).length,
    subject_labels_raw: countBy(rows.flatMap((r) => (Array.isArray(r.subject) ? r.subject : [r.subject])).filter(Boolean)),
    levels: Object.keys(levels).length ? levels : null,
    unmeasured_examples: rows.filter((r) => !r.ok).slice(0, 5).map((r) => `${r.id}: ${r.reason}`),
  };
}

const repoOf = (url) => { try { const p = parseGitHubUrl(url); return `${p.owner}/${p.repo}`.toLowerCase(); } catch { return null; } };

/**
 * Proof metrics belong to the benchmark compared here when the project they were measured in (the
 * one holding its statements and library) is a checkout of the same repository, or the same local
 * folder. A different commit is kept and flagged.
 */
export function matchProofMetrics(pm, source) {
  if (!pm) return { metrics: null, note: null };
  const dir = pm.sources?.statements?.project || pm.sources?.library?.project;
  const proj = (pm.projects || []).find((p) => p.dir === dir) || (pm.projects || [])[0] || null;
  if (!proj) return { metrics: null, note: null };
  const where = `${proj.remote || proj.dir}${proj.commit ? ` @ ${proj.commit.slice(0, 7)}` : ''}`;
  // A local folder is `file://<dir>` with its git HEAD in `head_commit` (`commit` hashes the tree).
  const localDir = source?.kind === 'local' && /^file:\/\//.test(source.url || '') ? source.url.replace(/^file:\/\//, '') : null;
  const sameLocal = Boolean(localDir) && path.resolve(localDir).toLowerCase() === path.resolve(proj.dir).toLowerCase();
  const sameRepo = Boolean(source?.url && proj.remote && repoOf(source.url) && repoOf(source.url) === repoOf(proj.remote));
  if (!sameLocal && !sameRepo) return { metrics: null, note: `The Lean proof measurements were taken in ${where}, a different corpus from the one compared here (${source?.url || 'local folder'}); compare that repository to see them.` };
  const compared = localDir ? source.head_commit || null : source?.commit || null;
  const sameCommit = !compared || !proj.commit || compared === proj.commit;
  return {
    metrics: { ...pm, corpus: { measured_in: where, measured_commit: proj.commit || null, compared_commit: compared, same_commit: sameCommit } },
    note: sameCommit ? null : `Lean proof measurements are from commit ${proj.commit.slice(0, 7)}; the benchmark compared here is at ${String(compared).slice(0, 7)}.`,
  };
}

function redact(text, secret) {
  return secret && secret.length >= 6 ? String(text).split(secret).join('[redacted]') : String(text);
}

/**
 * The full comparison of the paper: ProofBench against every catalogued benchmark.
 * @param {object} p
 * @param {object} p.proofbench   { url, path, ref, subdir, token }
 * @param {string[]} p.runDirs    QEDRank runs whose verified rates enter the comparison
 * @param {string} p.cacheDir     where public benchmarks are downloaded
 * @param {string[]} [p.only]     restrict the public benchmarks to these ids
 */
export async function buildComparison({ proofbench, runDirs = [], cacheDir, only = null, refresh = false, literatureFile = LITERATURE_FILE, proofMetricsFile = null, log = () => {} }) {
  const literature = await readJson(literatureFile);
  const selections = literature.benchmarks.filter((b) => b.id !== 'proofbench' && (!only || only.includes(b.id))).map((b) => ({ id: b.id }));
  return buildComparisonFor({ base: { name: 'ProofBench', ...proofbench }, selections, runDirs, cacheDir, refresh, literatureFile, proofMetricsFile, log });
}

/**
 * Your benchmark against a chosen list.
 * @param {object} p
 * @param {object} p.base          { name, url | path, ref, subdir, token } — any corpus QEDRank can discover
 * @param {object[]} p.selections  [{ id }] for a catalogued benchmark measured from its public source,
 *                                 [{ id, url, ref, folder, token }] for a catalogued one read from a URL you give,
 *                                 [{ name, url, ref, folder, token }] for any other benchmark
 * @param {string} [p.proofMetricsFile]  output of `proof-metrics` (Lean measurements of ProofBench's proofs)
 */
export async function buildComparisonFor({ base, selections = [], runDirs = [], cacheDir, refresh = false, literatureFile = LITERATURE_FILE, proofMetricsFile = null, log = () => {} }) {
  const literature = await readJson(literatureFile);
  const { name: baseName = 'ProofBench', ...baseSource } = base || {};
  const pb = await proofbenchStats({ ...baseSource, log });
  if (!pb.problems) throw new Error(`no problems found in ${baseSource.url || baseSource.path}${baseSource.subdir ? ` (${baseSource.subdir})` : ''}`);
  pb.name = baseName;
  pb.performance = await proofbenchPerformance(runDirs);
  pb.run_facts = await proofbenchRunFacts(runDirs);

  const benchmarks = [];
  let customN = 0;
  for (const sel of selections) {
    const entry = sel.id && sel.id !== 'proofbench' ? literature.benchmarks.find((b) => b.id === sel.id) : null;
    let row;
    if (entry) row = { ...entry, facts: { ...entry.facts } };
    else {
      customN += 1;
      const name = String(sel.name || '').trim() || `Benchmark ${customN}`;
      row = { id: sel.id && !literature.benchmarks.some((b) => b.id === sel.id) ? sel.id : `custom-${customN}`, name, short: name, custom: true, cite_key: null, facts: { languages: ['Lean 4'], statements: 'from the URL you gave', sources: [sel.url].filter(Boolean) } };
    }
    let spec = null;
    let measured;
    try {
      spec = sel.url ? customSource({ id: row.id, url: sel.url, ref: sel.ref || null, folder: sel.folder || null, token: sel.token || null }) : SOURCES.find((s) => s.id === row.id) || null;
    } catch (err) {
      measured = { available: false, reason: err.message };
    }
    if (!measured) {
      if (!spec) measured = { available: false, reason: row.statements_public === false ? `${row.facts?.statements || 'not public'}: add a URL to a copy you can access` : 'no public Lean 4 source: add a URL' };
      else {
        try {
          log(`measuring ${row.name}`);
          measured = await measureBenchmark(spec, { cacheDir, refresh, log });
          if (sel.url) measured.source = { ...measured.source, given_by_user: true };
        } catch (err) {
          measured = { available: false, reason: `could not read it: ${redact(err.message, sel.token)}` };
          log(`${row.name}: ${redact(err.message, sel.token)}`);
        }
      }
    }
    if (row.custom && measured.available) row.facts = { ...row.facts, problems: measured.problems, level: measured.levels ? Object.keys(measured.levels).join(', ') : null };
    const levels = measured.levels || row.level_counts || (row.level_code ? { [row.level_code]: row.facts?.problems || measured.problems || 0 } : null);
    const subjects = measured.subjects || row.subjects_stated || null;
    benchmarks.push({
      ...row, measured, levels, subjects,
      levels_source: measured.levels ? 'per problem' : row.level_counts || row.level_code ? 'stated' : null,
      subjects_source: measured.subjects ? `per problem (${measured.subjects_labelled} of ${measured.problems} labelled)` : row.subjects_stated ? 'stated' : null,
    });
  }

  // Your benchmark: the catalogued ProofBench facts apply only when it is ProofBench.
  const isProofBench = /^proofbench$/i.test(baseName.trim());
  const pbEntry = isProofBench ? literature.benchmarks.find((b) => b.id === 'proofbench') : null;
  const best = bestOf(pb.performance);
  const pbSubjects = subjectCounts(pb.per_problem.map((r) => r.msc).filter(Boolean));
  const baseStatements = pb.source?.kind === 'local' ? 'local folder' : pb.source?.private ? 'private' : 'public';
  const proofbenchRow = {
    ...(pbEntry || { cite_key: null }),
    id: 'proofbench',
    name: baseName,
    short: baseName,
    facts: { ...(pbEntry?.facts || { languages: ['Lean 4'], statements: baseStatements }), problems: pb.problems, problems_note: `${pb.claim_status.established || 0} established, ${pb.claim_status.open || 0} open${pb.targets?.disproof ? `; ${pb.targets.disproof} disproof variants` : ''}`, best: best || null },
    measured: { available: true, source: { kind: pb.source?.kind || 'git', url: pb.source?.url, label: pb.source?.owner ? `${pb.source.owner}/${pb.source.repo}${pb.source.private ? ' (private)' : ''}` : pb.source?.url, commit: pb.source?.commit, date: pb.source?.commit_date }, problems: pb.problems, statements: pb.statements, structure: pb.structure, subjects: pbSubjects, levels: pb.levels },
    levels: pb.levels,
    levels_source: 'per problem',
    subjects: pbSubjects,
    subjects_source: `per problem (${pb.problems - (pb.msc_unlabeled || 0)} of ${pb.problems} labelled)`,
  };

  // Lean measurements of the benchmark's proofs (`proof-metrics`): only ProofBench has them, and
  // only when they were measured on the same repository as the benchmark compared here.
  const pmAll = isProofBench && proofMetricsFile ? slimProofMetrics(await readJson(proofMetricsFile, null)) : null;
  const { metrics: proofMetrics, note: proofMetricsNote } = matchProofMetrics(pmAll, pb.source);
  if (proofMetrics) log(`proof metrics from ${proofMetricsFile} (${proofMetrics.generated_at})`);
  else if (proofMetricsNote) log(proofMetricsNote);

  const topSection = Object.entries(pb.msc_section || {}).sort((a, b) => b[1] - a[1])[0];
  return {
    schema: COMPARISON_SCHEMA,
    generated_at: new Date().toISOString(),
    literature_checked: literature.checked_at || null,
    method: {
      summary: 'Statement statistics use one rule for every benchmark: Lean tokens of the theorem signature, and of the signature with every non-Mathlib definition it uses (same file or the benchmark\'s own library, followed transitively). Measured on source text, without elaboration.',
      detail: 'A token is an identifier (dotted names once), a number, a string, a two-character operator or any other non-space character; comments, doc strings, attributes and proofs are excluded. Standard libraries: Mathlib, Std, Batteries, Lean, Lake, Init, Aesop, Qq, ProofWidgets, Plausible, Archive. Facts (sizes, levels, best results) are as published, with sources; success rates are comparable only at equal sampling budget.',
      structure: STRUCTURE_RULE,
      proofs: 'Tactics, proof length, unused hypotheses, linter warnings and the statement probe are measured with Lean, in the benchmark\'s own project; a benchmark that ships statements only has no proofs to measure.',
    },
    proof_metrics: proofMetrics,
    proof_metrics_note: proofMetricsNote,
    subject_groups: SUBJECT_GROUPS.map(({ id, label, short }) => ({ id, label, short })),
    msc_names: MSC_NAMES,
    proofbench_top_subject: topSection ? { code: topSection[0], label: `${topSection[0]} ${MSC_NAMES[topSection[0]] || ''}`.trim(), count: topSection[1] } : null,
    proofbench: pb,
    benchmarks: [proofbenchRow, ...benchmarks],
  };
}

export async function writeComparison(data, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'benchmark-comparison.json');
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export { exists };
