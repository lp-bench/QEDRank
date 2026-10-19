#!/usr/bin/env node
// Builds the LaTeX performance matrix (tables and pgfplots figures) for one QEDRank prove run.
// Every number is computed from the run's item records, so the file can be rebuilt after a re-grade.
//
//   node paper/make-tex.cjs <run-dir> [out.tex]
//
// Outcomes the model is not responsible for are kept apart from model outcomes:
//   provider failures (timeout, HTTP 429) and grader configuration failures (the problem's own
//   library missing from the grader's search path, or the import policy rejecting an import that
//   the challenge file itself contains). Rates are computed over model-attributable outcomes only.
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node paper/make-tex.cjs <run-dir> [out.tex]');
  process.exit(2);
}
const outFile = process.argv[3] || path.join(__dirname, 'performance-matrix.tex');

// Facts about the benchmark repository at the evaluated commit (lean-toolchain and lakefile.toml).
const BENCHMARK_PIN = { lean: 'v4.33.1', mathlib: 'v4.33.1', matroid: 'fa6c155', options: 'maxSynthPendingDepth = 3' };

const summary = readJson(path.join(runDir, 'summary.json'));
const exported = readJson(path.join(runDir, 'exports', 'items.json'));
const difficultyOf = new Map(exported.items.map((i) => [i.item_key, i.difficulty]));

if (summary.settings.repair_rounds !== 0) {
  throw new Error('this generator covers runs without repair rounds');
}
// Attempts per problem. The main tables use attempt 1 (pass@1 as in a single-attempt run); with
// K > 1 a pass@k section adds the unbiased pass@k over all K attempts.
const K = summary.settings.k || 1;

const records = [];
for (const key of fs.readdirSync(path.join(runDir, 'items')).sort()) {
  const file = path.join(runDir, 'items', key, 'attempt-a1r0.json');
  if (fs.existsSync(file)) records.push(readJson(file));
}

const MODELS = summary.models.map((m) => ({ id: m.id, label: shortLabel(m), facts: m.facts || {}, host: m.host, modelId: m.model_id }));

// ---------------------------------------------------------------- classification

const CATS = [
  // id, label, colour, group
  ['timeout', 'Request timed out (300 s)', 'qrTimeout', 'provider'],
  ['rate_limit', 'Rate limited (HTTP 429)', 'qrRate', 'provider'],
  ['provider_other', 'Other provider error', 'qrRate', 'provider'],
  ['abstained', 'Abstained (no Lean file returned)', 'qrAbst', 'model'],
  ['grader_env', 'Problem library missing from grader', 'qrEnv', 'grader'],
  ['grader_import', 'Challenge import rejected by policy', 'qrImp', 'grader'],
  ['grader_other', 'Other grader error', 'qrImp', 'grader'],
  ['screen_rejected', 'Rejected by static screen', 'qrScreen', 'model'],
  ['compile_error', 'Lean compile error', 'qrErr', 'model'],
  ['compile_timeout', 'Lean compile time limit reached', 'qrErr', 'model'],
  ['statement_changed', 'Compiled; target statement changed or absent', 'qrStmt', 'model'],
  ['sorry', 'Compiled; proof contains \\texttt{sorry}', 'qrSorry', 'model'],
  ['compiled_other', 'Compiled; non-standard axiom or replay failure', 'qrAx', 'model'],
  ['verified', 'Verified', 'qrOk', 'model'],
];
const CAT = Object.fromEntries(CATS.map(([id, label, color, group]) => [id, { id, label, color, group }]));

const MISSING_MODULE = /unknown module prefix|unknown package|object file .* does not exist|No directory '.*' or file/;

function firstError(r) {
  const line = String(r.compiler_output || '').split('\n').map((s) => s.trim()).find((l) => /(^|:\s?)error:/.test(l));
  return line ? line.replace(/^.*?error:\s*/, '') : '';
}

function classify(r) {
  // The grader itself could not judge the answer (its environment cannot compile the challenge).
  if (r.grade?.verdict === 'grader_error') return (r.grade.reasons || []).includes('challenge_import_unavailable') ? 'grader_env' : 'grader_other';
  if (r.outcomes?.infrastructure_failure) {
    const e = r.generation?.error || {};
    const kind = typeof e === 'string' ? e.split(':')[0] : e.kind;
    if (kind === 'timeout') return 'timeout';
    if (kind === 'rate_limited' || e.http_status === 429) return 'rate_limit';
    if (kind === 'challenge_does_not_compile') return 'grader_env';   // not sent to the model
    return 'provider_other';
  }
  if (r.abstained) return 'abstained';
  const status = r.compile?.status;
  if (status === 'rejected_by_static_screen') {
    const imp = r.grade?.checks?.imports || {};
    const challenge = new Set(imp.challenge || []);
    const disallowed = imp.disallowed || [];
    const ownImports = (imp.extra || []).length === 0 && disallowed.length > 0 && disallowed.every((m) => challenge.has(m));
    return ownImports ? 'grader_import' : 'screen_rejected';
  }
  if (status === 'compiler_failure') return MISSING_MODULE.test(firstError(r)) ? 'grader_env' : 'compile_error';
  if (status === 'timeout') return 'compile_timeout';
  if (status === 'compiler_success') {
    if (r.grade?.verdict === 'solved') return 'verified';
    const reasons = r.grade?.reasons || [];
    if (reasons.includes('target_missing') || r.statement_match === 'different') return 'statement_changed';
    if (reasons.includes('contains_sorry')) return 'sorry';
    return 'compiled_other';
  }
  throw new Error(`${r.item_key}: unclassified outcome (compile status ${status})`);
}

