// LaTeX for the paper: tables and pgfplots figures from a benchmark comparison JSON. Every number
// comes from the JSON, so the file is rebuilt with the comparison (`node qedrank/cli.js compare`).

import { placeLabels } from './labels.js';

const COLORS = {
  cmpPB: '235,104,52', // categorical slot 2 (ProofBench)
  cmpOther: '42,120,214', // slot 1
  ordA: '134,182,239', ordB: '57,135,229', ordC: '37,106,191', ordD: '24,79,149', ordE: '13,54,107',
  cmpGrey: '160,159,150', cmpLight: '225,224,217', cmpMid: '195,194,183',
};
// The five ordered levels on one validated blue ramp (steps 250/400/500/600/700, light end >= 2:1);
// coursework, calibration and unlabelled items are not on that scale and wear neutrals.
const LEVEL_COLORS = { coursework: 'cmpLight', competition: 'ordA', undergraduate: 'ordB', graduate: 'ordC', research: 'ordD', open: 'ordE', calibration: 'cmpGrey', unlabeled: 'cmpMid' };
const LEVEL_LABELS = { coursework: 'School coursework', competition: 'Competition', undergraduate: 'Undergraduate', graduate: 'Graduate', research: 'Research', open: 'Open problem', calibration: 'Calibration', unlabeled: 'Not labelled' };
const BUDGET_MARK = { single: '*', sampled: 'square*', heavy: 'triangle*', unknown: 'diamond*' };
const BUDGET_LABEL = { single: 'one attempt (incl.\\ one agentic run)', sampled: 'pass@2--64', heavy: 'pass@128+, refinement or compute budget', unknown: 'budget not reported' };

export function tex(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/≤/g, '$\\le$').replace(/≥/g, '$\\ge$').replace(/–/g, '--').replace(/—/g, '---').replace(/×/g, '$\\times$');
}
const pct = (x, d = 1) => (typeof x === 'number' ? `${(100 * x).toFixed(d)}\\,\\%` : '---');
const int = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x).toLocaleString('en-US').replace(/,/g, '{,}') : '---');
// A breakable space before the citation, so a long benchmark name and its key can wrap.
const cite = (b) => (b.cite_key ? ` \\cite{${b.cite_key}}` : '');

function factsTable(all) {
  const rows = all.map((b) => {
    const f = b.facts || {};
    return `${b.id === 'proofbench' ? '\\textbf{ProofBench}' : tex(b.name)}${b.id === 'proofbench' ? '' : cite(b)} & ${int(f.problems)} & ${tex((f.languages || []).join(', '))} & ${tex(f.level)} & ${tex(f.source)} & ${tex(f.task)} & ${tex(f.judged_by)} & ${tex(f.statements)} \\\\\\addlinespace[2pt]`;
  });
  // Eight descriptive columns: set sideways, on a page of its own, so every row stays readable.
  return String.raw`\begin{sidewaystable}
\centering
\caption{Lean benchmarks for formal mathematics, as described by their authors. ProofBench as of commit \texttt{COMMIT}.}
\label{tab:bench-characteristics}
\scriptsize
\begin{tabularx}{\linewidth}{@{}>{\raggedright\arraybackslash}p{2.3cm}r>{\raggedright\arraybackslash}p{2.2cm}>{\raggedright\arraybackslash}X>{\raggedright\arraybackslash}X>{\raggedright\arraybackslash}X>{\raggedright\arraybackslash}X>{\raggedright\arraybackslash}p{1.6cm}@{}}
\toprule
Benchmark & Problems & Proof assistant & Level & Problems from & Task & Judged by & Statements \\
\midrule
${rows.join('\n')}
\bottomrule
\end{tabularx}
\end{sidewaystable}`;
}

