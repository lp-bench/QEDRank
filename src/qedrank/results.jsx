import { useMemo, useState } from 'react'
import { MODEL_ORDER, TARGET_KINDS, TARGET_LABELS, seriesColor, fmtRate, fmtCI, fmtMs, fmtNum, fmtInt, download, toCsv, rateOf, useDarkMode } from './helpers.js'

/* ------------------------------------------------------------------ */
/* Performance matrix                                                   */
/* ------------------------------------------------------------------ */

const MATRIX_COLUMNS = [
  ['Model', (m, mm) => m.display_name],
  ['Eligible n (stmt / proof)', (m, mm) => `${mm.eligible_statement} / ${mm.eligible_proof}`],
  ['GT-faithful statement', (m, mm) => <Rate r={mm.statement_faithful} />],
  ['Compile', (m, mm) => <><Rate r={mm.compile} /><div className="qr-small">abstained {mm.compile.abstained}, screened out {mm.compile.screen_rejected}</div></>],
  ['Verified pass@1', (m, mm) => <Rate r={mm.verified_pass1} />],
  ['Verified pass@k', (m, mm) => (mm.pass_at_k ? <Rate r={mm.pass_at_k} /> : <Unavail note="k = 1" />)],
  ['Repair setting', (m, mm) => (mm.repair ? <Rate r={mm.repair} /> : <Unavail note="disabled" />)],
  ['RMS calibration (stmt / proof)', (m, mm) => `${fmtNum(mm.calibration.statement.rms_calibration_error, 3)} / ${fmtNum(mm.calibration.proof_audit.rms_calibration_error, 3)}`],
  ['Median total time', (m, mm) => `${fmtMs(mm.time.total_item_ms.median)} (timeouts ${mm.time.total_item_ms.timeouts})`],
  ['Median latency / Lean', (m, mm) => `${fmtMs(mm.time.observed_model_latency_ms.median)} / ${fmtMs(mm.time.lean_total_ms.median)}`],
  ['Median tokens in / out', (m, mm) => (mm.tokens.n_with_usage ? `${fmtInt(mm.tokens.median_input)} / ${fmtInt(mm.tokens.median_output)}` : <Unavail note="no usage data" />)],
  ['Cost / verified success', (m, mm) => (mm.cost.available ? (mm.cost.per_verified_success_usd === null ? <Unavail note="no verified successes" /> : `$${fmtNum(mm.cost.per_verified_success_usd, 3)}`) : <Unavail note="pricing not configured" />)],
  ['Median proof LOC (model / eligible ref)', (m, mm) => `${mm.loc.median_model_proof_lines ?? 'unavailable'} / ${mm.loc.median_reference_proof_lines_eligible ?? 'unavailable'}`],
  ['Unresolved · abstention', (m, mm) => `${fmtRate(mm.unresolved)} · ${fmtRate(mm.abstention)}`],
  ['Infra failures', (m, mm) => mm.infrastructure_failures],
]

function Rate({ r }) {
  if (!r || r.den === undefined) return <Unavail />
  if (r.den === 0) return <Unavail note="0 eligible" />
  return <span><b>{r.num}/{r.den}</b> ({(100 * r.value).toFixed(1)}%)<div className="qr-small">{fmtCI(r)}</div></span>
}

function Unavail({ note }) {
  return <span className="qr-muted">unavailable{note ? ` (${note})` : ''}</span>
}

