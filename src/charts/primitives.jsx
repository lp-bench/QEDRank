// Inline-SVG chart primitives shared by the pages. Marks are thin, labels wear text tokens,
// every figure has a table twin, and hover/focus show the same tooltip.

import { useRef, useState } from 'react'

export const pct = (v) => `${Math.round(100 * v)}%`
export const pct1 = (v) => `${(100 * v).toFixed(1)}%`
export const trunc = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Rounded data-end (4px), square at the baseline. */
export function barPath(x0, y, w, h, r = 4) {
  if (w <= 0) return ''
  const rr = Math.min(r, w, h / 2)
  return `M${x0},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr} z`
}

/** "Nice" tick values for a linear axis from 0 to max. */
export function niceTicks(max, count = 5) {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw
  const ticks = []
  for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(Number(t.toFixed(10)))
  return ticks
}

/* ---------------------------------------------------------------------------------- */
/* Tooltip                                                                            */
/* ---------------------------------------------------------------------------------- */

export function useTip(viewW) {
  const ref = useRef(null)
  const svgRef = useRef(null)
  const [tip, setTip] = useState(null)
  const place = (x, y, content) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setTip({ x: Math.max(0, Math.min(x, r.width - 230)), y, content })
  }
  const showAtPointer = (e, content) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    place(e.clientX - r.left + 12, e.clientY - r.top + 12, content)
  }
  // Keyboard focus: position from viewBox coordinates.
  const showAtSvg = (px, py, content) => {
    const r = ref.current?.getBoundingClientRect()
    const s = svgRef.current?.getBoundingClientRect()
    if (!r || !s) return
    const k = s.width / viewW
    place(s.left - r.left + px * k + 8, s.top - r.top + py * k + 8, content)
  }
  return { ref, svgRef, tip, showAtPointer, showAtSvg, hide: () => setTip(null) }
}

export function Tip({ tip }) {
  if (!tip) return null
  return <div className="ch-tip" role="status" style={{ left: tip.x, top: tip.y }}>{tip.content}</div>
}

/* ---------------------------------------------------------------------------------- */
/* Figure wrapper with chart | table toggle                                           */
/* ---------------------------------------------------------------------------------- */

export function Figure({ title, subtitle, legend, table, children, className = '', actions }) {
  const [view, setView] = useState('chart')
  return (
    <figure className={`ch-figure ${className}`}>
      <div className="ch-head">
        <div className="ch-head-text">
          <figcaption className="ch-title">{title}</figcaption>
          {subtitle && <div className="ch-sub">{subtitle}</div>}
        </div>
        <div className="row">
          {actions}
          {table && (
            <div className="ch-toggle" role="group" aria-label="View">
              <button type="button" className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>Chart</button>
              <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
            </div>
          )}
        </div>
      </div>
      {legend && view === 'chart' && (
        <div className="ch-legend">{legend.map((l) => <span key={l.label}><i style={{ background: l.color }} className={l.shape === 'line' ? 'line' : ''} />{l.label}</span>)}</div>
      )}
      {view === 'chart' ? children : <DataTable table={table} />}
    </figure>
  )
}

