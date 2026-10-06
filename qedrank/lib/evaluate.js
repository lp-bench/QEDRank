// Per-paper preparation (reference audit, definitions prelude) and per-item
// evaluation (static screen, compile, dependency audit, statement comparison).
//
// Naming of scratch modules:
//   QRR_*   copied reference files (compiled in refs/<paper> with their siblings)
//   QRSR_*  statement-only reference module (wrapped in namespace QRRef)
//   QRSM_*  statement-only model module (wrapped in namespace QRModel)
//   QRM_*   the ORIGINAL model proof file, compiled unchanged
//   QEDRank.Papers.<P>  generated definitions-only prelude for paper P

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseImports, rewriteImports, stripProofs, wrapNamespace, staticScreen, findDeclarations,
  theoremNames, countLines, dropDanglingDoc,
} from './leansrc.js';
import { buildComparisonScript, classifyAxioms, classifyComparison, applyExpertDecision } from './compare.js';
import { parseModelOutput } from './prompt.js';
import { ITEM_SCHEMA, STATEMENT_MATCH_ACCEPTED } from './schema.js';
import { ensureDir, writeText, writeJson, readJson, exists, sha256, leanIdent, slug, nowMono, isoNow } from './util.js';

const execFileP = promisify(execFile);

const STD_PREFIX = /^(Mathlib|Std|Lean|Init|Aesop|Batteries|Qq|ProofWidgets|Plausible|LeanSearchClient|ImportGraph)(\.|$)/;

function isValidModuleName(name) {
  return /^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(name);
}

function moduleNameForPath(relPath) {
  return relPath.replace(/\.lean$/i, '').split('/').join('.');
}

/** Keep only definition-like declarations (drop theorem/lemma/example) for a prelude. */
export function definitionsOnly(src) {
  const decls = findDeclarations(src);
  let out = '';
  let cursor = 0;
  for (const d of decls) {
    if (d.kind === 'theorem' || d.kind === 'lemma' || d.kind === 'example') {
      out += src.slice(cursor, dropDanglingDoc(src, cursor, d.start));
      cursor = d.end;
    }
  }
  out += src.slice(cursor);
  return out;
}

function topoSort(modules, depsOf) {
  const seen = new Set();
  const out = [];
  const visit = (m, stack = new Set()) => {
    if (seen.has(m)) return;
    if (stack.has(m)) throw new Error(`circular import involving ${m}`);
    stack.add(m);
    for (const d of depsOf(m)) if (modules.has(d)) visit(d, stack);
    stack.delete(m);
    seen.add(m);
    out.push(m);
  };
  for (const m of modules.keys()) visit(m);
  return out;
}

/**
 * Build (and compile) the per-paper definitions-only prelude module
 * QEDRank.Papers.<P>. Returns { moduleName, src, source, compile, decls, flags }.
 */
export async function preparePrelude({ runner, toolchain, paper, sharedFiles, reviewedPreludeSrc = null, leanDir, outDir, log = () => {} }) {
  const P = leanIdent(paper.paper_id);
  const moduleName = `QEDRank.Papers.${P}`;
  const flags = [];
  let src = null;
  let source = 'none';
  if (reviewedPreludeSrc && reviewedPreludeSrc.trim()) {
    src = reviewedPreludeSrc;
    source = 'reviewed';
  } else if (sharedFiles.length) {
    // Order shared files by their mutual imports, then strip theorems.
    const byModule = new Map();
    for (const f of sharedFiles) byModule.set(f.module, f);
    const order = topoSort(byModule, (m) => parseImports(byModule.get(m).text).filter((x) => byModule.has(x)));
    const parts = [];
    const stdImports = new Set();
    for (const m of order) {
      const f = byModule.get(m);
      for (const im of parseImports(f.text)) if (STD_PREFIX.test(im)) stdImports.add(im);
      const stripped = definitionsOnly(rewriteImports(f.text, () => null));
      parts.push(`-- ==== from ${f.path} (theorems removed automatically) ====\n${stripped.trim()}\n`);
    }
    // Carry over the definition files' own library imports (falling back to all of Mathlib).
    const header = [...(stdImports.size ? stdImports : new Set(['Mathlib'])), 'QEDRank.Prelude'].map((m) => `import ${m}`).join('\n');
    src = `${header}\n\n${parts.join('\n')}`;
    source = 'auto_stripped';
    flags.push('prelude_auto_stripped_needs_review');
  }
  const rec = { moduleName: src ? moduleName : null, src, source, compile: null, decls: [], flags, path: null };
  if (!src) return rec;
  const file = path.join(leanDir, 'QEDRank', 'Papers', `${P}.lean`);
  await writeText(file, src);
  rec.path = file;
  await writeText(path.join(outDir, 'prelude.lean'), src);
  if (!toolchain.available) {
    rec.compile = { status: 'infrastructure_failure', infra_reason: toolchain.reason };
    return rec;
  }
  // Build through lake so the .olean lands on the project LEAN_PATH.
  const t0 = nowMono();
  try {
    const { stdout, stderr } = await execFileP('lake', ['build', moduleName], { cwd: leanDir, timeout: runner.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: cleanEnv() });
    rec.compile = { status: 'compiler_success', duration_ms: nowMono() - t0, stdout_tail: stdout.slice(-2000), stderr_tail: stderr.slice(-2000) };
  } catch (err) {
    const text = `${err.stdout || ''}\n${err.stderr || ''}`;
    rec.compile = { status: err.killed ? 'timeout' : 'compiler_failure', duration_ms: nowMono() - t0, stdout_tail: text.slice(-4000) };
    flags.push('prelude_failed_to_build');
    return rec;
  }
  // Audit: definitions only.
  const audit = await runner.runScript({
    src: `import ${moduleName}\nimport QEDRank.Audit\n#qr_decls ${moduleName}\n`,
    name: `QRA_prelude_${P}`,
    scratchDir: path.join(outDir, 'lean'),
  });
  rec.decls = audit.qr.filter((r) => r.tag === 'QR_DECL').map((r) => ({ name: r.fields.name, kind: r.fields.kind, prop: r.fields.prop, unsafe: r.fields.unsafe }));
  if (rec.decls.some((d) => d.kind === 'theorem')) flags.push('prelude_contains_theorem');
  if (rec.decls.some((d) => d.unsafe)) flags.push('prelude_contains_unsafe');
  log(`prelude ${moduleName}: ${rec.compile.status}, ${rec.decls.length} decls`);
  return rec;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/_API_KEY$|^GITHUB_TOKEN$/.test(k)) delete env[k];
  return env;
}

