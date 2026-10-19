// Statement measurements that are applied identically to every benchmark, so the numbers are
// comparable across corpora that use different file layouts and Mathlib versions.
//
// Everything is measured on the Lean source text (comments removed), never by elaborating it:
// elaboration would need each benchmark's own toolchain and Mathlib build. The rules:
//
//   statement tokens   Lean tokens of the target's signature: binders and type, without the
//                      keyword, the name, attributes, doc comments and the proof.
//   closure tokens     statement tokens plus every declaration of the same file that the
//                      signature uses, transitively (definitions, structures, abbreviations,
//                      instances), plus the `variable` commands whose names they use. This is the
//                      text a reader must understand to know what is being asked.
//   defs used          number of same-file declarations in that closure.
//   project library    the file imports a module outside the standard Lean libraries (Mathlib,
//                      Std, Batteries, Lean, Lake, Init, Aesop, Qq, ProofWidgets, Plausible,
//                      LeanSearch, Archive). When the benchmark ships that library in its own repository,
//                      `measureFileWithImports` follows the imports (transitively) and the closure
//                      includes the library definitions the statement uses (`library_defs_used`);
//                      modules that cannot be resolved (external packages) are listed.
//
// A token is an identifier (dotted names count once), a number, a string literal, a two-character
// operator from a fixed list, or any other single non-space character.

import { stripComments, findDeclarations, parseImports } from '../leansrc.js';
import { quantile } from '../util.js';

const STANDARD_IMPORT = /^(Mathlib|Std|Batteries|Lean|Lake|Init|Aesop|Qq|ProofWidgets|Plausible|LeanSearchClient|ImportGraph|Archive|Counterexamples)(\.|$)/;
const DEF_KINDS = new Set(['def', 'abbrev', 'instance', 'structure', 'inductive', 'class', 'opaque', 'irreducible_def', 'axiom']);
const THM_KINDS = new Set(['theorem', 'lemma']);

const IDENT = String.raw`[\p{L}_][\p{L}\p{N}_'!?₀-ₜᵢ-ᵪ]*`;
const TOKEN_RE = new RegExp(String.raw`"(?:[^"\\]|\\.)*"|«[^»]*»|${IDENT}(?:\.(?:${IDENT}|\d+))*|\d+(?:\.\d+)?|:=|->|<-|<=|>=|!=|=>|\|\||&&|\.\.|::|<;>|[^\s]`, 'gu');
const IDENT_RE = new RegExp(String.raw`^(?:${IDENT}|«[^»]*»)(?:\.(?:${IDENT}|\d+))*$`, 'u');

/** Lean tokens of a (comment-free) text. */
export function leanTokens(text) {
  return String(text || '').match(TOKEN_RE) || [];
}

export function isStandardImport(mod) {
  return STANDARD_IMPORT.test(mod);
}

/** The signature of a declaration header: everything after `<kind> <name>` up to the top-level `:=`. */
export function signatureOf(decl) {
  let h = stripComments(decl.header || '');
  // attributes, modifiers, keyword and name
  h = h.replace(/^\s*(@\[[^\]]*\]\s*)*/, '');
  const re = new RegExp(String.raw`^\s*((?:noncomputable|private|protected|partial|unsafe|nonrec|scoped|local)\s+)*${decl.kind}\b`);
  h = h.replace(re, '');
  if (decl.name) {
    const idx = h.indexOf(decl.name);
    if (idx !== -1 && h.slice(0, idx).trim() === '') h = h.slice(idx + decl.name.length);
  }
  // `structure ... where` / `inductive ... where`: the header has no `:=`; keep it as is.
  return h.trim();
}

