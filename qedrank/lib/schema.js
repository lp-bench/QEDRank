// Enumerations and record shapes shared by the runner, the API and the UI.
// Everything here is plain data so it can be imported from Node and Vite alike.

export const MANIFEST_SCHEMA = 'qedrank-manifest-v1';
export const RUN_SCHEMA = 'qedrank-run-v1';
export const ITEM_SCHEMA = 'qedrank-item-v1';
export const SUMMARY_SCHEMA = 'qedrank-summary-v1';

export const TARGET_KINDS = Object.freeze(['main_theorem', 'upper_bound', 'lower_bound', 'disproof']);
export const TARGET_LABELS = Object.freeze({
  main_theorem: 'Main theorem',
  upper_bound: 'Upper bound',
  lower_bound: 'Lower bound',
  disproof: 'Disproof',
});

export const MATH_STATUS = Object.freeze(['established', 'open', 'refuted', 'uncertain']);
export const REF_PROOF_STATUS = Object.freeze(['complete', 'contains_placeholder', 'missing', 'invalid', 'unknown']);

export const COMPILE_STATUS = Object.freeze([
  'compiler_success',
  'compiler_failure',
  'timeout',
  'infrastructure_failure',
  'not_attempted',
  'rejected_by_static_screen',
]);

export const STATEMENT_MATCH = Object.freeze([
  'definitionally_identical',
  'equivalent',
  'expert_confirmed_equivalent',
  'stronger',
  'weaker',
  'different',
  'unresolved',
  'not_evaluated',
]);
export const STATEMENT_MATCH_ACCEPTED = Object.freeze([
  'definitionally_identical',
  'equivalent',
  'expert_confirmed_equivalent',
]);

export const AUDIT_STATUS = Object.freeze([
  'clean',
  'placeholder',
  'user_axiom',
  'native_decide',
  'unsafe',
  'disallowed_import',
  'forbidden_command',
  'target_not_found',
  'not_audited',
]);

export const ALLOWED_AXIOMS = Object.freeze(['propext', 'Classical.choice', 'Quot.sound']);
export const NATIVE_DECIDE_AXIOMS = Object.freeze(['Lean.ofReduceBool', 'Lean.ofReduceNat']);
export const PLACEHOLDER_AXIOMS = Object.freeze(['sorryAx']);

export const STAGES = Object.freeze([
  'discovery',
  'preparation',
  'generation',
  'compilation',
  'audit',
  'comparison',
  'statistics',
]);

export const STAGE_STATUS = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);

export const SETTINGS = Object.freeze({
  PASS_AT_1: 'pass@1',
  REPAIR: 'repair',
});

/** Key used for per-item artifact directories and resume bookkeeping. */
export function itemKey(paperId, targetKind, provider) {
  return `${paperId}__${targetKind}__${provider}`;
}

/** Eligibility rules, spelled out so every denominator is documented. */
export const ELIGIBILITY = Object.freeze({
  statement_track:
    'Paper x target has an audited reference statement (reference file present, target declaration resolved, reference statement elaborates). Open claims are included.',
  proof_track:
    'Statement-track eligible AND mathematical_status is established (or refuted for disproof targets with confirmed polarity). Open/uncertain claims are excluded. Infrastructure failures are excluded from the denominator and counted separately.',
  compile_rate:
    'Model returned a purported complete proof file that passed the static screen. Abstentions and infrastructure failures are excluded and counted separately.',
  sandwich_coverage:
    'Paper has audited main_theorem, upper_bound and lower_bound references. Covered when all three model statements are accepted matches and every declared bridge check has review status passed.',
  calibration:
    'Items with a parsed confidence estimate and a determinate outcome. Infrastructure failures are excluded and counted.',
});