// First Lean error of a model-attributable compile failure.
const ERRS = [
  ['outdated', 'Outdated syntax or unknown tactic', /Unknown identifier `begin`|unknown tactic|Unknown identifier `(nat|int|real|finset|set)\.|unexpected token 'in'/],
  ['unknown', 'Unknown identifier, constant or field', /Unknown identifier|Unknown constant|does not contain|Invalid field `/],
  ['unsolved', 'Unsolved goals', /unsolved goals/],
  ['mismatch', 'Type mismatch', /Type mismatch|Application type mismatch|Invalid field notation/],
  ['typeclass', 'Type-class synthesis failure', /failed to synthesize|typeclass instance problem is stuck/],
  ['tactic', 'Other tactic or elaboration error', /Tactic `|No goals to be solved|Alternative `|cannot omit referenced/],
  ['syntax', 'Parse error', /unexpected token|expected/],
  ['other', 'Other', /[\s\S]*/],
];
const errorClass = (msg) => ERRS.find(([, , re]) => re.test(msg))[0];

function difficultyGroup(d) {
  if (!d) return 'Unlabelled';
  if (d.startsWith('Calibration')) return 'Calibration';
  if (d.startsWith('Research (open until')) return 'Research, settled Oct 2026';
  if (d === 'Research') return 'Research';
  if (d === 'Undergraduate') return 'Undergraduate';
  if (d === 'Open') return 'Open';
  return d;
}
const GROUP_ORDER = ['Calibration', 'Undergraduate', 'Research', 'Research, settled Oct 2026', 'Open', 'Unlabelled'];

const items = records.map((r) => {
  const cat = classify(r);
  return {
    key: r.item_key,
    paper: r.paper_id,
    model: r.provider,
    cat,
    group: CAT[cat].group,
    established: r.mathematical_status === 'established',
    status: r.mathematical_status,
    truncated: Boolean(r.generation?.truncated),
    latencyMs: r.outcomes?.infrastructure_failure ? null : r.generation?.observed_latency_ms ?? null,
    outputTokens: r.outcomes?.infrastructure_failure ? null : r.generation?.usage?.outputTokens ?? null,
    temperature: r.generation?.temperature,
    err: cat === 'compile_error' ? firstError(r) : null,
    errClass: cat === 'compile_error' ? errorClass(firstError(r)) : null,
    difficulty: difficultyGroup(difficultyOf.get(r.item_key)),
    statementMatch: r.statement_match,
    axioms: r.audit?.axioms || [],
    reasons: r.grade?.reasons || [],
    leanProject: r.grade?.toolchain?.lean_project || null,
  };
});

const COMPILED = new Set(['statement_changed', 'sorry', 'compiled_other', 'verified']);
const KEPT = new Set(['sorry', 'compiled_other', 'verified']);

function stats(model) {
  const all = items.filter((i) => i.model === model);
  const n = (pred) => all.filter(pred).length;
  const count = Object.fromEntries(CATS.map(([id]) => [id, n((i) => i.cat === id)]));
  const answered = all.filter((i) => i.group !== 'provider');
  const fileReturned = answered.filter((i) => i.cat !== 'abstained');
  const graded = fileReturned.filter((i) => i.group === 'model');
  const compiled = graded.filter((i) => COMPILED.has(i.cat));
  const modelOutcomes = all.filter((i) => i.group === 'model'); // abstentions included
  const verifiedPool = modelOutcomes.filter((i) => i.established);
  const rawCompilePool = answered.filter((i) => i.cat !== 'abstained');
  const rawVerifiedPool = all.filter((i) => i.established && i.group !== 'provider');
  return {
    all, count, answered, fileReturned, graded, compiled,
    kept: compiled.filter((i) => KEPT.has(i.cat)),
    verified: graded.filter((i) => i.cat === 'verified'),
    verifiedPool,
    rawCompile: { k: rawCompilePool.filter((i) => COMPILED.has(i.cat)).length, n: rawCompilePool.length },
    rawVerified: { k: rawVerifiedPool.filter((i) => i.cat === 'verified').length, n: rawVerifiedPool.length },
    truncated: answered.filter((i) => i.truncated),
    medianLatencyS: median(answered.map((i) => i.latencyMs).filter(isNum)) / 1000,
    medianOutput: median(answered.map((i) => i.outputTokens).filter(isNum)),
    temperature: answered.some((i) => i.temperature === null || i.temperature === undefined) ? 'set by the provider' : String(answered[0]?.temperature ?? summary.settings.temperature),
  };
}
const S = Object.fromEntries(MODELS.map((m) => [m.id, stats(m.id)]));

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

// ---------------------------------------------------------------- document

const run = summary.run;
const cov = summary.coverage;
const ms = cov.mathematical_status.main_theorem || {};
const nProblems = cov.papers_discovered;
const leanProjects = [...new Set(items.map((i) => i.leanProject).filter(Boolean))];
const leanProjectName = leanProjects.map((p) => path.basename(p)).join(', ') || 'unknown';
const usedBenchmarkProject = leanProjects.every((p) => /proofbench/i.test(p));
const graderMismatch = !usedBenchmarkProject;

const colourDefs = String.raw`\definecolor{qrTimeout}{RGB}{110,110,110}
\definecolor{qrRate}{RGB}{175,175,175}
\definecolor{qrAbst}{RGB}{86,180,233}
\definecolor{qrEnv}{RGB}{230,159,0}
\definecolor{qrImp}{RGB}{240,228,66}
\definecolor{qrScreen}{RGB}{153,153,51}
\definecolor{qrErr}{RGB}{213,94,0}
\definecolor{qrStmt}{RGB}{204,121,167}
\definecolor{qrSorry}{RGB}{0,114,178}
\definecolor{qrAx}{RGB}{100,50,120}
\definecolor{qrOk}{RGB}{0,158,115}`;

