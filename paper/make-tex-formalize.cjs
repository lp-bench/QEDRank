#!/usr/bin/env node
// Builds the LaTeX performance matrix (tables and pgfplots figures) for one QEDRank formalize run:
// the model reads passages of a paper and returns a Lean statement of a claim (part A) and a Lean
// proof file (part B). Every number is computed from the run's item and reference records, so the
// file can be rebuilt after a re-grade. For prove runs use make-tex.cjs.
//
//   node paper/make-tex-formalize.cjs <run-dir> [out.tex]
//
// The two parts are reported separately, and each item is assigned to the first step at which it
// stopped. Outcomes the model is not responsible for (provider failures, a statement module the
// grader's Lean project lacks) are kept apart from model outcomes. Two corrections to the grader's
// own labels are applied, both visible in the tables:
//   - a proof file with no Lean code (the model declined in comments, as the prompt allows) is a
//     declined proof, not a compiled one;
//   - "object file ... does not exist" for a module whose source exists in no package of the Lean
//     project is an import the model invented, not an infrastructure failure.
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node paper/make-tex-formalize.cjs <run-dir> [out.tex]');
  process.exit(2);
}
const outFile = process.argv[3] || path.join(__dirname, 'performance-matrix-formalize.tex');

// Facts about the benchmark repository at the evaluated commit (lean-toolchain and lakefile.toml).
const BENCHMARK_PIN = { lean: 'v4.33.1', mathlib: 'v4.33.1', matroid: 'fa6c155', options: 'maxSynthPendingDepth = 3' };
const TARGETS = ['main_theorem', 'upper_bound', 'lower_bound'];
const TARGET_LABEL = { main_theorem: 'Main theorem', upper_bound: 'Upper bound', lower_bound: 'Lower bound' };
const ACCEPTED = new Set(['definitionally_identical', 'equivalent', 'expert_confirmed_equivalent']);

const summary = readJson(path.join(runDir, 'summary.json'));
const exported = readJson(path.join(runDir, 'exports', 'items.json'));
if (!exported.items.every((i) => i.task === 'formalize')) throw new Error('not a formalize run; use make-tex.cjs');
if (summary.settings.k !== 1 || summary.settings.repair_rounds !== 0) throw new Error('this generator covers pass@1 runs without repair rounds');
const difficultyOf = new Map(exported.items.map((i) => [i.item_key, i.difficulty]));

const run = summary.run;
const MODELS = summary.models.map((m) => ({ id: m.id, label: shortLabel(m), facts: m.facts || {}, host: m.host, modelId: m.model_id }));

const records = [];
for (const key of fs.readdirSync(path.join(runDir, 'items')).sort()) {
  const dir = path.join(runDir, 'items', key);
  const file = path.join(dir, 'attempt-a1r0.json');
  if (!fs.existsSync(file)) continue;
  const r = readJson(file);
  const resp = path.join(dir, 'response-a1r0.txt');
  r._response = fs.existsSync(resp) ? fs.readFileSync(resp, 'utf8') : null;
  records.push(r);
}

// Reference records written by reference preparation, one per paper and target.
const refs = new Map();
const preparedDir = path.join(runDir, 'prepared');
for (const p of fs.existsSync(preparedDir) ? fs.readdirSync(preparedDir).sort() : []) {
  for (const t of TARGETS) {
    const f = path.join(preparedDir, p, `reference__${t}.json`);
    if (fs.existsSync(f)) refs.set(`${p}__${t}`, readJson(f));
  }
}

// Module sources in the grader's Lean project, to tell a missing build artifact from an invented import.
const sourceRoots = (() => {
  const proj = run.toolchain?.lean_project;
  if (!proj || !fs.existsSync(proj)) return null;
  const roots = [proj];
  const pk = path.join(proj, '.lake', 'packages');
  if (fs.existsSync(pk)) for (const d of fs.readdirSync(pk)) roots.push(path.join(pk, d));
  return roots;
})();
function moduleExists(mod) {
  if (!sourceRoots) return null;
  const rel = mod.split('.').join(path.sep) + '.lean';
  return sourceRoots.some((r) => fs.existsSync(path.join(r, rel)));
}

// ---------------------------------------------------------------- classification

// Part A: the statement. id, label, colour, group
const CATS = [
  ['timeout', 'Request timed out', 'qrTimeout', 'provider'],
  ['rate_limit', 'Refused: concurrency limit (HTTP 429)', 'qrRate', 'provider'],
  ['quota', 'Refused: account balance exhausted (HTTP 429)', 'qrQuota', 'provider'],
  ['provider_other', 'Other provider error', 'qrRate', 'provider'],
  ['grader_env', 'Statement dependency not built in grader project', 'qrEnv', 'grader'],
  ['no_stmt_cutoff', 'No statement: answer cut off at the token limit', 'qrCut', 'model'],
  ['no_stmt_format', 'No statement: part A not in a Lean code block', 'qrAbst', 'model'],
  ['stmt_screen', 'Statement rejected by static screen', 'qrScreen', 'model'],
  ['stmt_bad_import', 'Statement imports a module that does not exist', 'qrImp', 'model'],
  ['stmt_error', 'Statement does not compile', 'qrErr', 'model'],
  ['stmt_timeout', 'Statement compile time limit reached', 'qrErr', 'model'],
  ['stmt_unchecked', 'Statement compiles; no reference to compare with', 'qrSorry', 'model'],
  ['stmt_unresolved', 'Statement compiles; equivalence unresolved', 'qrAx', 'model'],
  ['stmt_different', 'Statement compiles; stronger, weaker or different', 'qrStmt', 'model'],
  ['stmt_faithful', 'Statement faithful (accepted match)', 'qrOk', 'model'],
];
const CAT = Object.fromEntries(CATS.map(([id, label, color, group]) => [id, { id, label, color, group }]));
const STMT_COMPILED = new Set(['stmt_unchecked', 'stmt_unresolved', 'stmt_different', 'stmt_faithful']);
const NO_STMT = new Set(['no_stmt_cutoff', 'no_stmt_format']);
const CODE = {
  timeout: 'TO', rate_limit: '429', quota: 'BAL', provider_other: 'PRV', grader_env: 'ENV',
  no_stmt_cutoff: 'CUT', no_stmt_format: 'FMT', stmt_screen: 'SCR', stmt_bad_import: 'IMP', stmt_error: 'ERR',
  stmt_timeout: 'TLE', stmt_unchecked: 'CMP', stmt_unresolved: 'UNR', stmt_different: 'DIF', stmt_faithful: 'OK',
};

// Part B: the proof file.
const PCATS = [
  ['p_none', 'No proof file returned', 'qrAbst', 'model'],
  ['p_cutoff', 'No proof file extracted (answer cut off)', 'qrCut', 'model'],
  ['p_declined', 'Proof declined: file contains only comments', 'qrDecl', 'model'],
  ['p_grader', 'Proof dependency not built in grader project', 'qrEnv', 'grader'],
  ['p_screen', 'Rejected by static screen', 'qrScreen', 'model'],
  ['p_error', 'Does not compile', 'qrErr', 'model'],
  ['p_timeout', 'Compile time limit reached', 'qrErr', 'model'],
  ['p_no_target', 'Compiles; target theorem absent', 'qrStmt', 'model'],
  ['p_unclean', 'Compiles; \\texttt{sorry} or non-standard axiom', 'qrSorry', 'model'],
  ['p_unmatched', 'Compiles, clean; statement not an accepted match', 'qrAx', 'model'],
  ['p_verified', 'Verified', 'qrOk', 'model'],
];
const PCAT = Object.fromEntries(PCATS.map(([id, label, color, group]) => [id, { id, label, color, group }]));
const PROOF_CODE = new Set(['p_grader', 'p_screen', 'p_error', 'p_timeout', 'p_no_target', 'p_unclean', 'p_unmatched', 'p_verified']);
const PROOF_COMPILED = new Set(['p_no_target', 'p_unclean', 'p_unmatched', 'p_verified']);