/**
 * Compile and audit one ground-truth reference, then build its statement-only module.
 * @returns reference record (also written to <outDir>/reference__<kind>.json)
 */
export async function prepareReference({ runner, toolchain, paper, target, paperFiles, preludeModule, outDir, maxHeartbeats, log = () => {} }) {
  const kind = target.target_kind;
  const rec = {
    paper_id: paper.paper_id,
    target_kind: kind,
    lean_path: target.lean_path,
    sha256: target.sha256,
    declaration_name: target.declaration_name,
    resolved_declaration: null,
    reference_proof_status: target.lean_path ? 'unknown' : 'missing',
    reference_proof_status_source: 'not_compiled',
    compile: null,
    audit: null,
    axioms: null,
    static_screen: null,
    statement_module: null,
    statement_compile: null,
    statement_declaration: null,
    statement_available: false,
    definitions_in_statement_module: [],
    loc: null,
    flags: [...(target.mapping_flags || [])],
    prepared_at: isoNow(),
  };
  if (!target.lean_path) return rec;
  const targetFile = paperFiles.find((f) => f.path === target.lean_path);
  if (!targetFile) { rec.flags.push('reference_file_not_downloaded'); rec.reference_proof_status = 'missing'; return rec; }
  const text = targetFile.text;
  rec.loc = countLines(text, target.declaration_name);

  // --- static screen (code-execution safety) ---
  const localMods = parseImports(text).filter((m) => !STD_PREFIX.test(m));
  const screen = staticScreen(text, { allowedImports: localMods, maxHeartbeats: maxHeartbeats * 10 });
  rec.static_screen = { ok: screen.ok, rejections: screen.rejections, flags: screen.flags.map((f) => f.code) };
  if (!screen.ok) {
    rec.reference_proof_status = 'invalid';
    rec.reference_proof_status_source = 'static_screen_rejected';
    rec.flags.push('reference_fails_static_screen');
    return rec;
  }
  if (!toolchain.available) {
    rec.reference_proof_status = screen.flags.some((f) => f.code === 'placeholder') ? 'contains_placeholder' : 'unknown';
    rec.reference_proof_status_source = 'static_scan_only_toolchain_unavailable';
    rec.compile = { status: 'infrastructure_failure', infra_reason: toolchain.reason };
    return rec;
  }

  // --- copy the paper's Lean files into a scratch root preserving layout ---
  // Every copied module is placed under a unique top-level package name (QRP_<paper>) and local
  // imports are rewritten accordingly, so a corpus directory such as `lean/` or `Std/` can never
  // shadow the toolchain's own modules on the search path (module lookup is case-insensitive on Windows).
  const refsRoot = path.join(outDir, 'lean', 'refs');
  await ensureDir(refsRoot);
  const pkg = `QRP_${leanIdent(paper.paper_id)}`;
  const paperDir = paper.dir || '';
  const rel = (p) => (paperDir && p.startsWith(`${paperDir}/`) ? p.slice(paperDir.length + 1) : path.posix.basename(p));
  const modules = new Map(); // key: ORIGINAL local module name (as written in the corpus imports)
  for (const f of paperFiles) {
    if (!f.path.toLowerCase().endsWith('.lean')) continue;
    const r = rel(f.path);
    const mod = moduleNameForPath(r);
    modules.set(mod, { ...f, rel: `${pkg}/${r}`, module: mod, packaged: `${pkg}.${mod}` });
  }
  const targetRel = rel(target.lean_path);
  const targetModule = `${pkg}.${moduleNameForPath(targetRel)}`;
  const packagedName = (m) => (modules.has(m) ? modules.get(m).packaged : m);
  // Dependencies of the target within the paper.
  const needed = new Set();
  const visit = (m) => {
    if (needed.has(m) || !modules.has(m)) return;
    needed.add(m);
    for (const d of parseImports(modules.get(m).text)) if (!STD_PREFIX.test(d)) visit(d);
  };
  visit(moduleNameForPath(targetRel));
  const unresolvedImports = [];
  for (const m of needed) for (const d of parseImports(modules.get(m).text)) if (!STD_PREFIX.test(d) && !modules.has(d)) unresolvedImports.push(d);
  if (unresolvedImports.length) rec.flags.push(`unresolved_local_imports:${unresolvedImports.join('|')}`);
  const invalid = [...needed].filter((m) => !isValidModuleName(`${pkg}.${m}`));
  if (invalid.length) {
    rec.flags.push(`invalid_module_names:${invalid.join('|')}`);
    rec.reference_proof_status = 'invalid';
    rec.reference_proof_status_source = 'module_name_invalid';
    return rec;
  }
  let order;
  try {
    order = topoSort(new Map([...needed].map((m) => [m, modules.get(m)])), (m) => parseImports(modules.get(m).text).filter((x) => needed.has(x)));
  } catch (err) {
    rec.flags.push(`reference_import_cycle:${err.message}`);
    rec.reference_proof_status = 'invalid';
    rec.reference_proof_status_source = 'import_cycle';
    return rec;
  }
  // Compile dependencies then the target (each screened; dependencies from other targets are allowed here
  // because this is the evaluator's environment, never the model's).
  let compileFailed = null;
  const depResults = [];
  for (const m of order) {
    const f = modules.get(m);
    const filePath = path.join(refsRoot, ...f.rel.split('/'));
    const packagedText = rewriteImports(f.text, (x) => (STD_PREFIX.test(x) ? x : packagedName(x)));
    await writeText(filePath, packagedText);
    const depScreen = staticScreen(packagedText, { allowedImports: [...modules.values()].map((x) => x.packaged), maxHeartbeats: maxHeartbeats * 10 });
    if (!depScreen.ok) { compileFailed = { module: f.packaged, status: 'rejected_by_static_screen', rejections: depScreen.rejections }; break; }
    const r = await runner.runLean({
      file: filePath,
      cwd: refsRoot,
      extraLeanPath: [refsRoot],
      olean: filePath.replace(/\.lean$/, '.olean'),
      ilean: filePath.replace(/\.lean$/, '.ilean'),
      label: `ref:${paper.paper_id}:${kind}:${f.packaged}`,
    });
    depResults.push({ module: f.packaged, status: r.status, duration_ms: r.duration_ms, error_count: r.error_count });
    if (f.packaged === targetModule) rec.compile = r;
    if (r.status !== 'compiler_success') { compileFailed = { module: f.packaged, status: r.status }; if (f.packaged !== targetModule) rec.compile = r; break; }
  }
  rec.dependency_compiles = depResults;
  if (compileFailed) {
    rec.reference_proof_status = compileFailed.status === 'infrastructure_failure' ? 'unknown' : 'invalid';
    rec.reference_proof_status_source = compileFailed.status === 'infrastructure_failure' ? 'infrastructure_failure' : `compile_${compileFailed.status}`;
    rec.flags.push(`reference_compile_failed:${compileFailed.module}:${compileFailed.status}`);
    log(`reference ${paper.paper_id}/${kind}: ${compileFailed.status}`);
  } else {
    // --- dependency audit of the reference target declaration ---
    const declsScript = `import ${targetModule}\nimport QEDRank.Audit\n#qr_decls ${targetModule}\n`;
    const listing = await runner.runScript({ src: declsScript, name: `QRA_refdecls_${leanIdent(paper.paper_id)}_${kind}`, scratchDir: refsRoot, extraLeanPath: [refsRoot] });
    const decls = listing.qr.filter((r) => r.tag === 'QR_DECL').map((r) => r.fields);
    const resolved = resolveDecl(decls, target.declaration_name);
    rec.resolved_declaration = resolved;
    if (!resolved) {
      rec.reference_proof_status = 'invalid';
      rec.reference_proof_status_source = listing.status === 'compiler_success' ? 'declaration_not_found' : `audit_${listing.status}`;
      rec.flags.push('reference_declaration_not_found');
    } else {
      const ax = await runner.runScript({ src: `import ${targetModule}\nimport QEDRank.Audit\n#qr_axioms ${resolved}\n`, name: `QRA_refax_${leanIdent(paper.paper_id)}_${kind}`, scratchDir: refsRoot, extraLeanPath: [refsRoot] });
      const rr = ax.qr.find((r) => r.tag === 'QR_AXIOMS');
      rec.audit = { status: ax.status, duration_ms: ax.duration_ms };
      if (rr) {
        rec.axioms = rr.fields.axioms || [];
        const cls = classifyAxioms(rec.axioms);
        rec.axiom_classification = cls;
        rec.declaration_is_prop = rr.fields.prop;
        if (!rr.fields.prop) rec.flags.push('reference_declaration_not_a_proposition');
        if (cls.placeholder) { rec.reference_proof_status = 'contains_placeholder'; rec.reference_proof_status_source = 'axiom_audit'; }
        else if (cls.user_axioms.length) { rec.reference_proof_status = 'invalid'; rec.reference_proof_status_source = 'user_axioms'; rec.flags.push(`reference_user_axioms:${cls.user_axioms.join('|')}`); }
        else { rec.reference_proof_status = 'complete'; rec.reference_proof_status_source = 'axiom_audit'; if (cls.native_decide) rec.flags.push('reference_uses_native_decide'); }
      } else {
        rec.reference_proof_status = 'unknown';
        rec.reference_proof_status_source = `audit_${ax.status}`;
      }
    }
  }

  // --- statement-only module for comparison (built even when the reference proof is incomplete) ---
  const cmpRoot = path.join(outDir, 'lean', 'cmp');
  const mapImport = (m) => (STD_PREFIX.test(m) ? m : preludeModule || null);
  let stmtSrc = rewriteImports(text, mapImport);
  stmtSrc = stripProofs(stmtSrc);
  stmtSrc = wrapNamespace(stmtSrc, 'QRRef');
  if (!/^import\s+Mathlib/m.test(stmtSrc) && !parseImports(stmtSrc).some((m) => m.startsWith('Mathlib'))) stmtSrc = `import Mathlib\n${stmtSrc}`;
  // Local modules that could not be mapped to a prelude leave dangling references; note it.
  if (localMods.length && !preludeModule) rec.flags.push('reference_has_local_imports_but_no_prelude');
  const stmtModule = `QRSR_${leanIdent(paper.paper_id)}_${kind}`;
  rec.statement_module = stmtModule;
  rec.statement_compile = await runner.compileModule({ src: stmtSrc, moduleName: stmtModule, scratchDir: cmpRoot, label: `refstmt:${paper.paper_id}:${kind}` });
  await writeText(path.join(outDir, `reference_statement__${kind}.lean`), stmtSrc);
  if (rec.statement_compile.status === 'compiler_success') {
    const listing = await runner.runScript({ src: `import ${stmtModule}\nimport QEDRank.Audit\n#qr_decls ${stmtModule}\n`, name: `QRA_refstmt_${leanIdent(paper.paper_id)}_${kind}`, scratchDir: cmpRoot });
    const decls = listing.qr.filter((r) => r.tag === 'QR_DECL').map((r) => r.fields);
    rec.definitions_in_statement_module = decls.filter((d) => d.kind === 'def' && !d.prop).map((d) => d.name);
    rec.statement_declaration = resolveDecl(decls, target.declaration_name, 'QRRef');
    rec.statement_available = Boolean(rec.statement_declaration);
    if (!rec.statement_declaration) rec.flags.push('reference_statement_declaration_not_found');
  } else {
    rec.flags.push(`reference_statement_module_${rec.statement_compile.status}`);
  }
  log(`reference ${paper.paper_id}/${kind}: proof=${rec.reference_proof_status}, statement=${rec.statement_available ? 'available' : 'unavailable'}`);
  return rec;
}