const [A, B] = MODELS; // table columns in summary order
const modelCols = MODELS.map((m) => m.label).join(' & ');

// Table 1: setup
const modelRows = MODELS.map((m) => {
  const f = m.facts;
  const size = isNum(f.parameters_b) ? `${fmtB(f.parameters_b)} parameters${isNum(f.active_parameters_b) ? `, ${fmtB(f.active_parameters_b)} active (mixture of experts)` : ''}` : 'size not published';
  return String.raw`\textbf{${m.label}}: \texttt{${tt(m.modelId)}} via \texttt{${tt(m.host)}}; ${size}; released ${f.released || 'unknown'}; temperature ${S[m.id].temperature}${S[m.id].temperature === 'set by the provider' ? '' : samplingText()}.`;
}).join(String.raw`\newline `);

const setupTable = String.raw`% ---------------------------------------------------------------- Table: setup
\begin{table}[!htbp]
\centering
\caption{Evaluation setup of run \texttt{${tt(run.run_id)}}.}
\label{tab:setup}
\small
\begin{tabularx}{\linewidth}{@{}>{\raggedright\arraybackslash}p{2.4cm}>{\raggedright\arraybackslash}X@{}}
\toprule
Corpus & \texttt{${tt(run.source.repo)}} at commit \texttt{${short(run.source.commit)}} (${String(run.source.commit_date || '').slice(0, 10)}): ${nProblems} problems with a main-theorem target; claim status ${ms.established || 0} established, ${ms.open || 0} open, ${ms.uncertain || 0} uncertain. The ${cov.targets_discovered.disproof || 0} disproof variants were not evaluated. \\
Task & Prove the given statement: the model receives the challenge file, whose main theorem ends in a single \texttt{sorry}, and must return the completed file with the statement and all definitions unchanged. \\
Protocol & ${K > 1 ? String.raw`${K} independent requests per problem (pass@1 in Tables~\ref{tab:outcomes} and~\ref{tab:matrix} uses the first; pass@$k$ in Table~\ref{tab:passk} uses all ${K})` : 'One request per problem (pass@1)'}, no repair rounds, no tools or retrieval; prompt template \texttt{${tt(run.prompt_template_version)}}. \\
Models & ${modelRows} \\
Budgets & ${int(run.settings.max_tokens)} output tokens and ${run.settings.generation_timeout_ms / 1000}\,s per request. \\
Grader & Lean ${tt(String(run.toolchain.toolchain).replace(/^.*:/, ''))}, Mathlib \texttt{${short(run.toolchain.mathlib?.rev)}}; ${int(run.settings.lean.maxHeartbeats)} heartbeats, ${run.settings.lean.timeoutMs / 1000}\,s and ${run.settings.lean.memoryMb / 1024}\,GB per compilation. A solution counts as verified when it compiles, contains no \texttt{sorry}, keeps the main theorem and every challenge definition unchanged as compiled declarations, uses only \texttt{propext}, \texttt{Classical.choice} and \texttt{Quot.sound}, and replays through the kernel.${graderMismatch ? String.raw`\textsuperscript{a}` : ''} \\
Harness & QEDRank commit \texttt{${tt(run.harness.short)}}${run.harness.dirty ? ' (uncommitted changes)' : ''}; total wall-clock time ${(run.batch_wall_clock_ms / 3.6e6).toFixed(1)}\,h. \\
Statistics & Exact two-sided 95\,\% Clopper--Pearson intervals. Each problem contributes one item, so clustering by paper does not change the intervals. \\
\bottomrule
\end{tabularx}
${graderMismatch ? String.raw`\par\smallskip\parbox{\linewidth}{\footnotesize \textsuperscript{a}\,This run was graded in the QEDRank default Lean project (\texttt{${tt(leanProjectName)}}). The benchmark pins Lean ${BENCHMARK_PIN.lean}, Mathlib ${BENCHMARK_PIN.mathlib}, the Matroid library at \texttt{${BENCHMARK_PIN.matroid}} and the option \texttt{${tt(BENCHMARK_PIN.options)}}, and its problem library \texttt{ProofBench.Mathlib\_Problems} was not on the grader's search path.}` : ''}
\end{table}`;

// Table 2: outcome breakdown
const usedCats = CATS.filter(([id]) => id === 'verified' || MODELS.some((m) => S[m.id].count[id] > 0));
const groupTitle = { provider: 'Provider', grader: 'Grader configuration (not attributable to the model)', model: 'Model' };
let outcomeRows = '';
for (const g of ['provider', 'grader', 'model']) {
  const cats = usedCats.filter(([, , , grp]) => grp === g);
  if (!cats.length) continue;
  outcomeRows += String.raw`\addlinespace[2pt]\multicolumn{${1 + MODELS.length}}{@{}l}{\textit{${groupTitle[g]}}} \\` + '\n';
  for (const [id, label, color] of cats) {
    const cells = MODELS.map((m) => {
      const k = S[m.id].count[id];
      const extra = id === 'compile_error' && k ? String.raw` \,{\footnotesize(${S[m.id].all.filter((i) => i.cat === id && i.truncated).length} cut off)}` : '';
      return `${k} (${pct(k / S[m.id].all.length)}\\,\\%)${extra}`;
    }).join(' & ');
    outcomeRows += String.raw`\quad\swatch{${color}}\,${label} & ${cells} \\` + '\n';
  }
}
const outcomeTable = String.raw`% ---------------------------------------------------------------- Table: outcome breakdown
\begin{table}[!htbp]
\centering
\caption{Outcome of every request, by model (${nProblems} problems each). Categories are mutually exclusive; each item is assigned to the first step at which it stopped.}
\label{tab:outcomes}
\small
\begin{tabular}{@{}l${'r'.repeat(MODELS.length)}@{}}
\toprule
Outcome & ${modelCols} \\
\midrule
${outcomeRows}\midrule
Total & ${MODELS.map((m) => S[m.id].all.length).join(' & ')} \\
\bottomrule
\end{tabular}
\par\smallskip\parbox{0.92\linewidth}{\footnotesize \textit{Cut off}: the answer reached the ${int(run.settings.max_tokens)}-token output limit before it ended. \textit{Problem library missing}: the challenge imports \texttt{ProofBench.Mathlib\_Problems}, which the grader's Lean project did not contain. \textit{Challenge import rejected}: the import policy rejected an import that the challenge file itself contains (the Matroid library, \texttt{Archive}, or another problem's module); the model added no import.}
\end{table}`;

// Table 3: performance matrix
function pmRows() {
  const row = (label, f) => String.raw`${label} & ${MODELS.map((m) => f(S[m.id], m)).join(' & ')} \\`;
  const v = (s) => ({ k: s.verified.length, n: s.verifiedPool.length });
  const comp = (s) => ({ k: s.compiled.length, n: s.graded.length });
  return [
    row('Problems run', (s) => s.all.length),
    row('Requests timed out', (s) => s.count.timeout),
    row('Requests refused (HTTP 429)', (s) => s.count.rate_limit),
    ...(MODELS.some((m) => S[m.id].count.provider_other) ? [row('Other provider errors', (s) => s.count.provider_other)] : []),
    row('Answered', (s) => s.answered.length),
    row(String.raw`Abstained\tnote{b}`, (s) => frac(s.count.abstained, s.answered.length)),
    row('Answer cut off at token limit', (s) => frac(s.truncated.length, s.answered.length)),
    row(String.raw`Not gradable (grader configuration)\tnote{a}`, (s) => s.count.grader_env + s.count.grader_import + s.count.grader_other),
    row('Graded proof attempts', (s) => s.graded.length),
    String.raw`\midrule`,
    row(String.raw`Compile rate\tnote{c}`, (s) => frac(comp(s).k, comp(s).n)),
    row(String.raw`\quad 95\,\% CI`, (s) => ci(comp(s).k, comp(s).n)),
    row('Statement unchanged (of compiled)', (s) => frac(s.kept.length, s.compiled.length)),
    row(String.raw`No \texttt{sorry}, standard axioms (of compiled)`, (s) => frac(s.compiled.filter((i) => i.cat === 'verified').length, s.compiled.length)),
    row(String.raw`\textbf{Verified pass@1}\tnote{d}`, (s) => String.raw`\textbf{${frac(v(s).k, v(s).n)}}`),
    row(String.raw`\quad 95\,\% CI`, (s) => ci(v(s).k, v(s).n)),
    String.raw`\midrule`,
    row(String.raw`Compile rate, as graded\tnote{e}`, (s) => frac(s.rawCompile.k, s.rawCompile.n)),
    row(String.raw`Verified pass@1, as graded\tnote{e}`, (s) => frac(s.rawVerified.k, s.rawVerified.n)),
    String.raw`\midrule`,
    row('Median latency per answer', (s) => (isNum(s.medianLatencyS) ? `${s.medianLatencyS.toFixed(1)}\\,s` : '---')),
    row('Median output tokens per answer', (s) => int(s.medianOutput)),
  ].join('\n');
}
const kimiLike = MODELS.find((m) => S[m.id].count.timeout + S[m.id].count.rate_limit > S[m.id].all.length / 2);
const matrixTable = String.raw`% ---------------------------------------------------------------- Table: performance matrix
\begin{table}[!htbp]
\centering
\begin{threeparttable}
\caption{Performance matrix on the main theorems (task: prove the given statement, pass@1). Rates exclude provider failures and items the grader could not evaluate.}
\label{tab:matrix}
\small
\begin{tabular}{@{}l${'r'.repeat(MODELS.length)}@{}}
\toprule
Measure & ${modelCols} \\
\midrule
${pmRows()}
\bottomrule
\end{tabular}
\begin{tablenotes}\footnotesize
\item[a] The grader could not evaluate the answer: the problem library was missing from its Lean project, or its import policy rejected an import of the challenge file itself (Table~\ref{tab:outcomes}). These items are excluded from every rate.
\item[b] Answered without a Lean file. A Lean file that leaves the \texttt{sorry} in place is counted as compiled with \texttt{sorry}, not as an abstention.
\item[c] Graded attempts whose file compiled without errors. A compiling file is not a success.
\item[d] Compiles, contains no \texttt{sorry}, keeps the main theorem and all challenge definitions unchanged as compiled declarations, depends only on the standard axioms, and replays through the kernel. Denominator: problems whose claim is established, excluding provider failures and items that could not be graded; abstentions count as failures.
\item[e] The grader's own figures, before items it could not evaluate are removed; reported for comparison only.
${kimiLike ? String.raw`\item[] ${kimiLike.label}: the ${S[kimiLike.id].answered.length} answered problems are those that finished within the time limit before the rate limit set in, so its abstention rate is not representative. No comparison between the models is made.` : ''}
\end{tablenotes}
\end{threeparttable}
\end{table}`;

// Figure 1: outcome composition
const yOrder = [...MODELS].reverse(); // first model on top
const fig1Plots = usedCats.map(([id, label, color]) => {
  const coords = yOrder.map((m, idx) => `(${S[m.id].count[id]},${idx})`).join(' ');
  return String.raw`\addplot[fill=${color}, draw=black!55] coordinates {${coords}};`;
}).join('\n');
const fig1Legend = usedCats.map(([, label]) => `{${label}}`).join(',');
const outcomeFigure = String.raw`% ---------------------------------------------------------------- Figure: outcome composition
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  xbar stacked, bar width=15pt, width=0.8\linewidth, height=4.4cm,
  xmin=0, xmax=${nProblems}, xlabel={Problems (of ${nProblems})},
  ytick={${yOrder.map((_, i) => i).join(',')}}, yticklabels={${yOrder.map((m) => m.label).join(',')}},
  ymin=-0.6, ymax=${yOrder.length - 0.4}, y tick label style={font=\small},
  legend style={at={(0.5,-0.52)}, anchor=north, legend columns=2, draw=none, font=\footnotesize,
    /tikz/every even column/.append style={column sep=10pt}},
  legend cell align=left, axis x line*=bottom, axis y line*=left,
]
${fig1Plots}
\legend{${fig1Legend}}
\end{axis}
\end{tikzpicture}
\caption{Where each request ended. Grey: provider failures; orange and yellow: answers the grader could not evaluate because of its configuration; the remaining colours are outcomes attributable to the model (Table~\ref{tab:outcomes}).}
\label{fig:outcomes}
\end{figure}`;

// Figure 2: funnel
const FUNNEL = [
  ['Problems\\\\run', (s) => s.all.length],
  ['Answered', (s) => s.answered.length],
  ['Lean file\\\\returned', (s) => s.fileReturned.length],
  ['Graded', (s) => s.graded.length],
  ['Compiled', (s) => s.compiled.length],
  ['Statement\\\\unchanged', (s) => s.kept.length],
  ['Verified', (s) => s.verified.length],
];
const fig2Plots = MODELS.map((m, idx) => {
  const coords = FUNNEL.map(([, f], j) => `(${j + 1},${f(S[m.id])})`).join(' ');
  return String.raw`\addplot[fill=${idx === 0 ? 'qrRate' : 'qrSorry'}, draw=black!55] coordinates {${coords}};`;
}).join('\n');
const funnelFigure = String.raw`% ---------------------------------------------------------------- Figure: funnel
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  ybar=7pt, bar width=10pt, width=0.9\linewidth, height=6cm, area legend,
  ymin=0, ymax=${Math.ceil((nProblems * 1.18) / 10) * 10}, ylabel={Problems},
  xtick={1,...,${FUNNEL.length}}, xticklabels={${FUNNEL.map(([l]) => `{${l}}`).join(',')}},
  xticklabel style={align=center, font=\footnotesize}, enlarge x limits=0.08,
  nodes near coords, every node near coord/.append style={font=\scriptsize},
  legend style={at={(0.98,0.97)}, anchor=north east, draw=none, font=\footnotesize},
  axis x line*=bottom, axis y line*=left,
]
${fig2Plots}
\legend{${MODELS.map((m) => m.label).join(',')}}
\end{axis}
\end{tikzpicture}
\caption{Attrition from request to verified proof. \emph{Graded} counts the returned files that the grader could evaluate; the drop from \emph{Lean file returned} to \emph{Graded} is caused by the grader configuration, not by the model.}
\label{fig:funnel}
\end{figure}`;

// Figure 3: output length (models with truncated answers)
const histModel = MODELS.find((m) => S[m.id].truncated.length > 0) || MODELS[MODELS.length - 1];
const maxTok = run.settings.max_tokens;
const binW = 2048;
const nBins = Math.ceil(maxTok / binW);
const hist = Array(nBins).fill(0);
let capped = 0;
for (const i of S[histModel.id].answered) {
  if (i.truncated) { capped++; continue; }
  if (!isNum(i.outputTokens)) continue;
  hist[Math.min(nBins - 1, Math.floor(i.outputTokens / binW))]++;
}
const histLabels = hist.map((_, b) => `${(b * binW) / 1024}--${((b + 1) * binW) / 1024}`).concat(['limit']);
const histFigure = String.raw`% ---------------------------------------------------------------- Figure: output length
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  ybar, bar width=14pt, width=0.9\linewidth, height=5.2cm,
  ymin=0, ylabel={Answers}, xlabel={Output tokens (thousands; one bin per 2{,}048 tokens)},
  xtick={1,...,${nBins + 1}}, xticklabels={${histLabels.join(',')}}, xticklabel style={font=\footnotesize},
  nodes near coords, every node near coord/.append style={font=\scriptsize},
  enlarge x limits=0.07, axis x line*=bottom, axis y line*=left,
]
\addplot[fill=qrSorry, draw=black!55, bar shift=0pt] coordinates {${hist.map((c, b) => `(${b + 1},${c})`).join(' ')}};
\addplot[fill=qrErr, draw=black!55, bar shift=0pt] coordinates {(${nBins + 1},${capped})};
\end{axis}
\end{tikzpicture}
\caption{Length of the ${S[histModel.id].answered.length} answers of ${histModel.label}. ${capped} answers (${pct(capped / S[histModel.id].answered.length, 0)}\,\%, right) reached the ${int(maxTok)}-token limit and were cut off before they ended.}
\label{fig:length}
\end{figure}`;

// Figure 4: failure taxonomy of model-attributable compile errors
const errItems = items.filter((i) => i.cat === 'compile_error');
const errModels = MODELS.filter((m) => errItems.some((i) => i.model === m.id));
const taxModel = errModels.length === 1 ? errModels[0] : null;
const errPool = taxModel ? errItems.filter((i) => i.model === taxModel.id) : errItems;
const classes = ERRS.map(([id, label]) => ({
  id, label,
  cut: errPool.filter((i) => i.errClass === id && i.truncated).length,
  full: errPool.filter((i) => i.errClass === id && !i.truncated).length,
})).filter((c) => c.cut + c.full > 0).sort((a, b) => a.cut + a.full - (b.cut + b.full));
const taxFigure = !classes.length ? '' : String.raw`% ---------------------------------------------------------------- Figure: compile-error taxonomy
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  xbar stacked, bar width=10pt, width=0.55\linewidth, height=${(1.6 + 0.62 * classes.length).toFixed(1)}cm,
  xmin=0, xlabel={Answers}, ytick={${classes.map((_, i) => i).join(',')}},
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
\caption{First Lean error of the ${errPool.length} graded attempts${taxModel ? ` of ${taxModel.label}` : ''} that failed to compile. Most \emph{unsolved goals} come from answers cut off at the token limit, where the proof stops mid-tactic.}
\label{fig:errors}
\end{figure}`;

// Table 4: by difficulty (models with graded attempts)
const diffModels = MODELS.filter((m) => S[m.id].graded.length > 0);
let diffTable = '';
if (diffModels.length) {
  const groups = GROUP_ORDER.filter((g) => items.some((i) => i.difficulty === g)).concat([...new Set(items.map((i) => i.difficulty))].filter((g) => !GROUP_ORDER.includes(g)));
  const rows = [];
  for (const m of diffModels) {
    if (diffModels.length > 1) rows.push(String.raw`\addlinespace[2pt]\multicolumn{7}{@{}l}{\textit{${m.label}}} \\`);
    for (const g of groups) {
      const gi = S[m.id].all.filter((i) => i.difficulty === g);
      if (!gi.length) continue;
      const graded = gi.filter((i) => i.group === 'model' && i.cat !== 'abstained');
      rows.push(String.raw`${g} & ${gi.length} & ${gi.filter((i) => i.established).length} & ${gi.filter((i) => i.group === 'grader').length} & ${graded.length} & ${graded.filter((i) => COMPILED.has(i.cat)).length} & ${graded.filter((i) => i.cat === 'verified').length} \\`);
    }
  }
  diffTable = String.raw`% ---------------------------------------------------------------- Table: by difficulty
