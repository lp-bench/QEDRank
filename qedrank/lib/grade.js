// Independent Lean check of an agent's solution file against its challenge file.
//
// A submission is a solution when the solution file
//   1. passes the static screen and the import policy,
//   2. compiles without errors,
//   3. contains no `sorry` and its target depends only on the standard axioms,
//   4. leaves the target's statement and every definition of the challenge file unchanged, and
//   5. replays through the kernel.
//
// Check 4 is made on the compiled declarations, not on the text: the challenge and the
// solution are compiled to object files under the same module name and every declaration of
// the challenge is compared with the declaration of the same name in the solution. A changed
// `variable`, `open`, notation or instance that alters what the unchanged text means is
// therefore caught, and a reformatted statement that means the same is accepted.
//
// The solution is the only input taken from the agent. Mathlib and the statement library come
// from the grader's own Lean project, never from the agent's working copy.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseImports, staticScreen, findDeclarations, theoremNames, countLines, stripComments, DEFAULT_ALLOWED_IMPORT_PREFIXES } from './leansrc.js';
import { classifyAxioms } from './compare.js';
import { ensureDir, writeText, exists, sha256, nowMono, isoNow } from './util.js';

export const GRADE_SCHEMA = 'qedrank-grade-v1';
export const SUBMISSION_MODULE = 'QRSubmission';
const AUDIT_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lean', 'QEDRank', 'Audit.lean');

export const DEFAULT_GRADE_POLICY = Object.freeze({
  // Public statement library a challenge may import besides Mathlib.
  libraryPrefixes: ['ProofBench.Mathlib_Problems'],
  // Proctor-only modules (theorem sandwich, reference solutions): never importable, even with search on.
  hiddenPrefixes: ['ProofBench.Mathlib', 'ProofBench.PROBLEMS', 'ProofBench.DATABASE'],
  // The web-search configuration lets the agent add libraries; their object files must be on extraLeanPath.
  allowExtraImports: false,
  // The rule is "no sorry in the file"; true accepts a leftover sorry in a lemma the target does not use.
  allowUnusedSorry: false,
  kernelReplay: true,
});

const hasPrefix = (mod, prefixes) => prefixes.some((p) => mod === p || mod.startsWith(`${p}.`));

/**
 * Imports of the challenge that the solution no longer has. Every one must stay: dropping an
 * import could let another module supply different declarations under the same names.
 * `import Mathlib` covers every Mathlib module.
 */
export function removedImports(challengeImports, solutionImports) {
  const covered = (m) => solutionImports.includes(m) || (solutionImports.includes('Mathlib') && hasPrefix(m, ['Mathlib']));
  return challengeImports.filter((m) => !covered(m));
}

/** Static screen plus the import policy. Pure; no Lean needed. */
export function screenSolution(challengeSrc, solutionSrc, policy = DEFAULT_GRADE_POLICY, { maxHeartbeats = 400000 } = {}) {
  const challengeImports = parseImports(challengeSrc);
  const solutionImports = parseImports(solutionSrc);
  const allowedPrefixes = [...DEFAULT_ALLOWED_IMPORT_PREFIXES, ...policy.libraryPrefixes];
  // An import the challenge file itself contains belongs to the problem, whatever its prefix (another
  // library such as Matroid or Archive, or another problem's module); only the imports a solution adds
  // are judged by the policy.
  const added = solutionImports.filter((m) => !challengeImports.includes(m));
  // With extra imports allowed every import passes the screen's own allowlist; the hidden library is checked below.
  const screen = staticScreen(solutionSrc, {
    allowedImportPrefixes: allowedPrefixes,
    allowedImports: policy.allowExtraImports ? solutionImports : challengeImports,
    maxHeartbeats,
  });
  const hidden = added.filter((m) => hasPrefix(m, policy.hiddenPrefixes) && !hasPrefix(m, policy.libraryPrefixes));
  const disallowed = policy.allowExtraImports ? hidden : added.filter((m) => !hasPrefix(m, allowedPrefixes) || hidden.includes(m));
  const libraryRemoved = removedImports(challengeImports, solutionImports);
  // Imports are judged below, by the policy; the screen reports everything else.
  const rejections = screen.rejections.filter((r) => r.code !== 'disallowed_import');
  return {
    static_screen: { ok: rejections.length === 0, rejections, flags: [...new Set(screen.flags.map((f) => f.code))] },
    imports: {
      ok: disallowed.length === 0 && libraryRemoved.length === 0,
      challenge: challengeImports,
      solution: solutionImports,
      disallowed,
      hidden_library: hidden,
      removed_challenge_imports: libraryRemoved,
      extra: added,
      extra_allowed: Boolean(policy.allowExtraImports),
    },
  };
}