/** Resolve a short declaration name against a module listing (handles namespaces). */
export function resolveDecl(decls, shortName, requiredPrefix = null) {
  if (!shortName) return null;
  const names = decls.map((d) => d.name).filter((n) => !requiredPrefix || n === requiredPrefix || n.startsWith(`${requiredPrefix}.`));
  const exact = names.find((n) => n === shortName || n === `${requiredPrefix}.${shortName}`);
  if (exact) return exact;
  const suffix = names.filter((n) => n.endsWith(`.${shortName}`));
  if (suffix.length === 1) return suffix[0];
  return null;
}

/** Choose the model's target declaration: the last theorem in the statement text (documented rule). */
function modelTargetName(statementSrc) {
  const names = theoremNames(statementSrc);
  return names.length ? names[names.length - 1] : null;
}

function ensureImports(src, preludeModules) {
  const imports = parseImports(src);
  const add = [];
  if (!imports.some((m) => m === 'Mathlib' || m.startsWith('Mathlib.'))) add.push('import Mathlib');
  for (const p of preludeModules) if (!imports.includes(p)) add.push(`import ${p}`);
  if (!add.length) return src;
  const { imports: hdr, rest } = splitHeaderLocal(src);
  return `${hdr.trim()}\n${add.join('\n')}\n\n${rest}`;
}