function genErrorKind(r) {
  const e = r.generation?.error;
  if (!e) return null;
  return (typeof e === 'string' ? e.split(':')[0] : e.kind) || 'provider_other';
}
function missingModules(c) {
  const mods = [];
  for (const m of c?.messages || []) for (const x of String(m.text).matchAll(/of module (\S+) does not exist/g)) mods.push(x[1]);
  return mods;
}

function classifyStatement(r) {
  const gk = genErrorKind(r);
  if (gk) {
    if (gk === 'timeout') return 'timeout';
    if (gk === 'insufficient_quota') return 'quota';
    if (gk === 'rate_limited' || r.generation?.http_status === 429) return 'rate_limit';
    return 'provider_other';
  }
  const sc = r.statement_compile;
  if (!sc || sc.status === 'not_attempted') return r.generation?.truncated ? 'no_stmt_cutoff' : 'no_stmt_format';
  switch (sc.status) {
    case 'infrastructure_failure': {
      const mods = missingModules(sc);
      return mods.length && mods.every((m) => moduleExists(m) === false) ? 'stmt_bad_import' : 'grader_env';
    }
    case 'rejected_by_static_screen': return 'stmt_screen';
    case 'timeout': return 'stmt_timeout';
    case 'compiler_failure': return 'stmt_error';
    case 'compiler_success':
      if (ACCEPTED.has(r.statement_match)) return 'stmt_faithful';
      if (['different', 'stronger', 'weaker'].includes(r.statement_match)) return 'stmt_different';
      return r.eligibility?.statement_track ? 'stmt_unresolved' : 'stmt_unchecked';
    default:
      throw new Error(`${r.item_key}: unclassified statement outcome ${sc.status}`);
  }
}

function classifyProof(r) {
  const notes = r.parse?.notes || [];
  if (notes.includes('fallback_raw_text_as_proof_file')) return r.generation?.truncated ? 'p_cutoff' : 'p_none';
  if (r.abstained || !r.compile || r.compile.status === 'not_attempted') return 'p_none';
  if (r.loc?.model?.code === 0) return 'p_declined';
  switch (r.compile.status) {
    case 'infrastructure_failure': return 'p_grader';
    case 'rejected_by_static_screen': return 'p_screen';
    case 'compiler_failure': return 'p_error';
    case 'timeout': return 'p_timeout';
    case 'compiler_success':
      if (r.outcomes?.verified === 1) return 'p_verified';
      if (r.audit?.status === 'target_not_found') return 'p_no_target';
      if (r.audit?.status && r.audit.status !== 'clean') return 'p_unclean';
      return 'p_unmatched';
    default:
      throw new Error(`${r.item_key}: unclassified proof outcome ${r.compile.status}`);
  }
}

// First Lean error of a statement file that failed. The whole message is matched, so the
// autoImplicit hint ("The identifier `X` is unknown") counts as an unknown identifier.
const ERRS = [
  ['bad_import', 'Imported module does not exist', /of module \S+ does not exist/],
  ['outdated', 'Lean 3 syntax or unknown tactic', /Unknown identifier `begin`|unknown tactic|unexpected token 'in'/],
  ['unknown', 'Unknown identifier, namespace, constant or field', /Unknown identifier|Unknown constant|unknown namespace|identifier `[^`]+` is unknown|does not contain|Invalid field `|is not a field of structure/],
  ['typeclass', 'Type-class synthesis failure', /failed to synthesize|typeclass instance problem is stuck|is not a class instance/],
  ['mismatch', 'Ill-typed term (type or universe mismatch)', /Type mismatch|Application type mismatch|Invalid field notation|Function expected|universe/],
  ['syntax', 'Parse error', /unexpected token|expected token|expected/],
  ['other', 'Other', /[\s\S]*/],
];
const firstError = (c) => (c?.messages || []).find((m) => m.severity === 'error')?.text || '';
const errorClass = (msg) => ERRS.find(([, , re]) => re.test(msg))[0];

// Share of repeated lines in an answer, to tell a repetition loop from a long answer.
function repetition(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { dup: 0, imports: 0 };
  const seen = new Set();
  let dup = 0;
  let imports = 0;
  for (const l of lines) {
    if (seen.has(l)) dup++;
    seen.add(l);
    if (/^import\s/.test(l)) imports++;
  }
  return { dup: dup / lines.length, imports: imports / lines.length };
}

const items = records.map((r) => {
  const cat = classifyStatement(r);
  const provider = CAT[cat].group === 'provider';
  const proofCat = provider ? null : classifyProof(r);
  const truncated = !provider && Boolean(r.generation?.truncated);
  const rep = truncated ? repetition(r._response) : { dup: 0, imports: 0 };
  const stmtErr = cat === 'stmt_error' || cat === 'stmt_bad_import' ? firstError(r.statement_compile) : null;
  return {
    key: r.item_key,
    paper: r.paper_id,
    target: r.target_kind,
    model: r.provider,
    cat,
    group: CAT[cat].group,
    proofCat,
    truncated,
    loop: truncated && rep.dup >= 0.9,
    importLoop: truncated && rep.dup >= 0.9 && rep.imports >= 0.9,
    status: r.mathematical_status,
    established: r.mathematical_status === 'established',
    eligibleStatement: Boolean(r.eligibility?.statement_track),
    eligibleProof: Boolean(r.eligibility?.proof_track),
    refAvailable: Boolean(r.reference_statement_available),
    latencyMs: provider ? null : r.generation?.observed_latency_ms ?? null,
    outputTokens: provider ? null : r.generation?.usage?.outputTokens ?? null,
    temperature: r.generation?.temperature,
    stmtConf: isNum(r.confidence?.statement) ? r.confidence.statement : null,
    proofConf: isNum(r.confidence?.proof) ? r.confidence.proof : null,
    stmtErr,
    errClass: cat === 'stmt_bad_import' ? 'bad_import' : stmtErr !== null ? errorClass(stmtErr) : null,
    difficulty: difficultyOf.get(r.item_key) || 'unlabelled',
    graderCompiled: r.outcomes?.compiled === 1,
  };
});

function stats(model, target = null) {
  const all = items.filter((i) => i.model === model && (!target || i.target === target));
  const count = Object.fromEntries(CATS.map(([id]) => [id, all.filter((i) => i.cat === id).length]));
  const pcount = Object.fromEntries(PCATS.map(([id]) => [id, all.filter((i) => i.proofCat === id).length]));
  const answered = all.filter((i) => i.group !== 'provider');
  const gradable = answered.filter((i) => i.group === 'model');
  const extracted = answered.filter((i) => !NO_STMT.has(i.cat));
  const stmtCompiled = answered.filter((i) => STMT_COMPILED.has(i.cat));
  const faithfulPool = all.filter((i) => i.eligibleStatement && i.group === 'model');
  const proofCode = answered.filter((i) => PROOF_CODE.has(i.proofCat));
  const proofGradable = proofCode.filter((i) => PCAT[i.proofCat].group === 'model');
  const verifiedPool = all.filter((i) => i.target === 'main_theorem' && i.eligibleProof && i.group === 'model' && PCAT[i.proofCat]?.group !== 'grader');
  const truncated = answered.filter((i) => i.truncated);
  const conf = (f) => answered.map(f).filter(isNum);
  return {
    all, count, pcount, answered, gradable, extracted, stmtCompiled,
    faithfulPool, faithful: faithfulPool.filter((i) => i.cat === 'stmt_faithful'),
    refAvailable: all.filter((i) => i.refAvailable),
    proofCode, proofGradable, proofCompiled: answered.filter((i) => PROOF_COMPILED.has(i.proofCat)),
    declined: answered.filter((i) => i.proofCat === 'p_declined'),
    verifiedPool, verified: verifiedPool.filter((i) => i.proofCat === 'p_verified'),
    truncated, loops: truncated.filter((i) => i.loop), importLoops: truncated.filter((i) => i.importLoop),
    stmtConf: conf((i) => i.stmtConf), proofConf: conf((i) => i.proofConf),
    medianLatencyS: answered.length ? median(answered.map((i) => i.latencyMs).filter(isNum)) / 1000 : null,
    medianOutput: median(answered.map((i) => i.outputTokens).filter(isNum)),
    temperature: answered.length && answered.some((i) => i.temperature === null || i.temperature === undefined) ? 'set by the provider' : String(summary.settings.temperature),
  };
}
const S = Object.fromEntries(MODELS.map((m) => [m.id, stats(m.id)]));
const ST = Object.fromEntries(MODELS.map((m) => [m.id, Object.fromEntries(TARGETS.map((t) => [t, stats(m.id, t)]))]));
const answering = MODELS.filter((m) => S[m.id].answered.length > 0);
const silent = MODELS.filter((m) => S[m.id].answered.length === 0);