/** Resolve a short declaration name against records carrying `name` and `user`. */
function resolveName(decls, shortName) {
  if (!shortName) return null;
  const exact = decls.find((d) => d.name === shortName || d.user === shortName);
  if (exact) return exact;
  const suffix = decls.filter((d) => String(d.user ?? d.name).endsWith(`.${shortName}`));
  return suffix.length === 1 ? suffix[0] : null;
}

/**
 * Turn the QR_OLEAN_DECL records into the statement check. Pure.
 *   - the target must exist and be `same` (its type; the proof is never compared)
 *   - every other non-theorem declaration of the challenge must be `same`
 *   - a changed or removed lemma of the challenge is reported but does not fail the check:
 *     it cannot change what the target states
 *   - a missing auxiliary declaration is ignored: nothing that compared equal can refer to it
 */
export function classifyStatementDiff(qr, target) {
  const decls = qr.filter((r) => r.tag === 'QR_OLEAN_DECL').map((r) => r.fields);
  const done = qr.find((r) => r.tag === 'QR_OLEAN_DIFF_DONE')?.fields || null;
  const imports = qr.find((r) => r.tag === 'QR_OLEAN_IMPORTS')?.fields || null;
  const out = {
    status: 'not_checked',
    target: null,
    target_status: null,
    definitions_changed: [],
    definitions_removed: [],
    lemmas_changed: [],
    auxiliary_missing: 0,
    counts: done ? { challenge_declarations: done.ref_count, same: done.same, changed: done.changed, missing: done.missing } : null,
    object_imports: imports ? { challenge: imports.ref || [], solution: imports.sol || [] } : null,
    solution_is_module: done ? Boolean(done.sol_is_module) : null,
  };
  if (!done) return out;
  const t = resolveName(decls, target);
  out.target = t ? t.name : null;
  out.target_status = t ? t.status : 'not_in_challenge';
  for (const d of decls) {
    if (d.status === 'same' || (t && d.name === t.name)) continue;
    if (d.kind === 'theorem') { if (!d.aux) out.lemmas_changed.push({ name: d.user ?? d.name, status: d.status }); continue; }
    if (d.status === 'missing') {
      if (d.aux) out.auxiliary_missing += 1;
      else out.definitions_removed.push({ name: d.user ?? d.name, kind: d.kind });
      continue;
    }
    out.definitions_changed.push({ name: d.user ?? d.name, kind: d.kind, status: d.status });
  }
  // Lemmas Lean generated for a removed structure go with it; they are not separate findings.
  const removedPrefixes = out.definitions_removed.map((d) => `${d.name}.`);
  out.lemmas_changed = out.lemmas_changed.filter((l) => !removedPrefixes.some((p) => l.name.startsWith(p)));
  // The object files record their imports; a challenge import absent from the solution's is a change.
  const objRemoved = out.object_imports ? removedImports(out.object_imports.challenge, out.object_imports.solution) : [];
  out.object_imports_removed = objRemoved;
  const ok = t && t.status === 'same' && out.definitions_changed.length === 0 && out.definitions_removed.length === 0 && !out.solution_is_module && objRemoved.length === 0;
  out.status = ok ? 'unchanged' : 'changed';
  return out;
}

export const COMPLETENESS_DEFINITION = 'steps = the target plus every lemma written in the solution (not in the challenge) that the target\'s proof uses, directly or through other declarations of the file, plus every axiom the solution declares and the target relies on; a step is done when it is a lemma whose own proof contains no sorry; score = done steps / steps. Requires a file that compiles and leaves the statement and definitions unchanged. The agent chooses the decomposition, so compare scores within a problem, not across problems.';