function splitHeaderLocal(src) {
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (/^\s*import\s+/.test(lines[i]) || lines[i].trim() === '' || /^\s*--/.test(lines[i]))) i += 1;
  return { imports: lines.slice(0, i).join('\n'), rest: lines.slice(i).join('\n') };
}

/**
 * Evaluate one generation attempt against its reference. Returns the item record.
 * @param {object} p
 * @param {import('./lean.js').LeanRunner} p.runner
 * @param {object} p.toolchain
 * @param {object} p.paper   manifest paper record
 * @param {object} p.target  manifest target record
 * @param {object} p.reference prepared reference record
 * @param {object} p.prelude  prepared prelude record ({moduleName} or null)
 * @param {object} p.generation generation record (from models.generateOnce) incl. prompt info
 * @param {string} p.itemDir  directory for this item's artifacts
 * @param {object} p.config   run config (lean limits, etc.)
 * @param {object} [p.expertDecision]
 */
export async function evaluateAttempt({ runner, toolchain, paper, target, reference, prelude, generation, itemDir, config, expertDecision = null, setting = 'pass@1', attempt = 1, repairRound = 0, log = () => {} }) {
  const t0 = nowMono();
  const kind = target.target_kind;
  const preludeModules = ['QEDRank.Prelude', ...(prelude?.moduleName ? [prelude.moduleName] : [])];
  const allowedImports = [...preludeModules];
  const key = `${paper.paper_id}__${kind}__${generation.provider}`;
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
    mathematical_status: target.mathematical_status,
    reference_proof_status: reference.reference_proof_status,
    reference_statement_available: reference.statement_available,
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
    statement_compile: null,
    model_statement_declaration: null,
    compile: null,
    audit: null,
    ab_consistency: null,
    comparison: null,
    statement_match: 'not_evaluated',
    statement_match_source: null,
    loc: null,
    timing: { evaluation_started_at: isoNow(), lean_compile_ms: null, lean_audit_ms: null, lean_compare_ms: null, lean_total_ms: null, evaluation_total_ms: null, total_ms: null, working_ms: null },
    eligibility: { statement_track: false, proof_track: false, reasons: [] },
    outcomes: { infrastructure_failure: false, compiled: null, audit_clean: null, statement_faithful: null, verified: null },
    notes: [],
  };
  await ensureDir(itemDir);
  const suffix = `a${attempt}r${repairRound}`;

  // ---- eligibility ----
  if (reference.statement_available) rec.eligibility.statement_track = true;
  else rec.eligibility.reasons.push('reference_statement_unavailable');
  const statusOk = target.mathematical_status === 'established' || (kind === 'disproof' && target.mathematical_status === 'refuted');
  if (rec.eligibility.statement_track && statusOk) rec.eligibility.proof_track = true;
  else if (!statusOk) rec.eligibility.reasons.push(`mathematical_status_${target.mathematical_status}`);

  // ---- generation failure => infrastructure failure for everything ----
  if (generation.error) {
    rec.outcomes.infrastructure_failure = true;
    rec.notes.push(`generation_${generation.error.kind}`);
    rec.compile = { status: 'not_attempted' };
    rec.audit = { status: 'not_audited' };
    finish(rec, t0);
    await writeJson(path.join(itemDir, `attempt-${suffix}.json`), rec);
    return rec;
  }

  // ---- parse ----
  const parsed = parseModelOutput(generation.text);
  rec.parse = { notes: parsed.parseNotes, parts_found: parsed.partsFound, has_statement: Boolean(parsed.statement), has_proof_file: Boolean(parsed.proofFile), mapping_chars: parsed.mapping ? parsed.mapping.length : 0 };
  rec.confidence = { statement: parsed.statementConfidence, proof: parsed.proofConfidence };
  rec.abstained = parsed.abstained;
  await writeText(path.join(itemDir, `response-${suffix}.txt`), generation.text || '');
  if (parsed.mapping) await writeText(path.join(itemDir, `mapping-${suffix}.md`), parsed.mapping);

  let statementSrc = parsed.statement;
  if (!statementSrc && parsed.proofFile) { statementSrc = stripProofs(parsed.proofFile); rec.notes.push('statement_derived_from_proof_file'); }
  const targetName = statementSrc ? modelTargetName(statementSrc) : null;
  rec.model_statement_declaration = targetName;
  if (!statementSrc) rec.notes.push('no_statement_returned');
  else if (!targetName) rec.notes.push('no_theorem_in_statement');

  // ---- static screen of the proof file ----
  if (parsed.proofFile) {
    await writeText(path.join(itemDir, `proof-${suffix}.lean`), parsed.proofFile);
    const screen = staticScreen(parsed.proofFile, { allowedImports, maxHeartbeats: config.lean.maxHeartbeats });
    rec.static_screen = { ok: screen.ok, rejections: screen.rejections, flags: screen.flags.map((f) => f.code).filter((v, i, a) => a.indexOf(v) === i) };
    rec.loc = { model: countLines(parsed.proofFile, targetName), reference: reference.loc || null };
  }

  const leanTimes = [];
  const withTime = async (fn) => { const r = await fn(); if (r && typeof r.duration_ms === 'number') leanTimes.push(r.duration_ms); return r; };

  // ---- model statement module ----
  if (statementSrc && targetName) {
    let stmt = ensureImports(statementSrc, preludeModules);
    stmt = stripProofs(stmt);
    const stmtScreen = staticScreen(stmt, { allowedImports, maxHeartbeats: config.lean.maxHeartbeats });
    if (!stmtScreen.ok) {
      rec.statement_compile = { status: 'rejected_by_static_screen', rejections: stmtScreen.rejections };
    } else {
      stmt = wrapNamespace(stmt, 'QRModel');
      await writeText(path.join(itemDir, `statement-${suffix}.lean`), stmt);
      const mod = `QRSM_${leanIdent(paper.paper_id)}_${kind}_${leanIdent(generation.provider)}_${suffix}`;
      rec.statement_compile = await withTime(() => runner.compileModule({ src: stmt, moduleName: mod, scratchDir: path.join(itemDir, 'lean'), label: `stmt:${key}` }));
      rec.statement_compile.module = mod;
      if (rec.statement_compile.status === 'compiler_success') {
        const listing = await withTime(() => runner.runScript({ src: `import ${mod}\nimport QEDRank.Audit\n#qr_decls ${mod}\n`, name: `QRA_stmtdecls_${suffix}`, scratchDir: path.join(itemDir, 'lean') }));
        const decls = listing.qr.filter((r) => r.tag === 'QR_DECL').map((r) => r.fields);
        rec.statement_compile.resolved_declaration = resolveDecl(decls, targetName, 'QRModel');
        rec.statement_compile.definitions = decls.filter((d) => d.kind === 'def' && !d.prop).map((d) => d.name);
        if (!rec.statement_compile.resolved_declaration) rec.notes.push('model_statement_declaration_not_found_after_compile');
      }
    }
  }

  // ---- compile the ORIGINAL proof file ----
  const cStart = nowMono();
  if (!parsed.proofFile) {
    rec.compile = { status: 'not_attempted', reason: parsed.abstained ? 'abstained' : 'no_proof_file' };
  } else if (!rec.static_screen.ok) {
    rec.compile = { status: 'rejected_by_static_screen', rejections: rec.static_screen.rejections };
  } else {
    const mod = `QRM_${leanIdent(paper.paper_id)}_${kind}_${leanIdent(generation.provider)}_${suffix}`;
    rec.compile = await withTime(() => runner.compileModule({ src: parsed.proofFile, moduleName: mod, scratchDir: path.join(itemDir, 'lean'), label: `proof:${key}` }));
    rec.compile.module = mod;
    rec.compile.messages = (rec.compile.messages || []).slice(0, 200);
  }
  rec.timing.lean_compile_ms = rec.compile.duration_ms ?? null;

  // ---- dependency / trust audit ----
  if (rec.compile.status === 'compiler_success') {
    const mod = rec.compile.module;
    const listing = await withTime(() => runner.runScript({ src: `import ${mod}\nimport QEDRank.Audit\n#qr_decls ${mod}\n`, name: `QRA_decls_${suffix}`, scratchDir: path.join(itemDir, 'lean') }));
    const decls = listing.qr.filter((r) => r.tag === 'QR_DECL').map((r) => r.fields);
    let proofTarget = resolveDecl(decls, targetName);
    if (!proofTarget) {
      const thms = decls.filter((d) => d.kind === 'theorem').map((d) => d.name);
      if (thms.length) { proofTarget = thms[thms.length - 1]; rec.notes.push(`proof_target_fallback_last_theorem:${proofTarget}`); }
    }
    rec.audit = { status: 'not_audited', target_declaration: proofTarget, declarations: decls.length, unsafe_declarations: decls.filter((d) => d.unsafe).map((d) => d.name), static_flags: rec.static_screen.flags };
    if (!proofTarget) {
      rec.audit.status = 'target_not_found';
    } else {
      const ax = await withTime(() => runner.runScript({ src: `import ${mod}\nimport QEDRank.Audit\n#qr_axioms ${proofTarget}\n`, name: `QRA_ax_${suffix}`, scratchDir: path.join(itemDir, 'lean') }));
      const rr = ax.qr.find((r) => r.tag === 'QR_AXIOMS');
      if (rr) {
        const cls = classifyAxioms(rr.fields.axioms || []);
        rec.audit.axioms = rr.fields.axioms || [];
        rec.audit.classification = cls;
        rec.audit.target_is_prop = rr.fields.prop;
        rec.audit.target_kind = rr.fields.kind;
        if (rr.fields.unsafe || rec.audit.unsafe_declarations.length) rec.audit.status = 'unsafe';
        else if (cls.placeholder) rec.audit.status = 'placeholder';
        else if (cls.user_axioms.length) rec.audit.status = 'user_axiom';
        else if (cls.native_decide) rec.audit.status = 'native_decide';
        else rec.audit.status = 'clean';
        if (!rr.fields.prop) { rec.audit.status = rec.audit.status === 'clean' ? 'target_not_found' : rec.audit.status; rec.notes.push('proof_target_is_not_a_proposition'); }
        if (rec.static_screen.flags.includes('placeholder') && !cls.placeholder) rec.notes.push('unused_placeholder_present_outside_target');
      } else {
        rec.audit.status = ax.status === 'infrastructure_failure' ? 'not_audited' : 'target_not_found';
        if (ax.status === 'infrastructure_failure') rec.outcomes.infrastructure_failure = true;
      }
      // A/B consistency: the proof file proves the same statement as part A.
      if (rec.statement_compile?.resolved_declaration) {
        const script = `import ${mod}\nimport ${rec.statement_compile.module}\nimport QEDRank.Audit\n#qr_compare ${rec.statement_compile.resolved_declaration} ${proofTarget}\n`;
        const ab = await withTime(() => runner.runScript({ src: script, name: `QRA_ab_${suffix}`, scratchDir: path.join(itemDir, 'lean') }));
        const c = ab.qr.find((r) => r.tag === 'QR_COMPARE');
        rec.ab_consistency = c ? { consistent: Boolean(c.fields.default), syntactic: Boolean(c.fields.syntactic), status: ab.status } : { consistent: null, status: ab.status };
      } else {
        rec.ab_consistency = { consistent: null, status: 'statement_module_unavailable' };
      }
    }
  } else if (rec.compile.status === 'rejected_by_static_screen') {
    rec.audit = { status: rec.static_screen.rejections.some((r) => r.code === 'disallowed_import') ? 'disallowed_import' : 'forbidden_command', static_flags: rec.static_screen.flags };
  } else {
    rec.audit = { status: 'not_audited', static_flags: rec.static_screen?.flags || [] };
  }
  const afterAudit = nowMono();

  // ---- statement comparison (isolated; statement-only modules) ----
  if (rec.eligibility.statement_track && rec.statement_compile?.status === 'compiler_success' && rec.statement_compile.resolved_declaration) {
    const cmpRoot = path.join(itemDir, 'lean');
    const refCmpRoot = reference.statement_compile?.olean ? path.dirname(reference.statement_compile.olean) : null;
    const script = buildComparisonScript({
      refModule: reference.statement_module,
      modelModule: rec.statement_compile.module,
      refDecl: reference.statement_declaration,
      modelDecl: rec.statement_compile.resolved_declaration,
      unfold: [...(reference.definitions_in_statement_module || []), ...(rec.statement_compile.definitions || [])].slice(0, 40),
      maxHeartbeats: Math.min(config.lean.maxHeartbeats, 200000),
    });
    await writeText(path.join(itemDir, `compare-${suffix}.lean`), script);
    const cmp = await withTime(() => runner.runScript({ src: script, name: `QRA_cmp_${suffix}`, scratchDir: cmpRoot, extraLeanPath: refCmpRoot ? [refCmpRoot] : [] }));
    const auto = classifyComparison(cmp.qr, cmp);
    const final = applyExpertDecision(auto, expertDecision);
    rec.comparison = { ...final, script_status: cmp.status, duration_ms: cmp.duration_ms, qr_errors: cmp.qr_errors, messages: (cmp.messages || []).filter((m) => m.severity === 'error').slice(0, 20) };
    rec.statement_match = final.statement_match;
    rec.statement_match_source = final.source;
    rec.timing.lean_compare_ms = cmp.duration_ms;
    if (cmp.status === 'infrastructure_failure') rec.outcomes.infrastructure_failure = true;
  } else {
    const reason = !rec.eligibility.statement_track ? 'not_eligible' : !statementSrc ? 'no_statement' : rec.statement_compile?.status || 'statement_not_compiled';
    const auto = { statement_match: rec.eligibility.statement_track && statementSrc ? 'unresolved' : 'not_evaluated', method: 'none', evidence: { notes: [reason] } };
    const final = applyExpertDecision(auto, expertDecision);
    rec.comparison = { ...final, script_status: 'not_attempted' };
    rec.statement_match = final.statement_match;
    rec.statement_match_source = final.source;
    if (rec.statement_compile?.status === 'infrastructure_failure') rec.outcomes.infrastructure_failure = true;
  }

  // ---- outcomes ----
  rec.timing.lean_audit_ms = Math.max(0, afterAudit - cStart - (rec.timing.lean_compile_ms || 0));
  rec.timing.lean_total_ms = leanTimes.reduce((a, b) => a + b, 0);
  const infra = rec.outcomes.infrastructure_failure || rec.compile.status === 'infrastructure_failure' || rec.statement_compile?.status === 'infrastructure_failure';
  rec.outcomes.infrastructure_failure = infra;
  rec.outcomes.compiled = rec.compile.status === 'compiler_success' ? 1 : (rec.compile.status === 'compiler_failure' || rec.compile.status === 'timeout' || rec.compile.status === 'rejected_by_static_screen') ? 0 : null;
  rec.outcomes.audit_clean = rec.audit?.status === 'clean' ? 1 : rec.compile.status === 'compiler_success' ? 0 : null;
  rec.outcomes.statement_faithful = rec.eligibility.statement_track ? (STATEMENT_MATCH_ACCEPTED.includes(rec.statement_match) ? 1 : 0) : null;
  if (rec.eligibility.proof_track) {
    const abOk = rec.ab_consistency?.consistent === true;
    rec.outcomes.verified = (rec.outcomes.compiled === 1 && rec.outcomes.audit_clean === 1 && rec.outcomes.statement_faithful === 1 && abOk) ? 1 : 0;
    if (rec.outcomes.compiled === 1 && rec.outcomes.audit_clean === 1 && rec.outcomes.statement_faithful === 1 && !abOk) rec.notes.push('verified_blocked_by_ab_inconsistency');
  } else rec.outcomes.verified = null;
  if (infra) { rec.outcomes.compiled = null; rec.outcomes.audit_clean = null; rec.outcomes.verified = null; if (rec.statement_match === 'not_evaluated') rec.outcomes.statement_faithful = null; }
  if (target.mathematical_status === 'open' && rec.outcomes.compiled === 1 && rec.outcomes.audit_clean === 1 && rec.outcomes.statement_faithful === 1) rec.notes.push('ESCALATE: apparent proof of an open claim - independent mathematical review required');

  finish(rec, t0);
  await writeJson(path.join(itemDir, `attempt-${suffix}.json`), rec);
  log(`${key} [${setting} a${attempt}r${repairRound}] compile=${rec.compile.status} audit=${rec.audit?.status} match=${rec.statement_match} verified=${rec.outcomes.verified}`);
  return rec;
}

