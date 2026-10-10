// Aggregation of item-level records into the QEDRank summary: per-model and
// per-target matrices with numerator/denominator, paper-level sandwich
// coverage, paper-cluster bootstrap CIs, k-model tests, calibration,
// subject/difficulty matrices and reference-defect accounting.
//
// Pure functions shared by the runner and the browser UI.

import { TARGET_KINDS, STATEMENT_MATCH_ACCEPTED, SUMMARY_SCHEMA, ELIGIBILITY } from './schema.js';
import { rate, bootstrapByPaper, cochranQ, pairwiseMcNemar, pairedDifferenceCI, calibration, passAtK, timeSummary } from './stats.js';
import { quantile, round, groupBy } from './util.js';
import { effortByDifficulty, difficultyProxies, capabilityByRelease, contaminationSplit, agentSummary, workingMsOf } from './analysis.js';
import { modelFacts } from '../../lib/model-facts.js';

const BOUNDS = ['main_theorem', 'upper_bound', 'lower_bound'];

function isPrimary(r) {
  return r.setting === 'pass@1' && r.attempt === 1 && r.repair_round === 0;
}

/** Agent runs have one record per problem and model: the whole session chain of the first epoch. */
function isPrimaryAgent(r) {
  return r.setting === 'agent' && r.attempt === 1;
}

function costOf(rec, pricing) {
  // Agent runs: the harness's own figure, which prices cached prompt tokens correctly.
  if (typeof rec.agent?.totals?.cost_usd === 'number') return rec.agent.totals.cost_usd;
  const p = pricing?.[rec.model_id];
  const u = rec.generation?.usage;
  if (!p || !u || u.inputTokens === null || u.outputTokens === null) return null;
  return (u.inputTokens / 1e6) * (p.input ?? 0) + (u.outputTokens / 1e6) * (p.output ?? 0);
}

function totalTimeOf(r) {
  if (typeof r.timing?.total_ms === 'number') return r.timing.total_ms;
  const g = r.generation?.observed_latency_ms ?? 0;
  const e = r.timing?.evaluation_total_ms ?? 0;
  return g + e;
}

function medianOf(xs) {
  return quantile(xs.filter((x) => typeof x === 'number' && Number.isFinite(x)), 0.5);
}

function withCI(numFn, denFn, records, papersOf, bootOpts) {
  const num = records.filter(numFn).length;
  const den = records.filter(denFn).length;
  const byPaper = groupBy(records, (r) => r.paper_id);
  const paperIds = [...byPaper.keys()];
  const ci = bootstrapByPaper(paperIds, (sample) => {
    let n = 0;
    let d = 0;
    for (const p of sample) for (const r of byPaper.get(p)) { if (denFn(r)) { d += 1; if (numFn(r)) n += 1; } }
    return d > 0 ? n / d : null;
  }, bootOpts);
  return { num, den, value: den > 0 ? num / den : null, ci_lo: ci.lo, ci_hi: ci.hi, ci_method: ci.method, ci_B: ci.B };
}

/**
 * Per-model metrics for a set of primary records (already filtered to one target kind or all).
 */
