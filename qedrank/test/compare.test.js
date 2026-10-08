import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyComparison, classifyAxioms, buildComparisonScript, applyExpertDecision } from '../lib/compare.js';
import { parseQrLine, parseJsonMessages } from '../lib/lean.js';

const ok = { status: 'compiler_success' };
const q = (tag, fields) => ({ tag, fields });

test('classifyAxioms distinguishes placeholder, native_decide and user axioms', () => {
  assert.equal(classifyAxioms(['propext', 'Classical.choice', 'Quot.sound']).clean, true);
  assert.equal(classifyAxioms(['sorryAx']).placeholder, true);
  assert.equal(classifyAxioms(['Lean.ofReduceBool']).native_decide, true);
  assert.deepEqual(classifyAxioms(['myAxiom']).user_axioms, ['myAxiom']);
});

test('definitional identity wins', () => {
  const r = classifyComparison([q('QR_COMPARE', { syntactic: false, reducible: false, default: true })], ok);
  assert.equal(r.statement_match, 'definitionally_identical');
});

test('equivalence requires both directions, clean axioms, hypothesis use and no vacuity', () => {
  const base = [
    q('QR_COMPARE', { syntactic: false, reducible: false, default: false }),
    q('QR_USES_HYP', { name: 'QR_fwd', uses: true }),
    q('QR_AXIOMS', { name: 'QR_fwd', axioms: ['propext'] }),
    q('QR_USES_HYP', { name: 'QR_bwd', uses: true }),
    q('QR_AXIOMS', { name: 'QR_bwd', axioms: [] }),
    q('QR_AXIOMS', { name: 'QR_model_outright', axioms: ['sorryAx'] }),
    q('QR_AXIOMS', { name: 'QR_ref_outright', axioms: ['sorryAx'] }),
  ];
  assert.equal(classifyComparison(base, ok).statement_match, 'equivalent');
  // backward direction failed (sorry) -> unresolved, never "different"
  const oneWay = base.map((r) => (r.fields.name === 'QR_bwd' && r.tag === 'QR_AXIOMS' ? q('QR_AXIOMS', { name: 'QR_bwd', axioms: ['sorryAx'] }) : r));
  const u = classifyComparison(oneWay, ok);
  assert.equal(u.statement_match, 'unresolved');
  assert.ok(u.evidence.notes.some((n) => /reference implies model/.test(n)));
  // implication proved without using the hypothesis -> not accepted
  const noHyp = base.map((r) => (r.fields.name === 'QR_fwd' && r.tag === 'QR_USES_HYP' ? q('QR_USES_HYP', { name: 'QR_fwd', uses: false }) : r));
  assert.equal(classifyComparison(noHyp, ok).statement_match, 'unresolved');
  // model statement provable outright -> vacuous equivalence -> unresolved for expert review
  const vac = base.map((r) => (r.fields.name === 'QR_model_outright' ? q('QR_AXIOMS', { name: 'QR_model_outright', axioms: [] }) : r));
  const v = classifyComparison(vac, ok);
  assert.equal(v.statement_match, 'unresolved');
  assert.equal(v.evidence.model_provable_outright, true);
});

test('infrastructure failure is not_evaluated; missing compare is unresolved', () => {
  assert.equal(classifyComparison([], { status: 'infrastructure_failure', infra_reason: 'x' }).statement_match, 'not_evaluated');
  assert.equal(classifyComparison([], ok).statement_match, 'unresolved');
});

test('expert decisions override and are labelled', () => {
  const auto = classifyComparison([], ok);
  const d = applyExpertDecision(auto, { statement_match: 'weaker', reviewer: 'r1', note: 'drops hypothesis' });
  assert.equal(d.statement_match, 'weaker');
  assert.equal(d.source, 'expert_review');
  assert.equal(d.automated.statement_match, 'unresolved');
  assert.equal(applyExpertDecision(auto, { statement_match: 'bogus' }).statement_match, 'unresolved');
});

test('comparison script imports only statement-only modules and the audit commands', () => {
  const s = buildComparisonScript({ refModule: 'QRSR_p_main', modelModule: 'QRSM_p_main_g', refDecl: 'QRRef.t', modelDecl: 'QRModel.t', unfold: ['QRRef.f'] });
  assert.match(s, /^import QRSR_p_main\nimport QRSM_p_main_g\nimport QEDRank\.Audit\n/);
  assert.doesNotMatch(s, /import QRM_/);
  assert.ok(s.includes('def QR_fwd (h : QR_ref_prop) : QR_model_prop'));
  assert.ok(s.includes('#qr_uses_hyp QR_bwd'));
  assert.ok(s.includes('unfold QRRef.f'));
});

test('QR line and lean --json parsing', () => {
  const r = parseQrLine('QR_AXIOMS name=A kind=theorem prop=true unsafe=false partial=false axioms=[propext,Classical.choice]');
  assert.equal(r.tag, 'QR_AXIOMS');
  assert.deepEqual(r.fields.axioms, ['propext', 'Classical.choice']);
  assert.equal(r.fields.prop, true);
  assert.deepEqual(parseQrLine('QR_DECLS_DONE module=T2 count=3').fields, { module: 'T2', count: 3 });
  assert.equal(parseQrLine('hello'), null);
  const msgs = parseJsonMessages('{"severity":"error","pos":{"line":3,"column":2},"fileName":"x.lean","data":"boom"}\nnoise\n{"severity":"information","pos":{"line":1,"column":0},"data":"QR_VERSION lean=4.34.1"}');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].severity, 'error');
  assert.equal(msgs[0].line, 3);
});
