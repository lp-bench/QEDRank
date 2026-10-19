// LaTeX export of a loaded evaluation, the Evaluation page's third download next to the JSON
// and CSV files: benchmark and run metadata, the models, and the result tables, as one document
// that pdflatex compiles with standard packages. Pure functions over what the page has loaded
// (summary.json, run.json, exports/items.json); nothing is recomputed, every number is read.

import { TARGET_KINDS, TARGET_LABELS } from '../qedrank/helpers.js'

const M = (s) => `\\ensuremath{${s}}`
// Characters outside Latin-1 that inputenc does not know; anything else outside Latin-1 becomes "?".
const UNICODE = {
  '–': '--', '—': '---', '‘': '`', '’': "'", '“': '``', '”': "''", '…': '\\dots{}', '•': '\\textbullet{}',
  '≤': M('\\le'), '≥': M('\\ge'), '≠': M('\\ne'), '≈': M('\\approx'), '→': M('\\to'), '←': M('\\leftarrow'), '↔': M('\\leftrightarrow'),
  '∞': M('\\infty'), '∀': M('\\forall'), '∃': M('\\exists'), '⊢': M('\\vdash'), '∑': M('\\sum'), '√': M('\\surd'), '∎': '\\rule{0.5em}{0.5em}',
  'α': M('\\alpha'), 'β': M('\\beta'), 'γ': M('\\gamma'), 'δ': M('\\delta'), 'ε': M('\\varepsilon'), 'λ': M('\\lambda'), 'μ': M('\\mu'), 'π': M('\\pi'), 'σ': M('\\sigma'),
  '✓': 'yes', '✗': 'no',
}

/** Text for a LaTeX text-mode context: special characters escaped, unknown symbols replaced. */
export function texEscape(value) {
  if (value === null || value === undefined) return ''
  let out = ''
  for (const ch of String(value)) {
    if (UNICODE[ch] !== undefined) { out += UNICODE[ch]; continue }
    switch (ch) {
      case '\\': out += '\\textbackslash{}'; break
      case '&': case '%': case '$': case '#': case '_': case '{': case '}': out += `\\${ch}`; break
      case '~': out += '\\textasciitilde{}'; break
      case '^': out += '\\textasciicircum{}'; break
      case '|': out += '\\textbar{}'; break
      case '\n': case '\r': case '\t': out += ' '; break
      default: {
        const cp = ch.codePointAt(0)
        if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) break
        if (cp === 0xa0) out += '~'
        else out += cp <= 0xff ? ch : '?'
      }
    }
  }
  return out
}

const tt = (s) => `\\texttt{${texEscape(s)}}`
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const pct = (x) => `${(100 * x).toFixed(1)}\\%`
const fixed = (x, d) => (isNum(x) ? x.toFixed(d) : 'n/a')
const int = (x) => (isNum(x) ? String(Math.round(x)) : 'n/a')
const usd = (x, d) => (isNum(x) ? `\\$${x.toFixed(d)}` : 'n/a')
function ms(x) {
  if (!isNum(x)) return 'n/a'
  if (x < 1000) return `${Math.round(x)} ms`
  if (x < 60000) return `${(x / 1000).toFixed(1)} s`
  return `${(x / 60000).toFixed(1)} min`
}
/** num/den (pct): "---" when no item is eligible, "n/a" when the measurement was not recorded. */
function rate(r) {
  if (!r || r.den === undefined || r.den === null) return 'n/a'
  if (r.den === 0) return '---'
  return `${r.num}/${r.den} (${pct(r.value)})`
}
const ci = (r) => (r && isNum(r.ci_lo) && isNum(r.ci_hi) ? `[${(100 * r.ci_lo).toFixed(1)}, ${(100 * r.ci_hi).toFixed(1)}]` : '')
const withCi = (r) => (ci(r) ? `${rate(r)}\\newline ${ci(r)}` : rate(r))
const modelName = (m) => m?.label || m?.display_name || m?.id || 'unnamed model'
const row = (cells) => `${cells.join(' & ')} \\\\`

function table(L, spec, header, rows) {
  L.push('\\begingroup\\footnotesize\\setlength{\\tabcolsep}{3pt}', `\\noindent\\begin{tabular}{${spec}}`, '\\toprule', row(header), '\\midrule', ...rows, '\\bottomrule', '\\end{tabular}\\par\\endgroup', '')
}

