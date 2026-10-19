// Statistics used by the QEDRank summary. Pure functions, no I/O, shared by the
// runner and the browser UI. Every rate carries its numerator and denominator.

import { quantile, rng } from './util.js';

export function rate(num, den) {
  return { num, den, value: den > 0 ? num / den : null };
}

// --------------------------------------------------------------------------
// Special functions (for chi-square survival) - Numerical Recipes style.
// --------------------------------------------------------------------------

function gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function gammaincUpperRegularized(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) {
    // series for P, return 1-P
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 500; n += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  // continued fraction for Q
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}

/** P(X > x) for X ~ chi-square(df). */
export function chiSquareSf(x, df) {
  if (!(x > 0)) return 1;
  return gammaincUpperRegularized(df / 2, x / 2);
}

// --------------------------------------------------------------------------
// Bootstrap by paper (cluster bootstrap): keeps every target and model of a
// paper together in each resample.
// --------------------------------------------------------------------------

/**
 * @param {string[]} paperIds unique paper ids (the resampling unit)
 * @param {(sampledPaperIds: string[]) => number|null} statistic computed on a multiset of papers
 * @param {{B?: number, seed?: number, alpha?: number}} opts
 */
export function bootstrapByPaper(paperIds, statistic, { B = 1000, seed = 20260930, alpha = 0.05 } = {}) {
  const n = paperIds.length;
  if (n === 0) return { point: null, lo: null, hi: null, B: 0, method: 'percentile_cluster_bootstrap_by_paper' };
  const point = statistic(paperIds);
  const rand = rng(seed);
  const draws = [];
  for (let b = 0; b < B; b += 1) {
    const sample = new Array(n);
    for (let i = 0; i < n; i += 1) sample[i] = paperIds[Math.floor(rand() * n)];
    const v = statistic(sample);
    if (v !== null && Number.isFinite(v)) draws.push(v);
  }
  if (draws.length < 10) return { point, lo: null, hi: null, B: draws.length, method: 'percentile_cluster_bootstrap_by_paper' };
  return {
    point,
    lo: quantile(draws, alpha / 2),
    hi: quantile(draws, 1 - alpha / 2),
    B: draws.length,
    method: 'percentile_cluster_bootstrap_by_paper',
  };
}

// --------------------------------------------------------------------------
// Cochran's Q for k related binary outcomes over n common subjects.
// --------------------------------------------------------------------------

/** @param {number[][]} matrix rows = subjects (papers), cols = models, entries 0/1 */
export function cochranQ(matrix) {
  const n = matrix.length;
  if (n === 0) return { Q: null, df: null, p: null, n: 0 };
  const k = matrix[0].length;
  const colSums = new Array(k).fill(0);
  let rowSum = 0;
  let rowSq = 0;
  for (const row of matrix) {
    let r = 0;
    row.forEach((v, j) => { colSums[j] += v; r += v; });
    rowSum += r;
    rowSq += r * r;
  }
  const denom = k * rowSum - rowSq;
  if (denom === 0) return { Q: null, df: k - 1, p: null, n, note: 'no discordant subjects' };
  const Q = (k - 1) * (k * colSums.reduce((s, c) => s + c * c, 0) - rowSum * rowSum) / denom;
  return { Q, df: k - 1, p: chiSquareSf(Q, k - 1), n };
}

// --------------------------------------------------------------------------
// Exact McNemar test (binomial on discordant pairs) with Holm correction.
// --------------------------------------------------------------------------

function logChoose(n, k) {
  return gammaln(n + 1) - gammaln(k + 1) - gammaln(n - k + 1);
}

/** Two-sided exact McNemar p-value from discordant counts b (A wins) and c (B wins). */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { p: 1, b, c, n };
  const m = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= m; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { p: Math.min(1, 2 * tail), b, c, n };
}

/** Holm step-down adjustment. `pvals` is an array of {key, p}. */
export function holm(pvals) {
  const valid = pvals.filter((x) => x.p !== null && Number.isFinite(x.p));
  const m = valid.length;
  const sorted = [...valid].sort((a, b) => a.p - b.p);
  let running = 0;
  const adjusted = new Map();
  sorted.forEach((x, i) => {
    const adj = Math.min(1, (m - i) * x.p);
    running = Math.max(running, adj);
    adjusted.set(x.key, running);
  });
  return pvals.map((x) => ({ ...x, p_holm: adjusted.has(x.key) ? adjusted.get(x.key) : null }));
}

/**
 * Paired comparison of all model pairs on a common item set.
 * @param {Object<string, Object<string, 0|1>>} outcomes outcomes[model][paperId] = 0/1 (only common papers)
 */