function measuredTable(all) {
  const rows = all.map((b) => {
    const f = b.facts || {};
    const best = f.best || {};
    const s = b.measured?.available ? b.measured.statements : null;
    const bestCell = b.id === 'proofbench'
      ? (best.of ? `${best.solved}/${best.of} (${pct(best.of ? best.solved / best.of : null)}) & ${tex(best.model)} & pass@1` : '--- & --- & ---')
      : `${pct(best.rate)} & ${tex(best.model_short || best.model || '---')} & ${tex(best.budget_short || best.budget || '---')}`;
    const stmt = s ? `${int(s.stmt_tokens.median)} & ${int(s.closure_tokens.median)} {\\footnotesize[${int(s.closure_tokens.q1)}, ${int(s.closure_tokens.q3)}]} & ${s.count_with_local_defs}/${s.measured} (${pct(s.share_with_local_defs, 0)})` : '\\multicolumn{3}{c}{\\footnotesize not measured}';
    return `${b.id === 'proofbench' ? '\\textbf{ProofBench}' : tex(b.short || b.name)} & ${bestCell} & ${stmt} \\\\`;
  });
  return String.raw`\begin{table}[!htbp]
\centering
\begin{threeparttable}
\caption{Best reported results and statement complexity. Statement measures are computed here with one rule for every benchmark.}
\label{tab:bench-measured}
\scriptsize
\begin{tabular}{@{}l r >{\raggedright\arraybackslash}p{2.6cm} >{\raggedright\arraybackslash}p{1.7cm} r r r@{}}
\toprule
 & \multicolumn{3}{c}{Best reported\tnote{a}} & \multicolumn{3}{c}{Statement\tnote{b}} \\
\cmidrule(lr){2-4}\cmidrule(l){5-7}
Benchmark & Success & Model & Budget & Signature & With definitions [IQR] & Own definitions \\
\midrule
${rows.join('\n')}
\bottomrule
\end{tabular}
\begin{tablenotes}\footnotesize
\item[a] As reported by the benchmark's paper or leaderboard; rates are comparable only at equal sampling budget. ProofBench: QEDRank runs, verified answers over established main theorems with a determinate outcome.
\item[b] Median Lean tokens of the theorem signature, and of the signature together with every non-Mathlib definition it uses (same file or the benchmark's own library, transitively); share of problems whose statement uses at least one such definition.
\end{tablenotes}
\end{threeparttable}
\end{table}`;
}