export function modelMetrics(records, allAttempts, { pricing = {}, bootOpts, k = 1, repairRounds = 0, references = {} } = {}) {
  const nonInfra = records.filter((r) => !r.outcomes.infrastructure_failure);
  const infra = records.length - nonInfra.length;
  const eligStmt = nonInfra.filter((r) => r.eligibility.statement_track);
  const eligProof = nonInfra.filter((r) => r.eligibility.proof_track);
  const attempted = nonInfra.filter((r) => ['compiler_success', 'compiler_failure', 'timeout', 'rejected_by_static_screen'].includes(r.compile?.status));
  const compiled = nonInfra.filter((r) => r.compile?.status === 'compiler_success');

  // In the prove task the statement can only be checked on a file that compiles; an answer that
  // never got that far has no statement verdict and is left out rather than counted as "changed".
  const statementChecked = (r) => r.eligibility.statement_track && (r.task !== 'prove' || r.outcomes.statement_faithful !== null);
  const statementFaithful = withCI((r) => r.outcomes.statement_faithful === 1, statementChecked, nonInfra, null, bootOpts);
  const compileRate = withCI((r) => r.compile?.status === 'compiler_success', (r) => ['compiler_success', 'compiler_failure', 'timeout', 'rejected_by_static_screen'].includes(r.compile?.status), nonInfra, null, bootOpts);
  const auditClean = rate(compiled.filter((r) => r.audit?.status === 'clean').length, compiled.length);
  const verified = withCI((r) => r.outcomes.verified === 1, (r) => r.eligibility.proof_track, nonInfra, null, bootOpts);

  // pass@k over attempts of the same item (repair_round 0), only where all k attempts exist.
  let passK = null;
  if (k > 1) {
    const byKey = groupBy(allAttempts.filter((r) => r.repair_round === 0 && r.setting === 'pass@1' && !r.outcomes.infrastructure_failure && r.eligibility.proof_track), (r) => r.item_key);
    const rows = [];
    for (const [key, atts] of byKey) {
      const sorted = atts.sort((a, b) => a.attempt - b.attempt);
      if (sorted.length < k) continue;
      const outs = sorted.slice(0, k).map((r) => (r.outcomes.verified === 1 ? 1 : 0));
      rows.push({ key, paper_id: sorted[0].paper_id, pass: passAtK(outs, k), mean: outs.reduce((a, b) => a + b, 0) / outs.length, outs });
    }
    const perAttemptRates = Array.from({ length: k }, (_, i) => (rows.length ? rows.reduce((s, r) => s + r.outs[i], 0) / rows.length : null));
    const meanRate = perAttemptRates.filter((x) => x !== null);
    const sd = meanRate.length > 1 ? Math.sqrt(meanRate.reduce((s, x) => s + (x - meanRate.reduce((a, b) => a + b, 0) / meanRate.length) ** 2, 0) / (meanRate.length - 1)) : null;
    passK = {
      k,
      num: rows.filter((r) => r.pass === 1).length,
      den: rows.length,
      value: rows.length ? rows.filter((r) => r.pass === 1).length / rows.length : null,
      mean_success_per_attempt: rows.length ? rows.reduce((s, r) => s + r.mean, 0) / rows.length : null,
      per_attempt_rates: perAttemptRates,
      sd_across_attempts: sd,
      note: 'pass@k counts an item as solved when any of its k attempts is a strict verified success; the same k and budget apply to every model.',
    };
  }

  // Repair setting: final record of each repair chain.
  let repair = null;
  if (repairRounds > 0) {
    const chains = groupBy(allAttempts.filter((r) => r.setting === 'repair' && r.attempt === 1 && !r.outcomes.infrastructure_failure && r.eligibility.proof_track), (r) => r.item_key);
    let num = 0;
    let den = 0;
    for (const [, recs] of chains) {
      const last = recs.sort((a, b) => b.repair_round - a.repair_round)[0];
      den += 1;
      if (last.outcomes.verified === 1 || recs.some((r) => r.outcomes.verified === 1)) num += 1;
    }
    repair = { rounds: repairRounds, num, den, value: den ? num / den : null, note: `repair@${repairRounds}: every model received the same fixed budget of compiler-feedback rounds; reported separately from pass@1.` };
  }

  const matchCounts = {};
  for (const r of eligStmt) matchCounts[r.statement_match] = (matchCounts[r.statement_match] || 0) + 1;
  const abstained = nonInfra.filter((r) => r.abstained).length;
  const timeouts = nonInfra.filter((r) => r.compile?.status === 'timeout').length;
  const genTimeouts = records.filter((r) => r.generation?.error?.kind === 'timeout').length;
  const unresolved = eligStmt.filter((r) => r.statement_match === 'unresolved').length;
  const screenRejected = nonInfra.filter((r) => r.compile?.status === 'rejected_by_static_screen').length;

  const latencies = nonInfra.map((r) => r.generation?.observed_latency_ms).filter((x) => typeof x === 'number');
  const leanTimes = nonInfra.map((r) => r.timing?.lean_total_ms).filter((x) => typeof x === 'number');
  const compileTimes = attempted.map((r) => r.timing?.lean_compile_ms).filter((x) => typeof x === 'number');
  const totalTimes = nonInfra.map(totalTimeOf);
  const workingTimes = nonInfra.map(workingMsOf).filter((x) => x !== null);
  const inTok = nonInfra.map((r) => r.generation?.usage?.inputTokens).filter((x) => typeof x === 'number');
  const outTok = nonInfra.map((r) => r.generation?.usage?.outputTokens).filter((x) => typeof x === 'number');
  const costs = nonInfra.map((r) => costOf(r, pricing)).filter((x) => x !== null);
  const totalCost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;

  const modelLoc = compiled.map((r) => r.loc?.model?.proof?.code).filter((x) => typeof x === 'number');
  const refLocEligible = eligProof.map((r) => (r.reference_proof_status === 'complete' ? r.loc?.reference?.proof?.code : null)).filter((x) => typeof x === 'number');
  const ratios = nonInfra.filter((r) => r.outcomes.verified === 1 && r.reference_proof_status === 'complete' && STATEMENT_MATCH_ACCEPTED.includes(r.statement_match))
    .map((r) => { const m = r.loc?.model?.proof?.code; const g = r.loc?.reference?.proof?.code; return typeof m === 'number' && typeof g === 'number' && g > 0 ? m / g : null; })
    .filter((x) => x !== null);

  const calStmt = calibration(eligStmt.filter((r) => r.confidence?.statement !== null && r.outcomes.statement_faithful !== null).map((r) => ({ confidence: r.confidence.statement, outcome: r.outcomes.statement_faithful })));
  const calProof = calibration(nonInfra.filter((r) => r.confidence?.proof !== null && r.compile?.status !== 'not_attempted' || (r.abstained && r.confidence?.proof !== null)).map((r) => ({ confidence: r.confidence.proof, outcome: r.audit?.status === 'clean' ? 1 : 0 })));

  return {
    n_records: records.length,
    infrastructure_failures: infra,
    eligible_statement: eligStmt.length,
    eligible_proof: eligProof.length,
    statement_faithful: statementFaithful,
    compile: { ...compileRate, abstained, screen_rejected: screenRejected, not_attempted: nonInfra.filter((r) => r.compile?.status === 'not_attempted').length },
    audit_clean: auditClean,
    verified_pass1: verified,
    pass_at_k: passK,
    repair,
    statement_match_counts: matchCounts,
    unresolved: rate(unresolved, eligStmt.length),
    abstention: rate(abstained, nonInfra.length),
    timeout: { compile: rate(timeouts, attempted.length), generation: genTimeouts },
    time: {
      observed_model_latency_ms: timeSummary(latencies, genTimeouts),
      lean_compile_ms: timeSummary(compileTimes, timeouts),
      lean_total_ms: timeSummary(leanTimes, timeouts),
      total_item_ms: timeSummary(totalTimes, timeouts + genTimeouts),
      working_item_ms: timeSummary(workingTimes, timeouts + genTimeouts),
      note: 'observed latency and total time include network and provider delays; working time is the model calls that succeeded plus Lean and tool execution, without requests that ended in a transport error or the waits after them; all-attempt timing is reported regardless of success',
    },
    tokens: {
      n_with_usage: Math.min(inTok.length, outTok.length),
      median_input: medianOf(inTok),
      median_output: medianOf(outTok),
      total_input: inTok.length ? inTok.reduce((a, b) => a + b, 0) : null,
      total_output: outTok.length ? outTok.reduce((a, b) => a + b, 0) : null,
    },
    cost: {
      n_priced: costs.length,
      total_usd: totalCost,
      per_verified_success_usd: totalCost !== null && verified.num > 0 ? totalCost / verified.num : null,
      available: costs.length > 0,
      note: costs.length ? null : 'unavailable: pricing not configured or provider did not report usage',
    },
    loc: {
      median_model_proof_lines: medianOf(modelLoc),
      n_model: modelLoc.length,
      median_reference_proof_lines_eligible: medianOf(refLocEligible),
      n_reference: refLocEligible.length,
      median_model_to_reference_ratio: medianOf(ratios),
      n_ratio: ratios.length,
      note: 'ratio only over verified successes whose reference proof is complete and whose statements are accepted matches; shorter code is never evidence of correctness',
    },
    calibration: {
      statement: { ...calStmt, excluded_infrastructure_failures: infra },
      proof_audit: { ...calProof, excluded_infrastructure_failures: infra },
      abstention_coverage: rate(abstained, nonInfra.length),
    },
  };
}