export function DataTable({ table }) {
  if (!table) return null
  return (
    <div className="table-wrap ch-table-wrap">
      <table className="table">
        <thead><tr>{table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j > 0 ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Horizontal bars, one hue, optional CI whiskers                                     */
/* ---------------------------------------------------------------------------------- */

/**
 * series: [{ id, label, value, lo, hi, text, title, color }]  (value in [0, max])
 */
export function HBars({ series, max = 1, color = 'var(--s1)', fmtTick = pct, ticks, ariaLabel }) {
  const W = 640
  const padL = 150
  const padR = 86
  const padT = 6
  const padB = 24
  const rowH = 26
  const barH = 12
  const H = padT + padB + rowH * Math.max(1, series.length)
  const innerW = W - padL - padR
  const x = (v) => padL + innerW * Math.max(0, Math.min(1, v / max))
  const tk = ticks || [0, 0.25, 0.5, 0.75, 1].map((t) => t * max)
  const { ref, svgRef, tip, showAtPointer, showAtSvg, hide } = useTip(W)
  const content = (s) => s.title ?? <span><b>{s.label}</b><br />{s.text ?? (typeof s.value === 'number' ? fmtTick(s.value) : 'unavailable')}</span>
  return (
    <div className="ch-wrap" ref={ref} onPointerLeave={hide}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel || 'Bar chart'}>
        {tk.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - 8} textAnchor="middle" className="ch-axis">{fmtTick(t)}</text></g>)}
        <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} className="ch-baseline" />
        {series.map((s, i) => {
          const cy = padT + rowH * i + rowH / 2
          const has = typeof s.value === 'number' && Number.isFinite(s.value)
          const hasCI = has && typeof s.lo === 'number' && typeof s.hi === 'number'
          return (
            <g key={s.id ?? i} tabIndex={0} className="ch-row" onPointerMove={(e) => showAtPointer(e, content(s))} onFocus={() => showAtSvg(x(has ? s.value : 0), cy, content(s))} onBlur={hide}>
              <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill="transparent" />
              <text x={padL - 8} y={cy + 4} textAnchor="end" className="ch-label"><title>{s.label}</title>{trunc(s.label, 22)}</text>
              {has && <path d={barPath(x(0), cy - barH / 2, x(s.value) - x(0), barH)} fill={s.color || color} className="ch-bar" />}
              {hasCI && <g className="ch-ci"><line x1={x(s.lo)} x2={x(s.hi)} y1={cy} y2={cy} /><line x1={x(s.lo)} x2={x(s.lo)} y1={cy - 4} y2={cy + 4} /><line x1={x(s.hi)} x2={x(s.hi)} y1={cy - 4} y2={cy + 4} /></g>}
              <text x={W - padR + 8} y={cy + 4} className="ch-value">{has ? (s.text ?? fmtTick(s.value)) : 'n/a'}</text>
            </g>
          )
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Grouped horizontal bars: one row per entity, one thin bar per series               */
/* ---------------------------------------------------------------------------------- */

/**
 * rows: [{ id, label, values: { [key]: { value, text, title } } }]
 * series: [{ key, label, color }]
 */
export function GroupedBars({ rows, series, max = 1, fmtTick = pct, ariaLabel, labelKey }) {
  const W = 640
  const padL = 150
  const padR = 86
  const padT = 6
  const padB = 24
  const barH = 8
  const gap = 2
  const rowH = 10 + series.length * (barH + gap)
  const H = padT + padB + rowH * Math.max(1, rows.length)
  const innerW = W - padL - padR
  const x = (v) => padL + innerW * Math.max(0, Math.min(1, v / max))
  const tk = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max)
  const { ref, svgRef, tip, showAtPointer, showAtSvg, hide } = useTip(W)
  const content = (r) => (
    <span><b>{r.label}</b>{series.map((s) => { const v = r.values[s.key]; return <span key={s.key}><br /><i className="ch-key" style={{ background: s.color }} />{s.label}: <b>{v && typeof v.value === 'number' ? (v.text ?? fmtTick(v.value)) : 'n/a'}</b></span> })}</span>
  )
  return (
    <div className="ch-wrap" ref={ref} onPointerLeave={hide}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel || 'Grouped bar chart'}>
        {tk.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - 8} textAnchor="middle" className="ch-axis">{fmtTick(t)}</text></g>)}
        <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} className="ch-baseline" />
        {rows.map((r, i) => {
          const top = padT + rowH * i + 5
          const cy = padT + rowH * i + rowH / 2
          const lead = r.values[labelKey || series[0].key]
          return (
            <g key={r.id ?? i} tabIndex={0} className="ch-row" onPointerMove={(e) => showAtPointer(e, content(r))} onFocus={() => showAtSvg(padL, cy, content(r))} onBlur={hide}>
              <rect x={0} y={padT + rowH * i} width={W} height={rowH} fill="transparent" />
              <text x={padL - 8} y={cy + 4} textAnchor="end" className="ch-label"><title>{r.label}</title>{trunc(r.label, 22)}</text>
              {series.map((s, j) => {
                const v = r.values[s.key]
                const has = v && typeof v.value === 'number' && Number.isFinite(v.value)
                const y = top + j * (barH + gap)
                return has ? <path key={s.key} d={barPath(x(0), y, x(v.value) - x(0), barH, 3)} fill={s.color} className="ch-bar" /> : null
              })}
              <text x={W - padR + 8} y={cy + 4} className="ch-value">{lead && typeof lead.value === 'number' ? (lead.text ?? fmtTick(lead.value)) : 'n/a'}</text>
            </g>
          )
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Heatmap (sequential ramp)                                                          */
/* ---------------------------------------------------------------------------------- */

const SEQ_STEPS = 5
export function seqClass(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'seq-none'
  const i = Math.min(SEQ_STEPS - 1, Math.floor(v * SEQ_STEPS))
  return `seq-${i + 1}`
}

/**
 * rows: [{ id, label }], cols: [{ id, label }], cell(rowId, colId) -> { value in [0,1] | null, text, title }
 */
export function Heatmap({ rows, cols, cell, ariaLabel }) {
  const padL = 150
  const cw = 96
  const ch = 32
  const W = padL + cw * cols.length + 8
  const H = 24 + ch * rows.length + 6
  const { ref, svgRef, tip, showAtPointer, showAtSvg, hide } = useTip(W)
  return (
    <div className="ch-wrap" ref={ref} onPointerLeave={hide}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel || 'Heatmap'} style={{ maxWidth: `${W}px` }}>
        {cols.map((c, j) => <text key={c.id} x={padL + cw * j + cw / 2} y={14} textAnchor="middle" className="ch-axis">{trunc(c.label, 14)}</text>)}
        {rows.map((r, i) => (
          <g key={r.id}>
            <text x={padL - 8} y={24 + ch * i + ch / 2 + 4} textAnchor="end" className="ch-label"><title>{r.label}</title>{trunc(r.label, 22)}</text>
            {cols.map((c, j) => {
              const v = cell(r.id, c.id) || {}
              const cls = seqClass(v.value)
              const cx = padL + cw * j
              const cy = 24 + ch * i
              const content = v.title ?? <span><b>{r.label}</b> · {c.label}<br />{v.text ?? 'unavailable'}</span>
              return (
                <g key={c.id} tabIndex={0} className="ch-cell" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(cx + cw / 2, cy + ch / 2, content)} onBlur={hide}>
                  <rect x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className={`hm ${cls}`} />
                  <text x={cx + cw / 2} y={cy + ch / 2 + 4} textAnchor="middle" className={`hm-text ${cls}`}>{v.text ?? '–'}</text>
                </g>
              )
            })}
          </g>
        ))}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Range dots: median with IQR band and p90 tick, one hue                             */
/* ---------------------------------------------------------------------------------- */

/** series: [{ id, label, q1, median, q3, p90, n, timeouts }] */
export function RangeDots({ series, color = 'var(--s1)', fmt = (v) => String(v), ariaLabel }) {
  const W = 640
  const padL = 150
  const padR = 86
  const padT = 6
  const padB = 24
  const rowH = 26
  const H = padT + padB + rowH * Math.max(1, series.length)
  const innerW = W - padL - padR
  const maxV = Math.max(0, ...series.flatMap((s) => [s.p90, s.q3, s.median].filter((v) => typeof v === 'number')))
  const tk = niceTicks(maxV || 1)
  const max = tk[tk.length - 1] || 1
  const x = (v) => padL + innerW * Math.max(0, Math.min(1, v / max))
  const { ref, svgRef, tip, showAtPointer, showAtSvg, hide } = useTip(W)
  const content = (s) => <span><b>{s.label}</b><br />median <b>{fmt(s.median)}</b> · IQR {fmt(s.q1)}–{fmt(s.q3)} · p90 {fmt(s.p90)}<br />n = {s.n ?? '?'}{s.timeouts ? ` · timeouts ${s.timeouts}` : ''}</span>
  return (
    <div className="ch-wrap" ref={ref} onPointerLeave={hide}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel || 'Range chart'}>
        {tk.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - 8} textAnchor="middle" className="ch-axis">{fmt(t)}</text></g>)}
        <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} className="ch-baseline" />
        {series.map((s, i) => {
          const cy = padT + rowH * i + rowH / 2
          const has = typeof s.median === 'number'
          return (
            <g key={s.id ?? i} tabIndex={0} className="ch-row" onPointerMove={(e) => showAtPointer(e, content(s))} onFocus={() => showAtSvg(x(has ? s.median : 0), cy, content(s))} onBlur={hide}>
              <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill="transparent" />
              <text x={padL - 8} y={cy + 4} textAnchor="end" className="ch-label"><title>{s.label}</title>{trunc(s.label, 22)}</text>
              {has && typeof s.q1 === 'number' && typeof s.q3 === 'number' && <rect x={x(s.q1)} y={cy - 4} width={Math.max(1, x(s.q3) - x(s.q1))} height={8} rx={4} fill={color} opacity={0.35} />}
              {has && typeof s.p90 === 'number' && <line x1={x(s.p90)} x2={x(s.p90)} y1={cy - 6} y2={cy + 6} stroke={color} strokeWidth={2} />}
              {has && <circle cx={x(s.median)} cy={cy} r={5} fill={color} className="ch-dot" />}
              <text x={W - padR + 8} y={cy + 4} className="ch-value">{has ? fmt(s.median) : 'n/a'}</text>
            </g>
          )
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Stacked horizontal bars (part-to-whole)                                            */
/* ---------------------------------------------------------------------------------- */

/** rows: [{ id, label, counts: { [key]: n } }], parts: [{ key, label, color }] */
export function StackedBars({ rows, parts, ariaLabel }) {
  const W = 640
  const padL = 150
  const padR = 60
  const padT = 6
  const padB = 10
  const rowH = 26
  const barH = 14
  const H = padT + padB + rowH * Math.max(1, rows.length)
  const innerW = W - padL - padR
  const { ref, svgRef, tip, showAtPointer, showAtSvg, hide } = useTip(W)
  return (
    <div className="ch-wrap" ref={ref} onPointerLeave={hide}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel || 'Stacked bar chart'}>
        {rows.map((r, i) => {
          const cy = padT + rowH * i + rowH / 2
          const total = parts.reduce((s, p) => s + (r.counts[p.key] || 0), 0)
          let cursor = padL
          return (
            <g key={r.id ?? i}>
              <text x={padL - 8} y={cy + 4} textAnchor="end" className="ch-label"><title>{r.label}</title>{trunc(r.label, 22)}</text>
              {total === 0 && <text x={padL} y={cy + 4} className="ch-axis">no eligible items</text>}
              {parts.map((p) => {
                const n = r.counts[p.key] || 0
                if (!n) return null
                const w = (innerW * n) / total
                const x0 = cursor
                cursor += w
                const content = <span><b>{r.label}</b><br /><i className="ch-key" style={{ background: p.color }} />{p.label}: <b>{n}</b> of {total} ({pct1(n / total)})</span>
                return (
                  <g key={p.key} tabIndex={0} className="ch-cell" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(x0 + w / 2, cy, content)} onBlur={hide}>
                    <rect x={x0 + 1} y={cy - barH / 2} width={Math.max(0, w - 2)} height={barH} rx={3} fill={p.color} />
                    {w > 36 && <text x={x0 + w / 2} y={cy + 4} textAnchor="middle" className="ch-inlabel">{n}</text>}
                  </g>
                )
              })}
              <text x={W - padR + 8} y={cy + 4} className="ch-value">{total}</text>
            </g>
          )
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Reliability diagram (stated confidence vs observed rate)                           */
/* ---------------------------------------------------------------------------------- */

export function Reliability({ statement, proof, ariaLabel }) {
  const W = 240
  const H = 220
  const pad = 34
  const sx = (v) => pad + (W - pad - 10) * v
  const sy = (v) => H - pad - (H - pad - 12) * v
  const pts = (statement?.reliability || []).filter((b) => b.n > 0)
  const pts2 = (proof?.reliability || []).filter((b) => b.n > 0)
  const { ref, svgRef, tip, showAtPointer, showAtSvg, hide } = useTip(W)
  return (
    <div className="ch-wrap" ref={ref} onPointerLeave={hide}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel || 'Reliability diagram'}>
        {[0.25, 0.5, 0.75].map((g) => <g key={g}><line x1={sx(g)} x2={sx(g)} y1={sy(0)} y2={sy(1)} className="ch-grid" /><line x1={sx(0)} x2={sx(1)} y1={sy(g)} y2={sy(g)} className="ch-grid" /></g>)}
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} className="ch-ident" />
        <line x1={sx(0)} x2={sx(1)} y1={sy(0)} y2={sy(0)} className="ch-baseline" />
        <line x1={sx(0)} x2={sx(0)} y1={sy(0)} y2={sy(1)} className="ch-baseline" />
        {[0, 0.5, 1].map((t) => <text key={t} x={sx(t)} y={H - pad + 14} textAnchor="middle" className="ch-axis">{pct(t)}</text>)}
        {[0, 0.5, 1].map((t) => <text key={t} x={pad - 6} y={sy(t) + 4} textAnchor="end" className="ch-axis">{pct(t)}</text>)}
        <text x={sx(0.5)} y={H - 4} textAnchor="middle" className="ch-axis">stated confidence</text>
        <text x={10} y={sy(0.5)} className="ch-axis" transform={`rotate(-90 10 ${sy(0.5)})`} textAnchor="middle">observed</text>
        {pts.map((b) => {
          const content = <span><b>Statement</b> · bin {b.lo}–{b.hi}%<br />n = {b.n} · confidence {pct(b.mean_confidence)} · faithful {pct(b.accuracy)}</span>
          return <circle key={`s${b.bin}`} tabIndex={0} cx={sx(b.mean_confidence)} cy={sy(b.accuracy)} r={Math.min(10, 4 + Math.sqrt(b.n))} fill="var(--s1)" className="ch-dot" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(sx(b.mean_confidence), sy(b.accuracy), content)} onBlur={hide} />
        })}
        {pts2.map((b) => {
          const content = <span><b>Proof audit</b> · bin {b.lo}–{b.hi}%<br />n = {b.n} · confidence {pct(b.mean_confidence)} · audit clean {pct(b.accuracy)}</span>
          const r = Math.min(10, 4 + Math.sqrt(b.n))
          return <rect key={`p${b.bin}`} tabIndex={0} x={sx(b.mean_confidence) - r} y={sy(b.accuracy) - r} width={2 * r} height={2 * r} rx={2} fill="var(--s2)" className="ch-dot" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(sx(b.mean_confidence), sy(b.accuracy), content)} onBlur={hide} />
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Pairwise matrix (diverging): row model minus column model, in percentage points     */
/* ---------------------------------------------------------------------------------- */

export function dvClass(diff, scale) {
  if (typeof diff !== 'number' || !Number.isFinite(diff) || !(scale > 0)) return 'dv-0'
  const r = diff / scale
  if (Math.abs(r) < 0.1) return 'dv-0'
  const i = Math.min(3, Math.ceil(Math.abs(r) * 3))
  return r > 0 ? `dv-p${i}` : `dv-n${i}`
}

/** models: [{ id, label }], pairs from summary.model_comparison.pairwise */
export function PairMatrix({ models, pairs, ariaLabel }) {
  const padL = 150
  const cw = 64
  const ch = 32
  const W = padL + cw * models.length + 8
  const H = 40 + ch * models.length + 6
  const byKey = new Map()
  for (const p of pairs) { byKey.set(`${p.model_a}|${p.model_b}`, p); byKey.set(`${p.model_b}|${p.model_a}`, { ...p, flipped: true }) }
  const scale = Math.max(1, ...pairs.map((p) => Math.abs(p.diff_pp || 0)))
  const { ref, svgRef, tip, showAtPointer, showAtSvg, hide } = useTip(W)
  const labelOf = (id) => models.find((m) => m.id === id)?.label || id
  return (
    <div className="ch-wrap" ref={ref} onPointerLeave={hide}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel || 'Pairwise comparison matrix'} style={{ maxWidth: `${W}px` }}>
        {models.map((c, j) => <text key={c.id} x={padL + cw * j + cw / 2} y={30} textAnchor="middle" className="ch-axis" transform={`rotate(-20 ${padL + cw * j + cw / 2} 30)`}>{trunc(c.label, 12)}</text>)}
        {models.map((r, i) => (
          <g key={r.id}>
            <text x={padL - 8} y={40 + ch * i + ch / 2 + 4} textAnchor="end" className="ch-label"><title>{r.label}</title>{trunc(r.label, 22)}</text>
            {models.map((c, j) => {
              const cx = padL + cw * j
              const cy = 40 + ch * i
              if (i === j) return <rect key={c.id} x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className="hm dv-diag" />
              const p = byKey.get(`${r.id}|${c.id}`)
              if (!p) return <rect key={c.id} x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className="hm seq-none" />
              const diff = p.flipped ? -p.diff_pp : p.diff_pp
              const lo = p.flipped ? (p.diff_ci_hi === null ? null : -p.diff_ci_hi) : p.diff_ci_lo
              const hi = p.flipped ? (p.diff_ci_lo === null ? null : -p.diff_ci_lo) : p.diff_ci_hi
              const sig = p.p_holm !== null && p.p_holm !== undefined && p.p_holm < 0.05
              const content = <span><b>{labelOf(r.id)}</b> − <b>{labelOf(c.id)}</b><br />{diff >= 0 ? '+' : ''}{diff.toFixed(1)} pp {lo === null ? '' : `[${lo.toFixed(1)}, ${hi.toFixed(1)}]`}<br />discordant {p.flipped ? p.discordant_b_only : p.discordant_a_only} / {p.flipped ? p.discordant_a_only : p.discordant_b_only} · n = {p.n}<br />McNemar p = {p.p?.toFixed(4)} · Holm p = {p.p_holm === null ? 'n/a' : p.p_holm.toFixed(4)}{sig ? ' · supported' : ''}</span>
              return (
                <g key={c.id} tabIndex={0} className="ch-cell" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(cx + cw / 2, cy + ch / 2, content)} onBlur={hide}>
                  <rect x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className={`hm ${dvClass(diff, scale)} ${sig ? 'sig' : ''}`} />
                  <text x={cx + cw / 2} y={cy + ch / 2 + 4} textAnchor="middle" className={`hm-text ${dvClass(diff, scale)}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(0)}{sig ? '●' : ''}</text>
                </g>
              )
            })}
          </g>
        ))}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}
