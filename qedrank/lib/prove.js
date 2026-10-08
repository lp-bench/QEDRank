// Task "prove": the model receives the challenge file as it is (statement, definitions and the
// one intended `sorry`) and returns the completed file. The answer is judged by the same
// independent check as the agent protocol (grade.js): compiles, no sorry, standard axioms,
// statement and definitions unchanged as compiled declarations, kernel replay.
//
// This is the single-call counterpart of the agent protocol. It needs no paper PDF and no
// reference statement module, so it runs on every challenge whose imports the Lean project
// can resolve.

import path from 'node:path';
import { sha256, nowMono, isoNow, writeText, writeJson, ensureDir } from './util.js';
import { extractCodeBlocks } from './prompt.js';
import { SYSTEM_PROMPT } from '../../lib/providers.js';
import { gradeSubmission, DEFAULT_GRADE_POLICY } from './grade.js';
import { ITEM_SCHEMA } from './schema.js';
import { contaminationOf } from './evaluate.js';

export const PROVE_TEMPLATE_VERSION = 'qedrank-prove-v1';

export const PROVE_ENDPOINT = Object.freeze({
  id: 'verified_pass1_prove',
  description: 'Strict verified success at pass@1 on the given statement: the model\'s completed file compiles under the pinned toolchain, contains no sorry, its main theorem depends only on the standard axioms, the theorem statement and every definition of the challenge file are unchanged as compiled declarations, and every declaration replays through the kernel. Claims that are not established are excluded.',
});

export const PROVE_TEMPLATE = `You are completing one Lean 4 proof with Mathlib.

Problem: {paper_id}
Main theorem: {target}
Toolchain: {lean_toolchain} with Mathlib {mathlib_version}

The file below states the theorem \`{target}\` with its proof replaced by \`sorry\`. Return the SAME file with that \`sorry\` replaced by a complete proof.

Rules, checked automatically:
1. The statement of \`{target}\` and every definition in the file stay exactly as given (they are compared after compilation, so changing an instance, a variable or a notation that alters their meaning counts as a change). You may add helper lemmas and definitions above the main theorem.
2. Keep every import of the file; add imports only from {allowed_imports}.
3. No \`sorry\` or \`admit\` anywhere, no new \`axiom\`, no \`native_decide\`, no \`unsafe\`, no \`#eval\`/\`run_cmd\`/\`elab\`/\`macro\`.
4. If you cannot complete the proof, say so in one sentence and return no file.

Return the complete file in one \`\`\`lean block and nothing else.

\`\`\`lean
{challenge}
\`\`\``;