// ---------------------------------------------------------------- statistics

const LOG_FACT = [0];
function logFact(n) {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}
function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(logFact(n) - logFact(i) - logFact(n - i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, s);
}
function root(g) {
  let a = 0, b = 1;
  const ga = g(a);
  for (let it = 0; it < 200; it++) {
    const m = (a + b) / 2;
    if (Math.sign(g(m)) === Math.sign(ga)) a = m; else b = m;
  }
  return (a + b) / 2;
}
// Exact two-sided Clopper-Pearson interval.
function clopperPearson(k, n, alpha = 0.05) {
  if (n === 0) return null;
  const lo = k === 0 ? 0 : root((p) => 1 - binomCdf(k - 1, n, p) - alpha / 2);
  const hi = k === n ? 1 : root((p) => binomCdf(k, n, p) - alpha / 2);
  return [lo, hi];
}

// ---------------------------------------------------------------- formatting

const pct = (x, d = 1) => (100 * x).toFixed(d);
const int = (x) => (isNum(x) ? Math.round(x).toLocaleString('en-US').replace(/,/g, '{,}') : '---');
const frac = (k, n) => (n === 0 ? '---' : `${k}/${n} (${pct(k / n)}\\,\\%)`);
const ci = (k, n) => {
  const c = clopperPearson(k, n);
  return c ? `[${pct(c[0])}, ${pct(c[1])}]` : '---';
};
const short = (h) => String(h || '').slice(0, 7);
const fmtB = (b) => (b >= 1000 ? `${(b / 1000).toFixed(1)}\\,T` : `${b}\\,B`);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------------------------------------------------------------- document

const cov = summary.coverage;
const papersRun = [...new Set(items.map((i) => i.paper))].sort();
const papersAll = (summary.paper_level?.[MODELS[0].id]?.rows || []).map((r) => r.paper_id);
const papersNotRun = papersAll.filter((p) => !papersRun.includes(p));
const nTargets = S[MODELS[0].id].all.length;
const toolchainName = String(run.toolchain.toolchain).replace(/^.*:/, '');
const usedBenchmarkProject = /proofbench/i.test(String(run.toolchain.lean_project || ''));
const leanProjectName = path.basename(String(run.toolchain.lean_project || 'unknown'));
const contextChars = run.settings.context_max_chars;

// Claim status and difficulty, one value per paper and target.
const firstOfTarget = (t) => papersRun.map((p) => items.find((i) => i.paper === p && i.target === t)).filter(Boolean);
const statusCount = (t) => {
  const c = {};
  for (const i of firstOfTarget(t)) c[i.status] = (c[i.status] || 0) + 1;
  return c;
};
const statusText = (c) => Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ');
const diffCount = {};
for (const i of firstOfTarget('main_theorem')) diffCount[i.difficulty] = (diffCount[i.difficulty] || 0) + 1;

// Reference availability.
const refRows = TARGETS.map((t) => {
  const rs = papersRun.map((p) => refs.get(`${p}__${t}`)).filter(Boolean);
  const unavailable = rs.filter((r) => !r.statement_available);
  const libMissing = unavailable.filter((r) => (r.flags || []).some((f) => f.startsWith('unresolved_local_imports')));
  const wrapError = unavailable.filter((r) => !libMissing.includes(r) && (r.statement_compile?.messages || []).some((m) => /QRRef/.test(m.text)));
  return {
    t,
    targets: papersRun.length,
    found: rs.length,
    available: rs.length - unavailable.length,
    libMissing: libMissing.length,
    wrapError: wrapError.length,
    other: unavailable.length - libMissing.length - wrapError.length,
    complete: rs.filter((r) => r.reference_proof_status === 'complete').length,
    placeholder: rs.filter((r) => r.reference_proof_status === 'contains_placeholder').length,
    notCompiled: rs.filter((r) => r.reference_proof_status === 'invalid').length,
    established: firstOfTarget(t).filter((i) => i.established).length,
  };
});
const refTotal = Object.fromEntries(Object.keys(refRows[0]).filter((k) => k !== 't').map((k) => [k, refRows.reduce((s, r) => s + r[k], 0)]));
const libImports = {};
for (const r of refs.values()) {
  for (const f of r.flags || []) {
    if (!f.startsWith('unresolved_local_imports:')) continue;
    for (const m of f.slice('unresolved_local_imports:'.length).split('|')) {
      const k = m.split('.').slice(0, m.startsWith('ProofBench') ? 2 : 1).join('.');
      libImports[k] = (libImports[k] || 0) + 1;
    }
  }
}
const noDefinitionPrompts = (() => {
  let n = 0;
  let total = 0;
  for (const key of fs.readdirSync(path.join(runDir, 'items'))) {
    const f = path.join(runDir, 'items', key, 'prompt-a1.txt');
    if (!fs.existsSync(f)) continue;
    total++;
    if (fs.readFileSync(f, 'utf8').includes('(no per-paper definitions)')) n++;
  }
  return { n, total };
})();

const colourDefs = String.raw`\definecolor{qrTimeout}{RGB}{110,110,110}
\definecolor{qrRate}{RGB}{165,165,165}
\definecolor{qrQuota}{RGB}{215,215,215}
\definecolor{qrAbst}{RGB}{86,180,233}
\definecolor{qrEnv}{RGB}{230,159,0}
\definecolor{qrImp}{RGB}{240,228,66}
\definecolor{qrScreen}{RGB}{153,153,51}
\definecolor{qrCut}{RGB}{140,81,10}
\definecolor{qrErr}{RGB}{213,94,0}
\definecolor{qrDecl}{RGB}{128,205,193}
\definecolor{qrStmt}{RGB}{204,121,167}
\definecolor{qrSorry}{RGB}{0,114,178}
\definecolor{qrAx}{RGB}{100,50,120}
\definecolor{qrOk}{RGB}{0,158,115}`;

const modelCols = MODELS.map((m) => m.label).join(' & ');

// Table: setup
const modelRows = MODELS.map((m) => {
  const f = m.facts;
  const size = isNum(f.parameters_b) ? `${fmtB(f.parameters_b)} parameters${isNum(f.active_parameters_b) ? `, ${fmtB(f.active_parameters_b)} active (mixture of experts)` : ''}` : 'size not published';
  return String.raw`\textbf{${m.label}}: \texttt{${tt(m.modelId)}} via \texttt{${tt(m.host)}}; ${size}; released ${f.released || 'unknown'}; temperature ${S[m.id].temperature}.`;
}).join(String.raw`\newline `);
const mainStatus = statusCount('main_theorem');
const boundStatus = { ...statusCount('upper_bound') };
for (const [k, v] of Object.entries(statusCount('lower_bound'))) boundStatus[k] = (boundStatus[k] || 0) + v;