function scatterFigure(all) {
  const plots = [];
  const legend = [];
  const classOf = (b) => (BUDGET_MARK[b.facts.best.budget_class] ? b.facts.best.budget_class : 'unknown');
  const labelled = [];
  for (const [cls, mark] of Object.entries(BUDGET_MARK)) {
    const pts = all.filter((b) => b.id !== 'proofbench' && b.facts?.problems && typeof b.facts?.best?.rate === 'number' && classOf(b) === cls);
    if (!pts.length) continue;
    plots.push(`\\addplot[only marks, mark=${mark}, mark size=2.6pt, color=cmpOther] coordinates {${pts.map((b) => `(${b.facts.best.evaluated_on || b.facts.problems},${(100 * b.facts.best.rate).toFixed(2)})`).join(' ')}};`);
    legend.push(BUDGET_LABEL[cls]);
    for (const b of pts) labelled.push({ id: b.id, x: b.facts.best.evaluated_on || b.facts.problems, y: 100 * b.facts.best.rate, text: tex(b.short || b.name), color: 'black' });
  }
  const pb = all.find((b) => b.id === 'proofbench');
  const best = pb?.facts?.best;
  if (pb && best?.ci) {
    const x = best.evaluated_on || pb.facts.problems;
    const y = 100 * (best.solved / best.of);
    const up = 100 * best.ci[1] - y;
    const down = y - 100 * best.ci[0];
    plots.push(`\\addplot[only marks, mark=o, mark size=2.8pt, color=cmpPB, thick, error bars/.cd, y dir=both, y explicit, error bar style={color=cmpPB, thick}] coordinates {(${x},${y.toFixed(2)}) += (0,${up.toFixed(2)}) -= (0,${down.toFixed(2)})};`);
    legend.push('ProofBench (QEDRank runs, exact 95\\,\\% interval)');
    labelled.push({ id: 'proofbench', x, y: 100 * best.ci[1], text: 'ProofBench', color: 'cmpPB' });
  }
  // Direct labels: placed in cm so they avoid every marker and each other (axis ~14 x 5.6 cm).
  const X0 = Math.log10(50);
  const cmX = (v) => ((Math.log10(v) - X0) / (Math.log10(20000) - X0)) * 14;
  const cmY = (v) => (v / 100) * 5.6;
  const sides = placeLabels(labelled.map((l) => ({ id: l.id, x: cmX(l.x), y: cmY(l.y), w: 0.16 * l.text.replace(/\\[a-z]+|[{}]/g, '').length + 0.1, h: 0.3 })), { gap: 0.12, r: 0.12, bounds: { x0: 0, x1: 15, y0: -0.2, y1: 6 } });
  const ANCHOR = { right: 'anchor=west, xshift=3pt', left: 'anchor=east, xshift=-3pt', below: 'anchor=north, yshift=-3pt', above: 'anchor=south, yshift=3pt' };
  for (const l of labelled) plots.push(`\\node[font=\\scriptsize, ${ANCHOR[sides.get(l.id)]}, text=${l.color}] at (axis cs:${l.x},${l.y.toFixed(2)}) {${l.text}};`);
  return String.raw`\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{semilogxaxis}[
  width=0.92\linewidth, height=7cm, xmin=50, xmax=20000, ymin=0, ymax=100,
  xlabel={Problems in the evaluated set (log scale)}, ylabel={Best reported success (\%)},
  grid=major, grid style={draw=black!10}, axis lines*=left, tick label style={font=\small},
  legend style={at={(0.5,-0.22)}, anchor=north, legend columns=2, draw=none, font=\footnotesize},
  legend cell align=left, clip=false,
]
${plots.join('\n')}
\legend{${legend.map((l) => `{${l}}`).join(',')}}
\end{semilogxaxis}
\end{tikzpicture}
\caption{Headroom against size. Each benchmark at its best verified result, placed at the size of the set that result was reported on; marker shape gives the budget behind the number. ProofBench is shown with its exact 95\,\% Clopper--Pearson interval from the QEDRank runs.}
\label{fig:bench-headroom}
\end{figure}`;
}

function boxFigure(all, field, caption, label) {
  const rows = all.filter((b) => b.measured?.available && b.measured.statements[field]?.n);
  const plots = rows.map((b, i) => {
    const s = b.measured.statements[field];
    const v = (x) => Math.max(1, x).toFixed(1);
    return `\\addplot[${b.id === 'proofbench' ? 'cmpPB' : 'cmpOther'}, fill=${b.id === 'proofbench' ? 'cmpPB' : 'cmpOther'}!30, boxplot prepared={lower whisker=${v(s.p10)}, lower quartile=${v(s.q1)}, median=${v(s.median)}, upper quartile=${v(s.q3)}, upper whisker=${v(s.p90)}, draw position=${rows.length - i}}] coordinates {};`;
  });
  return String.raw`\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  boxplot/draw direction=x, xmode=log, width=0.88\linewidth, height=${(1.2 + 0.62 * rows.length).toFixed(1)}cm,
  ytick={${rows.map((_, i) => rows.length - i).join(',')}}, yticklabels={${rows.map((b) => tex(b.short || b.name)).join(',')}},
  ymin=0.4, ymax=${rows.length + 0.6}, xlabel={Lean tokens (log scale)}, xmajorgrids, grid style={draw=black!10},
  tick label style={font=\small}, axis lines*=left,
]
${plots.join('\n')}
\end{axis}
\end{tikzpicture}
\caption{${caption} Box: middle half of the problems; bar: median; whiskers: 10th to 90th percentile.}
\label{${label}}
\end{figure}`;
}