export function renderProvePrompt(vars) {
  for (const k of ['paper_id', 'target', 'challenge']) if (typeof vars[k] !== 'string') throw new Error(`renderProvePrompt: missing ${k}`);
  const all = { lean_toolchain: 'the pinned toolchain', mathlib_version: 'the pinned version', allowed_imports: 'Mathlib or the ProofBench statement library (ProofBench.Mathlib_Problems)', ...vars };
  const text = PROVE_TEMPLATE.replace(/\{([a-z_]+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
  return { text, system: SYSTEM_PROMPT, hash: sha256(`${SYSTEM_PROMPT}\n\n${text}`), templateVersion: PROVE_TEMPLATE_VERSION };
}

const LEAN_START = /^(import|theorem|lemma|def|open|namespace|variable|noncomputable|universe|set_option|\/-)/m;

/**
 * The completed file from a model response: the largest ```lean block; a bare Lean file
 * without fences is accepted with a note; prose alone counts as abstention.
 */
export function parseProveResponse(text) {
  const notes = [];
  if (typeof text !== 'string' || !text.trim()) return { file: null, abstained: true, notes: ['empty_response'] };
  const blocks = extractCodeBlocks(text).filter((b) => !b.lang || b.lang === 'lean' || b.lang === 'lean4');
  if (blocks.length) {
    const sorted = [...blocks].sort((a, b) => b.code.length - a.code.length);
    if (blocks.length > 1) notes.push('multiple_blocks_largest_used');
    return { file: sorted[0].code, abstained: false, notes };
  }
  if (LEAN_START.test(text) && /:=/.test(text)) { notes.push('unfenced_file'); return { file: text.trim(), abstained: false, notes }; }
  return { file: null, abstained: true, notes: ['no_lean_file_in_response'] };
}

/**
 * Evaluate one answer to the "prove" task: parse the file, grade it, record the item.
 * Never throws for a bad answer; grader failures are infrastructure failures.
 */
export async function evaluateProveAttempt({ runner, toolchain, paper, target, challengeSrc, generation, itemDir, config, setting = 'pass@1', attempt = 1, repairRound = 0, log = () => {} }) {
  const t0 = nowMono();
  const kind = target.target_kind;
  const key = `${paper.paper_id}__${kind}__${generation.provider}`;
  const suffix = `a${attempt}r${repairRound}`;
  const status = target.mathematical_status;
  const proofTrack = status === 'established' || (kind === 'disproof' && status === 'refuted');
  const rec = {
    schema: ITEM_SCHEMA,
    item_key: key,
    paper_id: paper.paper_id,
    target_kind: kind,
    provider: generation.provider,
    model_display_name: generation.display_name,
    model_id: generation.model_id,
    model_label: generation.label ?? null,
    api_host: generation.api_host ?? null,
    response_model: generation.response_model ?? null,
    setting,
    attempt,
    repair_round: repairRound,
    task: 'prove',
    mathematical_status: status,
    reference_proof_status: 'challenge',
    reference_statement_available: true,
    contamination: contaminationOf(paper, generation),
    generation: {
      mode: generation.mode,
      error: generation.error,
      http_status: generation.http_status,
      finish_reason: generation.finish_reason,
      observed_latency_ms: generation.observed_latency_ms,
      working_ms: generation.working_ms ?? null,
      usage: generation.usage,
      reasoning_chars: generation.reasoning_chars ?? null,
      provider_attempts: generation.provider_attempts ?? null,
      retry_wait_ms: generation.retry_wait_ms ?? null,
      truncated: Boolean(generation.truncated),
      prompt_hash: generation.prompt_hash,
      prompt_template_version: generation.prompt_template_version,
      temperature: generation.temperature,
      effort: generation.effort ?? null,
      max_tokens: generation.max_tokens,
      timeout_ms: generation.timeout_ms,
      started_at: generation.started_at,
      ended_at: generation.ended_at,
      response_chars: (generation.text || '').length,
    },
    parse: null,
    confidence: { statement: null, proof: null },
    abstained: false,
    static_screen: null,
    compile: null,
    audit: null,
    statement_match: 'not_evaluated',
    statement_match_source: null,
    grade: null,
    loc: null,
    timing: { evaluation_started_at: isoNow(), lean_compile_ms: null, lean_total_ms: null, evaluation_total_ms: null, total_ms: null, working_ms: null },
    eligibility: { statement_track: true, proof_track: proofTrack, reasons: proofTrack ? [] : [`mathematical_status_${status}`] },
    outcomes: { infrastructure_failure: false, compiled: null, audit_clean: null, statement_faithful: null, verified: null },
    notes: [],
  };
  await ensureDir(itemDir);
  const finish = async () => {
    rec.timing.evaluation_total_ms = nowMono() - t0;
    rec.timing.total_ms = (rec.generation.observed_latency_ms ?? 0) + rec.timing.evaluation_total_ms;
    rec.timing.working_ms = typeof rec.generation.working_ms === 'number' ? rec.generation.working_ms + (rec.timing.lean_total_ms ?? 0) : null;
    rec.timing.evaluation_ended_at = isoNow();
    rec.evaluation_complete = true;
    await writeJson(path.join(itemDir, `attempt-${suffix}.json`), rec);
    log(`${key} [${setting} ${suffix}] ${rec.outcomes.infrastructure_failure ? 'infrastructure_failure' : rec.grade?.verdict ?? 'abstained'}${rec.grade?.reasons?.length ? ` (${rec.grade.reasons.join(', ')})` : ''}`);
    return rec;
  };

  if (generation.error) {
    rec.outcomes.infrastructure_failure = true;
    rec.notes.push(`generation_${generation.error.kind}`);
    rec.compile = { status: 'not_attempted' };
    rec.audit = { status: 'not_audited' };
    return finish();
  }
  await writeText(path.join(itemDir, `response-${suffix}.txt`), generation.text || '');
  const parsed = parseProveResponse(generation.text);
  rec.parse = { has_file: Boolean(parsed.file), notes: parsed.notes };
  rec.abstained = parsed.abstained;
  if (!parsed.file) {
    rec.compile = { status: 'not_attempted', reason: 'abstained' };
    rec.audit = { status: 'not_audited' };
    rec.outcomes.verified = proofTrack ? 0 : null;
    return finish();
  }
  await writeText(path.join(itemDir, `proof-${suffix}.lean`), parsed.file);

  const grade = await gradeSubmission({
    runner,
    toolchain,
    challengeSrc,
    solutionSrc: parsed.file,
    target: target.declaration_name || null,
    scratchDir: path.join(itemDir, 'lean', suffix),
    cacheDir: path.join(config.runsDir, '.grade-cache'),
    policy: { ...DEFAULT_GRADE_POLICY, ...(config.grade || {}) },
    allowedAxioms: config.allowedAxioms,
    log,
  });
  const { compiler_output: compilerOutput, ...rest } = grade;
  rec.grade = rest;
  rec.compiler_output = compilerOutput;
  rec.static_screen = grade.checks.static_screen;
  const screened = (grade.reasons || []).some((r) => ['static_screen_rejected', 'disallowed_import', 'challenge_import_removed'].includes(r)) && grade.checks.compile?.status === 'not_attempted';
  const compileStatus = screened ? 'rejected_by_static_screen' : grade.checks.compile?.status ?? 'not_attempted';
  rec.compile = { status: compileStatus, error_count: grade.checks.compile?.error_count ?? null, duration_ms: grade.timing?.compile_ms ?? null, messages: [] };
  rec.audit = { status: grade.checks.axioms?.status ?? 'not_audited', axioms: grade.checks.axioms?.axioms ?? [], kernel_replay: grade.checks.kernel_replay?.status ?? null, file_sorry_free: grade.checks.sorry?.file_sorry_free ?? null };
  const stmt = grade.checks.statement?.status ?? null;
  rec.statement_match = stmt === 'unchanged' ? 'definitionally_identical' : stmt === 'changed' ? 'different' : 'not_evaluated';
  rec.statement_match_source = stmt ? 'compiled_declarations' : null;
  rec.loc = grade.proof ? { model: { total: grade.proof.solution_total_lines, code: grade.proof.solution_code_lines, proof: { code: grade.proof.proof_lines } }, reference: null, rule: grade.proof.rule } : null;
  rec.timing.lean_compile_ms = grade.timing?.compile_ms ?? null;
  rec.timing.lean_total_ms = grade.timing?.total_ms ?? null;
  rec.notes.push(...(grade.warnings || []));

  if (grade.verdict === 'grader_error') {
    rec.outcomes.infrastructure_failure = true;
    rec.notes.push(`grader_error: ${(grade.reasons || []).join(', ')}`);
    return finish();
  }
  const compiled = compileStatus === 'compiler_success' ? 1 : ['compiler_failure', 'timeout', 'rejected_by_static_screen'].includes(compileStatus) ? 0 : null;
  rec.outcomes.compiled = compiled;
  rec.outcomes.audit_clean = compiled === 1 ? (grade.checks.axioms?.status === 'clean' && grade.checks.sorry?.file_sorry_free ? 1 : 0) : null;
  rec.outcomes.statement_faithful = stmt ? (stmt === 'unchanged' ? 1 : 0) : null;
  rec.outcomes.verified = proofTrack ? (grade.verdict === 'solved' ? 1 : 0) : null;
  if (status === 'open' && grade.verdict === 'solved') rec.notes.push('ESCALATE: apparent proof of an open claim - independent mathematical review required');
  return finish();
}