function paperLevel(records, models, manifestPapers, references, bootOpts) {
  const byPaper = groupBy(records, (r) => r.paper_id);
  const out = {};
  for (const m of models) {
    const rows = [];
    for (const paper of manifestPapers) {
      const recs = (byPaper.get(paper.paper_id) || []).filter((r) => r.provider === m);
      const refOk = BOUNDS.every((k) => references[`${paper.paper_id}__${k}`]?.statement_available);
      const recsByKind = Object.fromEntries(recs.map((r) => [r.target_kind, r]));
      const infra = BOUNDS.some((k) => recsByKind[k]?.outcomes?.infrastructure_failure);
      const bridge = paper.bridge_checks || [];
      const bridgeOk = bridge.every((b) => b.status === 'passed');
      const allMatch = BOUNDS.every((k) => recsByKind[k]?.outcomes?.statement_faithful === 1);
      const eligProofKinds = BOUNDS.filter((k) => recsByKind[k]?.eligibility?.proof_track);
      rows.push({
        paper_id: paper.paper_id,
        sandwich_eligible: refOk && !infra && BOUNDS.every((k) => recsByKind[k]),
        sandwich_covered: refOk && !infra && allMatch && bridgeOk,
        bridge_checks: bridge.length,
        bridge_unreviewed: bridge.filter((b) => b.status !== 'passed' && b.status !== 'failed').length,
        paper_verified_eligible: eligProofKinds.length > 0 && !infra,
        paper_verified: eligProofKinds.length > 0 && !infra && eligProofKinds.every((k) => recsByKind[k].outcomes.verified === 1),
      });
    }
    const sandwich = withCI((r) => r.sandwich_covered, (r) => r.sandwich_eligible, rows, null, bootOpts);
    const pv = withCI((r) => r.paper_verified, (r) => r.paper_verified_eligible, rows, null, bootOpts);
    out[m] = { sandwich_coverage: sandwich, paper_verified_all_eligible_bounds: pv, rows };
  }
  return out;
}