function subjectTable(all, groups) {
  const rows = all.filter((b) => b.subjects && Object.keys(b.subjects).length);
  if (!rows.length) return '';
  const cell = (n, t) => {
    if (!t || !n) return '\\cellcolor{white}\\textcolor{black!35}{0}';
    const p = n / t;
    const shade = Math.round(8 + 72 * p);
    // Never print a non-empty share as 0.
    return `\\cellcolor{cmpOther!${shade}}${p >= 0.55 ? '\\textcolor{white}' : ''}{${p < 0.005 ? '$<$1' : Math.round(100 * p)}}`;
  };
  const lines = rows.map((b) => {
    const t = Object.values(b.subjects).reduce((a, c) => a + c, 0);
    return `${b.id === 'proofbench' ? '\\textbf{ProofBench}' : tex(b.short || b.name)}${b.subjects_source === 'stated' ? '$^{*}$' : ''} & ${groups.map((g) => cell(b.subjects[g.id] || 0, t)).join(' & ')} & ${Math.round(t)} \\\\`;
  });
  const missing = all.filter((b) => !rows.includes(b)).map((b) => tex(b.short || b.name));
  return String.raw`\begin{table}[!htbp]
\centering
\caption{Subject coverage: share of labelled problems (\%) by subject area; a problem with several labels counts in each. ${groups.map((g) => `${tex(g.short || g.label)}: ${tex(g.label.toLowerCase())}`).filter((_, i) => groups[i].short && groups[i].short !== groups[i].label).join('; ')}. $^{*}$: counts stated in the benchmark's paper.${missing.length ? ` No subject labels: ${missing.join(', ')}.` : ''}}
\label{tab:bench-subjects}
\scriptsize
\setlength{\tabcolsep}{3pt}
\begin{tabular}{@{}l${'c'.repeat(groups.length)}r@{}}
\toprule
Benchmark & ${groups.map((g) => `\\rotatebox{60}{${tex(g.short || g.label)}}`).join(' & ')} & $n$ \\
\midrule
${lines.join('\n')}
\bottomrule
\end{tabular}
\end{table}`;
}

function levelFigure(all) {
  const rows = all.filter((b) => b.levels && Object.keys(b.levels).length);
  if (!rows.length) return '';
  const keys = Object.keys(LEVEL_LABELS).filter((k) => rows.some((b) => b.levels[k]));
  const plots = keys.map((k) => `\\addplot[fill=${LEVEL_COLORS[k]}, draw=white] coordinates {${rows.map((b, i) => { const t = Object.values(b.levels).reduce((a, c) => a + c, 0); return `(${(100 * (b.levels[k] || 0) / t).toFixed(2)},${rows.length - 1 - i})`; }).join(' ')}};`);
  return String.raw`\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  xbar stacked, bar width=9pt, width=0.86\linewidth, height=${(1.4 + 0.55 * rows.length).toFixed(1)}cm, xmin=0, xmax=100,
  xlabel={Share of problems (\%)}, ytick={${rows.map((_, i) => i).join(',')}},
  yticklabels={${rows.slice().reverse().map((b) => `${tex(b.short || b.name)}${b.levels_source === 'stated' ? '$^{*}$' : ''}`).join(',')}},
  ymin=-0.6, ymax=${rows.length - 0.4}, tick label style={font=\small}, axis lines*=left,
  legend style={at={(0.5,-0.3)}, anchor=north, legend columns=4, draw=none, font=\footnotesize}, legend cell align=left,
]
${plots.join('\n')}
\legend{${keys.map((k) => `{${LEVEL_LABELS[k]}}`).join(',')}}
\end{axis}
\end{tikzpicture}
\caption{Problems by level. Per-problem labels where the benchmark has them; $^{*}$: level or counts stated by the benchmark's authors.${all.filter((b) => !rows.includes(b)).length ? ` No level breakdown published: ${all.filter((b) => !rows.includes(b)).map((b) => tex(b.short || b.name)).join(', ')}.` : ''}}
\label{fig:bench-levels}
\end{figure}`;
}