const setupTable = String.raw`% ---------------------------------------------------------------- Table: setup
\begin{table}[!htbp]
\centering
\caption{Evaluation setup of run \texttt{${tt(run.run_id)}}.}
\label{tab:f-setup}
\small
\begin{tabularx}{\linewidth}{@{}>{\raggedright\arraybackslash}p{2.4cm}>{\raggedright\arraybackslash}X@{}}
\toprule
Corpus & \texttt{${tt(run.source.repo)}} at commit \texttt{${short(run.source.commit)}} (${String(run.source.commit_date || '').slice(0, 10)}), folder \texttt{${tt(run.source.subdir || '')}}: ${cov.papers_discovered} paper folders, of which ${papersRun.length} with a PDF were run${papersNotRun.length ? ` (${papersNotRun.join(', ')} has no PDF)` : ''}. Three targets per paper (main theorem, upper bound, lower bound): ${nTargets} targets per model. Claim status from the benchmark index: main theorems ${statusText(mainStatus)}; bounds ${statusText(boundStatus)}. Difficulty label: ${Object.entries(diffCount).map(([k, v]) => `${k} ${v}`).join(', ')}. \\
Task & Formalize and prove from the paper. The prompt names the target and gives up to ${int(contextChars)} characters of passages extracted from the paper's PDF.\textsuperscript{b} The model returns (A) a Lean statement of the claim with any definitions it needs, (B) a complete Lean proof file, or no file if it cannot prove the claim, (C) a paper-to-Lean mapping, and (D) two confidences from 0 to 100: that A is faithful and that B passes the audit. \\
Protocol & One request per target (pass@1), no repair rounds, no tools or retrieval; prompt template \texttt{${tt(run.prompt_template_version)}}. \\
Models & ${modelRows} \\
Budgets & ${int(run.settings.max_tokens)} output tokens and ${run.settings.generation_timeout_ms / 1000}\,s per request. \\
Grader & Lean ${tt(toolchainName)}, Mathlib \texttt{${short(run.toolchain.mathlib?.rev)}} (the toolchain named in the prompt); ${int(run.settings.lean.maxHeartbeats)} heartbeats, ${run.settings.lean.timeoutMs / 1000}\,s and ${run.settings.lean.memoryMb / 1024}\,GB per compilation.${usedBenchmarkProject ? '' : String.raw`\textsuperscript{a}`} Part A is compiled on its own; it is \emph{faithful} when it compiles and is accepted as equivalent to the audited reference statement (definitional identity, an automated two-way implication, or expert review). Part B is \emph{verified} when it compiles, contains the target theorem, that theorem's statement is an accepted match, it depends only on \texttt{propext}, \texttt{Classical.choice} and \texttt{Quot.sound}, and the claim is established. \\
Harness & QEDRank commit \texttt{${tt(run.harness.short)}}${run.harness.dirty ? ' (uncommitted changes)' : ''}; total wall-clock time ${(run.batch_wall_clock_ms / 3.6e6).toFixed(1)}\,h. \\
Statistics & Exact two-sided 95\,\% Clopper--Pearson intervals over targets. The three targets of a paper are not independent, so pooled intervals are too narrow; the primary endpoint has one target per paper. \\
\bottomrule
\end{tabularx}
\par\smallskip\parbox{\linewidth}{\footnotesize ${usedBenchmarkProject ? '' : String.raw`\textsuperscript{a}\,Graded in the QEDRank default Lean project (\texttt{${tt(leanProjectName)}}). The benchmark pins Lean ${BENCHMARK_PIN.lean}, Mathlib ${BENCHMARK_PIN.mathlib}, the Matroid library at \texttt{${BENCHMARK_PIN.matroid}} and the option \texttt{${tt(BENCHMARK_PIN.options)}}; its reference files import benchmark modules that this project does not contain (Table~\ref{tab:f-refs}). `}\textsuperscript{b}\,${noDefinitionPrompts.n === noDefinitionPrompts.total ? `None of the ${noDefinitionPrompts.total} prompts` : `${noDefinitionPrompts.n} of the ${noDefinitionPrompts.total} prompts`} contained definitions from the benchmark's Lean files, so the model had to define every notion itself.}
\end{table}`;

// Table: reference availability
const refRowTex = (label, r) => String.raw`${label} & ${r.targets} & ${r.available} & ${r.libMissing} & ${r.wrapError}${refTotal.other ? ` & ${r.other}` : ''} & ${r.complete} & ${r.placeholder} & ${r.notCompiled} & ${r.established} \\`;
const refsTable = String.raw`% ---------------------------------------------------------------- Table: reference availability
\begin{table}[!htbp]
\centering
\begin{threeparttable}
\caption{Reference statements available to the grader, by target. A model statement can only be checked for faithfulness against an available reference.}
\label{tab:f-refs}
\small
\setlength{\tabcolsep}{4.5pt}
\begin{tabular}{@{}lrr${refTotal.other ? 'rrr' : 'rr'}rrrr@{}}
\toprule
 & & & \multicolumn{${refTotal.other ? 3 : 2}}{c}{Unavailable because} & \multicolumn{3}{c}{Reference proof} & \\
\cmidrule(lr){4-${refTotal.other ? 6 : 5}}\cmidrule(lr){${refTotal.other ? 7 : 6}-${refTotal.other ? 9 : 8}}
Target & Targets & Available & Library\tnote{a} & Wrapper\tnote{b}${refTotal.other ? ' & Other' : ''} & Complete & \texttt{sorry} & Not compiled & Established \\
\midrule
${refRows.map((r) => refRowTex(TARGET_LABEL[r.t], r)).join('\n')}
\midrule
${refRowTex('All', refTotal)}
\bottomrule
\end{tabular}
\begin{tablenotes}\footnotesize
\item[a] The reference file imports modules that are not in the grader's Lean project (${Object.entries(libImports).sort((a, b) => b[1] - a[1]).map(([k, v]) => String.raw`\texttt{${tt(k)}} ${v}`).join(', ')} imports), so its statement could not be compiled. This is a property of the grader configuration, not of the benchmark.
\item[b] The statement compiled in the benchmark's own file but failed after QEDRank wrapped it in its comparison namespace (\textit{unexpected name after \texttt{end}}); a defect of the harness.
\item[] \textit{Reference proof}: \emph{complete} has no \texttt{sorry}; \emph{\texttt{sorry}} compiles with a placeholder; \emph{not compiled} could not be compiled in the grader's project. \emph{Established}: the claim is marked established in the benchmark index (all bounds are marked uncertain).
\end{tablenotes}
\end{threeparttable}
\end{table}`;