function modelComparison(records, models, endpointFn, bootOpts) {
  const byPaperModel = {};
  for (const r of records) {
    if (r.target_kind !== 'main_theorem') continue;
    byPaperModel[r.paper_id] ||= {};
    byPaperModel[r.paper_id][r.provider] = endpointFn(r);
  }
  const common = Object.keys(byPaperModel).filter((p) => models.every((m) => byPaperModel[p][m] === 0 || byPaperModel[p][m] === 1)).sort();
  const outcomes = Object.fromEntries(models.map((m) => [m, Object.fromEntries(common.map((p) => [p, byPaperModel[p][m]]))]));
  const matrix = common.map((p) => models.map((m) => outcomes[m][p]));
  const q = cochranQ(matrix);
  const pairs = pairwiseMcNemar(outcomes, models, common).map((pr) => {
    const ci = pairedDifferenceCI(outcomes, pr.model_a, pr.model_b, common, bootOpts);
    return { ...pr, diff_ci_lo: ci.lo, diff_ci_hi: ci.hi };
  });
  const ranking = models.map((m) => ({ model: m, successes: common.reduce((s, p) => s + outcomes[m][p], 0), n: common.length }))
    .sort((a, b) => b.successes - a.successes);
  return {
    endpoint: `primary endpoint on common eligible papers (all ${models.length} models determinate)`,
    k_models: models.length,
    n_common_papers: common.length,
    cochran_q: q,
    pairwise: pairs,
    descriptive_ranking: ranking,
    statistically_supported_pairs: pairs.filter((p) => p.p_holm !== null && p.p_holm < 0.05).map((p) => `${p.model_a} vs ${p.model_b}`),
    note: common.length < 10 ? 'exploratory: fewer than 10 common papers' : null,
  };
}

