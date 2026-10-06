// Evaluation page: the complete QEDRank matrix with graphical and statistical analysis for
// the loaded run. Every figure has a table twin; nothing here computes a composite score.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppState } from '../state/AppState.jsx'
import { RunPanel } from '../qedrank/panels.jsx'
import { TARGET_KINDS, TARGET_LABELS, fmtRate, fmtCI, fmtMs, fmtNum, fmtInt, download, toCsv } from '../qedrank/helpers.js'
import { Figure, HBars, GroupedBars, Heatmap, RangeDots, StackedBars, Reliability, PairMatrix, pct1 } from '../charts/primitives.jsx'
import { shortLabel, slotColor } from '../components/vendor.js'
import { MatrixTable, ComparisonTable, CoverageView, ItemsView, Rate, matrixCsvRows } from './views.jsx'
import '../qedrank/qedrank.css'
import './evaluation.css'

const METRICS = [
  { key: 'verified_pass1', label: 'Verified pass@1', color: 'var(--s1)', get: (mm) => mm?.verified_pass1 },
  { key: 'statement_faithful', label: 'GT-faithful statement', color: 'var(--s2)', get: (mm) => mm?.statement_faithful },
  { key: 'compile', label: 'Compile', color: 'var(--s3)', get: (mm) => mm?.compile },
  { key: 'audit_clean', label: 'Audit clean', color: 'var(--s4)', get: (mm) => mm?.audit_clean },
]
const SCOPES = ['all', ...TARGET_KINDS]
const SECTIONS = [
  ['leaderboard', 'Leaderboard'], ['heatmap', 'Matrix heatmap'], ['matrix', 'Full matrix'], ['statements', 'Statement matches'],
  ['time', 'Time'], ['tokens', 'Tokens & cost'], ['calibration', 'Calibration'], ['comparison', 'k-model comparison'],
  ['subgroups', 'Subgroups'], ['coverage', 'Coverage & audit'], ['items', 'Items'],
]
const MATCH_PARTS = [
  { key: 'definitionally_identical', label: 'definitionally identical', color: 'var(--seq-5)' },
  { key: 'equivalent', label: 'equivalent', color: 'var(--seq-4)' },
  { key: 'expert_confirmed_equivalent', label: 'expert-confirmed equivalent', color: 'var(--seq-3)' },
  { key: 'stronger', label: 'stronger', color: 'var(--s4)' },
  { key: 'weaker', label: 'weaker', color: 'var(--s2)' },
  { key: 'different', label: 'different', color: 'var(--s8)' },
  { key: 'unresolved', label: 'unresolved', color: 'var(--axis)' },
  { key: 'not_evaluated', label: 'not evaluated', color: 'var(--surface-3)' },
]

const rateText = (r) => (r && r.den > 0 ? `${r.num}/${r.den} · ${pct1(r.value)}` : 'n/a')
const rateTitle = (label, r, what) => <span><b>{label}</b><br />{what}: <b>{fmtRate(r)}</b>{r && r.ci_lo !== null && r.ci_lo !== undefined ? <><br />{fmtCI(r)}</> : null}</span>

function rateSeries(summary, scope, metric) {
  return summary.models.map((m) => {
    const r = metric.get(summary.by_target[scope]?.[m.id])
    const has = r && r.den > 0
    return { id: m.id, label: shortLabel(m), value: has ? r.value : null, lo: has && typeof r.ci_lo === 'number' ? r.ci_lo : undefined, hi: has && typeof r.ci_hi === 'number' ? r.ci_hi : undefined, text: rateText(r), title: rateTitle(m.display_name, r, `${metric.label} · ${TARGET_LABELS[scope]}`) }
  })
}
const rateTable = (summary, scope, metric) => ({
  columns: ['Model', metric.label, '95% CI'],
  rows: summary.models.map((m) => { const r = metric.get(summary.by_target[scope]?.[m.id]); return [m.display_name, fmtRate(r), fmtCI(r) || '—'] }),
})