function preamble(L, runId, generatedAt) {
  L.push(
    '% QEDRank evaluation report, exported from the Evaluation page. Compile with pdflatex.',
    '\\documentclass[10pt,a4paper]{article}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{lmodern}',
    '\\usepackage[margin=15mm]{geometry}',
    '\\usepackage{array}',
    '\\usepackage{booktabs}',
    '\\setlength{\\parindent}{0pt}',
    '\\setlength{\\parskip}{4pt}',
    '\\renewcommand{\\arraystretch}{1.15}',
    '\\newcolumntype{L}[1]{>{\\raggedright\\arraybackslash}p{#1}}',
    '\\newcolumntype{R}[1]{>{\\raggedleft\\arraybackslash}p{#1}}',
    `\\title{QEDRank evaluation report\\\\[2pt]\\large ${tt(runId)}}`,
    `\\date{${generatedAt ? `Summary generated ${texEscape(String(generatedAt).replace('T', ' ').slice(0, 19))} UTC` : 'No summary generated'}}`,
    '\\begin{document}',
    '\\maketitle',
    '',
  )
}

function metadata(L, summary, run, items) {
  const r = summary?.run || run || {}
  const src = r.source || run?.source || {}
  const s = summary?.settings || {}
  const c = summary?.coverage
  const tc = r.toolchain || run?.toolchain
  const rows = []
  const add = (label, value) => { if (value !== undefined && value !== null && value !== '') rows.push(row([label, value])) }
  add('Run', tt(r.run_id || run?.run_id || 'unnamed run'))
  add('Protocol', r.protocol ? texEscape(r.protocol === 'agent' ? 'agent (multi-session)' : 'single call') : '')
  add('Task', texEscape(r.task || run?.task || ''))
  add('Benchmark corpus', src.url ? `${tt(src.url)}${src.subdir ? `, folder ${tt(src.subdir)}` : ''}` : '')
  add('Corpus commit', src.commit ? `${tt(String(src.commit).slice(0, 12))}${src.commit_date ? ` (${texEscape(String(src.commit_date).slice(0, 10))})` : ''}` : '')
  add('Lean toolchain', tc?.toolchain ? `${tt(tc.toolchain)}${tc.mathlib?.rev ? `, Mathlib ${tt(String(tc.mathlib.rev).slice(0, 10))}` : ''}` : '')
  add('Harness commit', r.harness?.commit ? `${tt(String(r.harness.commit).slice(0, 10))}${r.harness.dirty ? ' (uncommitted changes at run time)' : ''}` : '')
  add('Primary endpoint', texEscape(summary?.primary_endpoint?.description || ''))
  const settings = [
    isNum(s.k) ? `attempts per problem ${s.k}` : '', isNum(s.repair_rounds) ? `repair rounds ${s.repair_rounds}` : '',
    s.temperature !== undefined && s.temperature !== null ? `temperature ${s.temperature}` : '', isNum(s.top_p) ? `top-p ${s.top_p}` : '', isNum(s.top_k) ? `top-k ${s.top_k}` : '',
    isNum(s.presence_penalty) ? `presence penalty ${s.presence_penalty}` : '', s.effort ? `effort ${s.effort}` : '', isNum(s.max_tokens) ? `max output tokens ${s.max_tokens}` : '',
  ].filter(Boolean).join('; ')
  add('Generation settings', texEscape(settings))
  add('Intervals', s.bootstrap ? texEscape(`95% paper-cluster bootstrap, B = ${s.bootstrap.B}, seed ${s.bootstrap.seed}`) : '')
  if (c) add('Coverage', texEscape(`${c.papers_discovered} papers (expected ${c.expected_count}); ${c.items_total} items, of which ${c.items_infrastructure_failed} failed for infrastructure reasons and are excluded from every rate`))
  if (!summary && items?.length) add('Item records', texEscape(`${items.length} (no summary.json loaded: rates and intervals are not available)`))
  L.push('\\section{Benchmark and run}')
  if (rows.length) table(L, 'L{40mm}L{135mm}', ['Field', 'Value'], rows)
  else L.push('No run metadata is loaded.', '')
}