function subgroupMatrices(records, models, manifestPapers, bootOpts, threshold) {
  const paperById = new Map(manifestPapers.map((p) => [p.paper_id, p]));
  const tagOf = (r) => paperById.get(r.paper_id)?.subject_tags || [];
  const diffOf = (r) => paperById.get(r.paper_id)?.difficulty || 'unlabeled';
  const subjects = new Set();
  for (const p of manifestPapers) (p.subject_tags || []).forEach((t) => subjects.add(t));
  const build = (groupKeyFn, keys) => {
    const out = {};
    for (const key of keys) {
      const rows = {};
      for (const m of models) {
        const recs = records.filter((r) => r.provider === m && groupKeyFn(r).includes(key) && !r.outcomes.infrastructure_failure);
        const papers = new Set(recs.map((r) => r.paper_id)).size;
        rows[m] = {
          papers,
          statement_faithful: withCI((r) => r.outcomes.statement_faithful === 1, (r) => r.eligibility.statement_track, recs, null, bootOpts),
          verified_pass1: withCI((r) => r.outcomes.verified === 1, (r) => r.eligibility.proof_track, recs, null, bootOpts),
          exploratory: papers < threshold,
        };
      }
      out[key] = rows;
    }
    return out;
  };
  return {
    by_subject: build(tagOf, [...subjects].sort()),
    by_difficulty: build((r) => [diffOf(r)], [...new Set(manifestPapers.map((p) => p.difficulty || 'unlabeled'))].sort()),
    threshold,
    note: `groups with fewer than ${threshold} papers are labelled exploratory`,
  };
}

/**
 * Build the whole summary.
 * @param {object} p
 * @param {object[]} p.items      all item records (every attempt / setting)
 * @param {object} p.manifest     corpus manifest
 * @param {object} p.references   map "<paper_id>__<kind>" -> reference record
 * @param {object} p.config       run config
 * @param {string[]} p.models     provider ids in fixed order
 * @param {object} [p.review]     review data ({reference_defects: [...], decisions: {...}})
 * @param {object} [p.run]        run metadata
 */