export default function EvaluationPage() {
  const { loaded, setLoaded, clearLoaded } = useAppState()
  const { run, summary, items } = loaded
  if (!summary && !items) return <EmptyState onLoaded={setLoaded} />
  return (
    <main className="page eval">
      <div className="page-head row spread">
        <div>
          <span className="eyebrow">QEDRank · evaluation</span>
          <h1>Evaluation matrix &amp; analysis</h1>
          <p>All rates are numerator / eligible denominator at pass@1 with 95% paper-cluster bootstrap intervals. Verified success is the strict primary endpoint; statement fidelity, compilation and audit are reported alongside and never folded into a score.</p>
        </div>
        <div className="row">
          {summary && <button className="btn btn-secondary btn-sm" onClick={() => download(`${summary.run?.run_id || 'qedrank'}-summary.json`, JSON.stringify(summary, null, 2), 'application/json')}>Summary JSON</button>}
          {summary && <button className="btn btn-secondary btn-sm" onClick={() => download(`${summary.run?.run_id || 'qedrank'}-matrix.csv`, toCsv(matrixCsvRows(summary)), 'text/csv')}>Matrix CSV</button>}
          {items && <button className="btn btn-secondary btn-sm" onClick={() => download(`${summary?.run?.run_id || run?.run_id || 'qedrank'}-items.json`, JSON.stringify({ schema: 'qedrank-items-v1', run_id: summary?.run?.run_id, count: items.length, items }, null, 2), 'application/json')}>Items JSON</button>}
          <button className="btn btn-ghost btn-sm" onClick={clearLoaded}>Unload</button>
        </div>
      </div>

      {summary ? <SummaryAnalysis summary={summary} run={run} /> : <div className="note">Only item records are loaded (no <code>summary.json</code>). Run <code>node qedrank/cli.js stats --run-id …</code> to compute the matrix, or load the summary on the <Link to="/benchmark">Benchmark</Link> page.</div>}

      {items && <section id="items" className="ev-section"><h2 className="ev-h2"><span className="ev-num">{summary ? 11 : 1}</span>Item-level results</h2><ItemsView items={items} runId={run?.run_id || summary?.run?.run_id} /></section>}
    </main>
  )
}

function EmptyState({ onLoaded }) {
  return (
    <main className="page">
      <div className="page-head">
        <span className="eyebrow">QEDRank · evaluation</span>
        <h1>No run loaded yet</h1>
        <p>Load a finished (or in-progress) benchmark run to see the complete evaluation matrix, every chart and the statistical analysis. Runs are produced locally by <code>node qedrank/cli.js run …</code>; serve them with <code>npm run qedrank:serve</code> or drop the JSON files below. The corpus preview and the run command live on the <Link to="/benchmark">Benchmark</Link> page.</p>
      </div>
      <RunPanel onLoaded={onLoaded} />
    </main>
  )
}