\begin{table}[!htbp]
\centering
\caption{Results by the benchmark's difficulty label${diffModels.length === 1 ? ` (${diffModels[0].label}${MODELS.length > 1 ? '; the other model has no graded attempts' : ''})` : ''}.}
\label{tab:difficulty}
\small
\begin{tabular}{@{}lrrrrrr@{}}
\toprule
Difficulty label & Problems & Established & Not gradable & Graded & Compiled & Verified \\
\midrule
${rows.join('\n')}
\bottomrule
\end{tabular}
\par\smallskip\parbox{0.9\linewidth}{\footnotesize \textit{Calibration} merges the benchmark's calibration labels (elementary to upper-end, with or without a Lean reference proof). \textit{Research, settled Oct 2026}: open until October 2026 and settled by a Lean-checked result announced on 6 October 2026 that had not been independently verified when the run was made.}
\end{table}`;
}

// Table 5: compiled answers
const compiledItems = items.filter((i) => COMPILED.has(i.cat)).sort((a, b) => a.key.localeCompare(b.key));
const stmtText = (i) => (i.reasons.includes('target_missing') ? 'main theorem absent' : i.statementMatch === 'definitionally_identical' ? 'identical' : i.statementMatch === 'syntactically_identical' ? 'identical' : tt(String(i.statementMatch || '---').replace(/_/g, ' ')));
const axText = (i) => (i.axioms.length ? i.axioms.map((a) => String.raw`\texttt{${tt(a)}}`).join(', ') : '---');
const compiledTable = !compiledItems.length ? '' : String.raw`% ---------------------------------------------------------------- Table: compiled answers
\begin{table}[!htbp]
\centering
\caption{Every graded answer that compiled, and why none was verified.}
\label{tab:compiled}
\small
\begin{tabular}{@{}lll>{\raggedright\arraybackslash}p{4.6cm}l@{}}
\toprule
Problem & Model & Claim & Axioms of the main theorem & Outcome \\
\midrule
${compiledItems.map((i) => String.raw`${i.paper} & ${MODELS.find((m) => m.id === i.model).label} & ${i.status} & ${axText(i)} & ${i.cat === 'statement_changed' ? stmtText(i) : i.cat === 'sorry' ? String.raw`\texttt{sorry} left in proof` : i.cat === 'verified' ? 'verified' : 'non-standard axiom'} \\`).join('\n')}
\bottomrule
\end{tabular}
\end{table}`;

// Sampling settings beyond the temperature, as recorded in the summary.
function samplingText() {
  const st = summary.settings || {};
  const parts = [];
  if (isNum(st.top_p)) parts.push(`top-$p$ ${st.top_p}`);
  if (isNum(st.top_k)) parts.push(`top-$k$ ${st.top_k}`);
  if (isNum(st.presence_penalty)) parts.push(`presence penalty ${st.presence_penalty}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

// pass@k section (runs with K > 1 attempts per problem)
let passkSection = '';
const PASSK_COLOURS = ['qrSorry', 'qrErr', 'qrOk', 'qrStmt', 'qrAx', 'qrEnv'];
if (K > 1) {
  const curves = MODELS.map((m, i) => ({ m, colour: PASSK_COLOURS[i % PASSK_COLOURS.length], pk: summary.by_target.all?.[m.id]?.pass_at_k })).filter((x) => x.pk?.curve?.length);
  const levels = [...new Set(curves.flatMap((x) => x.pk.curve.map((c) => c.k)))].sort((a, b) => a - b);
  const at = (pk, k) => pk.curve.find((c) => c.k === k);
  const cellOf = (c) => (c && isNum(c.value) ? `${pct(c.value)}\\,\\%${isNum(c.ci_lo) ? ` {\\footnotesize[${pct(c.ci_lo)}, ${pct(c.ci_hi)}]}` : ''}` : '---');
  const last = (pk) => pk.curve[pk.curve.length - 1];
  const incomplete = curves.filter(({ pk }) => pk.curve.some((c) => c.items_short > 0));

  // Every attempt, classified as in Table~\ref{tab:outcomes}.
  const allAttempts = [];
  for (const it of items) for (const r of readAttempts(it.key)) allAttempts.push({ model: it.model, paper: it.paper, attempt: r.attempt, cat: classify(r), established: r.mathematical_status === 'established' });
  const attCats = CATS.filter(([id]) => allAttempts.some((a) => a.cat === id));
  const nAtt = (m) => allAttempts.filter((a) => a.model === m.id).length;
  const solvedRows = [];
  for (const m of MODELS) {
    const byPaper = new Map();
    for (const a of allAttempts.filter((x) => x.model === m.id && x.established && CAT[x.cat].group !== 'provider' && CAT[x.cat].group !== 'grader')) {
      const e = byPaper.get(a.paper) || { n: 0, c: 0 };
      e.n += 1;
      if (a.cat === 'verified') e.c += 1;
      byPaper.set(a.paper, e);
    }
    for (const [paper, e] of [...byPaper].sort()) if (e.c > 0) solvedRows.push(String.raw`${paper} & ${m.label} & ${e.c}/${e.n} \\`);
  }

  passkSection = String.raw`% ---------------------------------------------------------------- Table: pass@k
\begin{table}[!htbp]
\centering
\begin{threeparttable}
\caption{Verified pass@$k$ on the established main theorems, from ${K} attempts per problem.}
\label{tab:passk}
\small
\begin{tabular}{@{}l${'r'.repeat(levels.length + 1)}@{}}
\toprule
Model & ${levels.map((k, i) => `pass@${k}${i === 0 ? '\\tnote{a}' : ''}`).join(' & ')} & Solved at least once\tnote{b} \\
\midrule
${curves.map(({ m, pk }) => String.raw`${m.label} & ${levels.map((k) => cellOf(at(pk, k))).join(' & ')} & ${last(pk).items_solved_any}/${last(pk).items} {\footnotesize${ci(last(pk).items_solved_any, last(pk).items)}} \\`).join('\n')}
\bottomrule
\end{tabular}
\begin{tablenotes}\footnotesize
\item[a] For a problem with $n$ determinate attempts of which $c$ are verified, pass@$k = 1 - \binom{n-c}{k}/\binom{n}{k}$ (Chen et al., 2021), averaged over the problems with at least $k$ determinate attempts; pass@1 is therefore the mean share of verified attempts, not the first attempt alone. Brackets: 95\,\% paper bootstrap intervals, which collapse to a point when no attempt succeeded. Denominator: established main theorems, excluding attempts that failed at the provider or the grader; an attempt without a Lean file counts as a failure.${incomplete.length ? ` ${incomplete.map(({ m, pk }) => `${m.label}: ${Math.max(...pk.curve.map((c) => c.items_short))} problem(s) had fewer than ${K} determinate attempts and are left out of the larger $k$.`).join(' ')}` : ''}
\item[b] Problems with at least one verified attempt, with an exact Clopper--Pearson interval; equal to pass@${K}.
\end{tablenotes}
\end{threeparttable}
\end{table}

% ---------------------------------------------------------------- Figure: pass@k
\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  width=0.72\linewidth, height=5.6cm, xmode=log, log basis x=2,
  xtick={${levels.join(',')}}, xticklabels={${levels.join(',')}}, xlabel={$k$},
  ymin=0, ymax=${Math.max(10, Math.ceil((100 * Math.max(0, ...curves.flatMap(({ pk }) => pk.curve.map((c) => (isNum(c.ci_hi) ? c.ci_hi : c.value || 0))))) / 5) * 5)}, ylabel={Verified pass@$k$ (\%)},
  legend style={at={(0.02,0.98)}, anchor=north west, draw=none, font=\footnotesize}, legend cell align=left,
  grid=major, grid style={black!12}, axis x line*=bottom, axis y line*=left,
]
${curves.map(({ colour, pk }) => String.raw`\addplot+[mark=*, thick, color=${colour}, mark options={fill=${colour}}] coordinates {${pk.curve.filter((c) => isNum(c.value)).map((c) => `(${c.k},${pct(c.value)})`).join(' ')}};`).join('\n')}
\legend{${curves.map(({ m }) => m.label).join(',')}}
\end{axis}
\end{tikzpicture}
\caption{Verified pass@$k$ against the number of attempts $k$ (Table~\ref{tab:passk}).}
\label{fig:passk}
\end{figure}

% ---------------------------------------------------------------- Table: outcome of all attempts
\begin{table}[!htbp]
\centering
\caption{Outcome of all ${K} attempts per problem, by model (categories as in Table~\ref{tab:outcomes}).}
\label{tab:outcomes-all}
\small
\begin{tabular}{@{}l${'r'.repeat(MODELS.length)}@{}}
\toprule
Outcome & ${modelCols} \\
\midrule
${attCats.map(([id, label, color]) => String.raw`\swatch{${color}}\,${label} & ${MODELS.map((m) => { const k = allAttempts.filter((a) => a.model === m.id && a.cat === id).length; return nAtt(m) ? `${k} (${pct(k / nAtt(m))}\\,\\%)` : '---'; }).join(' & ')} \\`).join('\n')}
\midrule
Attempts & ${MODELS.map((m) => nAtt(m)).join(' & ')} \\
\bottomrule
\end{tabular}
\end{table}
${solvedRows.length ? String.raw`
% ---------------------------------------------------------------- Table: problems solved at least once
\begin{table}[!htbp]
\centering
\caption{Established main theorems with at least one verified attempt.}
\label{tab:solved}
\small
\begin{tabular}{@{}llr@{}}
\toprule
Problem & Model & Verified attempts \\
\midrule
${solvedRows.join('\n')}
\bottomrule
\end{tabular}
\end{table}` : ''}`;
}

// Validity notes
const q = S[MODELS[MODELS.length - 1].id];
const graderLoss = MODELS.map((m) => {
  const k = S[m.id].count.grader_env + S[m.id].count.grader_import + S[m.id].count.grader_other;
  const n = S[m.id].fileReturned.length;
  return `${k === n ? (n === 2 ? 'both' : `all ${n}`) : `${k} of the ${n}`} files returned by ${m.label}`;
}).join(' and ').replace(/^./, (c) => c.toUpperCase());
const validity = String.raw`% ---------------------------------------------------------------- Threats to validity (adapt to the paper)
\subsection*{Threats to validity}
\begin{itemize}\setlength\itemsep{2pt}
${graderMismatch ? String.raw`\item \textbf{Grader configuration.} ${graderLoss} could not be evaluated, because the grader ran outside the benchmark's pinned Lean project and its import policy rejected imports that belong to the challenge files. The rates in Table~\ref{tab:matrix} therefore rest on ${MODELS.map((m) => `${S[m.id].graded.length} graded attempts (${m.label})`).join(' and ')}. The answers that were graded were compiled with Lean ${tt(String(run.toolchain.toolchain).replace(/^.*:/, ''))} instead of the pinned ${BENCHMARK_PIN.lean} and without the benchmark's Lean options.` : ''}
${kimiLike ? String.raw`\item \textbf{Provider failures.} ${S[kimiLike.id].count.timeout + S[kimiLike.id].count.rate_limit} of ${S[kimiLike.id].all.length} requests to ${kimiLike.label} failed (${S[kimiLike.id].count.timeout} timed out after ${run.settings.generation_timeout_ms / 1000}\,s; ${S[kimiLike.id].count.rate_limit} were refused with HTTP 429 because the account allows one concurrent request). Its results are not comparable with the other model's.` : ''}
${K > 1 ? String.raw`\item \textbf{Attempts.} ${K} independent samples per problem, without repair rounds or tools; repair success is not measured. pass@$k$ for $k < ${K}$ is estimated from the ${K} samples with the unbiased estimator, not from separate runs.` : String.raw`\item \textbf{Single attempt.} One request per problem${MODELS.some((m) => S[m.id].temperature === '0') ? ' at temperature 0 where the provider allows it' : ''}, without repair rounds or tools; pass@$k$ and repair success are not measured.`}
\item \textbf{Output budget.} ${pct(q.truncated.length / Math.max(1, q.answered.length), 0)}\,\% of the answers of ${MODELS[MODELS.length - 1].label} reached the ${int(maxTok)}-token limit (Figure~\ref{fig:length}); a larger budget could change its compile rate.
\item \textbf{Contamination.} Neither provider states a training cutoff and the problems' publication dates are not recorded, so prior exposure cannot be assessed.
\end{itemize}`;

const tex = String.raw`% Performance matrix for QEDRank run ${run.run_id}
% Generated by paper/make-tex.cjs from the run's item records on ${new Date().toISOString().slice(0, 10)}.
% Rebuild after a re-grade:  node paper/make-tex.cjs runs/<run-id> paper/performance-matrix.tex
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
\usepackage{amsmath}
\usepackage{threeparttable}
\usepackage[font=small,labelfont=bf]{caption}
\usepackage{xcolor}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
${colourDefs}
\newcommand{\swatch}[1]{\textcolor{#1}{\rule{0.75em}{0.75em}}}

\begin{document}

\section*{Pilot evaluation: performance matrix}
Run \texttt{${tt(run.run_id)}}, ${nProblems} ProofBench problems, task \emph{prove the given statement}, ${MODELS.length} models.

${setupTable}

${outcomeTable}

${outcomeFigure}

${matrixTable}

${passkSection}

${funnelFigure}

${histFigure}

${taxFigure}

${diffTable}

${compiledTable}

\clearpage
${validity}

\end{document}
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, tex.replace(/\n{3,}/g, '\n\n'));

// Short report of the computed numbers for checking.
for (const m of MODELS) {
  const s = S[m.id];
  console.log(m.label, JSON.stringify({
    counts: Object.fromEntries(Object.entries(s.count).filter(([, v]) => v)),
    answered: s.answered.length, fileReturned: s.fileReturned.length, graded: s.graded.length,
    compiled: s.compiled.length, kept: s.kept.length, verified: `${s.verified.length}/${s.verifiedPool.length}`,
    truncated: s.truncated.length, compileCI: ci(s.compiled.length, s.graded.length), verifiedCI: ci(s.verified.length, s.verifiedPool.length),
    raw: s.rawCompile, rawVerified: s.rawVerified,
  }));
}
console.log('error classes:', JSON.stringify(classes));
console.log('histogram:', JSON.stringify(hist), 'capped', capped);
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
/** Every attempt record of an item (attempt-a1r0.json … attempt-a<K>r0.json that exist). */
function readAttempts(key) {
  const out = [];
  for (let j = 1; j <= K; j += 1) {
    const file = path.join(runDir, 'items', key, `attempt-a${j}r0.json`);
    if (fs.existsSync(file)) out.push(readJson(file));
  }
  return out;
}
function shortLabel(m) {
  const l = m.label || m.display_name || m.id;
  return l.replace(/\s+Instruct$/, '').replace(/^Qwen3 (\d)/, 'Qwen3-$1');
}
function tt(s) {
  return String(s).replace(/\\/g, '\\textbackslash{}').replace(/([_#%&$])/g, '\\$1').replace(/~/g, '\\textasciitilde{}');
}
