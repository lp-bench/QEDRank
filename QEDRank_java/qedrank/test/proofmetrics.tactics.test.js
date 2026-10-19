import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProofs } from '../lib/proofmetrics.js';

// `constructor` is an ordinary Lean tactic; a plain-object counter would read Object.prototype's
// constructor and turn the tactic total into a string.
const rec = (tactics_by_name, extra = {}) => {
  const tactics = Object.values(tactics_by_name).reduce((a, n) => a + n, 0);
  return { complete: true, has_sorry: false, errors: 0, proof_lines: 3, proof_tokens: 12, term_size: 40, term_size_capped: false, tactics, tactics_by_name, automation: tactics_by_name.simp || 0, hypotheses: 0, unused_hypotheses: [], undecided_hypotheses: 0, ...extra };
};

test('proof metrics: a tactic named constructor (or toString, hasOwnProperty) counts like any other', () => {
  const s = summarizeProofs([rec({ constructor: 2, simp: 1 }), rec({ constructor: 1, toString: 1, hasOwnProperty: 1 })], []);
  assert.equal(s.proofs, 2);
  assert.equal(s.tactic_calls, 6);
  assert.equal(typeof s.tactic_calls, 'number');
  assert.equal(s.automation_calls, 1);
  assert.ok(Math.abs(s.automation_share - 1 / 6) < 1e-12);
  assert.equal(s.tactic_counts.constructor, 3);
  assert.equal(s.tactic_counts.toString, 1);
  assert.deepEqual(s.top_tactics[0], { name: 'constructor', count: 3, share: 0.5, automation: false });
  // The summary survives a JSON round trip as plain data.
  const back = JSON.parse(JSON.stringify(s));
  assert.equal(back.tactic_counts.constructor, 3);
});