function SummaryAnalysis({ summary, run }) {
  const models = summary.models
  const [heatMetric, setHeatMetric] = useState('verified_pass1')
  const [matrixScope, setMatrixScope] = useState('all')
  const best = useMemo(() => {
    const rows = models.map((m) => ({ m, r: summary.by_target.all?.[m.id]?.verified_pass1 })).filter((x) => x.r && x.r.den > 0)
    return rows.sort((a, b) => b.r.value - a.r.value)[0] || null
  }, [summary, models])
  const c = summary.coverage
  const cmp = summary.model_comparison
  const metric = METRICS.find((x) => x.key === heatMetric)

  const verifiedAll = rateSeries(summary, 'all', METRICS[0])
  const groupedRows = models.map((m) => ({ id: m.id, label: shortLabel(m), values: Object.fromEntries(METRICS.map((mt) => { const r = mt.get(summary.by_target.all?.[m.id]); return [mt.key, { value: r && r.den > 0 ? r.value : null, text: rateText(r) }] })) }))
  const groupedTable = { columns: ['Model', ...METRICS.map((mt) => mt.label)], rows: models.map((m) => [m.display_name, ...METRICS.map((mt) => fmtRate(mt.get(summary.by_target.all?.[m.id])))]) }

  const heatRows = models.map((m) => ({ id: m.id, label: shortLabel(m) }))
  const heatCols = SCOPES.map((s) => ({ id: s, label: TARGET_LABELS[s] }))
  const heatCell = (mid, scope) => { const r = metric.get(summary.by_target[scope]?.[mid]); const m = models.find((x) => x.id === mid); return { value: r && r.den > 0 ? r.value : null, text: r && r.den > 0 ? `${r.num}/${r.den}` : '–', title: rateTitle(m?.display_name || mid, r, `${metric.label} · ${TARGET_LABELS[scope]}`) } }
  const heatTable = { columns: ['Model', ...SCOPES.map((s) => TARGET_LABELS[s])], rows: models.map((m) => [m.display_name, ...SCOPES.map((s) => fmtRate(metric.get(summary.by_target[s]?.[m.id])))]) }

  const matchRows = models.map((m) => ({ id: m.id, label: shortLabel(m), counts: summary.by_target.all?.[m.id]?.statement_match_counts || {} }))
  const matchParts = MATCH_PARTS.filter((p) => matchRows.some((r) => r.counts[p.key]))
  const matchTable = { columns: ['Model', ...matchParts.map((p) => p.label), 'eligible'], rows: matchRows.map((r) => [models.find((m) => m.id === r.id)?.display_name, ...matchParts.map((p) => r.counts[p.key] || 0), summary.by_target.all?.[r.id]?.eligible_statement ?? 0]) }

  const timeKeys = [['observed_model_latency_ms', 'Observed model latency', 'var(--s1)'], ['lean_total_ms', 'Lean total (compile + audit + comparison)', 'var(--s3)'], ['total_item_ms', 'Total per item', 'var(--s7)']]
  const timeSeries = (key) => models.map((m) => { const t = summary.by_target.all?.[m.id]?.time?.[key]; return { id: m.id, label: shortLabel(m), q1: t?.q1, median: t?.median, q3: t?.q3, p90: t?.p90, n: t?.n, timeouts: t?.timeouts } })
  const timeTable = (key) => ({ columns: ['Model', 'Median', 'IQR', 'p90', 'n', 'Timeouts'], rows: models.map((m) => { const t = summary.by_target.all?.[m.id]?.time?.[key]; return t && t.n ? [m.display_name, fmtMs(t.median), `${fmtMs(t.q1)} – ${fmtMs(t.q3)}`, fmtMs(t.p90), t.n, t.timeouts] : [m.display_name, 'unavailable', '', '', 0, t?.timeouts ?? 0] }) })

  const tokMax = Math.max(1, ...models.flatMap((m) => { const t = summary.by_target.all?.[m.id]?.tokens; return [t?.median_input, t?.median_output].filter((v) => typeof v === 'number') }))
  const tokRows = models.map((m) => { const t = summary.by_target.all?.[m.id]?.tokens; const has = t && t.n_with_usage; return { id: m.id, label: shortLabel(m), values: { input: { value: has ? t.median_input / tokMax : null, text: has ? fmtInt(t.median_input) : 'n/a' }, output: { value: has ? t.median_output / tokMax : null, text: has ? fmtInt(t.median_output) : 'n/a' } } } })
  const tokTable = { columns: ['Model', 'Median input', 'Median output', 'Total input', 'Total output', 'n with usage'], rows: models.map((m) => { const t = summary.by_target.all?.[m.id]?.tokens || {}; return [m.display_name, fmtInt(t.median_input), fmtInt(t.median_output), fmtInt(t.total_input), fmtInt(t.total_output), t.n_with_usage ?? 0] }) }
  const anyCost = models.some((m) => summary.by_target.all?.[m.id]?.cost?.available)
  const costMax = Math.max(0.000001, ...models.map((m) => summary.by_target.all?.[m.id]?.cost?.per_verified_success_usd || 0))
  const costSeries = models.map((m) => { const cst = summary.by_target.all?.[m.id]?.cost; const v = cst?.per_verified_success_usd; return { id: m.id, label: shortLabel(m), value: typeof v === 'number' ? v / costMax : null, text: typeof v === 'number' ? `$${fmtNum(v, 3)}` : cst?.available ? 'no verified successes' : 'n/a', title: <span><b>{m.display_name}</b><br />total ${fmtNum(cst?.total_usd, 4)} over {cst?.n_priced ?? 0} priced items<br />per verified success: {typeof v === 'number' ? `$${fmtNum(v, 3)}` : 'unavailable'}</span> } })

  const sg = summary.subgroups
  const pl = summary.paper_level || {}
  const sandwich = models.map((m) => { const r = pl[m.id]?.sandwich_coverage; const has = r && r.den > 0; return { id: m.id, label: shortLabel(m), value: has ? r.value : null, lo: has ? r.ci_lo ?? undefined : undefined, hi: has ? r.ci_hi ?? undefined : undefined, text: rateText(r), title: rateTitle(m.display_name, r, 'Sandwich coverage') } })
  const paperVerified = models.map((m) => { const r = pl[m.id]?.paper_verified_all_eligible_bounds; const has = r && r.den > 0; return { id: m.id, label: shortLabel(m), value: has ? r.value : null, lo: has ? r.ci_lo ?? undefined : undefined, hi: has ? r.ci_hi ?? undefined : undefined, text: rateText(r), title: rateTitle(m.display_name, r, 'Paper-level verified (all eligible bounds)') } })

  return (
    <>
      <section className="ev-runbar card">
        <div className="row">
          <span className="pill"><b>run</b> <code>{summary.run?.run_id || run?.run_id || '?'}</code></span>
          <span className="pill" title={summary.run?.source?.url || ''}><b>commit</b> <code>{(summary.run?.source?.commit || '').slice(0, 10) || '?'}</code>{summary.run?.source?.dirty ? ' · dirty' : ''}</span>
          <span className="pill"><b>toolchain</b> <code>{summary.run?.toolchain?.toolchain || 'unavailable'}</code> · Mathlib <code>{summary.run?.toolchain?.mathlib?.rev?.slice(0, 8) || '?'}</code></span>
          <span className="pill"><b>k</b> {summary.settings?.k ?? 1} · <b>repair</b> {summary.settings?.repair_rounds ?? 0} · <b>T</b> {summary.settings?.temperature ?? '?'} · <b>max tokens</b> {summary.settings?.max_tokens ?? '?'}</span>
          <span className="pill"><b>bootstrap</b> B={summary.settings?.bootstrap?.B} seed {summary.settings?.bootstrap?.seed}</span>
          <span className="pill"><b>generated</b> {summary.generated_at?.replace('T', ' ').slice(0, 19)}</span>
        </div>
        <div className="row ev-models">
          {models.map((m) => <span key={m.id} className="pill model-chip" style={{ '--mc': slotColor(m.id) }}><i className="chip-dot" />{shortLabel(m)} <code>{m.model_id}</code>{m.host ? <span className="muted">@ {m.host}</span> : null}</span>)}
        </div>
        <nav className="ev-toc" aria-label="Sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
      </section>

      <section className="stat-tiles ev-kpis">
        <div className="stat" style={{ '--stat-color': 'var(--s1)' }}><div className="label">Primary endpoint · best model</div><div className="value" style={{ fontSize: '1.2rem' }}>{best ? shortLabel(best.m) : '—'}</div><div className="sub">{best ? `verified pass@1 ${fmtRate(best.r)} ${fmtCI(best.r)}` : 'no eligible proof-track items'}</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s3)' }}><div className="label">Papers</div><div className="value">{c.papers_discovered}</div><div className="sub">expected {c.expected_count} · {c.expected_count_matches ? 'matches' : 'does not match'} · {c.papers_with_pdf ?? '?'} with PDF</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s7)' }}><div className="label">Items at pass@1</div><div className="value">{c.items_total}</div><div className="sub">{c.items_infrastructure_failed} infrastructure failures (excluded from denominators)</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s2)' }}><div className="label">Models</div><div className="value">{models.length}</div><div className="sub">{cmp ? `${cmp.n_common_papers} common papers for the k-model tests` : ''}</div></div>
        <div className="stat" style={{ '--stat-color': cmp?.cochran_q?.p !== null && cmp?.cochran_q?.p < 0.05 ? 'var(--good)' : 'var(--axis)' }}><div className="label">Cochran's Q</div><div className="value" style={{ fontSize: '1.2rem' }}>{cmp?.cochran_q?.Q === null || cmp?.cochran_q?.Q === undefined ? 'n/a' : `Q = ${fmtNum(cmp.cochran_q.Q, 2)}`}</div><div className="sub">{cmp?.cochran_q?.p === null || cmp?.cochran_q?.p === undefined ? (cmp?.cochran_q?.note || 'no test') : `df ${cmp.cochran_q.df} · p = ${fmtNum(cmp.cochran_q.p, 4)}`}</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s4)' }}><div className="label">Supported pairwise differences</div><div className="value">{cmp?.statistically_supported_pairs?.length ?? 0}</div><div className="sub">of {cmp?.pairwise?.length ?? 0} pairs after Holm correction</div></div>
      </section>

      <section id="leaderboard" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">1</span>Leaderboard</h2>
        <p className="small">Descriptive only: models are ordered by point estimate; whether two models differ is decided in section 8. Whiskers are 95% paper-cluster intervals; the label is numerator / denominator.</p>
        <div className="ev-grid-2">
          <Figure title="Verified pass@1 — all targets" subtitle={summary.primary_endpoint?.description} table={rateTable(summary, 'all', METRICS[0])}>
            <HBars series={verifiedAll.slice().sort((a, b) => (b.value ?? -1) - (a.value ?? -1))} color="var(--s1)" ariaLabel="Verified pass@1 by model" />
          </Figure>
          <Figure title="The four measurements per model — all targets" subtitle="Each measurement has its own eligible denominator; the value label shows verified pass@1." legend={METRICS.map((mt) => ({ label: mt.label, color: mt.color }))} table={groupedTable}>
            <GroupedBars rows={groupedRows} series={METRICS.map((mt) => ({ key: mt.key, label: mt.label, color: mt.color }))} labelKey="verified_pass1" ariaLabel="Four measurements per model" />
          </Figure>
        </div>
        <div className="ev-grid-4">
          {TARGET_KINDS.map((k) => <Figure key={k} title={`Verified pass@1 — ${TARGET_LABELS[k]}`} table={rateTable(summary, k, METRICS[0])} className="ch-compact"><HBars series={rateSeries(summary, k, METRICS[0])} color="var(--s1)" ariaLabel={`Verified pass@1 on ${TARGET_LABELS[k]}`} /></Figure>)}
        </div>
      </section>

      <section id="heatmap" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">2</span>Matrix heatmap — models × targets</h2>
        <div className="tabs">{METRICS.map((mt) => <button key={mt.key} className={`tab ${heatMetric === mt.key ? 'active' : ''}`} onClick={() => setHeatMetric(mt.key)}>{mt.label}</button>)}</div>
        <Figure title={`${metric.label} by model and target`} subtitle="Darker is higher. Cells show numerator / denominator; hover or focus for the rate and its interval." table={heatTable}>
          <Heatmap rows={heatRows} cols={heatCols} cell={heatCell} ariaLabel={`${metric.label} heatmap`} />
        </Figure>
      </section>

      <section id="matrix" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">3</span>Complete evaluation matrix</h2>
        <p className="small">Every rate shows numerator / eligible denominator with its 95% interval. No weighted composite is computed. Scope selects a target kind.</p>
        <div className="tabs">{SCOPES.map((s) => <button key={s} className={`tab ${matrixScope === s ? 'active' : ''}`} onClick={() => setMatrixScope(s)}>{TARGET_LABELS[s]}</button>)}</div>
        <MatrixTable summary={summary} scope={matrixScope} />
        <details className="small"><summary>Eligibility rules and denominators</summary><ul>{Object.entries(summary.eligibility_rules || {}).map(([k, v]) => <li key={k}><b>{k}</b>: {v}</li>)}</ul></details>
      </section>

      <section id="statements" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">4</span>Statement match distribution</h2>
        <Figure title="How each model's part-A statement compares with the audited reference" subtitle="Accepted matches are the three blue steps. stronger / weaker / different come only from expert review; unresolved means automation found no equivalence and needs review." legend={matchParts.map((p) => ({ label: p.label, color: p.color }))} table={matchTable}>
          <StackedBars rows={matchRows} parts={matchParts} ariaLabel="Statement match distribution" />
        </Figure>
      </section>

      <section id="time" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">5</span>Time per item (all attempts)</h2>
        <p className="small">Dot = median, band = interquartile range, tick = p90. Observed latency includes network and provider queueing; timing is reported regardless of success.</p>
        <div className="ev-grid-3">
          {timeKeys.map(([key, label, color]) => <Figure key={key} title={label} table={timeTable(key)} className="ch-compact"><RangeDots series={timeSeries(key)} color={color} fmt={fmtMs} ariaLabel={label} /></Figure>)}
        </div>
      </section>

      <section id="tokens" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">6</span>Tokens and cost</h2>
        <div className="ev-grid-2">
          <Figure title="Median tokens per item" subtitle="Only where the provider reports usage. Reasoning tokens are included in output tokens where the provider counts them." legend={[{ label: 'input', color: 'var(--s1)' }, { label: 'output', color: 'var(--s2)' }]} table={tokTable}>
            <GroupedBars rows={tokRows} series={[{ key: 'input', label: 'input', color: 'var(--s1)' }, { key: 'output', label: 'output', color: 'var(--s2)' }]} labelKey="output" fmtTick={(v) => fmtInt(v * tokMax)} ariaLabel="Median tokens per item" />
          </Figure>
          <Figure title="Cost per verified success" subtitle={anyCost ? 'USD, from configured pricing and reported usage.' : 'Unavailable: configure "pricing" in qedrank.config.json (USD per million tokens, keyed by model id) and re-run stats.'} table={{ columns: ['Model', 'Total USD', 'Priced items', 'Per verified success'], rows: models.map((m) => { const cst = summary.by_target.all?.[m.id]?.cost || {}; return [m.display_name, cst.total_usd === null || cst.total_usd === undefined ? 'n/a' : `$${fmtNum(cst.total_usd, 4)}`, cst.n_priced ?? 0, cst.per_verified_success_usd === null || cst.per_verified_success_usd === undefined ? 'n/a' : `$${fmtNum(cst.per_verified_success_usd, 3)}`] }) }}>
            {anyCost ? <HBars series={costSeries} color="var(--s3)" fmtTick={(v) => `$${fmtNum(v * costMax, 2)}`} ariaLabel="Cost per verified success" /> : <div className="ch-empty">No pricing configured.</div>}
          </Figure>
        </div>
      </section>

      <section id="calibration" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">7</span>Calibration</h2>
        <p className="small">Stated confidence against the observed outcome, ten equal-width bins; marker size grows with bin count. A perfectly calibrated model sits on the diagonal. RMS calibration error is listed per model.</p>
        <div className="ch-legend"><span><i style={{ background: 'var(--s1)' }} />statement fidelity (●)</span><span><i style={{ background: 'var(--s2)' }} />proof audit (■)</span></div>
        <div className="ev-grid-4">
          {models.map((m) => { const cal = summary.by_target.all?.[m.id]?.calibration; return (
            <Figure key={m.id} title={shortLabel(m)} subtitle={`RMS ${fmtNum(cal?.statement?.rms_calibration_error, 3)} (statement, n=${cal?.statement?.n ?? 0}) · ${fmtNum(cal?.proof_audit?.rms_calibration_error, 3)} (proof, n=${cal?.proof_audit?.n ?? 0}) · abstention ${fmtRate(cal?.abstention_coverage)}`} className="ch-compact" table={{ columns: ['Bin', 'Stmt n', 'Stmt conf', 'Stmt faithful', 'Proof n', 'Proof conf', 'Audit clean'], rows: (cal?.statement?.reliability || []).map((b, i) => { const p = cal?.proof_audit?.reliability?.[i] || {}; return [`${b.lo}–${b.hi}%`, b.n, b.n ? pct1(b.mean_confidence) : '—', b.n ? pct1(b.accuracy) : '—', p.n ?? 0, p.n ? pct1(p.mean_confidence) : '—', p.n ? pct1(p.accuracy) : '—'] }) }}>
              <Reliability statement={cal?.statement} proof={cal?.proof_audit} ariaLabel={`Reliability diagram for ${m.display_name}`} />
            </Figure>) })}
        </div>
      </section>

      <section id="comparison" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">8</span>{cmp?.k_models || models.length}-model comparison</h2>
        {cmp ? (
          <>
            <p className="small">{cmp.endpoint}: n = {cmp.n_common_papers} common papers (every model determinate). Cochran's Q tests whether the models differ at all; exact McNemar tests compare each pair on discordant papers with Holm correction across {cmp.pairwise.length} pairs. {cmp.note ? <b>{cmp.note}.</b> : null}</p>
            <div className="ev-ranking">
              <span className="small">Descriptive ranking:</span>
              {cmp.descriptive_ranking.map((r, i) => <span key={r.model} className="pill model-chip" style={{ '--mc': slotColor(r.model) }}><i className="chip-dot" />{i + 1}. {shortLabel(models.find((m) => m.id === r.model) || { id: r.model })} <b>{r.successes}/{r.n}</b></span>)}
            </div>
            <p className="small"><b>Statistically supported differences</b> (Holm-adjusted p &lt; 0.05): {cmp.statistically_supported_pairs.length ? cmp.statistically_supported_pairs.map((s) => s.replace(/ vs /, ' vs ')).join('; ') : 'none'}.</p>
            <div className="ev-grid-2">
              <Figure title="Paired difference in verified pass@1 (row − column, percentage points)" subtitle="Blue: the row model solved more common papers; red: fewer. ● marks a pair that stays significant after Holm correction. Hover or focus a cell for the interval, discordant counts and p-values." legend={[{ label: 'row better', color: 'var(--dv-p3)' }, { label: 'no difference', color: 'var(--div-mid)' }, { label: 'column better', color: 'var(--dv-n3)' }]} table={{ columns: ['Pair', 'A / B successes', 'Diff (pp)', '95% CI', 'Discordant A-only / B-only', 'McNemar p', 'Holm p'], rows: cmp.pairwise.map((p) => [`${shortLabel(models.find((m) => m.id === p.model_a) || { id: p.model_a })} vs ${shortLabel(models.find((m) => m.id === p.model_b) || { id: p.model_b })}`, `${p.a_successes} / ${p.b_successes} of ${p.n}`, fmtNum(p.diff_pp, 1), p.diff_ci_lo === null ? 'unavailable' : `[${fmtNum(p.diff_ci_lo, 1)}, ${fmtNum(p.diff_ci_hi, 1)}]`, `${p.discordant_a_only} / ${p.discordant_b_only}`, fmtNum(p.p, 4), fmtNum(p.p_holm, 4)]) }}>
                <PairMatrix models={models.map((m) => ({ id: m.id, label: shortLabel(m) }))} pairs={cmp.pairwise} ariaLabel="Pairwise comparison matrix" />
              </Figure>
              <div className="ch-figure"><div className="ch-head"><div className="ch-head-text"><div className="ch-title">All pairs</div><div className="ch-sub">Exact two-sided McNemar on discordant papers; paired percentage-point difference with a paper-cluster bootstrap interval.</div></div></div><ComparisonTable comparison={cmp} models={models} /></div>
            </div>
          </>
        ) : <p className="muted">No comparison was computed (fewer than two models or no common eligible papers).</p>}
      </section>

      <section id="subgroups" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">9</span>Subject and difficulty subgroups</h2>
        {sg ? (
          <>
            <p className="small">{sg.note}. Same paired papers; 95% paper-cluster intervals. Labels come from <code>qedrank-annotations.json</code> or the corpus index.</p>
            {[['By subject tag', sg.by_subject], ['By difficulty', sg.by_difficulty]].map(([title, groups]) => (
              <div key={title}>
                <h3 className="ev-h3">{title}</h3>
                {Object.keys(groups || {}).length === 0 && <p className="muted small">No labels in the manifest.</p>}
                <div className="ev-grid-3">
                  {Object.entries(groups || {}).map(([key, rows]) => {
                    const anyExploratory = models.some((m) => rows[m.id]?.exploratory)
                    const series = models.map((m) => { const r = rows[m.id]?.verified_pass1; const has = r && r.den > 0; return { id: m.id, label: shortLabel(m), value: has ? r.value : null, lo: has ? r.ci_lo ?? undefined : undefined, hi: has ? r.ci_hi ?? undefined : undefined, text: rateText(r), title: rateTitle(m.display_name, r, `Verified pass@1 · ${key}`) } })
                    return (
                      <Figure key={key} title={`${key} · ${Object.values(rows)[0]?.papers ?? 0} papers`} subtitle={anyExploratory ? 'exploratory: fewer papers than the threshold' : undefined} className="ch-compact" table={{ columns: ['Model', 'Papers', 'GT-faithful statement', 'Verified pass@1'], rows: models.map((m) => [m.display_name, rows[m.id]?.papers ?? 0, fmtRate(rows[m.id]?.statement_faithful), fmtRate(rows[m.id]?.verified_pass1)]) }}>
                        <HBars series={series} color="var(--s1)" ariaLabel={`Verified pass@1 in ${key}`} />
                      </Figure>)
                  })}
                </div>
              </div>
            ))}
          </>
        ) : <p className="muted">No subgroup analysis in this summary.</p>}
      </section>

      <section id="coverage" className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">10</span>Paper-level coverage, corpus coverage and reference audit</h2>
        <div className="ev-grid-2">
          <Figure title="Sandwich coverage" subtitle="Papers where main, upper and lower statements are all accepted matches and every bridge check passed." table={{ columns: ['Model', 'Sandwich coverage', '95% CI'], rows: models.map((m) => [m.display_name, fmtRate(pl[m.id]?.sandwich_coverage), fmtCI(pl[m.id]?.sandwich_coverage) || '—']) }}>
            <HBars series={sandwich} color="var(--s3)" ariaLabel="Sandwich coverage by model" />
          </Figure>
          <Figure title="Paper-level verified (all eligible bounds)" subtitle="Papers where every eligible bound target is a strict verified success." table={{ columns: ['Model', 'Paper-level verified', '95% CI'], rows: models.map((m) => [m.display_name, fmtRate(pl[m.id]?.paper_verified_all_eligible_bounds), fmtCI(pl[m.id]?.paper_verified_all_eligible_bounds) || '—']) }}>
            <HBars series={paperVerified} color="var(--s1)" ariaLabel="Paper-level verified by model" />
          </Figure>
        </div>
        <CoverageView summary={summary} />
      </section>
    </>
  )
}