// Table: outcome breakdown (part A, then part B)
const usedCats = CATS.filter(([id]) => MODELS.some((m) => S[m.id].count[id] > 0));
const usedPCats = PCATS.filter(([id]) => MODELS.some((m) => S[m.id].pcount[id] > 0));
const groupTitle = { provider: 'Provider (not attributable to the model)', grader: 'Grader configuration (not attributable to the model)', model: 'Model' };
const cell = (k, n) => (n ? `${k} (${pct(k / n)}\\,\\%)` : String(k));
let outcomeRows = String.raw`\addlinespace[2pt]\multicolumn{${1 + MODELS.length}}{@{}l}{\textbf{Part A: statement} (each target counted once)} \\` + '\n';
for (const g of ['provider', 'grader', 'model']) {
  const cats = usedCats.filter(([, , , grp]) => grp === g);
  if (!cats.length) continue;
  outcomeRows += String.raw`\addlinespace[1pt]\multicolumn{${1 + MODELS.length}}{@{}l}{\quad\textit{${groupTitle[g]}}} \\` + '\n';
  for (const [id, label, color] of cats) {
    const cells = MODELS.map((m) => {
      const k = S[m.id].count[id];
      const cut = S[m.id].all.filter((i) => i.cat === id && i.truncated).length;
      const extra = id !== 'no_stmt_cutoff' && cut ? String.raw` \,{\footnotesize(${cut} cut off)}` : '';
      return cell(k, S[m.id].all.length) + extra;
    }).join(' & ');
    outcomeRows += String.raw`\qquad\swatch{${color}}\,${label} & ${cells} \\` + '\n';
  }
}
outcomeRows += String.raw`\midrule
\addlinespace[2pt]\multicolumn{${1 + MODELS.length}}{@{}l}{\textbf{Part B: proof file} (answered targets only)} \\` + '\n';
for (const [id, label, color] of usedPCats) {
  const cells = MODELS.map((m) => (S[m.id].answered.length ? cell(S[m.id].pcount[id], S[m.id].answered.length) : '---')).join(' & ');
  outcomeRows += String.raw`\qquad\swatch{${color}}\,${label} & ${cells} \\` + '\n';
}
const outcomeTable = String.raw`% ---------------------------------------------------------------- Table: outcome breakdown
\begin{table}[!htbp]
\centering
\caption{Outcome of every request, by model (${nTargets} targets each). Within each part the categories are mutually exclusive; each target is assigned to the first step at which it stopped.}
\label{tab:f-outcomes}
\small
\begin{tabular}{@{}l${'r'.repeat(MODELS.length)}@{}}
\toprule
Outcome & ${modelCols} \\
\midrule
${outcomeRows}\midrule
Targets & ${MODELS.map((m) => S[m.id].all.length).join(' & ')} \\
\bottomrule
\end{tabular}
\par\smallskip\parbox{0.94\linewidth}{\footnotesize \textit{Cut off}: the answer reached the ${int(run.settings.max_tokens)}-token output limit before it ended. \textit{Imports a module that does not exist}: Lean reports a missing object file, and no package of the grader's Lean project has a source file for that module; the grader itself labels these items infrastructure failures. \textit{Proof declined}: the proof file has no Lean code, only comments saying that no complete proof is given, which the prompt allows; the grader itself counts these files as compiled.}
\end{table}`;

// Table: performance matrix
function pmRows() {
  const row = (label, f) => String.raw`${label} & ${MODELS.map((m) => f(S[m.id], m)).join(' & ')} \\`;
  const dash = (s, f) => (s.answered.length ? f() : '---');
  const reported = (m) => summary.by_target?.all?.[m.id]?.compile || { num: 0, den: 0 };
  const confText = (xs) => (xs.length ? `${pct(mean(xs) / 100, 0)}\\,\\% {\\footnotesize(n\\,=\\,${xs.length})}` : '---');
  const providerRows = [
    ['timeout', 'Requests timed out'],
    ['rate_limit', 'Refused: concurrency limit (HTTP 429)'],
    ['quota', 'Refused: account balance exhausted'],
    ['provider_other', 'Other provider errors'],
  ].filter(([id]) => MODELS.some((m) => S[m.id].count[id] > 0));
  return [
    row(`Targets run (${papersRun.length} papers $\\times$ 3)`, (s) => s.all.length),
    ...providerRows.map(([id, label]) => row(label, (s) => s.count[id])),
    row('Answered', (s) => s.answered.length),
    row('Answer cut off at the token limit', (s) => dash(s, () => frac(s.truncated.length, s.answered.length))),
    row(String.raw`\quad of which repetition loops\tnote{a}`, (s) => dash(s, () => `${s.loops.length}/${s.truncated.length}`)),
    String.raw`\midrule`,
    String.raw`\multicolumn{${1 + MODELS.length}}{@{}l}{\textit{Part A: statement}} \\`,
    row('Statement extracted from the answer', (s) => dash(s, () => frac(s.extracted.length, s.answered.length))),
    row(String.raw`Statement compiles\tnote{b}`, (s) => dash(s, () => frac(s.stmtCompiled.length, s.gradable.length))),
    row(String.raw`\quad 95\,\% CI`, (s) => dash(s, () => ci(s.stmtCompiled.length, s.gradable.length))),
    row(String.raw`Reference statement available\tnote{c}`, (s) => `${s.refAvailable.length}/${s.all.length}`),
    row(String.raw`Statement faithful to the reference\tnote{d}`, (s) => dash(s, () => frac(s.faithful.length, s.faithfulPool.length))),
    row(String.raw`\quad 95\,\% CI`, (s) => dash(s, () => ci(s.faithful.length, s.faithfulPool.length))),
    String.raw`\midrule`,
    String.raw`\multicolumn{${1 + MODELS.length}}{@{}l}{\textit{Part B: proof}} \\`,
    row(String.raw`Proof declined in comments\tnote{e}`, (s) => dash(s, () => frac(s.declined.length, s.answered.length))),
    row('Proof file with Lean code', (s) => dash(s, () => frac(s.proofCode.length, s.answered.length))),
    row('Proof file compiles (of files with code)', (s) => dash(s, () => frac(s.proofCompiled.length, s.proofGradable.length))),
    row(String.raw`\textbf{Verified pass@1, main theorem}\tnote{f}`, (s) => dash(s, () => String.raw`\textbf{${frac(s.verified.length, s.verifiedPool.length)}}`)),
    row(String.raw`\quad 95\,\% CI`, (s) => dash(s, () => ci(s.verified.length, s.verifiedPool.length))),
    String.raw`\midrule`,
    row(String.raw`Compile rate as reported by QEDRank\tnote{g}`, (s, m) => dash(s, () => frac(reported(m).num, reported(m).den))),
    String.raw`\midrule`,
    row(String.raw`Mean stated confidence: statement faithful\tnote{h}`, (s) => dash(s, () => confText(s.stmtConf))),
    row(String.raw`Mean stated confidence: proof passes audit\tnote{h}`, (s) => dash(s, () => confText(s.proofConf))),
    row('Median latency per answer', (s) => (isNum(s.medianLatencyS) ? `${s.medianLatencyS.toFixed(1)}\\,s` : '---')),
    row('Median output tokens per answer', (s) => int(s.medianOutput)),
  ].join('\n');
}
const matrixTable = String.raw`% ---------------------------------------------------------------- Table: performance matrix
\begin{table}[!htbp]
\centering
\begin{threeparttable}
\caption{Performance matrix (task: formalize and prove from the paper, pass@1). Rates exclude provider failures and items the grader could not evaluate.}
\label{tab:f-matrix}
\small
\begin{tabular}{@{}l${'r'.repeat(MODELS.length)}@{}}
\toprule
Measure & ${modelCols} \\
\midrule
${pmRows()}
\bottomrule
\end{tabular}
\begin{tablenotes}\footnotesize
\item[a] At least 90\,\% of the answer's non-empty lines repeat an earlier line (Figure~\ref{fig:f-length}).
\item[b] Answered targets whose part A file compiles on its own. Answers without an extractable statement count as failures.
\item[c] Targets whose audited reference statement compiled in the grader's project (Table~\ref{tab:f-refs}); only these can be checked for faithfulness.
\item[d] Denominator: targets with an available reference, excluding provider failures. A statement that does not compile counts as not faithful.
\item[e] The proof file holds only comments stating that no complete proof is given, as the prompt allows when the model cannot prove the claim.
\item[f] Primary endpoint. Denominator: main theorems with an available reference and an established claim, excluding provider failures.
\item[g] QEDRank's own summary figure: part B files that compiled, among answers with a proof file. It counts the comment-only files of note e as compiled; reported for comparison only.
\item[h] The model's own estimates in part D, averaged over answers that stated one.
${silent.length ? String.raw`\item[] ${silent.map((m) => m.label).join(', ')}: no request was answered (Table~\ref{tab:f-outcomes}), so no rate is defined and no comparison between the models is made.` : ''}
\end{tablenotes}
\end{threeparttable}
\end{table}`;