export function buildSummary({ items, manifest, references, config, models, review = {}, run = {} }) {
  const bootOpts = { B: config.bootstrap?.B ?? 1000, seed: config.bootstrap?.seed ?? 1 };
  const k = config.generation?.attempts ?? 1;
  const repairRounds = config.generation?.repairRounds ?? 0;
  const agentRun = run.protocol === 'agent';
  const primary = items.filter(agentRun ? isPrimaryAgent : isPrimary);
  const factsOf = (m) => run.model_facts?.[m] ?? modelFacts(primary.find((x) => x.provider === m)?.model_id, config.modelFacts || {});
  const papers = manifest.papers || [];
  const opts = { pricing: config.pricing || {}, bootOpts, k, repairRounds, references };

  const byTarget = {};
  for (const kind of [...TARGET_KINDS, 'all']) {
    byTarget[kind] = {};
    for (const m of models) {
      const recs = primary.filter((r) => r.provider === m && (kind === 'all' || r.target_kind === kind));
      const att = items.filter((r) => r.provider === m && (kind === 'all' || r.target_kind === kind));
      byTarget[kind][m] = modelMetrics(recs, att, opts);
    }
  }
  const paperLevelByModel = paperLevel(primary, models, papers, references, bootOpts);
  const endpointFn = (r) => (r.outcomes.infrastructure_failure || !r.eligibility.proof_track ? null : r.outcomes.verified);
  const comparison = modelComparison(primary, models, endpointFn, bootOpts);
  const subgroups = subgroupMatrices(primary, models, papers, bootOpts, config.exploratoryThreshold ?? 10);

  // Common input set (every model has a determinate record) and text-only subset.
  const byPaperKind = groupBy(primary, (r) => `${r.paper_id}__${r.target_kind}`);
  const commonKeys = new Set([...byPaperKind.entries()].filter(([, recs]) => models.every((m) => recs.some((r) => r.provider === m && !r.outcomes.infrastructure_failure))).map(([key]) => key));
  const textOnlyPapers = new Set(papers.filter((p) => p.requires_figures === false).map((p) => p.paper_id));
  const subsets = {};
  for (const m of models) {
    const common = primary.filter((r) => r.provider === m && commonKeys.has(`${r.paper_id}__${r.target_kind}`));
    const textOnly = common.filter((r) => textOnlyPapers.has(r.paper_id));
    subsets[m] = {
      common_input_set: { n_items: common.length, verified_pass1: withCI((r) => r.outcomes.verified === 1, (r) => r.eligibility.proof_track && !r.outcomes.infrastructure_failure, common, null, bootOpts), statement_faithful: withCI((r) => r.outcomes.statement_faithful === 1, (r) => r.eligibility.statement_track && !r.outcomes.infrastructure_failure, common, null, bootOpts) },
      text_only_subset: { n_items: textOnly.length, n_papers: textOnlyPapers.size, verified_pass1: withCI((r) => r.outcomes.verified === 1, (r) => r.eligibility.proof_track && !r.outcomes.infrastructure_failure, textOnly, null, bootOpts), note: textOnlyPapers.size ? null : 'no papers annotated requires_figures=false' },
    };
  }

  // Corpus coverage and reference audit accounting.
  const refList = Object.values(references);
  const coverage = {
    papers_discovered: papers.length,
    expected_count: manifest.counts?.expected_count ?? config.expectedPaperCount,
    expected_count_matches: manifest.counts?.expected_count_matches ?? null,
    papers_with_pdf: manifest.counts?.papers_with_pdf ?? null,
    targets_discovered: manifest.counts?.targets ?? null,
    references_audited: Object.fromEntries(TARGET_KINDS.map((kd) => [kd, refList.filter((r) => r.target_kind === kd && r.statement_available).length])),
    reference_proof_status: Object.fromEntries(TARGET_KINDS.map((kd) => [kd, countBy(refList.filter((r) => r.target_kind === kd), (r) => r.reference_proof_status)])),
    mathematical_status: Object.fromEntries(TARGET_KINDS.map((kd) => [kd, countBy(papers.map((p) => p.targets?.[kd]).filter(Boolean), (t) => t.mathematical_status)])),
    eligible_items: {
      statement_track: countBy(primary.filter((r) => r.eligibility.statement_track), (r) => r.target_kind),
      proof_track: countBy(primary.filter((r) => r.eligibility.proof_track), (r) => r.target_kind),
    },
    items_total: primary.length,
    items_infrastructure_failed: primary.filter((r) => r.outcomes.infrastructure_failure).length,
    open_claim_escalations: primary.filter((r) => r.notes?.some((n) => n.startsWith('ESCALATE')) || (r.mathematical_status === 'open' && r.outcomes.compiled === 1 && r.outcomes.audit_clean === 1 && r.outcomes.statement_faithful === 1)).map((r) => r.item_key),
  };
  const defects = review.reference_defects || [];
  const referenceDefects = {
    references_total: refList.length,
    references_reviewed: refList.filter((r) => (review.reviewed_references || []).includes(`${r.paper_id}__${r.target_kind}`)).length,
    defects_recorded: defects.length,
    defects_by_type: countBy(defects, (d) => d.type || 'unspecified'),
    corrections: defects.filter((d) => d.correction).map((d) => ({ reference: d.reference, type: d.type, reason: d.reason || null, original_sha256: d.original_sha256 || null, corrected_sha256: d.corrected_sha256 || null })),
    automated_findings: {
      invalid: refList.filter((r) => r.reference_proof_status === 'invalid').length,
      contains_placeholder: refList.filter((r) => r.reference_proof_status === 'contains_placeholder').length,
      missing: refList.filter((r) => r.reference_proof_status === 'missing').length,
      statement_unavailable: refList.filter((r) => !r.statement_available).length,
    },
    denominator_changes: 'items whose reference statement is unavailable are excluded from the statement track; items whose claim is not established are excluded from the proof track (see eligibility)',
  };

  return {
    schema: SUMMARY_SCHEMA,
    generated_at: new Date().toISOString(),
    run: { run_id: run.run_id ?? null, protocol: run.protocol ?? 'single_call', harness: run.harness ?? null, sandbox: run.sandbox ?? null, source: run.source ?? manifest.source ?? null, toolchain: run.toolchain ?? null, prompt_template_version: run.prompt_template_version ?? null, settings: run.settings ?? null, protocol_mismatches: run.protocol_mismatches ?? [], bundles: run.bundles ?? null },
    primary_endpoint: run.primary_endpoint ?? config.primaryEndpoint,
    eligibility_rules: ELIGIBILITY,
    models: models.map((m) => { const r = primary.find((x) => x.provider === m); return { id: m, model_id: r?.model_id ?? null, display_name: r?.model_display_name ?? m, label: r?.model_label ?? null, host: r?.api_host ?? null, effort: r?.generation?.effort ?? null, facts: factsOf(m) }; }),
    settings: { k, repair_rounds: repairRounds, bootstrap: bootOpts, temperature: config.generation?.temperature, max_tokens: config.generation?.maxTokens },
    coverage,
    by_target: byTarget,
    paper_level: paperLevelByModel,
    model_comparison: comparison,
    subgroups,
    subsets,
    effort: effortByDifficulty(primary, models, papers),
    difficulty_proxies: difficultyProxies(primary, models, papers, factsOf),
    generations: capabilityByRelease(primary, models, factsOf, bootOpts, (m) => primary.find((x) => x.provider === m)?.model_display_name ?? m),
    contamination: contaminationSplit(primary, models, bootOpts),
    agent: agentRun ? agentSummary(primary, models, bootOpts) : null,
    reference_defects: referenceDefects,
    caveats: [
      'Prior training contamination cannot be ruled out for public papers and public Lean formalizations.',
      'Statement fidelity and verified proof success are separate measurements; a compile pass alone is never a success.',
      'Equivalence classifications marked unresolved need independent expert review; automated failure to find an equivalence is not evidence of difference.',
      'No weighted composite ranking is computed. Descriptive rankings are ordered by point estimate; only pairs listed under statistically_supported_pairs differ after Holm correction.',
    ],
  };
}

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