function models(L, summary) {
  L.push('\\section{Models}')
  if (!summary.models?.length) { L.push('No models were evaluated in this run.', ''); return }
  table(L, 'L{34mm}L{62mm}L{12mm}R{18mm}R{34mm}', ['Model', 'Model id and host', 'Effort', 'Released', 'Parameters'],
    summary.models.map((m) => {
      const f = m.facts || {}
      const params = isNum(f.parameters_b) ? `${f.parameters_b}\\,B${isNum(f.active_parameters_b) ? ` (${f.active_parameters_b}\\,B active)` : ''}` : 'n/a'
      return row([texEscape(modelName(m)), `${tt(m.model_id || 'not recorded')}${m.host ? `\\newline ${tt(m.host)}` : ''}`, texEscape(m.effort || '---'), texEscape(f.released || 'n/a'), params])
    }))
}

function results(L, summary) {
  L.push('\\section{Results by target}')
  const ms_ = summary.models || []
  if (!ms_.length) { L.push('No results: no model was evaluated.', ''); return }
  const byTarget = summary.by_target || {}
  const hasRecords = (scope) => ms_.some((m) => (byTarget[scope]?.[m.id]?.n_records ?? 0) > 0)
  // "All targets" repeats the only target of a single-target run (e.g. prove), so it is shown
  // only when two or more target kinds have records.
  const kinds = TARGET_KINDS.filter(hasRecords)
  const scopes = kinds.length > 1 ? ['all', ...kinds] : kinds.length ? kinds : ['all'].filter(hasRecords)
  if (!scopes.length) { L.push('No results: no item of this run has been evaluated yet.', ''); return }
  L.push('Rates are numerator/denominator over eligible items; the bracket below a verified rate is its 95\\% interval. Items that failed for infrastructure reasons (provider timeouts, rate limits, grader errors) are counted in their own column and excluded from every denominator. --- means no item was eligible; n/a means the measurement was not recorded.', '')
  for (const scope of scopes) {
    L.push(`\\subsection*{${texEscape(TARGET_LABELS[scope] || scope)}}`)
    table(L, 'L{30mm}R{11mm}R{15mm}R{12mm}R{22mm}R{22mm}R{22mm}R{26mm}',
      ['Model', 'Records', 'Eligible\\newline stmt./proof', 'Infra.\\newline failures', 'Statement\\newline faithful', 'Compiled', 'Audit clean', 'Verified pass@1'],
      ms_.map((m) => {
        const mm = byTarget[scope]?.[m.id]
        if (!mm || !mm.n_records) return `${texEscape(modelName(m))} & \\multicolumn{7}{l}{\\textit{no items in this scope}} \\\\`
        return row([texEscape(modelName(m)), int(mm.n_records), `${int(mm.eligible_statement)} / ${int(mm.eligible_proof)}`, int(mm.infrastructure_failures), rate(mm.statement_faithful), rate(mm.compile), rate(mm.audit_clean), withCi(mm.verified_pass1)])
      }))
  }
}

function passK(L, summary) {
  const curves = (summary.models || []).map((m) => ({ m, pk: summary.by_target?.all?.[m.id]?.pass_at_k })).filter((x) => x.pk?.curve?.length)
  if (!curves.length) return
  const ks = [...new Set(curves.flatMap((x) => x.pk.curve.map((c) => c.k)))].sort((a, b) => a - b)
  L.push('\\section{Verified pass@k}', texEscape(curves[0].pk.curve_note || 'Unbiased estimator over all attempts per problem.'), '')
  const w = Math.max(14, Math.floor(100 / ks.length))
  table(L, `L{30mm}${ks.map(() => `R{${w}mm}`).join('')}R{14mm}R{18mm}`, ['Model', ...ks.map((k) => `pass@${k}`), 'Items', 'Solved at least once'],
    curves.map(({ m, pk }) => row([texEscape(modelName(m)), ...ks.map((k) => { const c = pk.curve.find((x) => x.k === k); return isNum(c?.value) ? `${pct(c.value)}${ci(c) ? `\\newline ${ci(c)}` : ''}` : 'n/a' }), int(pk.curve[0]?.items), int(pk.curve[pk.curve.length - 1]?.items_solved_any)])))
}

function efficiency(L, summary) {
  const ms_ = summary.models || []
  if (!ms_.length) return
  L.push('\\section{Time, tokens and cost}', 'Medians over all attempts; latency includes network and provider queueing. Cost uses the configured pricing and the usage the provider reported.', '')
  table(L, 'L{30mm}R{18mm}R{18mm}R{18mm}R{18mm}R{18mm}R{18mm}R{18mm}',
    ['Model', 'Model latency', 'Lean time', 'Total per item', 'Input tokens', 'Output tokens', 'Total cost', 'Cost per verified'],
    ms_.map((m) => {
      const mm = summary.by_target?.all?.[m.id] || {}
      const t = mm.time || {}
      return row([texEscape(modelName(m)), ms(t.observed_model_latency_ms?.median), ms(t.lean_total_ms?.median), ms(t.total_item_ms?.median), int(mm.tokens?.median_input), int(mm.tokens?.median_output), usd(mm.cost?.total_usd, 4), mm.cost?.available && !isNum(mm.cost?.per_verified_success_usd) ? 'no success' : usd(mm.cost?.per_verified_success_usd, 3)])
    }))
}