// Table: by target (answering models)
let targetTable = '';
if (answering.length) {
  const measures = [
    ['Targets run', (s) => s.all.length],
    ['Requests failed at the provider', (s) => s.all.length - s.answered.length],
    ['Answered', (s) => s.answered.length],
    ['Answer cut off at the token limit', (s) => s.truncated.length],
    ['Statement extracted', (s) => s.extracted.length],
    ['Statement compiles', (s) => s.stmtCompiled.length],
    ['Reference statement available', (s) => s.refAvailable.length],
    ['Statement faithful', (s) => (s.faithfulPool.length ? `${s.faithful.length}/${s.faithfulPool.length}` : '---')],
    ['Proof declined in comments', (s) => s.declined.length],
    ['Proof file with Lean code', (s) => s.proofCode.length],
    ['Proof file compiles', (s) => s.proofCompiled.length],
    ['Verified (main theorem, eligible)', (s, t) => (t === 'main_theorem' || t === null ? `${s.verified.length}/${s.verifiedPool.length}` : '---')],
  ];
  const rows = [];
  for (const m of answering) {
    if (answering.length > 1) rows.push(String.raw`\addlinespace[2pt]\multicolumn{5}{@{}l}{\textit{${m.label}}} \\`);
    for (const [label, f] of measures) rows.push(String.raw`${label} & ${TARGETS.map((t) => f(ST[m.id][t], t)).join(' & ')} & ${f(S[m.id], null)} \\`);
  }
  targetTable = String.raw`% ---------------------------------------------------------------- Table: by target
\begin{table}[!htbp]
\centering
\caption{Results by target${answering.length === 1 ? ` (${answering[0].label})` : ''}.}
\label{tab:f-targets}
\small
\begin{tabular}{@{}lrrrr@{}}
\toprule
Measure & Main theorem & Upper bound & Lower bound & All \\
\midrule
${rows.join('\n')}
\bottomrule
\end{tabular}
\end{table}`;
}

// Table: per-paper grid (answering models)
let gridTable = '';
if (answering.length) {
  const usedCodes = new Set();
  const cellFor = (m, p, t) => {
    const i = items.find((x) => x.model === m.id && x.paper === p && x.target === t);
    if (!i) return '';
    usedCodes.add(i.cat);
    const mark = i.proofCat === 'p_declined' ? String.raw`\textsuperscript{d}` : i.proofCat === 'p_verified' ? String.raw`\textsuperscript{v}` : '';
    return String.raw`\swatch{${CAT[i.cat].color}}\,\texttt{${CODE[i.cat]}}${mark}`;
  };
  const refMarks = (p) => TARGETS.map((t) => (refs.get(`${p}__${t}`)?.statement_available ? t[0].toUpperCase() : '--')).join('\\,');
  const claim = (p) => items.find((x) => x.paper === p && x.target === 'main_theorem')?.status || '---';
  const head = answering.map(() => 'Main & Upper & Lower').join(' & ');
  const rows = papersRun.map((p) => String.raw`${p} & ${claim(p)} & ${refMarks(p)} & ${answering.map((m) => TARGETS.map((t) => cellFor(m, p, t)).join(' & ')).join(' & ')} \\`);
  const legend = CATS.filter(([id]) => usedCodes.has(id)).map(([id, label]) => `\\texttt{${CODE[id]}} ${label.replace(/^No statement: /, 'no statement, ').replace(/^Statement /, '').replace(/^statement /, '')}`).join('; ');
  gridTable = String.raw`% ---------------------------------------------------------------- Table: per-paper grid
\begin{table}[!htbp]
\centering
\caption{Part A outcome for every paper and target${answering.length === 1 ? ` (${answering[0].label})` : ''}.${silent.length ? ` ${silent.map((m) => m.label).join(', ')} answered no request and is omitted.` : ''}}
\label{tab:f-grid}
\footnotesize
\renewcommand{\arraystretch}{0.92}
\begin{tabular}{@{}lll${'l'.repeat(3 * answering.length)}@{}}
\toprule
${answering.length > 1 ? String.raw` & & & ${answering.map((m) => String.raw`\multicolumn{3}{c}{${m.label}}`).join(' & ')} \\` : ''}
Paper & Main claim & Ref. & ${head} \\
\midrule
${rows.join('\n')}
\bottomrule
\end{tabular}
\par\smallskip\parbox{0.92\linewidth}{\footnotesize ${legend}. \textsuperscript{d}\,proof declined in comments${items.some((i) => i.proofCat === 'p_verified') ? '; \\textsuperscript{v}\\,verified' : ''}. \textit{Ref.}: targets with an available reference statement (M main theorem, U upper bound, L lower bound).}
\end{table}`;
}

// Figure: outcome composition (share of targets)
const bars = [];
for (const m of silent) bars.push({ label: `${m.label} (all ${S[m.id].all.length})`, s: S[m.id] });
for (const m of [...answering].reverse()) for (const t of [...TARGETS].reverse()) bars.push({ label: `${answering.length > 1 ? `${m.label}: ` : ''}${TARGET_LABEL[t]} (${ST[m.id][t].all.length})`, s: ST[m.id][t] });
const fig1Plots = usedCats.map(([id, , color]) => {
  const coords = bars.map((b, idx) => `(${pct(b.s.count[id] / b.s.all.length)},${idx})`).join(' ');
  return String.raw`\addplot[fill=${color}, draw=black!55] coordinates {${coords}};`;
}).join('\n');
const outcomeFigure = String.raw`% ---------------------------------------------------------------- Figure: outcome composition
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  xbar stacked, bar width=12pt, width=0.78\linewidth, height=${(2.4 + 0.75 * bars.length).toFixed(1)}cm,
  xmin=0, xmax=100, xlabel={Share of targets (\%)},
  ytick={${bars.map((_, i) => i).join(',')}}, yticklabels={${bars.map((b) => `{${b.label}}`).join(',')}},
  ymin=-0.6, ymax=${bars.length - 0.4}, y tick label style={font=\small},
  legend style={at={(0.42,-0.30)}, anchor=north, legend columns=2, draw=none, font=\footnotesize,
    /tikz/every even column/.append style={column sep=10pt}},
  legend cell align=left, axis x line*=bottom, axis y line*=left,
]
${fig1Plots}
\legend{${usedCats.map(([, label]) => `{${label}}`).join(',')}}
\end{axis}
\end{tikzpicture}
\caption{Where part A ended, as a share of each group's targets${answering.length === 1 ? ` (${answering[0].label} by target${silent.length ? `; ${silent.map((m) => m.label).join(', ')} over all targets` : ''})` : ''}. Grey: provider failures; the other colours are outcomes attributable to the model (Table~\ref{tab:f-outcomes}).}
\label{fig:f-outcomes}
\end{figure}`;