/** Flatten the summary into matrix rows (one per scope x model) for CSV/UI. */
export function matrixRows(summary) {
  const rows = [];
  const scopes = ['all', ...TARGET_KINDS];
  for (const scope of scopes) {
    for (const m of summary.models) {
      const mm = summary.by_target[scope]?.[m.id];
      if (!mm) continue;
      const pl = summary.paper_level?.[m.id];
      rows.push({
        scope,
        model: m.display_name,
        model_id: m.model_id,
        eligible_statement_n: mm.eligible_statement,
        eligible_proof_n: mm.eligible_proof,
        infrastructure_failures: mm.infrastructure_failures,
        statement_faithful: fmtRate(mm.statement_faithful),
        statement_faithful_pct: pct(mm.statement_faithful.value),
        statement_faithful_ci: fmtCI(mm.statement_faithful),
        compile: fmtRate(mm.compile),
        compile_pct: pct(mm.compile.value),
        audit_clean: fmtRate(mm.audit_clean),
        verified_pass1: fmtRate(mm.verified_pass1),
        verified_pass1_pct: pct(mm.verified_pass1.value),
        verified_pass1_ci: fmtCI(mm.verified_pass1),
        verified_passk: mm.pass_at_k ? fmtRate(mm.pass_at_k) : 'n/a (k=1)',
        repair: mm.repair ? fmtRate(mm.repair) : 'n/a',
        sandwich_coverage: scope === 'all' && pl ? fmtRate(pl.sandwich_coverage) : scope === 'all' ? 'unavailable' : 'n/a',
        unresolved: fmtRate(mm.unresolved),
        abstention: fmtRate(mm.abstention),
        rms_calibration_statement: round(mm.calibration.statement.rms_calibration_error, 3),
        rms_calibration_proof: round(mm.calibration.proof_audit.rms_calibration_error, 3),
        median_latency_ms: round(mm.time.observed_model_latency_ms.median, 0),
        median_lean_ms: round(mm.time.lean_total_ms.median, 0),
        median_total_ms: round(mm.time.total_item_ms.median, 0),
        median_working_ms: round(mm.time.working_item_ms?.median, 0),
        timeouts: mm.time.total_item_ms.timeouts,
        median_input_tokens: mm.tokens.median_input ?? 'unavailable',
        median_output_tokens: mm.tokens.median_output ?? 'unavailable',
        cost_per_verified_usd: mm.cost.per_verified_success_usd ?? 'unavailable',
        median_model_proof_loc: mm.loc.median_model_proof_lines ?? 'unavailable',
        median_reference_proof_loc: mm.loc.median_reference_proof_lines_eligible ?? 'unavailable',
      });
    }
  }
  return rows;
}

export function fmtRate(r) {
  if (!r || r.den === undefined) return 'unavailable';
  if (r.den === 0) return `0/0 (unavailable)`;
  return `${r.num}/${r.den} (${(100 * r.value).toFixed(1)}%)`;
}

export function fmtCI(r) {
  if (!r || r.ci_lo === null || r.ci_lo === undefined) return 'unavailable';
  return `[${(100 * r.ci_lo).toFixed(1)}%, ${(100 * r.ci_hi).toFixed(1)}%]`;
}

function pct(v) {
  return v === null || v === undefined ? null : round(100 * v, 1);
}
