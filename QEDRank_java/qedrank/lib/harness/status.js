// Attempt status and failure classes, shared by the importers, the summary and the page.
// Plain data and pure functions only, so Node and Vite import the same file.
//
// Status (one per attempt record):
//   fully_solved         the proof passed every required check of its harness (ProofBench: layer 1
//                        and Comparator; QEDRank: compile, no sorry, standard axioms, statement
//                        unchanged, kernel replay)
//   partially_solved     not solved, but the final file compiles and holds at least one auxiliary
//                        lemma that QEDRank's grader verified independently (sorry-free, standard
//                        axioms); the evidence and the method are recorded on the item
//   failed               no accepted complete proof and no verified partial progress
//   infrastructure_error the attempt could not be carried out or graded (provider, sandbox,
//                        checker); excluded from every denominator and counted separately
//   pending/running/cancelled  operational states of planned attempts that have no record yet
//
// A compiling file is never a success; partial results never count toward verified rates or pass@k.

export const ATTEMPT_STATUS = Object.freeze(['fully_solved', 'partially_solved', 'failed', 'infrastructure_error', 'pending', 'running', 'cancelled']);
export const ATTEMPT_STATUS_LABELS = Object.freeze({
  fully_solved: 'Fully solved',
  partially_solved: 'Partially solved',
  failed: 'Failed',
  infrastructure_error: 'Infrastructure error',
  pending: 'Pending',
  running: 'Running',
  cancelled: 'Cancelled',
});

export const FAILURE_CLASSES = Object.freeze([
  'syntax', 'elaboration', 'type', 'tactic', 'timeout', 'dependency', 'statement_mismatch',
  'disallowed_proof', 'incomplete_proof', 'no_answer', 'provider', 'infrastructure', 'unknown',
]);
export const FAILURE_CLASS_LABELS = Object.freeze({
  syntax: 'Syntax error',
  elaboration: 'Elaboration (unknown name)',
  type: 'Type error',
  tactic: 'Tactic failure / unsolved goals',
  timeout: 'Timeout',
  dependency: 'Dependency / import',
  statement_mismatch: 'Statement changed',
  disallowed_proof: 'Disallowed proof construct',
  incomplete_proof: 'Incomplete proof (sorry left)',
  no_answer: 'No answer / no file',
  provider: 'Provider failure',
  infrastructure: 'Infrastructure failure',
  unknown: 'Unclassified',
});

const PROVIDER_END = /^provider_error|^error:.*(RateLimit|APIStatus|APIConnection|APITimeout|Timeout|InternalServer|ServiceUnavailable|Overloaded|BadGateway|GatewayTimeout|ConnectError|ReadTimeout|RemoteProtocol|\b429\b|\b5\d\d\b)/i;
const ERROR_END = /^provider_error|^error/i;

/** True when a session end string (ProofBench harness `ended_by`) denotes a provider failure. */
export function isProviderEnd(s) { return PROVIDER_END.test(String(s || '')); }
export function isErrorEnd(s) { return ERROR_END.test(String(s || '')); }

