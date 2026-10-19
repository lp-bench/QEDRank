// Statement comparison: builds the isolated Lean script that compares a model
// statement with the audited reference statement, and classifies the result.
//
// The comparison environment imports only statement-only modules (every proof
// replaced by an evaluator-attached `sorry`) plus the definitions prelude. It
// never imports the model's proof file or the reference proof file.

import { ALLOWED_AXIOMS, PLACEHOLDER_AXIOMS, NATIVE_DECIDE_AXIOMS } from './schema.js';

/** Portfolio of bounded automation used for each implication direction. */
function portfolio(hyp) {
  return [
    `exact ${hyp}`,
    `(simpa using ${hyp})`,
    `(intros; simp_all)`,
    `(intros; aesop)`,
    `(intros; omega)`,
    `(intros; exact?)`,
  ].join('\n    | ');
}

function outrightPortfolio() {
  return [
    `(intros; simp_all)`,
    `(intros; aesop)`,
    `(intros; omega)`,
    `decide`,
    `(intros; exact?)`,
  ].join('\n    | ');
}

/**
 * @param {object} p
 * @param {string} p.refModule      statement-only reference module name
 * @param {string} p.modelModule    statement-only model module name
 * @param {string} p.refDecl        fully qualified reference declaration (QRRef....)
 * @param {string} p.modelDecl      fully qualified model declaration (QRModel....)
 * @param {string[]} [p.unfold]     definition names to unfold in a last attempt
 * @param {number} [p.maxHeartbeats]
 */
export function buildComparisonScript({ refModule, modelModule, refDecl, modelDecl, unfold = [], maxHeartbeats = 200000 }) {
  const unfoldLine = unfold.length ? `\n    | (unfold ${unfold.join(' ')} at *; intros; aesop)` : '';
  return `import ${refModule}
import ${modelModule}
import QEDRank.Audit

set_option maxHeartbeats ${maxHeartbeats}

#qr_compare ${refDecl} ${modelDecl}
#qr_mk_prop QR_ref_prop := ${refDecl}
#qr_mk_prop QR_model_prop := ${modelDecl}

/-- reference ⇒ model -/
def QR_fwd (h : QR_ref_prop) : QR_model_prop := by
  delta QR_ref_prop at h
  delta QR_model_prop
  first
    | ${portfolio('h')}${unfoldLine}
#qr_uses_hyp QR_fwd
#qr_axioms QR_fwd

/-- model ⇒ reference -/
def QR_bwd (h : QR_model_prop) : QR_ref_prop := by
  delta QR_model_prop at h
  delta QR_ref_prop
  first
    | ${portfolio('h')}${unfoldLine}
#qr_uses_hyp QR_bwd
#qr_axioms QR_bwd

/-- is the model statement provable outright by the same automation? -/
def QR_model_outright : QR_model_prop := by
  delta QR_model_prop
  first
    | ${outrightPortfolio()}
#qr_axioms QR_model_outright

/-- is the reference statement provable outright by the same automation? -/
def QR_ref_outright : QR_ref_prop := by
  delta QR_ref_prop
  first
    | ${outrightPortfolio()}
#qr_axioms QR_ref_outright
`;
}

export function classifyAxioms(axioms = []) {
  const placeholder = axioms.some((a) => PLACEHOLDER_AXIOMS.includes(a));
  const native = axioms.some((a) => NATIVE_DECIDE_AXIOMS.includes(a));
  const other = axioms.filter((a) => !ALLOWED_AXIOMS.includes(a) && !PLACEHOLDER_AXIOMS.includes(a) && !NATIVE_DECIDE_AXIOMS.includes(a));
  return { placeholder, native_decide: native, user_axioms: other, clean: !placeholder && !native && other.length === 0 };
}

/**
 * Turn the QR_ records of a comparison script into a classification.
 * @param {{tag:string, fields:object}[]} qr
 * @param {{status:string}} scriptResult
 */