/**
 * Completeness of a compiling solution from the QR_MODULE_DECL records. Pure.
 * `challengeNames` are the user-visible names declared by the challenge (not counted as the agent's lemmas).
 */
export function completenessFrom(qr, { target, challengeNames = [], solutionSrc = '' }) {
  const decls = qr.filter((r) => r.tag === 'QR_MODULE_DECL').map((r) => r.fields);
  const t = decls.find((d) => d.target === true) || resolveName(decls, target);
  if (!t) return { available: false, reason: 'target_not_found', definition: COMPLETENESS_DEFINITION };
  const inChallenge = new Set(challengeNames);
  // Lemmas the agent wrote: theorems named in the solution text, which excludes facts that Lean
  // generates for structures and inductive types.
  const written = new Set(findDeclarations(solutionSrc).filter((d) => (d.kind === 'theorem' || d.kind === 'lemma') && d.name).map((d) => d.name.split('.').pop()));
  const lemmas = decls.filter((d) => d.kind === 'theorem' && d.name !== t.name && !inChallenge.has(d.user) && !inChallenge.has(d.name)
    && (written.size === 0 || written.has(String(d.user).split('.').pop())));
  const used = lemmas.filter((d) => d.used === true);
  // An axiom the agent declared and the target relies on is an unproved step, like a sorry.
  const assumed = decls.filter((d) => d.kind === 'axiom' && d.used === true && !inChallenge.has(d.user) && !inChallenge.has(d.name));
  const steps = [t, ...used, ...assumed];
  const isDone = (d) => d.kind !== 'axiom' && d.own_sorry === false;
  const done = steps.filter(isDone);
  return {
    available: true,
    score: done.length / steps.length,
    steps: steps.length,
    steps_done: done.length,
    target_own_sorry: t.own_sorry === true,
    lemmas_written: lemmas.length,
    lemmas_written_sorry_free: lemmas.filter((d) => d.sorry_free === true).length,
    lemmas_used: used.length,
    lemmas_used_sorry_free: used.filter((d) => d.sorry_free === true).length,
    axioms_assumed: assumed.length,
    open_steps: steps.filter((d) => !isDone(d)).map((d) => d.user ?? d.name),
    definition: COMPLETENESS_DEFINITION,
  };
}