/** Names bound by `variable` commands, with the command text, in file order. */
function variableCommands(stripped) {
  const out = [];
  const re = /^variable\b([^\n]*(?:\n[ \t]+[^\n]*)*)/gm;
  let m;
  while ((m = re.exec(stripped))) {
    const text = m[0];
    const names = new Set();
    for (const b of text.matchAll(/[({[⦃]\s*([^:(){}[\]⦃⦄]+?)\s*:/gu)) for (const n of b[1].split(/\s+/)) if (n && IDENT_RE.test(n)) names.add(n);
    for (const b of text.matchAll(/\[\s*([A-Z][\w.]*)/gu)) names.add(b[1]);
    out.push({ text, names });
  }
  return out;
}

function nameKeys(name) {
  if (!name) return [];
  const parts = name.split('.');
  const keys = new Set([name, parts[parts.length - 1]]);
  for (let i = 1; i < parts.length; i += 1) keys.add(parts.slice(i).join('.'));
  return [...keys];
}

// Definitions counted per file (an `axiom` is not a definition).
const STRUCTURE_DEF_KINDS = new Set([...DEF_KINDS].filter((k) => k !== 'axiom'));
const PLACEHOLDER = /(^|[^A-Za-z0-9_'.])(sorry|admit)(?![A-Za-z0-9_'!?])/;

export const STRUCTURE_RULE = 'A file is a problem\'s own Lean text (for benchmarks published as rows, one row). Theorems: top-level `theorem`/`lemma` declarations, the problem\'s target included. Definitions: top-level `def`, `abbrev`, `structure`, `inductive`, `class`, `instance`, `opaque`. A shipped proof is a theorem whose body has no `sorry`/`admit`; its length is the non-blank lines and the Lean tokens of the body after `:=`, comments removed. Library modules a problem imports from the benchmark\'s own repository are counted once each.';

/** Theorems, definitions and the proofs a Lean file ships (source text, `STRUCTURE_RULE`). */
export function fileStructure(src, decls = findDeclarations(src)) {
  const theorems = decls.filter((d) => THM_KINDS.has(d.kind));
  const proved = [];
  for (const d of theorems) {
    const body = stripComments(d.body || '');
    const proof = body.replace(/^\s*:=/, '');
    if (!proof.trim() || PLACEHOLDER.test(body)) continue;
    proved.push({ name: d.name, line: d.line, proof_lines: proof.split('\n').filter((l) => l.trim()).length, proof_tokens: leanTokens(proof).length });
  }
  return {
    theorems: theorems.length,
    definitions: decls.filter((d) => STRUCTURE_DEF_KINDS.has(d.kind)).length,
    unproved_theorems: theorems.length - proved.length,
    proved,
  };
}

/** Choose the problem's target in a file: the given name, else the last theorem proved by `sorry`, else the last theorem. */
export function pickTarget(decls, targetName = null) {
  const thms = decls.filter((d) => THM_KINDS.has(d.kind));
  if (targetName) {
    const exact = thms.find((d) => d.name === targetName) || decls.find((d) => d.name === targetName);
    if (exact) return exact;
    const suffix = thms.find((d) => d.name && (d.name.endsWith(`.${targetName}`) || targetName.endsWith(`.${d.name}`)));
    if (suffix) return suffix;
  }
  const sorried = thms.filter((d) => /\bsorry\b/.test(stripComments(d.body || '')));
  if (sorried.length) return sorried[sorried.length - 1];
  if (thms.length) return thms[thms.length - 1];
  // No theorem at all (some datasets state a proposition as `def ... := by sorry`): the last
  // declaration of any kind that is left to `sorry`.
  const anySorried = decls.filter((d) => d.kind !== 'example' && /\bsorry\b/.test(stripComments(d.body || '')));
  return anySorried.length ? anySorried[anySorried.length - 1] : null;
}

/**
 * Measure every requested target in one Lean file.
 * @param {string} src            file text (or header + statement for JSON-row benchmarks)
 * @param {string[]|null} targets target names; null = one problem, picked by `pickTarget`
 * @returns {object[]}            one measurement per target (`ok: false` with a reason when no target is found)
 */
export function measureFile(src, targets = null, { context = [], unresolved = [] } = {}) {
  // Declarations are found at column 0; a file whose only theorem is indented is dedented first.
  if (!findDeclarations(src).some((d) => THM_KINDS.has(d.kind)) && /^[ \t]+(?:theorem|lemma)\s/m.test(src)) {
    src = src.replace(/^[ \t]+(?=(?:@\[[^\]]*\]\s*)?(?:(?:noncomputable|private|protected)\s+)*(?:theorem|lemma|def|abbrev|structure|inductive|class|instance)\s)/gm, '');
  }
  const decls = findDeclarations(src);
  const stripped = stripComments(src);
  const imports = parseImports(src);
  const projectImports = imports.filter((m) => !isStandardImport(m));
  const lines = stripped.split('\n').filter((l) => l.trim()).length;
  const vars = variableCommands(stripped);
  const local = decls.filter((d) => DEF_KINDS.has(d.kind));
  for (const d of local) d.text = src.slice(d.start, d.end);
  const byKey = new Map();
  for (const d of local) for (const k of nameKeys(d.name)) if (!byKey.has(k)) byKey.set(k, d);
  // Library declarations (imported benchmark modules) resolve after the file's own names.
  for (const c of context) {
    for (const d of findDeclarations(c.text)) {
      if (!DEF_KINDS.has(d.kind)) continue;
      d.text = c.text.slice(d.start, d.end);
      d.library = c.module;
      for (const k of nameKeys(d.name)) if (!byKey.has(k)) byKey.set(k, d);
    }
  }
  const structure = fileStructure(src, decls);
  const wanted = targets && targets.length ? targets : [null];
  return wanted.map((t) => {
    const target = pickTarget(decls, t);
    if (!target) return { target: t, ok: false, reason: 'no theorem found' };
    const sig = signatureOf(target);
    const sigTokens = leanTokens(sig);
    // Transitive closure over same-file declarations, starting from the signature.
    const used = new Set();
    const queue = [sigTokens];
    const varsUsed = new Set();
    while (queue.length) {
      const toks = queue.pop();
      for (const tok of toks) {
        if (!IDENT_RE.test(tok)) continue;
        const d = byKey.get(tok) || byKey.get(tok.split('.').pop());
        if (d && d !== target && !used.has(d)) {
          used.add(d);
          queue.push(leanTokens(stripComments(d.text)));
        }
        if (!d || !d.library) vars.forEach((v, i) => { if (v.names.has(tok)) varsUsed.add(i); });
      }
    }
    let closureTokens = sigTokens.length;
    let libraryTokens = 0;
    for (const d of used) {
      const n = leanTokens(stripComments(d.text)).length;
      closureTokens += n;
      if (d.library) libraryTokens += n;
    }
    for (const i of varsUsed) closureTokens += leanTokens(vars[i].text).length;
    // An answer slot (`abbrev x_solution : T := sorry`, a construct-the-answer task) is part of the
    // statement's text but not a definition the reader has to understand: counted separately.
    const isAnswerSlot = (d) => /^\s*:=\s*(by\s+)?sorry\s*$/.test(stripComments(d.body || '').replace(/--.*$/gm, ''));
    const answerSlots = [...used].filter(isAnswerSlot);
    for (const d of answerSlots) used.delete(d);
    const libraryUsed = [...used].filter((d) => d.library);
    return {
      target: target.name,
      ok: true,
      stmt_tokens: sigTokens.length,
      stmt_chars: sig.replace(/\s+/g, ' ').length,
      closure_tokens: closureTokens,
      closure_tokens_file_only: closureTokens - libraryTokens,
      defs_used: used.size,
      answer_slots: answerSlots.length,
      file_defs_used: used.size - libraryUsed.length,
      library_defs_used: libraryUsed.length,
      library_modules_used: [...new Set(libraryUsed.map((d) => d.library))],
      defs_in_file: local.length,
      other_theorems_in_file: decls.filter((d) => THM_KINDS.has(d.kind) && d !== target).length,
      theorems_in_file: structure.theorems,
      definitions_in_file: structure.definitions,
      unproved_theorems_in_file: structure.unproved_theorems,
      proved_lemmas: structure.proved,
      imports: imports.length,
      project_imports: projectImports,
      uses_project_library: projectImports.length > 0,
      unresolved_imports: unresolved,
      lines,
    };
  });
}

/**
 * `measureFile` after following the file's non-standard imports through `readModule`
 * (module name -> source text, or null when the module is not part of the benchmark's repository).
 */
export async function measureFileWithImports(src, targets, readModule, { maxModules = 200, onModule = null } = {}) {
  const context = [];
  const unresolved = new Set();
  const seen = new Set();
  const queue = parseImports(src).filter((m) => !isStandardImport(m));
  while (queue.length && seen.size < maxModules) {
    const mod = queue.shift();
    if (seen.has(mod)) continue;
    seen.add(mod);
    const text = await readModule(mod);
    if (text == null) { unresolved.add(mod); continue; }
    if (onModule) onModule(mod, text);
    context.push({ module: mod, text });
    for (const m of parseImports(text)) if (!isStandardImport(m) && !seen.has(m)) queue.push(m);
  }
  return measureFile(src, targets, { context, unresolved: [...unresolved] });
}

/** Five-number style summary of one numeric field over measured problems. */
export function summarizeField(rows, field) {
  return summarizeValues(rows.filter((r) => r.ok && typeof r[field] === 'number').map((r) => r[field]));
}

/** The same summary of plain numbers. */
export function summarizeValues(values) {
  const xs = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!xs.length) return { n: 0 };
  const q = (p) => quantile(xs, p);
  return { n: xs.length, min: Math.min(...xs), p10: q(0.1), q1: q(0.25), median: q(0.5), q3: q(0.75), p90: q(0.9), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}

// Fixed length buckets (tokens), the same for every benchmark.
export const LENGTH_BUCKETS = [[0, 25, '<25'], [25, 50, '25–49'], [50, 100, '50–99'], [100, 200, '100–199'], [200, 500, '200–499'], [500, 1000, '500–999'], [1000, Infinity, '≥1000']];

export function lengthHistogram(rows, field) {
  const xs = rows.filter((r) => r.ok && typeof r[field] === 'number').map((r) => r[field]);
  return LENGTH_BUCKETS.map(([lo, hi, label]) => ({ label, lo, hi: Number.isFinite(hi) ? hi : null, count: xs.filter((x) => x >= lo && x < hi).length }));
}

// Fixed count buckets for theorems and definitions per file, the same for every benchmark.
export const THEOREM_BUCKETS = [[1, 2, '1'], [2, 3, '2'], [3, 6, '3–5'], [6, Infinity, '6+']];
export const DEFINITION_BUCKETS = [[0, 1, '0'], [1, 3, '1–2'], [3, 6, '3–5'], [6, 11, '6–10'], [11, Infinity, '11+']];

function countHistogram(xs, buckets) {
  return buckets.map(([lo, hi, label]) => ({ label, lo, hi: Number.isFinite(hi) ? hi : null, count: xs.filter((x) => x >= lo && x < hi).length }));
}

/**
 * File structure of one benchmark (`STRUCTURE_RULE`): theorems and definitions per problem file,
 * the proofs the files ship, and the same for the benchmark's own library modules.
 * @param {object[]} rows             measureFile rows (with `id`)
 * @param {{module:string, text:string}[]} libraryFiles  each library module once
 */
export function summarizeStructure(rows, libraryFiles = []) {
  const ok = rows.filter((r) => r.ok && typeof r.theorems_in_file === 'number');
  const proved = ok.flatMap((r) => (r.proved_lemmas || []).map((l) => ({ problem: r.id ?? null, name: l.name, proof_lines: l.proof_lines, proof_tokens: l.proof_tokens })));
  const lib = libraryFiles.map((f) => ({ module: f.module, ...fileStructure(f.text) }));
  const libProved = lib.flatMap((f) => f.proved.map((l) => ({ module: f.module, name: l.name, proof_lines: l.proof_lines, proof_tokens: l.proof_tokens })));
  return {
    rule: STRUCTURE_RULE,
    files: ok.length,
    theorems_per_file: summarizeField(ok, 'theorems_in_file'),
    definitions_per_file: summarizeField(ok, 'definitions_in_file'),
    theorems_histogram: countHistogram(ok.map((r) => r.theorems_in_file), THEOREM_BUCKETS),
    definitions_histogram: countHistogram(ok.map((r) => r.definitions_in_file), DEFINITION_BUCKETS),
    files_with_several_theorems: ok.filter((r) => r.theorems_in_file > 1).length,
    files_with_several_unproved: ok.filter((r) => (r.unproved_theorems_in_file || 0) > 1).length,
    theorems: ok.reduce((a, r) => a + r.theorems_in_file, 0),
    definitions: ok.reduce((a, r) => a + r.definitions_in_file, 0),
    proved_lemmas: proved.length,
    files_with_proved_lemmas: ok.filter((r) => (r.proved_lemmas || []).length > 0).length,
    proof_lines: summarizeValues(proved.map((l) => l.proof_lines)),
    proof_tokens: summarizeValues(proved.map((l) => l.proof_tokens)),
    proved_lemma_list: proved.slice(0, 200),
    library: lib.length ? {
      modules: lib.length,
      theorems: lib.reduce((a, f) => a + f.theorems, 0),
      definitions: lib.reduce((a, f) => a + f.definitions, 0),
      proved_lemmas: libProved.length,
      unproved_theorems: lib.reduce((a, f) => a + f.unproved_theorems, 0),
      proof_lines: summarizeValues(libProved.map((l) => l.proof_lines)),
      proof_tokens: summarizeValues(libProved.map((l) => l.proof_tokens)),
      proved_lemma_list: libProved.slice(0, 200),
    } : null,
  };
}

/** The comparable statement statistics of one benchmark. */
export function summarizeMeasurements(rows) {
  const ok = rows.filter((r) => r.ok);
  return {
    closure_histogram: lengthHistogram(rows, 'closure_tokens'),
    stmt_histogram: lengthHistogram(rows, 'stmt_tokens'),
    problems: rows.length,
    measured: ok.length,
    unmeasured: rows.length - ok.length,
    stmt_tokens: summarizeField(rows, 'stmt_tokens'),
    closure_tokens: summarizeField(rows, 'closure_tokens'),
    closure_tokens_file_only: summarizeField(rows, 'closure_tokens_file_only'),
    defs_used: summarizeField(rows, 'defs_used'),
    share_with_local_defs: ok.length ? ok.filter((r) => r.defs_used > 0).length / ok.length : null,
    share_with_project_library: ok.length ? ok.filter((r) => r.uses_project_library).length / ok.length : null,
    count_with_local_defs: ok.filter((r) => r.defs_used > 0).length,
    count_with_project_library: ok.filter((r) => r.uses_project_library).length,
    count_with_library_defs: ok.filter((r) => (r.library_defs_used || 0) > 0).length,
    count_with_answer_slot: ok.filter((r) => (r.answer_slots || 0) > 0).length,
    count_with_unresolved_imports: ok.filter((r) => (r.unresolved_imports || []).length > 0).length,
    unresolved_modules: [...new Set(ok.flatMap((r) => r.unresolved_imports || []))].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// Exact binomial interval (used for the pass rates in the comparison).
// ---------------------------------------------------------------------------------------------

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i += 1) s += Math.log((n - k + i) / i);
  return s;
}

export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let s = 0;
  for (let i = 0; i <= k; i += 1) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, s);
}

function root(f) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Exact two-sided Clopper-Pearson interval for k successes in n trials. */
export function clopperPearson(k, n, alpha = 0.05) {
  if (!(n > 0)) return null;
  const lo = k === 0 ? 0 : root((p) => 1 - binomCdf(k - 1, n, p) - alpha / 2);
  const hi = k === n ? 1 : root((p) => binomCdf(k, n, p) - alpha / 2);
  return [lo, hi];
}