function proofbenchFigure(data) {
  const pb = data.proofbench;
  const secs = Object.entries(pb.msc_section || {}).sort((a, b) => b[1] - a[1]);
  const top = secs.slice(0, 8);
  const rest = secs.slice(8).reduce((a, [, v]) => a + v, 0);
  const entries = [...top.map(([k, v]) => [`${k}${data.msc_names?.[k] ? ` ${data.msc_names[k]}` : ''}`, v]), ...(rest ? [['other sections', rest]] : [])];
  return String.raw`\begin{figure}[!htbp]
\centering
\begin{tikzpicture}
\begin{axis}[
  xbar, bar width=8pt, width=0.7\linewidth, height=${(1.4 + 0.5 * entries.length).toFixed(1)}cm, xmin=0,
  xlabel={Problems}, ytick={${entries.map((_, i) => i).join(',')}}, yticklabels={${entries.slice().reverse().map(([l]) => tex(l)).join(',')}},
  ymin=-0.6, ymax=${entries.length - 0.4}, nodes near coords, nodes near coords style={font=\scriptsize},
  tick label style={font=\small}, axis lines*=left, enlarge x limits={upper, value=0.12},
]
\addplot[fill=cmpPB, draw=none] coordinates {${entries.slice().reverse().map(([, v], i) => `(${v},${i})`).join(' ')}};
\end{axis}
\end{tikzpicture}
\caption{ProofBench problems by MSC~2020 section of their primary subject code (${pb.problems} problems, ${pb.msc_unlabeled || 0} without a code).}
\label{fig:proofbench-msc}
\end{figure}`;
}

function structureTable(all) {
  const measured = all.filter((b) => b.measured?.available && b.measured.structure);
  if (!measured.length) return null;
  const rows = measured.map((b) => {
    const s = b.measured.structure;
    const lib = s.library ? `${int(s.library.proved_lemmas)} in ${int(s.library.modules)} modules` : '---';
    return `${b.id === 'proofbench' ? '\\textbf{ProofBench}' : tex(b.short || b.name)} & ${int(s.files)} & ${int(s.theorems_per_file.median)} & ${int(s.files_with_several_theorems)} & ${int(s.definitions_per_file.median)} {\\footnotesize[${int(s.definitions_per_file.p90)}]} & ${int(s.proved_lemmas)} & ${lib} & ${s.proved_lemmas + (s.library?.proved_lemmas || 0) ? int(s.library?.proved_lemmas ? s.library.proof_lines.median : s.proof_lines.median) : '---'} \\\\`;
  });
  return String.raw`\begin{table}[!htbp]
\centering
\begin{threeparttable}
\caption{File structure: what a problem file states and which proofs the benchmark ships, measured on source text with one rule for every benchmark.}
\label{tab:bench-structure}
\scriptsize
\begin{tabular}{@{}l r r r r r l r@{}}
\toprule
Benchmark & Files & Theorems/file & Several & Definitions/file [P90] & Proofs in files & Proofs in library & Median proof lines\tnote{a} \\
\midrule
${rows.join('\n')}
\bottomrule
\end{tabular}
\begin{tablenotes}\footnotesize
\item ${tex(measured[0].measured.structure.rule)}
\item[a] Of the library's proofs when the benchmark has a library, else of the proofs in its problem files.
\end{tablenotes}
\end{threeparttable}
\end{table}`;
}