/**
 * Could the model have seen the problem's source during training? Dates are compared as
 * ISO strings (YYYY, YYYY-MM or YYYY-MM-DD); an unknown date gives null, never a guess.
 */
export function contaminationOf(paper, generation) {
  const cutoff = generation?.facts?.training_cutoff ?? null;
  const published = paper?.publication_date ?? null;
  return {
    model_training_cutoff: cutoff,
    problem_publication_date: published,
    published_before_cutoff: publishedBeforeCutoff(published, cutoff),
    public_formal_proof: paper?.public_formal_proof ?? null,
  };
}

export function publishedBeforeCutoff(published, cutoff) {
  if (!published || !cutoff) return null;
  const p = String(published);
  const c = String(cutoff);
  const n = Math.min(p.length, c.length);
  // Same year or month at the shared precision: the order cannot be decided.
  if (p.slice(0, n) === c.slice(0, n)) return p.length === 10 && c.length === 10 ? true : null;
  return p.slice(0, n) < c.slice(0, n);
}

function finish(rec, t0) {
  rec.timing.evaluation_total_ms = nowMono() - t0;
  rec.timing.total_ms = (rec.generation?.observed_latency_ms ?? 0) + rec.timing.evaluation_total_ms;
  // Working time: the model call that succeeded plus Lean execution; no waits on rate limits.
  rec.timing.working_ms = typeof rec.generation?.working_ms === 'number' ? rec.generation.working_ms + (rec.timing.lean_total_ms ?? 0) : null;
  rec.timing.evaluation_ended_at = isoNow();
  rec.evaluation_complete = true;
}