export function pairwiseMcNemar(outcomes, models, paperIds) {
  const results = [];
  for (let i = 0; i < models.length; i += 1) {
    for (let j = i + 1; j < models.length; j += 1) {
      const a = models[i];
      const b = models[j];
      let bWins = 0;
      let cWins = 0;
      let aSucc = 0;
      let bSucc = 0;
      for (const p of paperIds) {
        const x = outcomes[a][p];
        const y = outcomes[b][p];
        aSucc += x;
        bSucc += y;
        if (x === 1 && y === 0) bWins += 1;
        if (x === 0 && y === 1) cWins += 1;
      }
      const t = mcnemarExact(bWins, cWins);
      results.push({
        key: `${a}__vs__${b}`,
        model_a: a,
        model_b: b,
        n: paperIds.length,
        a_successes: aSucc,
        b_successes: bSucc,
        diff_pp: paperIds.length ? ((aSucc - bSucc) / paperIds.length) * 100 : null,
        discordant_a_only: bWins,
        discordant_b_only: cWins,
        p: t.p,
      });
    }
  }
  return holm(results);
}

/** Paired percentage-point difference with a paper-cluster bootstrap CI. */
export function pairedDifferenceCI(outcomes, a, b, paperIds, opts) {
  return bootstrapByPaper(paperIds, (sample) => {
    if (sample.length === 0) return null;
    let d = 0;
    for (const p of sample) d += outcomes[a][p] - outcomes[b][p];
    return (d / sample.length) * 100;
  }, opts);
}

// --------------------------------------------------------------------------
// Calibration: RMS calibration error over equal-width confidence bins.
// --------------------------------------------------------------------------

/**
 * @param {{confidence:number, outcome:0|1}[]} pairs confidence in [0,100]
 */
export function calibration(pairs, bins = 10) {
  const valid = pairs.filter((p) => Number.isFinite(p.confidence) && (p.outcome === 0 || p.outcome === 1));
  const N = valid.length;
  const buckets = Array.from({ length: bins }, (_, i) => ({ bin: i, lo: (i * 100) / bins, hi: ((i + 1) * 100) / bins, n: 0, conf_sum: 0, hit_sum: 0 }));
  for (const p of valid) {
    const idx = Math.min(bins - 1, Math.floor((p.confidence / 100) * bins));
    const b = buckets[idx];
    b.n += 1;
    b.conf_sum += p.confidence / 100;
    b.hit_sum += p.outcome;
  }
  let sq = 0;
  const reliability = buckets.map((b) => {
    const conf = b.n ? b.conf_sum / b.n : null;
    const acc = b.n ? b.hit_sum / b.n : null;
    if (b.n) sq += (b.n / N) * (conf - acc) ** 2;
    return { bin: b.bin, lo: b.lo, hi: b.hi, n: b.n, mean_confidence: conf, accuracy: acc };
  });
  const meanConf = N ? valid.reduce((s, p) => s + p.confidence / 100, 0) / N : null;
  const meanAcc = N ? valid.reduce((s, p) => s + p.outcome, 0) / N : null;
  return { n: N, rms_calibration_error: N ? Math.sqrt(sq) : null, mean_confidence: meanConf, accuracy: meanAcc, reliability, bins };
}

// --------------------------------------------------------------------------
// pass@k helpers (attempts of the same item).
// --------------------------------------------------------------------------

/** @param {(0|1)[]} attempts outcomes per attempt for one item */
export function passAtK(attempts, k) {
  const a = attempts.slice(0, k);
  if (a.length === 0) return null;
  return a.some((x) => x === 1) ? 1 : 0;
}

/**
 * Unbiased pass@k from n attempts with c successes (Chen et al. 2021, "Evaluating Large Language
 * Models Trained on Code"): the probability that at least one of k attempts drawn without
 * replacement from the n is a success, 1 - C(n-c, k) / C(n, k). Null when n < k.
 */
export function passAtKUnbiased(n, c, k) {
  if (!(n >= k) || k < 1) return null;
  if (n - c < k) return 1;
  let fail = 1;
  for (let i = n - c + 1; i <= n; i += 1) fail *= 1 - k / i;
  return 1 - fail;
}

/** The k values reported for n attempts: every integer from 1 to n (n at most 16 in practice). */
export function passAtKLevels(n) {
  const ks = [];
  for (let k = 1; k <= n; k += 1) ks.push(k);
  return ks;
}

/** The k values given prominence in summaries and on the page. */
export const PASS_K_PROMINENT = Object.freeze([1, 2, 4, 8]);

export function meanPerAttempt(attempts) {
  if (attempts.length === 0) return null;
  return attempts.reduce((s, x) => s + x, 0) / attempts.length;
}

export function timeSummary(values, timeoutCount = 0) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return {
    n: xs.length,
    median: quantile(xs, 0.5),
    q1: quantile(xs, 0.25),
    q3: quantile(xs, 0.75),
    p90: quantile(xs, 0.9),
    timeouts: timeoutCount,
  };
}