function proofsTable(data) {
  const pm = data.proof_metrics;
  if (!pm) return null;
  const names = { library: 'Own library', solutions: 'Reference solutions', models: 'Verified model answers' };
  const rows = Object.entries(names).filter(([k]) => pm.sources[k]?.summary?.proofs).map(([k, label]) => {
    const s = pm.sources[k].summary;
    return `${label} & ${int(s.proofs)} & ${int(s.proof_lines.median)} {\\footnotesize[${int(s.proof_lines.q1)}, ${int(s.proof_lines.q3)}]} & ${int(s.tactics.median)} {\\footnotesize[${int(s.tactics.q1)}, ${int(s.tactics.q3)}]} & ${pct(s.automation_share, 0)} & ${s.hypotheses.proofs_with_unused}/${s.hypotheses.proofs_with_hypotheses} & ${int(s.linter_warnings.total)} \\\\`;
  });
  const st = pm.sources.statements?.summary;
  const others = data.benchmarks.filter((b) => b.id !== 'proofbench' && b.measured?.available).map((b) => tex(b.short || b.name));
  return String.raw`\begin{table}[!htbp]
\centering
\begin{threeparttable}
\caption{ProofBench's proofs, measured with Lean in the benchmark's own project. ${others.length ? `${others.join(', ')} ship statements only and have no proofs to measure.` : ''}}
\label{tab:bench-proofs}
\scriptsize
\begin{tabular}{@{}l r r r r r r@{}}
\toprule
Source & Proofs & Lines [IQR] & Tactics [IQR] & Automation\tnote{a} & Unused hypothesis\tnote{b} & Linter warnings \\
\midrule
${rows.join('\n') || '\\multicolumn{7}{c}{\\footnotesize no complete proofs measured} \\\\'}
\bottomrule
\end{tabular}
\begin{tablenotes}\footnotesize
\item Tactics: ${tex(pm.rules?.tactics || '')}.
\item[a] ${tex(pm.rules?.automation || '')}.
\item[b] Proofs that leave a hypothesis unused, of proofs with hypotheses: ${tex(pm.rules?.unused_hypothesis || '')}.
${st ? `\\item Statements: ${st.closed_by_automation} of ${st.targets_found} proved outright and ${st.contradictory} with contradictory hypotheses (${tex(st.portfolio.join(', '))}, each alone); ${int(st.linter_warnings.total)} linter warnings in ${st.linter_warnings.files_with_warnings} of ${st.measured} statement files.` : ''}
\end{tablenotes}
\end{threeparttable}
\end{table}`;
}

export function comparisonTex(data) {
  const all = data.benchmarks;
  const pb = data.proofbench;
  const colourDefs = Object.entries(COLORS).map(([k, v]) => `\\definecolor{${k}}{RGB}{${v}}`).join('\n');
  const body = [
    factsTable(all).replace('COMMIT', tex(pb.source?.commit?.slice(0, 7) || 'local')),
    measuredTable(all),
    scatterFigure(all),
    boxFigure(all, 'closure_tokens', 'Statement length including the definitions the theorem uses.', 'fig:bench-closure'),
    boxFigure(all, 'stmt_tokens', 'Length of the theorem signature alone.', 'fig:bench-signature'),
    subjectTable(all, data.subject_groups || []),
    levelFigure(all),
    structureTable(all),
    proofsTable(data),
    proofbenchFigure(data),
  ].filter(Boolean);
  return `${String.raw`\documentclass[11pt]{article}
\usepackage[a4paper,margin=2.0cm]{geometry}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{booktabs}
\usepackage{tabularx}
\usepackage{array}
\usepackage{threeparttable}
\usepackage{graphicx}
\usepackage{rotating}
\usepackage[table]{xcolor}
\usepackage[font=small,labelfont=bf]{caption}
\usepackage{pgfplots}
\usepgfplotslibrary{statistics}
\pgfplotsset{compat=1.18}
`}${colourDefs}
% Generated by: node qedrank/cli.js compare (${data.generated_at}). Do not edit by hand; rebuild instead.
% Citation keys follow qedrank/data/benchmark-literature.json (cite_key). In this standalone file
% \\cite shows the key; delete the next line when the tables and figures go into the paper.
\\renewcommand{\\cite}[1]{[\\texttt{#1}]}
\\begin{document}

\\section*{ProofBench compared with Lean benchmarks}
${tex(data.method?.summary || '')}

${body.join('\n\n')}

\\end{document}
`;
}
