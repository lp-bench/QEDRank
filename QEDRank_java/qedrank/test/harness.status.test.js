import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttempt, classifyFailure, classifyLeanText, statusOf, failureOf, isProviderEnd, ATTEMPT_STATUS, FAILURE_CLASSES } from '../lib/harness/status.js';

test('attempt status: solved beats everything, infrastructure beats solved, partial needs verified lemmas', () => {
  assert.equal(classifyAttempt({ solved: true }), 'fully_solved');
  assert.equal(classifyAttempt({ solved: true, infrastructure: true }), 'infrastructure_error');
  assert.equal(classifyAttempt({ partial: { assessed: true, verified_aux_lemmas: 2 } }), 'partially_solved');
  assert.equal(classifyAttempt({ partial: { assessed: true, verified_aux_lemmas: 0 } }), 'failed');
  assert.equal(classifyAttempt({ partial: { assessed: false } }), 'failed', 'unassessed progress is never partial');
  assert.equal(classifyAttempt({}), 'failed');
  assert.ok(ATTEMPT_STATUS.includes('cancelled') && ATTEMPT_STATUS.includes('pending') && ATTEMPT_STATUS.includes('running'));
});

test('failure classes from the ProofBench layer-1 errors', () => {
  const c = (errors, extra = {}) => classifyFailure({ errors, ...extra }).class;
  assert.equal(c(['theorem statement altered']), 'statement_mismatch');
  assert.equal(c(['reference line missing or altered before the theorem: \'def foo\'']), 'statement_mismatch');
  assert.equal(c(['comparator rejected: statement differs']), 'statement_mismatch');
  assert.equal(c(['declares an axiom']), 'disallowed_proof');
  assert.equal(c(['non-standard axioms: myAx']), 'disallowed_proof');
  assert.equal(c(['uses native_decide']), 'disallowed_proof');
  assert.equal(c(['disallowed import in Submission/P1.lean: import Foo']), 'dependency');
  assert.equal(c(['compile timeout']), 'timeout');
  assert.equal(c(['compile error: 12:3: error: unsolved goals\n⊢ False']), 'tactic');
  assert.equal(c(['compile error: 4:10: error: unknown identifier \'Nat.foo\'']), 'elaboration');
  assert.equal(c(['compile error: 4:10: error: type mismatch']), 'type');
  assert.equal(c(['compile error: 2:1: error: unexpected token \'theorem\'; expected command']), 'syntax');
  assert.equal(c(['compile error: 9:9: error: unknown module prefix \'Foo\'']), 'dependency');
  assert.equal(c(['contains sorry']), 'incomplete_proof');
  assert.equal(c(['checker failed: rc=1']), 'infrastructure');
  assert.equal(c([], { sampleError: 'RuntimeError: sandbox exited' }), 'infrastructure');
  assert.equal(c([], { sampleError: 'rate limit exceeded (429)' }), 'provider');
  assert.equal(c([], { sessionEnds: ['provider_error: RateLimitError: 429', 'provider_error: RateLimitError: 429'] }), 'provider');
  assert.equal(c([], { sessionEnds: ['error: RuntimeError: boom'] }), 'infrastructure');
  assert.equal(c([], { sessionEnds: ['submit', 'error: RuntimeError: boom'], limit: { type: 'token' } }), 'incomplete_proof', 'one error among normal sessions is not infrastructure');
  assert.equal(c([], { limit: { type: 'working' } }), 'timeout');
  assert.equal(c([]), 'unknown');
  assert.ok(isProviderEnd('error: APIStatusError: 503 Service Unavailable'));
  assert.ok(!isProviderEnd('error: ValueError: bad json'));
  for (const cls of ['syntax', 'elaboration', 'type', 'tactic', 'timeout', 'dependency', 'statement_mismatch', 'disallowed_proof', 'incomplete_proof', 'no_answer', 'provider', 'infrastructure', 'unknown']) assert.ok(FAILURE_CLASSES.includes(cls));
});

test('failure classes from QEDRank grade reasons and compiler text (single-call records)', () => {
  const c = (reasons, extra = {}) => classifyFailure({ reasons, ...extra }).class;
  assert.equal(c(['statement_changed']), 'statement_mismatch');
  assert.equal(c(['non_standard_axioms']), 'disallowed_proof');
  assert.equal(c(['kernel_replay_failed']), 'disallowed_proof');
  assert.equal(c(['disallowed_import']), 'dependency');
  assert.equal(c(['compile_timeout']), 'timeout');
  assert.equal(c(['compile_error'], { compilerOutput: '24:72: error: unsolved goals\n⊢ P' }), 'tactic');
  assert.equal(c(['compile_error'], { compilerOutput: '3:1: error: application type mismatch' }), 'type');
  assert.equal(c(['contains_sorry']), 'incomplete_proof');
  assert.equal(c(['solution_missing']), 'no_answer');
  assert.equal(c([], { abstained: true }), 'no_answer');
  assert.equal(c([], { truncated: true }), 'no_answer');
  assert.equal(classifyLeanText('error: deterministic timeout at whnf'), 'timeout');
  assert.equal(classifyLeanText(''), null);
});

test('statusOf and failureOf derive values for records written before the fields existed', () => {
  const old = { outcomes: { infrastructure_failure: false, verified: 0 }, grade: { reasons: ['compile_error'] }, compiler_output: '1:1: error: unknown identifier \'x\'' };
  assert.equal(statusOf(old), 'failed');
  assert.equal(failureOf(old).class, 'elaboration');
  assert.equal(statusOf({ outcomes: { infrastructure_failure: true } }), 'infrastructure_error');
  assert.equal(failureOf({ outcomes: { infrastructure_failure: true }, generation: { error: { kind: 'rate_limited', message: '429' } } }).class, 'provider');
  assert.equal(statusOf({ outcomes: { verified: 1 } }), 'fully_solved');
  assert.equal(failureOf({ outcomes: { verified: 1 } }), null);
  assert.equal(statusOf({ status: 'partially_solved', outcomes: { verified: 0 } }), 'partially_solved');
  assert.equal(failureOf({ status: 'failed', failure: { class: 'tactic', evidence: 'x' }, outcomes: { verified: 0 } }).class, 'tactic');
});