// Figure: attrition of part A and part B (answering models)
const STAGES = [
  ['Targets\\\\run', (s) => s.all.length, (s) => s.all.length],
  ['Answered', (s) => s.answered.length, (s) => s.answered.length],
  ['Lean code\\\\returned', (s) => s.extracted.length, (s) => s.proofCode.length],
  ['Compiles', (s) => s.stmtCompiled.length, (s) => s.proofCompiled.length],
  ['Accepted', (s) => s.faithful.length, (s) => s.verified.length],
];
const fig2Model = answering[0];
const attritionFigure = !fig2Model ? '' : String.raw`% ---------------------------------------------------------------- Figure: attrition
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  ybar=6pt, bar width=13pt, width=0.85\linewidth, height=6cm, area legend,
  ymin=0, ymax=${Math.ceil((nTargets * 1.18) / 10) * 10}, ylabel={Targets},
  xtick={1,...,${STAGES.length}}, xticklabels={${STAGES.map(([l]) => `{${l}}`).join(',')}},
  xticklabel style={align=center, font=\footnotesize}, enlarge x limits=0.12,
  nodes near coords, every node near coord/.append style={font=\scriptsize},
  legend style={at={(0.98,0.97)}, anchor=north east, draw=none, font=\footnotesize},
  axis x line*=bottom, axis y line*=left,
]
\addplot[fill=qrSorry, draw=black!55] coordinates {${STAGES.map(([, a], j) => `(${j + 1},${a(S[fig2Model.id])})`).join(' ')}};
\addplot[fill=qrStmt, draw=black!55] coordinates {${STAGES.map(([, , b], j) => `(${j + 1},${b(S[fig2Model.id])})`).join(' ')}};
\legend{Part A: statement, Part B: proof file}
\end{axis}
\end{tikzpicture}
\caption{Attrition from request to accepted result for ${fig2Model.label}. \emph{Lean code returned}: a statement could be extracted (part A) or the proof file contains Lean code (part B). \emph{Accepted}: faithful to the reference (part A, ${S[fig2Model.id].faithfulPool.length} eligible targets) or verified (part B, ${S[fig2Model.id].verifiedPool.length} eligible main theorems).}
\label{fig:f-attrition}
\end{figure}`;

// Figure: output length (first answering model)
let histFigure = '';
if (fig2Model) {
  const maxTok = run.settings.max_tokens;
  const binW = 2048;
  const nBins = Math.ceil(maxTok / binW);
  const hist = Array(nBins).fill(0);
  const s = S[fig2Model.id];
  for (const i of s.answered) if (!i.truncated && isNum(i.outputTokens)) hist[Math.min(nBins - 1, Math.floor(i.outputTokens / binW))]++;
  const loops = s.loops.length;
  const otherCut = s.truncated.length - loops;
  const labels = hist.map((_, b) => `${(b * binW) / 1024}--${((b + 1) * binW) / 1024}`).concat(['{limit:\\\\loop}', '{limit:\\\\other}']);
  histFigure = String.raw`% ---------------------------------------------------------------- Figure: output length
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  ybar, bar width=13pt, width=0.92\linewidth, height=5.4cm,
  ymin=0, ylabel={Answers}, xlabel={Output tokens (thousands; one bin per 2{,}048 tokens)},
  xtick={1,...,${nBins + 2}}, xticklabels={${labels.join(',')}}, xticklabel style={font=\footnotesize, align=center},
  nodes near coords, every node near coord/.append style={font=\scriptsize},
  enlarge x limits=0.06, axis x line*=bottom, axis y line*=left,
]
\addplot[fill=qrSorry, draw=black!55, bar shift=0pt] coordinates {${hist.map((c, b) => `(${b + 1},${c})`).join(' ')}};
\addplot[fill=qrCut, draw=black!55, bar shift=0pt] coordinates {(${nBins + 1},${loops})};
\addplot[fill=qrErr, draw=black!55, bar shift=0pt] coordinates {(${nBins + 2},${otherCut})};
\end{axis}
\end{tikzpicture}
\caption{Length of the ${s.answered.length} answers of ${fig2Model.label}. ${s.truncated.length} answers (${pct(s.truncated.length / s.answered.length, 0)}\,\%) reached the ${int(maxTok)}-token limit. In ${loops} of them at least 90\,\% of the lines repeat an earlier line (${s.importLoops.length} repeat \texttt{import} lines); the other ${otherCut} were long answers cut off before they ended.}
\label{fig:f-length}
\end{figure}`;
}

// Figure: first Lean error of statement files that failed (all answering models)
const errItems = items.filter((i) => i.errClass);
const errModels = MODELS.filter((m) => errItems.some((i) => i.model === m.id));
const classes = ERRS.map(([id, label]) => ({
  id, label,
  cut: errItems.filter((i) => i.errClass === id && i.truncated).length,
  full: errItems.filter((i) => i.errClass === id && !i.truncated).length,
})).filter((c) => c.cut + c.full > 0).sort((a, b) => a.cut + a.full - (b.cut + b.full));
const taxFigure = !classes.length ? '' : String.raw`% ---------------------------------------------------------------- Figure: statement error taxonomy
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  xbar stacked, bar width=10pt, width=0.55\linewidth, height=${(1.6 + 0.62 * classes.length).toFixed(1)}cm,
  xmin=0, xlabel={Statement files}, ytick={${classes.map((_, i) => i).join(',')}},
  yticklabels={${classes.map((c) => `{${c.label}}`).join(',')}}, y tick label style={font=\footnotesize},
  ymin=-0.7, ymax=${classes.length - 0.3},
  legend style={at={(0.98,0.03)}, anchor=south east, draw=none, fill=white, font=\footnotesize}, legend cell align=left,
  axis x line*=bottom, axis y line*=left,
]
\addplot[fill=qrErr, draw=black!55] coordinates {${classes.map((c, i) => `(${c.full},${i})`).join(' ')}};
\addplot[fill=qrErr!40, draw=black!55] coordinates {${classes.map((c, i) => `(${c.cut},${i})`).join(' ')}};
\legend{Complete answer, Cut off at limit}
\end{axis}
\end{tikzpicture}
\caption{First Lean error of the ${errItems.length} extracted statements${errModels.length === 1 ? ` of ${errModels[0].label}` : ''} that did not compile. \emph{Unknown identifier} includes names the model used without importing or defining them (Lean's \texttt{autoImplicit} hint).}
\label{fig:f-errors}
\end{figure}`;

// Figure: stated confidence (first answering model)
let confFigure = '';
if (fig2Model && (S[fig2Model.id].stmtConf.length || S[fig2Model.id].proofConf.length)) {
  const s = S[fig2Model.id];
  const bin = (xs) => {
    const h = Array(10).fill(0);
    for (const x of xs) h[Math.min(9, Math.floor(x / 10))]++;
    return h;
  };
  const hs = bin(s.stmtConf);
  const hp = bin(s.proofConf);
  confFigure = String.raw`% ---------------------------------------------------------------- Figure: stated confidence
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  ybar=2pt, bar width=7pt, width=0.92\linewidth, height=5.2cm, area legend,
  ymin=0, ylabel={Answers}, xlabel={Stated confidence (\%)},
  xtick={1,...,10}, xticklabels={0--9,10--19,20--29,30--39,40--49,50--59,60--69,70--79,80--89,90--100}, xticklabel style={font=\footnotesize},
  y filter/.expression={y==0 ? nan : y}, unbounded coords=discard,
  nodes near coords, every node near coord/.append style={font=\scriptsize},
  legend style={at={(0.5,0.97)}, anchor=north, draw=none, font=\footnotesize},
  enlarge x limits=0.06, axis x line*=bottom, axis y line*=left,
]
\addplot[fill=qrSorry, draw=black!55] coordinates {${hs.map((c, b) => `(${b + 1},${c})`).join(' ')}};
\addplot[fill=qrStmt, draw=black!55] coordinates {${hp.map((c, b) => `(${b + 1},${c})`).join(' ')}};
\legend{Statement is faithful (n\,=\,${s.stmtConf.length}), Proof passes the audit (n\,=\,${s.proofConf.length})}
\end{axis}
\end{tikzpicture}
\caption{Confidence that ${fig2Model.label} stated in part D. Of the same answers, ${s.stmtCompiled.length} statements compiled and ${s.proofCompiled.length} proof files with Lean code compiled.}
\label{fig:f-confidence}
\end{figure}`;
}