function comparison(L, summary) {
  const cmp = summary.model_comparison
  if (!cmp) return
  const name = (id) => modelName((summary.models || []).find((m) => m.id === id) || { id })
  L.push('\\section{Model comparison}')
  const q = cmp.cochran_q
  L.push(texEscape(q && isNum(q.Q) ? `Cochran's Q = ${q.Q.toFixed(2)}, df ${q.df}, p = ${fixed(q.p, 4)} over ${cmp.n_common_papers} common papers.` : `Cochran's Q: ${q?.note || 'not computed'}.`), '')
  if (cmp.pairwise?.length) {
    table(L, 'L{52mm}R{30mm}R{16mm}R{26mm}R{20mm}R{20mm}', ['Pair', 'Successes A / B', 'Diff (pp)', '95\\% CI', 'McNemar p', 'Holm p'],
      cmp.pairwise.map((p) => row([texEscape(`${name(p.model_a)} vs ${name(p.model_b)}`), `${int(p.a_successes)} / ${int(p.b_successes)} of ${int(p.n)}`, fixed(p.diff_pp, 1), isNum(p.diff_ci_lo) ? `[${p.diff_ci_lo.toFixed(1)}, ${p.diff_ci_hi.toFixed(1)}]` : 'n/a', fixed(p.p, 4), fixed(p.p_holm, 4)])))
  }
  L.push(texEscape(`Statistically supported differences (Holm-adjusted p < 0.05): ${cmp.statistically_supported_pairs?.length ? cmp.statistically_supported_pairs.join('; ') : 'none'}.`), '')
}

function itemOutcomes(L, items, summary) {
  const groups = new Map()
  for (const it of items) {
    // Same label as the other tables when the summary knows the model slot.
    const known = summary?.models?.find((m) => m.id === it.provider)
    const key = known ? modelName(known) : it.model || it.provider || 'unknown model'
    const g = groups.get(key) || { n: 0, infra: 0, genErr: 0, abstained: 0, cut: 0, compiled: 0, verified: 0 }
    g.n += 1
    if (it.infrastructure_failure) g.infra += 1
    if (it.generation_error) g.genErr += 1
    if (it.abstained) g.abstained += 1
    if (it.output_truncated) g.cut += 1
    if (it.compiled) g.compiled += 1
    if (it.verified) g.verified += 1
    groups.set(key, g)
  }
  L.push('\\section{Item outcomes}', 'Counts over every item record, attempts included. A record can carry several flags (an answer cut off at the token limit can still compile); infrastructure failures are not attributed to the model.', '')
  table(L, 'L{34mm}R{16mm}R{20mm}R{20mm}R{17mm}R{20mm}R{17mm}R{17mm}',
    ['Model', 'Records', 'Infrastructure failures', 'Generation errors', 'Abstained', 'Cut off at token limit', 'Compiled', 'Verified'],
    [...groups.entries()].map(([k, g]) => row([texEscape(k), g.n, g.infra, g.genErr, g.abstained, g.cut, g.compiled, g.verified])))
}

/** The whole document. Any of the three inputs may be missing; what is absent is said so. */
export function buildLatexReport({ summary = null, items = null, run = null } = {}) {
  const L = []
  preamble(L, summary?.run?.run_id || run?.run_id || 'unnamed run', summary?.generated_at)
  metadata(L, summary, run, items)
  if (summary) {
    models(L, summary)
    results(L, summary)
    passK(L, summary)
    efficiency(L, summary)
    comparison(L, summary)
  }
  if (items?.length) itemOutcomes(L, items, summary)
  if (!summary && !items?.length) L.push('\\section{Results}', 'No results are loaded: the run has neither a summary nor item records.', '')
  if (summary?.caveats?.length) L.push('\\section{Caveats}', '\\begin{itemize}', ...summary.caveats.map((c) => `\\item ${texEscape(c)}`), '\\end{itemize}', '')
  L.push('\\end{document}', '')
  return L.join('\n')
}