export function MatrixView({ summary }) {
  const [scope, setScope] = useState('all')
  const models = summary.models
  const rows = summary.by_target[scope] || {}
  return (
    <section className="qr-card">
      <h2>Performance matrix</h2>
      <p className="qr-muted">Primary endpoint (predefined): {summary.primary_endpoint?.description} Every rate shows numerator / eligible denominator. No weighted composite is computed.</p>
      <div className="qr-tabs">
        {['all', ...TARGET_KINDS].map((k) => <button key={k} className={`qr-tab ${scope === k ? 'active' : ''}`} onClick={() => setScope(k)}>{TARGET_LABELS[k]}</button>)}
      </div>
      <div className="qr-table-wrap">
        <table className="qr-table qr-matrix">
          <thead><tr>{MATRIX_COLUMNS.map(([h]) => <th key={h}>{h}</th>)}{scope === 'all' && <th>Sandwich coverage</th>}{scope === 'all' && <th>Paper-level verified</th>}</tr></thead>
          <tbody>
            {models.map((m) => {
              const mm = rows[m.id]
              if (!mm) return null
              const pl = summary.paper_level?.[m.id]
              return (
                <tr key={m.id}>
                  {MATRIX_COLUMNS.map(([h, fn], i) => <td key={h}>{i === 0 ? <span><span className="qr-swatch" style={{ background: seriesColor(m.id, useDarkMode()) }} />{fn(m, mm)}<div className="qr-small">{m.model_id}</div></span> : fn(m, mm)}</td>)}
                  {scope === 'all' && <td>{pl ? <Rate r={pl.sandwich_coverage} /> : <Unavail />}</td>}
                  {scope === 'all' && <td>{pl ? <Rate r={pl.paper_verified_all_eligible_bounds} /> : <Unavail />}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <details className="qr-small"><summary>Eligibility rules and denominators</summary><ul>{Object.entries(summary.eligibility_rules || {}).map(([k, v]) => <li key={k}><b>{k}</b>: {v}</li>)}</ul></details>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Charts (inline SVG)                                                  */
/* ------------------------------------------------------------------ */

function BarFacet({ title, series, dark, maxLabel = true }) {
  const [hover, setHover] = useState(null)
  const W = 320
  const H = 190
  const padL = 36
  const padB = 44
  const padT = 18
  const innerH = H - padB - padT
  const n = series.length
  const slot = (W - padL - 8) / n
  const barW = Math.min(28, slot * 0.6)
  const y = (v) => padT + innerH * (1 - v)
  return (
    <figure className="qr-figure" onMouseLeave={() => setHover(null)}>
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: verified pass@1 by model with 95% confidence intervals`}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => <g key={g}><line x1={padL} x2={W - 8} y1={y(g)} y2={y(g)} className="qr-grid" /><text x={padL - 4} y={y(g) + 3} textAnchor="end" className="qr-axis">{Math.round(g * 100)}%</text></g>)}
        <line x1={padL} x2={W - 8} y1={y(0)} y2={y(0)} className="qr-baseline" />
        {series.map((s, i) => {
          const cx = padL + slot * i + slot / 2
          const v = s.rate?.value
          const has = v !== null && v !== undefined
          const top = has ? y(v) : y(0)
          const color = seriesColor(s.id, dark)
          return (
            <g key={s.id} onMouseEnter={() => setHover(i)} tabIndex={0} onFocus={() => setHover(i)}>
              <rect x={cx - slot / 2} y={padT} width={slot} height={innerH} fill="transparent" />
              {has && <rect x={cx - barW / 2} y={top} width={barW} height={Math.max(0, y(0) - top)} rx="4" ry="4" fill={color} className="qr-bar-mark" />}
              {has && s.rate.ci_lo !== null && s.rate.ci_lo !== undefined && <line x1={cx} x2={cx} y1={y(s.rate.ci_lo)} y2={y(s.rate.ci_hi)} className="qr-ci" />}
              {has && s.rate.ci_lo !== null && s.rate.ci_lo !== undefined && <><line x1={cx - 5} x2={cx + 5} y1={y(s.rate.ci_lo)} y2={y(s.rate.ci_lo)} className="qr-ci" /><line x1={cx - 5} x2={cx + 5} y1={y(s.rate.ci_hi)} y2={y(s.rate.ci_hi)} className="qr-ci" /></>}
              <text x={cx} y={has ? top - 5 : y(0) - 5} textAnchor="middle" className="qr-label">{has ? `${s.rate.num}/${s.rate.den}` : 'n/a'}</text>
              <text x={cx} y={H - padB + 14} textAnchor="middle" className="qr-axis">{s.label}</text>
            </g>
          )
        })}
      </svg>
      {hover !== null && series[hover] && (
        <div className="qr-tooltip">
          <b>{series[hover].name}</b><br />
          {series[hover].rate ? `${fmtRate(series[hover].rate)} ${fmtCI(series[hover].rate)}` : 'unavailable'}
        </div>
      )}
    </figure>
  )
}

export function ChartsView({ summary }) {
  const dark = useDarkMode()
  const models = summary.models
  const short = (m) => m.display_name.replace('Gemini 1.5 Pro', 'Gemini').replace('Claude 3 Sonnet', 'Claude').replace('Command R+', 'Cmd R+').replace('Mistral Large', 'Mistral')
  const facets = ['all', ...TARGET_KINDS].map((k) => ({
    key: k,
    title: `Verified pass@1 — ${TARGET_LABELS[k]}`,
    series: models.map((m) => ({ id: m.id, name: m.display_name, label: short(m), rate: summary.by_target[k]?.[m.id]?.verified_pass1 })),
  }))
  const stmt = models.map((m) => ({ id: m.id, name: m.display_name, label: short(m), rate: summary.by_target.all?.[m.id]?.statement_faithful }))
  return (
    <section className="qr-card">
      <h2>Charts</h2>
      <div className="qr-legend">{models.map((m) => <span key={m.id}><i style={{ background: seriesColor(m.id, dark) }} />{m.display_name}</span>)}</div>
      <div className="qr-facets">
        <BarFacet title="GT-faithful statement — all targets" series={stmt} dark={dark} />
        {facets.map((f) => <BarFacet key={f.key} title={f.title} series={f.series} dark={dark} />)}
      </div>
      <h3>Reliability (confidence vs outcome)</h3>
      <div className="qr-facets">
        {models.map((m) => <Reliability key={m.id} model={m} cal={summary.by_target.all?.[m.id]?.calibration} dark={dark} />)}
      </div>
      <h3>Time per item (median, IQR, p90; all attempts)</h3>
      <TimeTable summary={summary} />
    </section>
  )
}

function Reliability({ model, cal, dark }) {
  const W = 220
  const H = 200
  const pad = 30
  const sx = (v) => pad + (W - pad - 8) * v
  const sy = (v) => H - pad - (H - pad - 12) * v
  const color = seriesColor(model.id, dark)
  const pts = (cal?.statement?.reliability || []).filter((b) => b.n > 0)
  const pts2 = (cal?.proof_audit?.reliability || []).filter((b) => b.n > 0)
  return (
    <figure className="qr-figure">
      <figcaption>{model.display_name} · RMS {fmtNum(cal?.statement?.rms_calibration_error, 3)} (stmt, n={cal?.statement?.n ?? 0}) / {fmtNum(cal?.proof_audit?.rms_calibration_error, 3)} (proof, n={cal?.proof_audit?.n ?? 0})</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Reliability diagram for ${model.display_name}`}>
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} className="qr-grid" />
        <line x1={sx(0)} x2={sx(1)} y1={sy(0)} y2={sy(0)} className="qr-baseline" />
        <line x1={sx(0)} x2={sx(0)} y1={sy(0)} y2={sy(1)} className="qr-baseline" />
        <text x={sx(0.5)} y={H - 6} textAnchor="middle" className="qr-axis">stated confidence</text>
        <text x={8} y={sy(0.5)} className="qr-axis" transform={`rotate(-90 8 ${sy(0.5)})`} textAnchor="middle">observed</text>
        {pts.map((b) => <circle key={`s${b.bin}`} cx={sx(b.mean_confidence)} cy={sy(b.accuracy)} r={Math.min(10, 4 + Math.sqrt(b.n))} fill={color} stroke="var(--qr-surface)" strokeWidth="2"><title>statement · bin {b.lo}–{b.hi}%: n={b.n}, conf {(100 * b.mean_confidence).toFixed(0)}%, faithful {(100 * b.accuracy).toFixed(0)}%</title></circle>)}
        {pts2.map((b) => <rect key={`p${b.bin}`} x={sx(b.mean_confidence) - 5} y={sy(b.accuracy) - 5} width="10" height="10" fill="none" stroke={color} strokeWidth="2"><title>proof audit · bin {b.lo}–{b.hi}%: n={b.n}, conf {(100 * b.mean_confidence).toFixed(0)}%, audit clean {(100 * b.accuracy).toFixed(0)}%</title></rect>)}
      </svg>
      <div className="qr-small">● statement fidelity · □ proof audit · abstention coverage {fmtRate(cal?.abstention_coverage)} · infra excluded {cal?.statement?.excluded_infrastructure_failures ?? 0}</div>
    </figure>
  )
}

function TimeTable({ summary }) {
  const models = summary.models
  const t = (m, key) => summary.by_target.all?.[m.id]?.time?.[key]
  return (
    <div className="qr-table-wrap">
      <table className="qr-table">
        <thead><tr><th>Model</th><th>Observed latency</th><th>Lean compile</th><th>Lean total</th><th>Total per item</th></tr></thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}><td>{m.display_name}</td>
              {['observed_model_latency_ms', 'lean_compile_ms', 'lean_total_ms', 'total_item_ms'].map((k) => {
                const s = t(m, k)
                return <td key={k}>{s && s.n ? `${fmtMs(s.median)} · IQR ${fmtMs(s.q1)}–${fmtMs(s.q3)} · p90 ${fmtMs(s.p90)} · n=${s.n} · timeouts ${s.timeouts}` : <Unavail />}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Five-model comparison, subgroups, coverage, defects                  */
/* ------------------------------------------------------------------ */

export function ComparisonView({ summary }) {
  const c = summary.five_model_comparison
  if (!c) return null
  return (
    <section className="qr-card">
      <h2>Five-model comparison (common eligible papers, primary endpoint)</h2>
      <p className="qr-muted">n = {c.n_common_papers} common papers. Cochran&apos;s Q = {fmtNum(c.cochran_q?.Q, 2)} (df {c.cochran_q?.df ?? 'n/a'}), p = {fmtNum(c.cochran_q?.p, 4)}{c.cochran_q?.note ? ` — ${c.cochran_q.note}` : ''}. {c.note}</p>
      <p><b>Descriptive ranking</b> (by point estimate): {c.descriptive_ranking.map((r) => `${r.model} ${r.successes}/${r.n}`).join(' › ')}</p>
      <p><b>Statistically supported differences</b> (Holm-adjusted p &lt; 0.05): {c.statistically_supported_pairs.length ? c.statistically_supported_pairs.join('; ') : 'none'}</p>
      <div className="qr-table-wrap">
        <table className="qr-table">
          <thead><tr><th>Pair</th><th>Successes A / B</th><th>Difference (pp)</th><th>95% CI (paper bootstrap)</th><th>Discordant A-only / B-only</th><th>Exact McNemar p</th><th>Holm p</th></tr></thead>
          <tbody>
            {c.pairwise.map((p) => (
              <tr key={p.key}><td>{p.model_a} vs {p.model_b}</td><td>{p.a_successes} / {p.b_successes} of {p.n}</td><td>{fmtNum(p.diff_pp, 1)}</td><td>{p.diff_ci_lo === null ? 'unavailable' : `[${fmtNum(p.diff_ci_lo, 1)}, ${fmtNum(p.diff_ci_hi, 1)}]`}</td><td>{p.discordant_a_only} / {p.discordant_b_only}</td><td>{fmtNum(p.p, 4)}</td><td>{fmtNum(p.p_holm, 4)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function SubgroupView({ summary }) {
  const sg = summary.subgroups
  if (!sg) return null
  const block = (title, groups) => (
    <div>
      <h3>{title}</h3>
      {Object.keys(groups).length === 0 && <p className="qr-muted">No labels in the manifest (add subject_tags / difficulty in qedrank-annotations.json).</p>}
      {Object.entries(groups).map(([key, rows]) => (
        <div className="qr-table-wrap" key={key}>
          <table className="qr-table">
            <thead><tr><th>{key}</th><th>Papers</th><th>GT-faithful statement</th><th>Verified pass@1</th><th /></tr></thead>
            <tbody>
              {summary.models.map((m) => {
                const r = rows[m.id]
                if (!r) return null
                return <tr key={m.id}><td>{m.display_name}</td><td>{r.papers}</td><td><Rate r={r.statement_faithful} /></td><td><Rate r={r.verified_pass1} /></td><td>{r.exploratory && <span className="qr-badge">exploratory</span>}</td></tr>
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
  return (
    <section className="qr-card">
      <h2>Subject and difficulty</h2>
      <p className="qr-muted">{sg.note}. Same paired papers; 95% paper-cluster CIs.</p>
      {block('By subject tag', sg.by_subject)}
      {block('By difficulty', sg.by_difficulty)}
    </section>
  )
}

export function CoverageView({ summary }) {
  const c = summary.coverage
  const d = summary.reference_defects
  return (
    <section className="qr-card">
      <h2>Corpus coverage and reference audit</h2>
      <div className="qr-kv">
        <div><span>Papers</span>{c.papers_discovered} discovered (expected {c.expected_count}; {c.expected_count_matches ? 'matches' : 'does not match'}), {c.papers_with_pdf} with PDF</div>
        <div><span>Audited reference statements</span>{TARGET_KINDS.map((k) => <b key={k}>{TARGET_LABELS[k]}: {c.references_audited?.[k] ?? 0}&nbsp;&nbsp;</b>)}</div>
        <div><span>Reference proof status</span>{TARGET_KINDS.map((k) => <code key={k}>{k}: {JSON.stringify(c.reference_proof_status?.[k] || {})} </code>)}</div>
        <div><span>Mathematical status</span>{TARGET_KINDS.map((k) => <code key={k}>{k}: {JSON.stringify(c.mathematical_status?.[k] || {})} </code>)}</div>
        <div><span>Eligible items</span>statement track {JSON.stringify(c.eligible_items?.statement_track)} · proof track {JSON.stringify(c.eligible_items?.proof_track)}</div>
        <div><span>Items</span>{c.items_total} total, {c.items_infrastructure_failed} infrastructure failures (excluded from denominators)</div>
        {c.open_claim_escalations?.length > 0 && <div><span className="qr-bad">Escalations</span>apparent proofs of open claims need independent review: {c.open_claim_escalations.join(', ')}</div>}
        <div><span>Reference defects</span>{d.references_reviewed}/{d.references_total} references expert-reviewed; {d.defects_recorded} defects recorded {Object.keys(d.defects_by_type || {}).length ? JSON.stringify(d.defects_by_type) : ''}; automated findings: {JSON.stringify(d.automated_findings)}</div>
        {d.corrections?.length > 0 && <div><span>Corrections</span>{d.corrections.map((x, i) => <code key={i}>{x.reference}: {x.type} — {x.reason}</code>)}</div>}
      </div>
      <details className="qr-small"><summary>Caveats</summary><ul>{summary.caveats.map((x, i) => <li key={i}>{x}</li>)}</ul></details>
      <h3>Subsets</h3>
      <div className="qr-table-wrap">
        <table className="qr-table">
          <thead><tr><th>Model</th><th>Common input set (all five determinate): verified pass@1</th><th>Common input set: GT-faithful</th><th>Text-only subset: verified pass@1</th></tr></thead>
          <tbody>{summary.models.map((m) => { const s = summary.subsets?.[m.id]; return s ? <tr key={m.id}><td>{m.display_name}</td><td><Rate r={s.common_input_set.verified_pass1} /></td><td><Rate r={s.common_input_set.statement_faithful} /></td><td>{s.text_only_subset.note ? <Unavail note={s.text_only_subset.note} /> : <Rate r={s.text_only_subset.verified_pass1} />}</td></tr> : null })}</tbody>
        </table>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Item-level table with filters and exports                            */
/* ------------------------------------------------------------------ */

const ITEM_FILTERS = [
  ['model', 'Model'], ['paper_id', 'Paper'], ['target_kind', 'Target'], ['mathematical_status', 'Math status'], ['statement_match', 'Statement match'], ['compile_status', 'Compile'], ['audit_status', 'Audit'], ['setting', 'Setting'],
]

export function ItemsView({ items, runId }) {
  const [filters, setFilters] = useState({})
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState(null)
  const options = useMemo(() => Object.fromEntries(ITEM_FILTERS.map(([k]) => [k, [...new Set(items.map((r) => r[k]).filter((v) => v !== null && v !== undefined))].sort()])), [items])
  const filtered = useMemo(() => items.filter((r) => ITEM_FILTERS.every(([k]) => !filters[k] || String(r[k]) === filters[k]) && (!search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase()))), [items, filters, search])
  const pageSize = 50
  const shown = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const primary = filtered.filter((r) => r.setting === 'pass@1' && r.attempt === 1 && r.repair_round === 0 && !r.infrastructure_failure)
  const rStmt = rateOf(primary, (r) => r.statement_faithful === 1, (r) => r.eligible_statement_track)
  const rComp = rateOf(primary, (r) => r.compiled === 1, (r) => r.compiled === 0 || r.compiled === 1)
  const rVer = rateOf(primary, (r) => r.verified === 1, (r) => r.eligible_proof_track)
  return (
    <section className="qr-card">
      <h2>Item-level results</h2>
      <div className="qr-form qr-form-row">
        {ITEM_FILTERS.map(([k, label]) => (
          <label key={k}>{label}
            <select value={filters[k] || ''} onChange={(e) => { setFilters({ ...filters, [k]: e.target.value }); setPage(0) }}>
              <option value="">all</option>
              {options[k].map((v) => <option key={v} value={v}>{String(v)}</option>)}
            </select>
          </label>
        ))}
        <label>Search<input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="paper, note, error…" /></label>
      </div>
      <p className="qr-small">{filtered.length} records match. Filtered pass@1 rates (no CI): GT-faithful {fmtRate(rStmt)} · compile {fmtRate(rComp)} · verified {fmtRate(rVer)}. Infrastructure failures excluded: {filtered.filter((r) => r.infrastructure_failure).length}.</p>
      <div className="qr-actions">
        <button className="qr-btn qr-btn-secondary" onClick={() => download(`${runId || 'qedrank'}-items-filtered.csv`, toCsv(filtered), 'text/csv')}>Download filtered CSV</button>
        <button className="qr-btn qr-btn-secondary" onClick={() => download(`${runId || 'qedrank'}-items-filtered.json`, JSON.stringify({ schema: 'qedrank-items-v1', run_id: runId, count: filtered.length, items: filtered }, null, 2), 'application/json')}>Download filtered JSON</button>
      </div>
      <div className="qr-table-wrap">
        <table className="qr-table qr-items">
          <thead><tr><th>Paper</th><th>Target</th><th>Model</th><th>Setting</th><th>Compile</th><th>Audit</th><th>Statement match</th><th>Verified</th><th>Conf (stmt/proof)</th><th>Latency</th><th>Lean</th><th /></tr></thead>
          <tbody>
            {shown.map((r, i) => {
              const key = `${r.item_key}-${r.setting}-${r.attempt}-${r.repair_round}`
              return (
                <>
                  <tr key={key} className={r.infrastructure_failure ? 'qr-row-infra' : r.verified === 1 ? 'qr-row-ok' : ''}>
                    <td><code>{r.paper_id}</code></td><td>{TARGET_LABELS[r.target_kind] || r.target_kind}</td><td>{r.model}</td><td>{r.setting} a{r.attempt}{r.repair_round ? ` r${r.repair_round}` : ''}</td>
                    <td><Status v={r.compile_status} /></td><td><Status v={r.audit_status} /></td><td><Status v={r.statement_match} />{r.statement_match_source === 'expert_review' && <span className="qr-badge">expert</span>}</td>
                    <td>{r.infrastructure_failure ? <span className="qr-muted">infra</span> : r.verified === 1 ? <b className="qr-good">yes</b> : r.verified === 0 ? 'no' : <span className="qr-muted">n/e</span>}</td>
                    <td>{r.statement_confidence ?? '–'} / {r.proof_confidence ?? '–'}</td><td>{fmtMs(r.observed_latency_ms)}</td><td>{fmtMs(r.lean_total_ms)}</td>
                    <td><button className="qr-link" onClick={() => setOpen(open === key ? null : key)}>{open === key ? 'hide' : 'details'}</button></td>
                  </tr>
                  {open === key && (
                    <tr key={`${key}-d`} className="qr-details"><td colSpan="12">
                      <div className="qr-kv">
                        <div><span>Model id</span><code>{r.model_id}</code>{r.response_model ? <code> ({r.response_model})</code> : null} · prompt {r.prompt_hash?.slice(0, 12)} · T={r.temperature} · max tokens {r.max_tokens}</div>
                        <div><span>Eligibility</span>statement {String(r.eligible_statement_track)} · proof {String(r.eligible_proof_track)} {r.eligibility_reasons && <code>{r.eligibility_reasons}</code>}</div>
                        <div><span>Reference</span>{r.reference_proof_status} · statement available: {String(r.reference_statement_available)} · math status {r.mathematical_status}</div>
                        {r.generation_error && <div><span>Generation error</span><code>{r.generation_error}</code></div>}
                        {r.static_screen_rejections && <div><span>Static screen</span><code>{r.static_screen_rejections}</code></div>}
                        {r.axioms && <div><span>Axioms</span><code>{r.axioms}</code></div>}
                        {r.audit_static_flags && <div><span>Static flags</span><code>{r.audit_static_flags}</code></div>}
                        <div><span>A/B consistent</span>{String(r.ab_consistent)}</div>
                        {r.comparison_notes && <div><span>Comparison</span>{r.statement_match_method}: {r.comparison_notes}</div>}
                        {r.lean_diagnostics && <div><span>Lean diagnostics</span><pre>{r.lean_diagnostics}</pre></div>}
                        <div><span>LOC</span>model {r.model_code_lines ?? '–'} code / {r.model_proof_lines ?? '–'} proof · reference {r.reference_code_lines ?? '–'} / {r.reference_proof_lines ?? '–'}</div>
                        <div><span>Tokens / cost</span>{r.input_tokens ?? 'n/a'} in, {r.output_tokens ?? 'n/a'} out, {r.cost_usd === null || r.cost_usd === undefined ? 'cost unavailable' : `$${r.cost_usd}`}</div>
                        {r.notes && <div><span>Notes</span>{r.notes}</div>}
                      </div>
                    </td></tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="qr-actions">
        <button className="qr-btn qr-btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="qr-small">page {page + 1} of {Math.max(1, Math.ceil(filtered.length / pageSize))}</span>
        <button className="qr-btn qr-btn-secondary" disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  )
}

function Status({ v }) {
  if (v === null || v === undefined) return <span className="qr-muted">–</span>
  const good = ['compiler_success', 'clean', 'definitionally_identical', 'equivalent', 'expert_confirmed_equivalent']
  const bad = ['compiler_failure', 'placeholder', 'user_axiom', 'unsafe', 'forbidden_command', 'disallowed_import', 'different', 'rejected_by_static_screen']
  const cls = good.includes(v) ? 'qr-good' : bad.includes(v) ? 'qr-bad' : v === 'infrastructure_failure' || v === 'timeout' ? 'qr-warn' : ''
  return <span className={cls}>{v.replace(/_/g, ' ')}</span>
}