// Observations and threats to validity
const q = fig2Model ? S[fig2Model.id] : null;
const topErr = [...classes].sort((a, b) => b.cut + b.full - (a.cut + a.full))[0];
const observations = !q ? '' : String.raw`% ---------------------------------------------------------------- Observations (numbers from the tables above)
\subsection*{Observations}
\begin{itemize}\setlength\itemsep{2pt}
\item ${fig2Model.label}: ${q.stmtCompiled.length} of ${q.gradable.length} answered targets produced a statement that compiles (95\,\% CI ${ci(q.stmtCompiled.length, q.gradable.length)}\,\%). For ${q.answered.length - q.extracted.length} answers no statement could be extracted, ${q.count.no_stmt_cutoff} of them because the answer ran into the token limit.
${topErr ? String.raw`\item The most frequent first error of a failed statement is \emph{${topErr.label.toLowerCase()}} (${topErr.cut + topErr.full} of ${errItems.length}): the model used Mathlib names it had not imported, names that do not exist, or notions it never defined.${q.count.stmt_bad_import ? ` ${q.count.stmt_bad_import} statements import a Mathlib module that does not exist.` : ''}` : ''}
\item ${q.declined.length} answers declined the proof in comments, as the prompt allows; ${q.proofCompiled.length} of the ${q.proofGradable.length} proof files with Lean code compiled, and no target was verified (${q.verified.length}/${q.verifiedPool.length} eligible main theorems).
${q.stmtConf.length ? String.raw`\item The model's stated confidence that its statement is faithful averaged ${pct(mean(q.stmtConf) / 100, 0)}\,\% (${q.stmtConf.length} answers), while ${q.stmtCompiled.length} of its statements compiled (Figure~\ref{fig:f-confidence}).` : ''}
\end{itemize}`;

const validity = String.raw`% ---------------------------------------------------------------- Threats to validity (adapt to the paper)
\subsection*{Threats to validity}
\begin{itemize}\setlength\itemsep{2pt}
${usedBenchmarkProject ? '' : String.raw`\item \textbf{Reference statements.} The run was graded in QEDRank's default Lean project rather than the benchmark's pinned project. The model answers were compiled with the toolchain named in the prompt, but ${refTotal.libMissing} of the ${refTotal.found} reference statements import benchmark modules that this project does not contain, and ${refTotal.wrapError} more failed because of a defect in QEDRank's statement wrapper (Table~\ref{tab:f-refs}). Faithfulness can therefore be measured on ${refTotal.available} main theorems at most, and on no upper or lower bound.`}
\item \textbf{No benchmark definitions in the prompt.} ${noDefinitionPrompts.n === noDefinitionPrompts.total ? 'No prompt' : `${noDefinitionPrompts.n} of ${noDefinitionPrompts.total} prompts`} contained the definitions of the benchmark's Lean files, so each model statement introduces its own notions. Even a statement that compiles would rarely be decided equivalent to the reference automatically; expert review would be needed.
\item \textbf{Grader labels corrected.} QEDRank's summary counts ${items.filter((i) => i.proofCat === 'p_declined' && i.graderCompiled).length} comment-only proof files as compiled and labels ${MODELS.map((m) => S[m.id].count.stmt_bad_import).reduce((a, b) => a + b, 0)} statements that import non-existent modules as infrastructure failures. The tables above count them as declined proofs and model errors.
${silent.length ? String.raw`\item \textbf{Provider failures.} ${silent.map((m) => `${m.label} answered none of its ${S[m.id].all.length} requests: ${[S[m.id].count.rate_limit ? `${S[m.id].count.rate_limit} were refused because the account allows one concurrent request` : '', S[m.id].count.quota ? `${S[m.id].count.quota} because the account was suspended for insufficient balance` : '', S[m.id].count.timeout ? `${S[m.id].count.timeout} timed out` : ''].filter(Boolean).join(', ')}`).join('; ')}. No comparison between models is possible from this run.` : ''}
${q ? String.raw`\item \textbf{Decoding.} ${fig2Model.label} ran at temperature ${q.temperature}. ${q.truncated.length} of ${q.answered.length} answers reached the token limit, ${q.loops.length} of them in a repetition loop. Its model card recommends temperature 0.7, top-p 0.8 and top-k 20, and a presence penalty between 0 and 2 to reduce endless repetitions; the output budget matches the 16{,}384 tokens it recommends. A rerun with the recommended sampling settings may change the extraction and compile rates.` : ''}
\item \textbf{Single attempt.} One request per target, without repair rounds or tools; pass@$k$ and repair success are not measured. ${diffCount.Research || 0} of the ${papersRun.length} papers are labelled research-level${papersRun.length - (diffCount.Research || 0) ? ` and ${papersRun.length - (diffCount.Research || 0)} unlabelled` : ''}, so the run says nothing about easier problems.
\item \textbf{Contamination.} Neither provider states a training cutoff and the problems' publication dates are not recorded, so prior exposure cannot be assessed.
\end{itemize}`;

const tex = String.raw`% Performance matrix for QEDRank formalize run ${run.run_id}
% Generated by paper/make-tex-formalize.cjs from the run's item and reference records on ${new Date().toISOString().slice(0, 10)}.
% Rebuild after a re-grade:  node paper/make-tex-formalize.cjs runs/<run-id> paper/performance-matrix-formalize.tex
%
% Each table and figure below is self-contained: copy the environments you need into the paper and
% add these packages and colours to its preamble.
\documentclass[11pt]{article}
\usepackage[a4paper,margin=2.2cm]{geometry}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{booktabs}
\usepackage{tabularx}
\usepackage{array}
\usepackage{threeparttable}
\usepackage[font=small,labelfont=bf]{caption}
\usepackage{xcolor}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
${colourDefs}
\newcommand{\swatch}[1]{\textcolor{#1}{\rule{0.75em}{0.75em}}}

\begin{document}

\section*{Pilot evaluation, formalize task: performance matrix}
Run \texttt{${tt(run.run_id)}}: ${papersRun.length} ProofBench papers, ${nTargets} targets per model, task \emph{formalize and prove from the paper}, ${MODELS.length} models.

${setupTable}

${refsTable}

${outcomeTable}

${outcomeFigure}

${matrixTable}

${attritionFigure}

${targetTable}

${gridTable}

${histFigure}

${taxFigure}

${confFigure}

\clearpage
${observations}

${validity}

\end{document}
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, tex.replace(/\n{3,}/g, '\n\n'));

// Short report of the computed numbers for checking.
for (const m of MODELS) {
  const s = S[m.id];
  console.log(m.label, JSON.stringify({
    statement: Object.fromEntries(Object.entries(s.count).filter(([, v]) => v)),
    proof: Object.fromEntries(Object.entries(s.pcount).filter(([, v]) => v)),
    answered: s.answered.length, extracted: s.extracted.length, stmtCompiled: `${s.stmtCompiled.length}/${s.gradable.length}`,
    faithful: `${s.faithful.length}/${s.faithfulPool.length}`, proofCode: s.proofCode.length, proofCompiled: s.proofCompiled.length,
    verified: `${s.verified.length}/${s.verifiedPool.length}`, truncated: s.truncated.length, loops: s.loops.length, importLoops: s.importLoops.length,
    meanStmtConf: mean(s.stmtConf), meanProofConf: mean(s.proofConf),
  }));
}
console.log('references:', JSON.stringify(refTotal), JSON.stringify(libImports));
console.log('error classes:', JSON.stringify(classes));
console.log('prompts without definitions:', JSON.stringify(noDefinitionPrompts));
console.log('wrote', outFile);

// ---------------------------------------------------------------- helpers

function readJson(f) {
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
function shortLabel(m) {
  const l = m.label || m.display_name || m.id;
  return l.replace(/\s+Instruct$/, '').replace(/^Qwen3 (\d)/, 'Qwen3-$1');
}
function tt(s) {
  return String(s).replace(/\\/g, '\\textbackslash{}').replace(/([_#%&$])/g, '\\$1').replace(/~/g, '\\textasciitilde{}');
}