/** Class of a Lean compiler diagnostic, from its text. */
export function classifyLeanText(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (/deterministic timeout|maximum heartbeats|\(deterministic\) timeout|timed out/i.test(t)) return 'timeout';
  if (/unknown module|object file .* does not exist|unknown package|could not resolve import|import .*failed|no such file.*\.olean/i.test(t)) return 'dependency';
  if (/unexpected token|expected '|expected term|expected command|unterminated|parse error|unexpected end of input|unexpected identifier/i.test(t)) return 'syntax';
  if (/unknown identifier|unknown constant|unknown namespace|unknown tactic|unknown attribute|ambiguous, possible interpretations|invalid field notation|has already been declared/i.test(t)) return 'elaboration';
  if (/type mismatch|application type mismatch|failed to synthesize|but is expected to have type|motive is not type correct|function expected|numerals are data|invalid field|failed to unify|not a structure|universe level/i.test(t)) return 'type';
  if (/unsolved goals|tactic .*failed|linarith failed|omega could not|simp made no progress|ring failed|no goals to be proved|decide failed|nlinarith failed|positivity failed|could not close the goal|rewrite failed|did not find instance|rfl.*failed|aesop.*(failed|unable)|exact\? could not|maximum recursion depth|norm_num failed|induction tactic failed|cases tactic failed/i.test(t)) return 'tactic';
  return null;
}

/**
 * Failure class of one unsuccessful attempt. Evidence drawn from, in order: the sample/session
 * state (provider or infrastructure), the harness's layer-1 error strings, the grader's verdict
 * reasons, the compiler text, the sample limit. Returns { class, evidence }.
 */
export function classifyFailure({ errors = [], compilerOutput = '', sessionEnds = [], sampleError = null, limit = null, abstained = false, truncated = false, reasons = [], infrastructure = false } = {}) {
  const errs = errors.map((e) => String(e));
  const joined = errs.join('\n');
  const first = (re) => errs.find((e) => re.test(e)) || null;
  const ev = (cls, text) => ({ class: cls, evidence: text ? String(text).slice(0, 300) : null });

  if (sampleError) return ev(/rate ?limit|429|5\d\d|connection|timeout|overloaded/i.test(String(sampleError)) ? 'provider' : 'infrastructure', sampleError);
  if (sessionEnds.length && sessionEnds.every(isErrorEnd)) return ev(sessionEnds.every(isProviderEnd) ? 'provider' : 'infrastructure', sessionEnds[0]);
  if (/checker failed|checker did not finish|cannot read submission|grader_error|toolchain_unavailable/i.test(joined) || infrastructure) return ev('infrastructure', first(/checker|cannot read|grader/i) || 'infrastructure');

  if (first(/theorem statement altered|no longer states theorem|reference line missing or altered|line added before the theorem|reference has no main theorem/i)) return ev('statement_mismatch', first(/statement|reference line|line added/i));
  // Comparator (layer 2) rejects a file that passed layer 1: the elaborated statement or its
  // dependencies differ from the trusted module, or the kernel replay failed.
  if (first(/^comparator rejected/i)) return ev('statement_mismatch', first(/^comparator rejected/i));
  if (first(/declares an axiom|native_decide|implemented_by|bypasses the kernel|elaboration time|# command|non-standard axioms|syntax\/notation command/i)) return ev('disallowed_proof', first(/axiom|native_decide|implemented_by|kernel|elaboration|# command|notation/i));
  if (first(/disallowed import|imported file not found|helper build error/i)) return ev('dependency', first(/import|helper build/i));
  if (first(/compile timeout|build timeout/i)) return ev('timeout', first(/timeout/i));
  const compileErr = first(/^compile error:/i);
  if (compileErr) return ev(classifyLeanText(compileErr) || 'unknown', compileErr.replace(/^compile error:\s*/i, ''));
  if (first(/contains sorry|declaration uses sorry|no proof after the statement/i)) return ev('incomplete_proof', first(/sorry|no proof/i));

  // QEDRank grade reasons (prove task / re-grade).
  const R = new Set(reasons);
  if (['statement_changed', 'definition_changed', 'definition_removed', 'target_missing', 'target_is_not_a_theorem'].some((r) => R.has(r))) return ev('statement_mismatch', reasons.join(', '));
  if (['non_standard_axioms', 'native_decide', 'unsafe_declaration', 'static_screen_rejected', 'kernel_replay_failed'].some((r) => R.has(r))) return ev('disallowed_proof', reasons.join(', '));
  if (['disallowed_import', 'challenge_import_removed'].some((r) => R.has(r))) return ev('dependency', reasons.join(', '));
  if (R.has('compile_timeout')) return ev('timeout', 'compile_timeout');
  if (R.has('compile_error')) { const m = String(compilerOutput).match(/error: ([^\n]*)/); return ev(classifyLeanText(compilerOutput) || 'unknown', m ? m[1] : 'compile_error'); }
  if (['contains_sorry', 'sorry_in_file'].some((r) => R.has(r))) return ev('incomplete_proof', reasons.join(', '));
  if (R.has('solution_missing') || abstained) return ev('no_answer', abstained ? 'no Lean file in the answer' : 'solution_missing');

  if (limit?.type === 'time' || limit?.type === 'working') return ev('timeout', `sample limit: ${limit.type}`);
  if (limit?.type === 'token') return ev('incomplete_proof', 'token budget exhausted before a complete proof');
  if (truncated) return ev('no_answer', 'answer cut off at the output limit');
  const fromText = classifyLeanText(compilerOutput);
  if (fromText) { const m = String(compilerOutput).match(/error: ([^\n]*)/); return ev(fromText, m ? m[1] : null); }
  if (errs.length) return ev('unknown', errs[0]);
  return ev('unknown', null);
}

/**
 * Status of one attempt from its grading facts.
 * @param {object} p
 * @param {boolean} p.infrastructure  the attempt could not be carried out or graded
 * @param {boolean} p.solved          every required check passed
 * @param {object}  [p.partial]       { assessed, verified_aux_lemmas } from the independent re-grade
 */
export function classifyAttempt({ infrastructure = false, solved = false, partial = null } = {}) {
  if (infrastructure) return 'infrastructure_error';
  if (solved) return 'fully_solved';
  if (partial?.assessed && (partial.verified_aux_lemmas ?? 0) > 0) return 'partially_solved';
  return 'failed';
}

/** Failure class of an item record: the stored one, else derived from its grade and generation. */
export function failureOf(item) {
  if (!item) return null;
  if (item.failure && item.failure.class) return item.failure;
  const st = statusOf(item);
  if (st === 'fully_solved') return null;
  const gen = item.generation || {};
  const errKind = gen.error?.kind || null;
  return classifyFailure({
    reasons: item.grade?.reasons || item.agent?.final_reasons || [],
    compilerOutput: item.compiler_output || '',
    abstained: Boolean(item.abstained),
    truncated: Boolean(gen.truncated),
    infrastructure: Boolean(item.outcomes?.infrastructure_failure) && !errKind,
    sampleError: errKind ? `${errKind}: ${gen.error?.message || ''}` : null,
    sessionEnds: (item.agent?.sessions || []).map((s) => s.ended_by || s.stop_reason || ''),
    limit: item.agent?.inspect?.sample_limit || null,
  });
}

/** Status of an item record; records written before the field existed are derived from their outcomes. */
export function statusOf(item) {
  if (item?.status && ATTEMPT_STATUS.includes(item.status)) return item.status;
  return classifyAttempt({ infrastructure: Boolean(item?.outcomes?.infrastructure_failure), solved: item?.outcomes?.verified === 1, partial: item?.partial ?? null });
}
