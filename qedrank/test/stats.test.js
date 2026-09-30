import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chiSquareSf, cochranQ, mcnemarExact, holm, calibration, bootstrapByPaper, passAtK, pairwiseMcNemar, timeSummary } from '../lib/stats.js';

test('chi-square survival matches tabulated critical values', () => {
  assert.ok(Math.abs(chiSquareSf(3.841, 1) - 0.05) < 0.001);
  assert.ok(Math.abs(chiSquareSf(9.488, 4) - 0.05) < 0.001);
  assert.ok(Math.abs(chiSquareSf(13.277, 4) - 0.01) < 0.001);
  assert.equal(chiSquareSf(0, 3), 1);
});

test("Cochran's Q on a known table", () => {
  // 3 raters, 6 subjects (classic small example): Q = 6, df 2
  const q = cochranQ([[1, 1, 0], [1, 0, 0], [1, 1, 1], [0, 0, 0], [1, 0, 0], [1, 1, 0]]);
  assert.equal(q.Q, 6);
  assert.equal(q.df, 2);
  assert.ok(Math.abs(q.p - 0.0498) < 0.001);
  assert.equal(cochranQ([]).Q, null);
  assert.equal(cochranQ([[1, 1], [1, 1]]).Q, null); // no discordant subjects
});

test('exact McNemar two-sided p-value', () => {
  assert.ok(Math.abs(mcnemarExact(5, 1).p - 0.21875) < 1e-9);
  assert.equal(mcnemarExact(0, 0).p, 1);
  assert.ok(Math.abs(mcnemarExact(10, 0).p - 2 / 1024) < 1e-9);
});

test('Holm step-down', () => {
  const adj = holm([{ key: 'a', p: 0.01 }, { key: 'b', p: 0.04 }, { key: 'c', p: 0.03 }]);
  const by = Object.fromEntries(adj.map((x) => [x.key, x.p_holm]));
  assert.ok(Math.abs(by.a - 0.03) < 1e-9);
  assert.ok(Math.abs(by.c - 0.06) < 1e-9);
  assert.ok(Math.abs(by.b - 0.06) < 1e-9);
});

test('calibration: perfect calibration has zero RMS error', () => {
  const pairs = [];
  for (let i = 0; i < 100; i += 1) pairs.push({ confidence: 75, outcome: i < 75 ? 1 : 0 });
  const c = calibration(pairs);
  assert.ok(c.rms_calibration_error < 1e-9);
  assert.equal(c.n, 100);
  const bad = calibration([{ confidence: 100, outcome: 0 }, { confidence: 100, outcome: 0 }]);
  assert.ok(Math.abs(bad.rms_calibration_error - 1) < 1e-9);
});

test('paper bootstrap CI brackets the point estimate and is reproducible', () => {
  const outcomes = { p1: 1, p2: 0, p3: 1, p4: 1, p5: 0, p6: 1 };
  const stat = (s) => s.reduce((a, p) => a + outcomes[p], 0) / s.length;
  const a = bootstrapByPaper(Object.keys(outcomes), stat, { B: 300, seed: 7 });
  const b = bootstrapByPaper(Object.keys(outcomes), stat, { B: 300, seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.point && a.point <= a.hi);
  assert.equal(bootstrapByPaper([], stat).point, null);
});

test('pass@k and pairwise comparison bookkeeping', () => {
  assert.equal(passAtK([0, 0, 1], 3), 1);
  assert.equal(passAtK([0, 0, 1], 2), 0);
  const outcomes = { A: { p1: 1, p2: 1, p3: 0 }, B: { p1: 0, p2: 1, p3: 0 } };
  const pw = pairwiseMcNemar(outcomes, ['A', 'B'], ['p1', 'p2', 'p3']);
  assert.equal(pw.length, 1);
  assert.equal(pw[0].discordant_a_only, 1);
  assert.equal(pw[0].discordant_b_only, 0);
  assert.ok(Math.abs(pw[0].diff_pp - 33.333) < 0.01);
  const t = timeSummary([1, 2, 3, 4, 100], 2);
  assert.equal(t.median, 3);
  assert.equal(t.timeouts, 2);
});