export function classifyComparison(qr, scriptResult) {
  const evidence = {
    syntactic_identical: null,
    reducible_defeq: null,
    default_defeq: null,
    fwd_proved: false,
    fwd_uses_hyp: null,
    bwd_proved: false,
    bwd_uses_hyp: null,
    model_provable_outright: false,
    ref_provable_outright: false,
    script_status: scriptResult?.status ?? 'not_attempted',
    notes: [],
  };
  if (!scriptResult || scriptResult.status === 'infrastructure_failure' || scriptResult.status === 'not_attempted') {
    return { statement_match: 'not_evaluated', method: 'none', evidence: { ...evidence, notes: [scriptResult?.infra_reason || 'comparison script not run'] } };
  }
  if (scriptResult.status === 'timeout') {
    evidence.notes.push('comparison script timed out');
  }
  const byName = (tag, name) => qr.find((r) => r.tag === tag && r.fields.name === name);
  const cmp = qr.find((r) => r.tag === 'QR_COMPARE');
  if (cmp) {
    evidence.syntactic_identical = Boolean(cmp.fields.syntactic);
    evidence.reducible_defeq = Boolean(cmp.fields.reducible);
    evidence.default_defeq = Boolean(cmp.fields.default);
  } else {
    evidence.notes.push('QR_COMPARE missing (statement declarations did not resolve)');
    return { statement_match: 'unresolved', method: 'automated', evidence };
  }
  const axOf = (name) => {
    const r = byName('QR_AXIOMS', name);
    return r ? classifyAxioms(r.fields.axioms || []) : null;
  };
  const fwdAx = axOf('QR_fwd');
  const bwdAx = axOf('QR_bwd');
  const fwdUse = byName('QR_USES_HYP', 'QR_fwd');
  const bwdUse = byName('QR_USES_HYP', 'QR_bwd');
  evidence.fwd_proved = Boolean(fwdAx && fwdAx.clean);
  evidence.bwd_proved = Boolean(bwdAx && bwdAx.clean);
  evidence.fwd_uses_hyp = fwdUse ? fwdUse.fields.uses === true : null;
  evidence.bwd_uses_hyp = bwdUse ? bwdUse.fields.uses === true : null;
  const mo = axOf('QR_model_outright');
  const ro = axOf('QR_ref_outright');
  evidence.model_provable_outright = Boolean(mo && mo.clean);
  evidence.ref_provable_outright = Boolean(ro && ro.clean);

  if (evidence.default_defeq) {
    return { statement_match: 'definitionally_identical', method: evidence.syntactic_identical ? 'syntactic_identity' : 'isDefEq_default_transparency', evidence };
  }
  const fwdOk = evidence.fwd_proved && evidence.fwd_uses_hyp === true;
  const bwdOk = evidence.bwd_proved && evidence.bwd_uses_hyp === true;
  if (fwdOk && bwdOk) {
    if (evidence.model_provable_outright || evidence.ref_provable_outright) {
      evidence.notes.push('both implications proved but a statement is provable outright by the same automation; equivalence evidence is vacuous - expert review required');
      return { statement_match: 'unresolved', method: 'automated_bidirectional_implication', evidence };
    }
    return { statement_match: 'equivalent', method: 'automated_bidirectional_implication', evidence };
  }
  if (fwdOk) evidence.notes.push('reference implies model statement (candidate: weaker or equivalent) - reverse direction unresolved');
  if (bwdOk) evidence.notes.push('model statement implies reference (candidate: stronger or equivalent) - reverse direction unresolved');
  if (evidence.fwd_proved && evidence.fwd_uses_hyp === false) evidence.notes.push('forward implication proof ignored its hypothesis');
  if (evidence.bwd_proved && evidence.bwd_uses_hyp === false) evidence.notes.push('backward implication proof ignored its hypothesis');
  return { statement_match: 'unresolved', method: 'automated_bidirectional_implication', evidence };
}

/** Apply an expert decision on top of the automated classification. */
export function applyExpertDecision(auto, decision) {
  if (!decision || !decision.statement_match) return { ...auto, source: 'automated' };
  const allowed = ['expert_confirmed_equivalent', 'stronger', 'weaker', 'different', 'unresolved', 'definitionally_identical', 'equivalent'];
  if (!allowed.includes(decision.statement_match)) return { ...auto, source: 'automated', evidence: { ...auto.evidence, notes: [...(auto.evidence?.notes || []), `ignored invalid expert decision ${decision.statement_match}`] } };
  return {
    statement_match: decision.statement_match,
    method: 'expert_review',
    source: 'expert_review',
    automated: { statement_match: auto.statement_match, method: auto.method },
    evidence: auto.evidence,
    review: { reviewer: decision.reviewer || null, note: decision.note || null, date: decision.date || null },
  };
}