/** Compiler diagnostics as text, errors first, for the next session's handoff. */
export function formatCompilerOutput(messages = [], { maxChars = 6000, maxMessages = 40 } = {}) {
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = messages.filter((m) => m.severity === 'error' || m.severity === 'warning')
    .sort((a, b) => (order[a.severity] - order[b.severity]) || ((a.line ?? 0) - (b.line ?? 0)));
  const lines = sorted.slice(0, maxMessages).map((m) => `${m.line ?? '?'}:${m.column ?? '?'}: ${m.severity}: ${String(m.text).trim()}`);
  if (sorted.length > maxMessages) lines.push(`… ${sorted.length - maxMessages} more diagnostics not shown`);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

/** Proof length. Rule stated in the record. */
export function proofLength(challengeSrc, solutionSrc, target) {
  const chal = countLines(challengeSrc, target);
  const sol = countLines(solutionSrc, target);
  const statementLines = chal.code - (chal.proof?.code ?? 0);
  return {
    proof_lines: Math.max(0, sol.code - statementLines),
    solution_code_lines: sol.code,
    solution_total_lines: sol.total,
    challenge_code_lines: chal.code,
    target_proof_lines: sol.proof?.code ?? null,
    rule: 'proof_lines = code lines of the solution (non-blank after comment removal) minus the code lines of the challenge that are not the target\'s proof; it counts the target\'s proof and every lemma or definition the agent added',
  };
}

// Gradings running in parallel in one process share a compilation that is already under way
// instead of starting the same one again; the result is then on disk for everyone after.
const inFlight = new Map();
async function shared(key, build) {
  const running = inFlight.get(key);
  if (running) return { ...(await running), cached: true, duration_ms: 0 };
  const p = build().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Compile the evaluator commands once per toolchain and source version. Returns the root that
 * holds QEDRank/Audit.olean; it goes first on the search path so a stale project build cannot shadow it.
 */
export async function ensureAudit({ runner, toolchain, cacheDir, auditSource = AUDIT_SOURCE }) {
  const src = await fs.readFile(auditSource, 'utf8');
  const key = sha256(`${toolchain.lean_version}\n${src}`).slice(0, 16);
  const root = path.join(cacheDir, `audit-${key}`);
  const olean = path.join(root, 'QEDRank', 'Audit.olean');
  if (await exists(olean)) return { root, status: 'compiler_success', cached: true };
  return shared(root, async () => {
    // Build in a private directory and rename it into place, so an interrupted or concurrent
    // build can never leave a truncated object file behind the cache key.
    const tmp = `${root}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(tmp, 'QEDRank', 'Audit.lean');
    await writeText(file, src);
    const tmpOlean = path.join(tmp, 'QEDRank', 'Audit.olean');
    const r = await runner.runLean({ file, cwd: tmp, olean: tmpOlean, ilean: tmpOlean.replace(/\.olean$/, '.ilean'), label: 'audit' });
    if (r.status === 'compiler_success') {
      try { await fs.rename(tmp, root); } catch { /* another process finished first */ }
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    const ok = r.status === 'compiler_success' && (await exists(olean));
    return { root, status: ok ? 'compiler_success' : r.status === 'compiler_success' ? 'infrastructure_failure' : r.status, cached: false, messages: r.messages.filter((m) => m.severity === 'error').slice(0, 5), infra_reason: r.infra_reason };
  });
}

// A compile error that means Lean cannot find a module, not that the code is wrong.
const MISSING_MODULE = /unknown module prefix|unknown package|object file .* does not exist|No directory '.*' or file/;

/**
 * Compile the unmodified challenge in the grader's own environment, once per challenge, Lean project,
 * toolchain and options. Every verdict about a solution presumes that this succeeds: when the challenge
 * itself does not compile (a library missing from the project, another Lean or Mathlib version), a
 * failing solution says nothing about the model. Only successes are cached, so a project that is built
 * or fixed later is picked up by the next grading.
 */
export async function compileChallenge({ runner, toolchain, challengeSrc, cacheDir, leanArgs = [] }) {
  const key = sha256([toolchain.lean_version, toolchain.lean_dir, toolchain.mathlib?.rev ?? '', JSON.stringify(leanArgs), challengeSrc].join('\n')).slice(0, 16);
  const root = path.join(cacheDir, `challenge-${key}`);
  const olean = path.join(root, `${SUBMISSION_MODULE}.olean`);
  if (await exists(olean)) return { status: 'compiler_success', olean, cached: true, duration_ms: 0, errors: '', infra_reason: null, missing_module: false };
  return shared(root, async () => {
    // Build in a private directory and rename it into place, as ensureAudit does.
    const tmp = `${root}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await runner.compileModule({ src: challengeSrc, moduleName: SUBMISSION_MODULE, scratchDir: tmp, label: 'challenge', extraArgs: leanArgs });
    if (r.status === 'compiler_success') {
      try { await fs.rename(tmp, root); } catch { /* another grading finished first */ }
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    const ok = r.status === 'compiler_success' && (await exists(olean));
    const errors = formatCompilerOutput(r.messages, { maxMessages: 5 });
    return {
      status: ok ? 'compiler_success' : r.status === 'compiler_success' ? 'infrastructure_failure' : r.status,
      olean: ok ? olean : null,
      cached: false,
      duration_ms: r.duration_ms,
      errors,
      infra_reason: r.infra_reason ?? null,
      missing_module: MISSING_MODULE.test(errors),
    };
  });
}

const leanPathString = (p) => p.split(path.sep).join('/');

/**
 * Grade one submission. Never throws for a bad submission; `verdict` is
 * 'solved' | 'not_solved' | 'grader_error'.
 *
 * @param {object} p
 * @param {import('./lean.js').LeanRunner} p.runner
 * @param {object} p.toolchain            result of detectToolchain for the grader's Lean project
 * @param {string} p.challengeSrc
 * @param {string|null} p.solutionSrc
 * @param {string} [p.target]             main theorem; default: the last theorem of the challenge
 * @param {string} p.scratchDir           empty working directory for this grading
 * @param {string} p.cacheDir             where the compiled evaluator commands are kept
 * @param {object} [p.policy]
 * @param {string[]} [p.extraLeanPath]    object-file roots of libraries the agent added (search configuration)
 * @param {string[]} [p.allowedAxioms]
 */
export async function gradeSubmission({ runner, toolchain, challengeSrc, solutionSrc, target = null, scratchDir, cacheDir, policy = {}, extraLeanPath = [], allowedAxioms = ['propext', 'Classical.choice', 'Quot.sound'], log = () => {} }) {
  const t0 = nowMono();
  const pol = { ...DEFAULT_GRADE_POLICY, ...policy };
  const rec = {
    schema: GRADE_SCHEMA,
    graded_at: isoNow(),
    verdict: 'not_solved',
    reasons: [],
    warnings: [],
    target: target || null,
    policy: pol,
    challenge_sha256: sha256(challengeSrc),
    solution_sha256: solutionSrc == null ? null : sha256(solutionSrc),
    checks: { static_screen: null, imports: null, challenge: null, compile: null, sorry: null, axioms: null, statement: null, kernel_replay: null },
    completeness: { available: false, reason: 'not_computed', definition: COMPLETENESS_DEFINITION },
    proof: null,
    compiler_output: '',
    timing: { compile_ms: null, challenge_compile_ms: null, total_ms: null },
    toolchain: { lean_version: toolchain.lean_version, toolchain: toolchain.toolchain, mathlib: toolchain.mathlib?.rev ?? null, lean_options: toolchain.lean_options || [], lean_project: toolchain.lean_dir },
    limits: runner.limits(),
  };
  const fail = (code) => { if (!rec.reasons.includes(code)) rec.reasons.push(code); };
  const finish = (verdict = null) => {
    if (verdict) rec.verdict = verdict;
    else rec.verdict = rec.reasons.length === 0 ? 'solved' : 'not_solved';
    rec.timing.total_ms = nowMono() - t0;
    return rec;
  };
  const graderError = (code, detail = null) => { rec.reasons = [code]; if (detail) rec.grader_error = detail; return finish('grader_error'); };

  if (!rec.target) { const names = theoremNames(challengeSrc); rec.target = names.length ? names[names.length - 1] : null; }
  if (!rec.target) return graderError('challenge_has_no_theorem');
  if (solutionSrc == null || !String(solutionSrc).trim()) { fail('solution_missing'); return finish(); }
  rec.proof = proofLength(challengeSrc, solutionSrc, rec.target);

  // ---- 1. static screen and import policy ----
  const screened = screenSolution(challengeSrc, solutionSrc, pol, { maxHeartbeats: runner.maxHeartbeats });
  rec.checks.static_screen = screened.static_screen;
  rec.checks.imports = screened.imports;
  if (!screened.static_screen.ok) fail('static_screen_rejected');
  if (screened.imports.disallowed.length) fail('disallowed_import');
  if (screened.imports.removed_challenge_imports.length) fail('challenge_import_removed');
  if (rec.reasons.length) {
    // Nothing that failed the screen is handed to the compiler.
    rec.checks.compile = { status: 'not_attempted', reason: 'rejected_before_compilation' };
    rec.compiler_output = [...screened.static_screen.rejections.map((r) => `${r.line}: rejected: ${r.code} (${r.text})`), ...screened.imports.disallowed.map((m) => `import not allowed: ${m}`), ...screened.imports.removed_challenge_imports.map((m) => `import of the challenge file removed: ${m}`)].join('\n');
    return finish();
  }
  if (!toolchain.available) return graderError('toolchain_unavailable', toolchain.reason);

  const audit = await ensureAudit({ runner, toolchain, cacheDir });
  if (audit.status !== 'compiler_success') return graderError('evaluator_commands_failed_to_compile', audit);
  const leanArgs = toolchain.lean_options || [];
  const solDir = path.join(scratchDir, 'solution');
  await ensureDir(solDir);

  // ---- 2. the challenge must compile in the grader's environment; then the solution, under the same module name ----
  const ref = await compileChallenge({ runner, toolchain, challengeSrc, cacheDir, leanArgs });
  rec.timing.challenge_compile_ms = ref.duration_ms;
  rec.checks.challenge = { status: ref.status, cached: ref.cached, missing_module: ref.missing_module };
  if (ref.status !== 'compiler_success') {
    rec.checks.compile = { status: 'not_attempted', reason: 'challenge_does_not_compile' };
    return graderError(ref.missing_module ? 'challenge_import_unavailable' : 'challenge_does_not_compile', { status: ref.status, infra_reason: ref.infra_reason, errors: ref.errors });
  }
  const sol = await runner.compileModule({ src: solutionSrc, moduleName: SUBMISSION_MODULE, scratchDir: solDir, extraLeanPath, label: 'solution', extraArgs: leanArgs });
  rec.timing.compile_ms = sol.duration_ms;
  rec.checks.compile = { status: sol.status, error_count: sol.error_count, warning_count: sol.warning_count, duration_ms: sol.duration_ms, infra_reason: sol.infra_reason ?? null, resource_limit: sol.resource_limit ?? null };
  rec.compiler_output = formatCompilerOutput(sol.messages);
  if (sol.status === 'infrastructure_failure') return graderError('solution_compile_infrastructure_failure', sol.infra_reason);
  if (sol.status === 'timeout') { fail('compile_timeout'); rec.completeness = { available: false, reason: 'file_does_not_compile', definition: COMPLETENESS_DEFINITION }; return finish(); }
  if (sol.status !== 'compiler_success') { fail('compile_error'); rec.completeness = { available: false, reason: 'file_does_not_compile', definition: COMPLETENESS_DEFINITION }; return finish(); }

  // ---- 3. statement and definitions unchanged (compiled declarations, read as data) ----
  const diffScript = `import QEDRank.Audit\n#qr_olean_diff "${leanPathString(ref.olean)}" "${leanPathString(sol.olean)}"\n`;
  const diff = await runner.runScript({ src: diffScript, name: 'QRA_diff', scratchDir: path.join(scratchDir, 'scripts'), extraLeanPath: [audit.root] });
  if (!diff.qr.some((r) => r.tag === 'QR_OLEAN_DIFF_DONE')) return graderError('statement_comparison_failed', { status: diff.status, errors: formatCompilerOutput(diff.messages, { maxMessages: 5 }) });
  const statement = classifyStatementDiff(diff.qr, rec.target);
  const text = (src) => { const d = findDeclarations(src).find((x) => x.name === rec.target || (x.name && x.name.endsWith(`.${rec.target}`))); return d ? stripComments(d.header).replace(/\s+/g, ' ').trim() : null; };
  statement.text_identical = text(challengeSrc) !== null && text(challengeSrc) === text(solutionSrc);
  rec.checks.statement = statement;
  if (statement.target_status === 'not_in_challenge') return graderError('target_not_declared_in_challenge', { target: rec.target });
  if (statement.target_status === 'missing') fail('target_missing');
  else if (statement.target_status !== 'same') fail('statement_changed');
  if (statement.definitions_changed.length) fail('definition_changed');
  if (statement.definitions_removed.length) fail('definition_removed');
  if (statement.solution_is_module || statement.object_imports_removed.length) fail('challenge_import_removed');
  for (const l of statement.lemmas_changed) rec.warnings.push(`challenge lemma ${l.status}: ${l.name}`);
  if (statement.status === 'unchanged' && !statement.text_identical) rec.warnings.push('statement text was edited but compiles to the same statement');
  if (statement.target_status !== 'same' && statement.target_status !== 'missing' && statement.text_identical) rec.warnings.push('ESCALATE: statement text is identical but it compiles to a different statement (changed context)');

  // ---- 4. sorry, axioms, completeness (needs the solution imported) ----
  const targetFull = statement.target || rec.target;
  if (statement.target_status !== 'missing') {
    const reportScript = `import ${SUBMISSION_MODULE}\nimport QEDRank.Audit\n#qr_axioms ${targetFull}\n#qr_module_report ${targetFull} ${SUBMISSION_MODULE}\n`;
    const report = await runner.runScript({ src: reportScript, name: 'QRA_report', scratchDir: path.join(scratchDir, 'scripts'), extraLeanPath: [audit.root, solDir, ...extraLeanPath] });
    const ax = report.qr.find((r) => r.tag === 'QR_AXIOMS');
    if (!ax || !report.qr.some((r) => r.tag === 'QR_MODULE_REPORT_DONE')) return graderError('axiom_audit_failed', { status: report.status, errors: formatCompilerOutput(report.messages, { maxMessages: 5 }) });
    const axioms = ax.fields.axioms || [];
    const cls = classifyAxioms(axioms);
    const nonStandard = axioms.filter((a) => !allowedAxioms.includes(a) && a !== 'sorryAx');
    rec.checks.axioms = {
      status: cls.placeholder ? 'placeholder' : cls.native_decide ? 'native_decide' : nonStandard.length ? 'user_axiom' : 'clean',
      axioms,
      non_standard: nonStandard,
      target_kind: ax.fields.kind,
      target_is_prop: ax.fields.prop,
      target_unsafe: ax.fields.unsafe,
    };
    const decls = report.qr.filter((r) => r.tag === 'QR_MODULE_DECL').map((r) => r.fields);
    const withSorry = decls.filter((d) => d.sorry_free === false).map((d) => d.user ?? d.name);
    rec.checks.sorry = { target_sorry_free: !cls.placeholder, file_sorry_free: withSorry.length === 0, declarations_with_sorry: withSorry.slice(0, 50), declarations_with_sorry_count: withSorry.length };
    if (cls.placeholder) fail('contains_sorry');
    else if (withSorry.length && !pol.allowUnusedSorry) fail('sorry_in_file');
    if (cls.native_decide) fail('native_decide');
    if (nonStandard.length && !cls.native_decide) fail('non_standard_axioms');
    if (ax.fields.kind !== 'theorem' || ax.fields.prop !== true) fail('target_is_not_a_theorem');
    if (ax.fields.unsafe) fail('unsafe_declaration');
    const challengeNames = diff.qr.filter((r) => r.tag === 'QR_OLEAN_DECL').map((r) => r.fields.user ?? r.fields.name);
    // Progress on a different statement is not progress on the problem.
    rec.completeness = statement.status === 'unchanged'
      ? completenessFrom(report.qr, { target: rec.target, challengeNames, solutionSrc })
      : { available: false, reason: 'statement_or_definitions_changed', definition: COMPLETENESS_DEFINITION };
  }

  // ---- 5. kernel replay: every declaration of the solution goes through the kernel again ----
  if (pol.kernelReplay) {
    const replayScript = `import QEDRank.Audit\n#qr_replay "${leanPathString(sol.olean)}"\n`;
    const r = await runner.runScript({ src: replayScript, name: 'QRA_replay', scratchDir: path.join(scratchDir, 'scripts'), extraLeanPath: [audit.root, ...extraLeanPath] });
    const q = r.qr.find((x) => x.tag === 'QR_REPLAY');
    const detail = r.messages.map((m) => m.text).find((t) => t.startsWith('QR_REPLAY_ERROR')) || null;
    rec.checks.kernel_replay = { status: q ? q.fields.status : r.status === 'timeout' ? 'timeout' : 'error', declarations: q?.fields.count ?? null, duration_ms: r.duration_ms, detail: detail ? detail.slice(0, 1000) : null };
    if (rec.checks.kernel_replay.status === 'failed') fail('kernel_replay_failed');
    else if (rec.checks.kernel_replay.status !== 'passed') return graderError('kernel_replay_did_not_finish', { status: r.status, errors: formatCompilerOutput(r.messages, { maxMessages: 5 }) });
  } else rec.checks.kernel_replay = { status: 'skipped', reason: 'disabled by policy' };

  const out = finish();
  if (out.verdict === 'solved' && out.completeness.available) out.completeness.score = 1;
  log(`grade ${rec.target}: ${out.verdict}${out.reasons.length ? ` (${out.reasons.join(', ')})` : ''}`);
  return out;
}
