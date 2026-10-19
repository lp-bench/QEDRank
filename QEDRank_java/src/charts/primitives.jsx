// Inline-SVG chart primitives shared by the pages. Marks are thin, labels wear text tokens,
// every figure has a table twin, and hover/focus show the same tooltip.

import { Component, createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'

export const pct = (v) => `${Math.round(100 * v)}%`
export const pct1 = (v) => `${(100 * v).toFixed(1)}%`
export const trunc = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/* ---------------------------------------------------------------------------------- */
/* Fluid sizing                                                                       */
/* ---------------------------------------------------------------------------------- */

/**
 * Opt-in for a page: { height, compactHeight } in px. Charts under it are drawn at their box's
 * pixel width (so text keeps its CSS size, horizontal scroll if the box is too narrow) and aim
 * for `height`; figures get an Enlarge control. Without it a chart scales a fixed viewBox.
 */
export const ChartSizing = createContext(null)

// Rendered sizes in fluid mode; they must match the .ch-fluid rules in evaluation.css.
const FONT = 14
const AXIS = 13
const MIN_PLOT = 96

// Text width in px with the page font (semibold, the widest label weight); estimated without a canvas.
let measure
function textW(s, px = FONT) {
  const str = String(s ?? '')
  if (measure === undefined) {
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    const family = ctx ? getComputedStyle(document.body).fontFamily : ''
    measure = ctx ? (t, size) => { ctx.font = `600 ${size}px ${family}`; return ctx.measureText(t).width } : null
  }
  return measure ? measure(str, px) : str.length * px * 0.58
}

/** The label, shortened with an ellipsis until it fits in w px. */
function fitLabel(s, w, px = FONT) {
  if (typeof s !== 'string' || textW(s, px) <= w) return s
  let n = s.length
  while (n > 4 && textW(`${s.slice(0, n - 1)}…`, px) > w) n--
  return `${s.slice(0, n - 1)}…`
}

/** The box width in CSS px and the height to aim for, or null when the page did not opt in. */
function useFit(ref) {
  const sizing = useContext(ChartSizing)
  const on = Boolean(sizing)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!on || !el) return undefined
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [on, ref])
  if (!on) return null
  const w = width || 640
  return { width: w, height: w < 480 ? Math.round(sizing.height * 0.75) : sizing.height }
}

/** Label column: room for the longest label, capped so `reserve` px stay for the plot. */
function labelCol(width, labels, reserve) {
  const want = Math.ceil(Math.max(0, ...labels.map((l) => textW(l))) + 16)
  return Math.min(want, Math.max(64, Math.min(Math.round(width * 0.38), width - reserve)))
}

/**
 * Geometry of a one-row-per-entity chart: label and value columns sized to their text, rows
 * sharing the target height. `short` fits a label into its column.
 */
function rowLayout(fit, labels, values, { minRowH = 40, padB = 30 } = {}) {
  const padR = Math.ceil(Math.max(32, ...values.map((v) => textW(v))) + 16)
  const padL = labelCol(fit.width, labels, padR + MIN_PLOT)
  const W = Math.max(fit.width, padL + padR + MIN_PLOT)
  const padT = 8
  const rowH = Math.max(minRowH, (fit.height - padT - padB) / Math.max(1, labels.length))
  return { W, padL, padR, padT, padB, rowH, short: (l) => fitLabel(l, padL - 14) }
}
const legacyShort = (l) => trunc(l, 22)

/** Fractional ticks for a 0..max axis, fewer when the plot is narrow. */
const fracTicks = (innerW, max) => (innerW >= 260 ? [0, 0.25, 0.5, 0.75, 1] : innerW >= 140 ? [0, 0.5, 1] : [0, 1]).map((t) => t * max)

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

/** Tooltip state for one chart; `fit` is the chart box from useFit (null when not fluid). */
export function useTip() {
  const ref = useRef(null)
  const svgRef = useRef(null)
  const [tip, setTip] = useState(null)
  const fit = useFit(ref)
  const tipW = fit ? 300 : 230
  const place = (x, y, content) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setTip({ x: Math.max(0, Math.min(x, r.width - tipW)), y, content })
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
    const k = s.width / (svgRef.current.viewBox.baseVal?.width || s.width)
    place(s.left - r.left + px * k + 8, s.top - r.top + py * k + 8, content)
  }
  return { ref, svgRef, tip, fit, showAtPointer, showAtSvg, hide: () => setTip(null) }
}

export function Tip({ tip }) {
  if (!tip) return null
  return <div className="ch-tip" role="status" style={{ left: tip.x, top: tip.y }}>{tip.content}</div>
}

/** The box around every chart: tooltip anchor, inner horizontal scroller, SVG. */
function ChartFrame({ chart, W, H, ariaLabel, style, children }) {
  const { ref, svgRef, tip, fit, hide } = chart
  return (
    <div className={`ch-wrap${fit ? ' ch-fluid' : ''}`} ref={ref} onPointerLeave={hide}>
      <div className="ch-scroll">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} style={fit ? { width: W, height: H } : style}>{children}</svg>
      </div>
      <Tip tip={tip} />
    </div>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Full-screen overlay and the Enlarge control                                        */
/* ---------------------------------------------------------------------------------- */

/** Full-screen view of a figure or table; Escape, the Close button or the backdrop dismiss it. */
export function Overlay({ title, subtitle, actions, onClose, children }) {
  const sizing = useContext(ChartSizing)
  const closeRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const back = document.activeElement
    const overflow = document.body.style.overflow
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; back?.focus?.() }
  }, [])
  const h = clamp(window.innerHeight - 220, 360, 900)
  return (
    <div className="ch-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ch-overlay-panel" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Enlarged view'}>
        <div className="ch-overlay-head">
          <div className="ch-head-text">
            <div className="ch-overlay-title">{title}</div>
            {subtitle && <div className="ch-sub">{subtitle}</div>}
          </div>
          <div className="row">
            {actions}
            <button type="button" ref={closeRef} className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="ch-overlay-body">
          <ChartSizing.Provider value={{ ...sizing, height: h, compactHeight: h }}>{children}</ChartSizing.Provider>
        </div>
      </div>
    </div>
  )
}

/** A block (usually a table) with an Enlarge control; `toolbar` sits beside it and in the overlay. */
export function Enlargeable({ title, toolbar, children }) {
  const [big, setBig] = useState(false)
  return (
    <>
      <div className="ch-enlarge-bar">
        <div>{toolbar}</div>
        <button type="button" className="ch-enlarge" aria-haspopup="dialog" onClick={() => setBig(true)}>Enlarge</button>
      </div>
      {children}
      {big && <Overlay title={title} onClose={() => setBig(false)}>{toolbar}{children}</Overlay>}
    </>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Figure wrapper with chart | table toggle                                           */
/* ---------------------------------------------------------------------------------- */

/**
 * A chart that throws while drawing must not take the whole page down (React unmounts the tree on
 * an uncaught render error): it shows its table instead, with the error, and the rest renders.
 */
export class ChartBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('chart failed to draw:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="ch-empty">
        <p>This chart could not be drawn ({String(this.state.error.message || this.state.error)}).{this.props.table ? ' Its table:' : ''}</p>
        {this.props.table && <DataTable table={this.props.table} />}
      </div>
    )
  }
}

/** `compact` marks a small multiple: smaller title and, under ChartSizing, the compact height. */
export function Figure({ title, subtitle, legend, table, children, className = '', actions, compact = false }) {
  const sizing = useContext(ChartSizing)
  const [view, setView] = useState('chart')
  const [big, setBig] = useState(false)
  const toggle = table && (
    <div className="ch-toggle" role="group" aria-label="View">
      <button type="button" className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>Chart</button>
      <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
    </div>
  )
  const body = (
    <>
      {legend && view === 'chart' && (
        <div className="ch-legend">{legend.map((l) => <span key={l.label}><i style={{ background: l.color }} className={l.shape === 'line' ? 'line' : ''} />{l.label}</span>)}</div>
      )}
      {view === 'chart' ? <ChartBoundary table={table}>{children}</ChartBoundary> : <DataTable table={table} />}
    </>
  )
  return (
    <figure className={`ch-figure ${compact ? 'ch-compact' : ''} ${className}`}>
      <div className="ch-head">
        <div className="ch-head-text">
          <figcaption className="ch-title">{title}</figcaption>
          {subtitle && <div className="ch-sub">{subtitle}</div>}
        </div>
        <div className="row">
          {actions}
          {sizing && <button type="button" className="ch-enlarge" aria-haspopup="dialog" onClick={() => setBig(true)}>Enlarge</button>}
          {toggle}
        </div>
      </div>
      {sizing && compact ? <ChartSizing.Provider value={{ ...sizing, height: sizing.compactHeight ?? sizing.height }}>{body}</ChartSizing.Provider> : body}
      {big && <Overlay title={title} subtitle={subtitle} actions={toggle} onClose={() => setBig(false)}>{body}</Overlay>}
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
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  const valueText = (s) => (typeof s.value === 'number' && Number.isFinite(s.value) ? (s.text ?? fmtTick(s.value)) : 'n/a')
  const { W, padL, padR, padT, padB, rowH, short } = fit
    ? rowLayout(fit, series.map((s) => s.label), series.map(valueText))
    : { W: 640, padL: 150, padR: 86, padT: 6, padB: 24, rowH: 26, short: legacyShort }
  const barH = fit ? clamp(rowH * 0.45, 14, 36) : 12
  const cap = fit ? Math.round(barH / 2) : 4
  const dy = fit ? 5 : 4
  const H = padT + padB + rowH * Math.max(1, series.length)
  const innerW = W - padL - padR
  const x = (v) => padL + innerW * Math.max(0, Math.min(1, v / max))
  const tk = ticks || (fit ? fracTicks(innerW, max) : [0, 0.25, 0.5, 0.75, 1].map((t) => t * max))
  const content = (s) => s.title ?? <span><b>{s.label}</b><br />{s.text ?? (typeof s.value === 'number' ? fmtTick(s.value) : 'unavailable')}</span>
  return (
    <ChartFrame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Bar chart'}>
      {tk.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - (fit ? 9 : 8)} textAnchor="middle" className="ch-axis">{fmtTick(t)}</text></g>)}
      <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} className="ch-baseline" />
      {series.map((s, i) => {
        const cy = padT + rowH * i + rowH / 2
        const has = typeof s.value === 'number' && Number.isFinite(s.value)
        const hasCI = has && typeof s.lo === 'number' && typeof s.hi === 'number'
        return (
          <g key={s.id ?? i} tabIndex={0} className="ch-row" onPointerMove={(e) => showAtPointer(e, content(s))} onFocus={() => showAtSvg(x(has ? s.value : 0), cy, content(s))} onBlur={hide}>
            <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill="transparent" />
            <text x={padL - 8} y={cy + dy} textAnchor="end" className="ch-label"><title>{s.label}</title>{short(s.label)}</text>
            {has && <path d={barPath(x(0), cy - barH / 2, x(s.value) - x(0), barH)} fill={s.color || color} className="ch-bar" />}
            {hasCI && <g className="ch-ci"><line x1={x(s.lo)} x2={x(s.hi)} y1={cy} y2={cy} /><line x1={x(s.lo)} x2={x(s.lo)} y1={cy - cap} y2={cy + cap} /><line x1={x(s.hi)} x2={x(s.hi)} y1={cy - cap} y2={cy + cap} /></g>}
            <text x={W - padR + 8} y={cy + dy} className="ch-value">{valueText(s)}</text>
          </g>
        )
      })}
    </ChartFrame>
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
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  const leadText = (r) => { const lead = r.values[labelKey || series[0].key]; return lead && typeof lead.value === 'number' ? (lead.text ?? fmtTick(lead.value)) : 'n/a' }
  const gap = fit ? 4 : 2
  const { W, padL, padR, padT, padB, rowH, short } = fit
    ? rowLayout(fit, rows.map((r) => r.label), rows.map(leadText), { minRowH: 24 + series.length * (10 + gap) })
    : { W: 640, padL: 150, padR: 86, padT: 6, padB: 24, rowH: 10 + series.length * (8 + gap), short: legacyShort }
  const barH = fit ? clamp((rowH - 24) / series.length - gap, 10, 22) : 8
  const inset = fit ? (rowH - (series.length * (barH + gap) - gap)) / 2 : 5
  const dy = fit ? 5 : 4
  const H = padT + padB + rowH * Math.max(1, rows.length)
  const innerW = W - padL - padR
  const x = (v) => padL + innerW * Math.max(0, Math.min(1, v / max))
  const tk = fit ? fracTicks(innerW, max) : [0, 0.25, 0.5, 0.75, 1].map((t) => t * max)
  const content = (r) => (
    <span><b>{r.label}</b>{series.map((s) => { const v = r.values[s.key]; return <span key={s.key}><br /><i className="ch-key" style={{ background: s.color }} />{s.label}: <b>{v && typeof v.value === 'number' ? (v.text ?? fmtTick(v.value)) : 'n/a'}</b></span> })}</span>
  )
  return (
    <ChartFrame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Grouped bar chart'}>
      {tk.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - (fit ? 9 : 8)} textAnchor="middle" className="ch-axis">{fmtTick(t)}</text></g>)}
      <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} className="ch-baseline" />
      {rows.map((r, i) => {
        const top = padT + rowH * i + inset
        const cy = padT + rowH * i + rowH / 2
        return (
          <g key={r.id ?? i} tabIndex={0} className="ch-row" onPointerMove={(e) => showAtPointer(e, content(r))} onFocus={() => showAtSvg(padL, cy, content(r))} onBlur={hide}>
            <rect x={0} y={padT + rowH * i} width={W} height={rowH} fill="transparent" />
            <text x={padL - 8} y={cy + dy} textAnchor="end" className="ch-label"><title>{r.label}</title>{short(r.label)}</text>
            {series.map((s, j) => {
              const v = r.values[s.key]
              const has = v && typeof v.value === 'number' && Number.isFinite(v.value)
              const y = top + j * (barH + gap)
              return has ? <path key={s.key} d={barPath(x(0), y, x(v.value) - x(0), barH, 3)} fill={s.color} className="ch-bar" /> : null
            })}
            <text x={W - padR + 8} y={cy + dy} className="ch-value">{leadText(r)}</text>
          </g>
        )
      })}
    </ChartFrame>
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
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  // Fluid: cells share the full width (horizontal scroll below 72px a cell), rows share the height.
  const minCw = 72
  const padL = fit ? labelCol(fit.width, rows.map((r) => r.label), minCw * cols.length + 8) : 150
  const W = fit ? Math.max(fit.width, padL + minCw * cols.length + 8) : padL + 96 * cols.length + 8
  const cw = fit ? (W - padL - 8) / cols.length : 96
  const head = fit ? 34 : 24
  const ch = fit ? clamp((fit.height - head - 6) / Math.max(1, rows.length), 44, 120) : 32
  const H = head + ch * rows.length + 6
  const dy = fit ? 5 : 4
  return (
    <ChartFrame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Heatmap'} style={{ maxWidth: `${W}px` }}>
      {cols.map((c, j) => <text key={c.id} x={padL + cw * j + cw / 2} y={fit ? 20 : 14} textAnchor="middle" className="ch-axis"><title>{c.label}</title>{fit ? fitLabel(c.label, cw - 8, AXIS) : trunc(c.label, 14)}</text>)}
      {rows.map((r, i) => (
        <g key={r.id}>
          <text x={padL - 8} y={head + ch * i + ch / 2 + dy} textAnchor="end" className="ch-label"><title>{r.label}</title>{fit ? fitLabel(r.label, padL - 14) : trunc(r.label, 22)}</text>
          {cols.map((c, j) => {
            const v = cell(r.id, c.id) || {}
            const cls = seqClass(v.value)
            const cx = padL + cw * j
            const cy = head + ch * i
            const content = v.title ?? <span><b>{r.label}</b> · {c.label}<br />{v.text ?? 'unavailable'}</span>
            return (
              <g key={c.id} tabIndex={0} className="ch-cell" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(cx + cw / 2, cy + ch / 2, content)} onBlur={hide}>
                <rect x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className={`hm ${cls}`} />
                <text x={cx + cw / 2} y={cy + ch / 2 + dy} textAnchor="middle" className={`hm-text ${cls}`}>{v.text ?? '–'}</text>
              </g>
            )
          })}
        </g>
      ))}
    </ChartFrame>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Range dots: median with IQR band and p90 tick, one hue                             */
/* ---------------------------------------------------------------------------------- */

/** series: [{ id, label, q1, median, q3, p90, n, timeouts }] */
export function RangeDots({ series, color = 'var(--s1)', fmt = (v) => String(v), ariaLabel }) {
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  const valueText = (s) => (typeof s.median === 'number' ? fmt(s.median) : 'n/a')
  const { W, padL, padR, padT, padB, rowH, short } = fit
    ? rowLayout(fit, series.map((s) => s.label), series.map(valueText))
    : { W: 640, padL: 150, padR: 86, padT: 6, padB: 24, rowH: 26, short: legacyShort }
  const band = fit ? clamp(rowH * 0.22, 8, 18) : 8
  const dotR = fit ? 7 : 5
  const dy = fit ? 5 : 4
  const H = padT + padB + rowH * Math.max(1, series.length)
  const innerW = W - padL - padR
  const maxV = Math.max(0, ...series.flatMap((s) => [s.p90, s.q3, s.median].filter((v) => typeof v === 'number')))
  const tk = niceTicks(maxV || 1, fit ? clamp(Math.floor(innerW / 90), 1, 5) : 5)
  const max = tk[tk.length - 1] || 1
  const x = (v) => padL + innerW * Math.max(0, Math.min(1, v / max))
  const content = (s) => <span><b>{s.label}</b><br />median <b>{fmt(s.median)}</b> · IQR {fmt(s.q1)}–{fmt(s.q3)} · p90 {fmt(s.p90)}<br />n = {s.n ?? '?'}{s.timeouts ? ` · timeouts ${s.timeouts}` : ''}</span>
  return (
    <ChartFrame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Range chart'}>
      {tk.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - (fit ? 9 : 8)} textAnchor="middle" className="ch-axis">{fmt(t)}</text></g>)}
      <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} className="ch-baseline" />
      {series.map((s, i) => {
        const cy = padT + rowH * i + rowH / 2
        const has = typeof s.median === 'number'
        return (
          <g key={s.id ?? i} tabIndex={0} className="ch-row" onPointerMove={(e) => showAtPointer(e, content(s))} onFocus={() => showAtSvg(x(has ? s.median : 0), cy, content(s))} onBlur={hide}>
            <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill="transparent" />
            <text x={padL - 8} y={cy + dy} textAnchor="end" className="ch-label"><title>{s.label}</title>{short(s.label)}</text>
            {has && typeof s.q1 === 'number' && typeof s.q3 === 'number' && <rect x={x(s.q1)} y={cy - band / 2} width={Math.max(1, x(s.q3) - x(s.q1))} height={band} rx={band / 2} fill={color} opacity={0.35} />}
            {has && typeof s.p90 === 'number' && <line x1={x(s.p90)} x2={x(s.p90)} y1={cy - band / 2 - 2} y2={cy + band / 2 + 2} stroke={color} strokeWidth={2} />}
            {has && <circle cx={x(s.median)} cy={cy} r={dotR} fill={color} className="ch-dot" />}
            <text x={W - padR + 8} y={cy + dy} className="ch-value">{valueText(s)}</text>
          </g>
        )
      })}
    </ChartFrame>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Stacked horizontal bars (part-to-whole)                                            */
/* ---------------------------------------------------------------------------------- */

/** rows: [{ id, label, counts: { [key]: n } }], parts: [{ key, label, color, ink }] (ink: in-bar label colour, white by default) */
export function StackedBars({ rows, parts, ariaLabel }) {
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  const totalOf = (r) => parts.reduce((s, p) => s + (r.counts[p.key] || 0), 0)
  const { W, padL, padR, padT, padB, rowH, short } = fit
    ? rowLayout(fit, rows.map((r) => r.label), rows.map((r) => totalOf(r)), { padB: 10 })
    : { W: 640, padL: 150, padR: 60, padT: 6, padB: 10, rowH: 26, short: legacyShort }
  const barH = fit ? clamp(rowH * 0.45, 16, 40) : 14
  const dy = fit ? 5 : 4
  const H = padT + padB + rowH * Math.max(1, rows.length)
  const innerW = W - padL - padR
  return (
    <ChartFrame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Stacked bar chart'}>
      {rows.map((r, i) => {
        const cy = padT + rowH * i + rowH / 2
        const total = totalOf(r)
        let cursor = padL
        return (
          <g key={r.id ?? i}>
            <text x={padL - 8} y={cy + dy} textAnchor="end" className="ch-label"><title>{r.label}</title>{short(r.label)}</text>
            {total === 0 && <text x={padL} y={cy + dy} className="ch-axis">no eligible items</text>}
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
                  {w > (fit ? textW(n, AXIS) + 14 : 36) && <text x={x0 + w / 2} y={cy + dy} textAnchor="middle" className="ch-inlabel" style={p.ink ? { fill: p.ink } : undefined}>{n}</text>}
                </g>
              )
            })}
            <text x={W - padR + 8} y={cy + dy} className="ch-value">{total}</text>
          </g>
        )
      })}
    </ChartFrame>
  )
}

/* ---------------------------------------------------------------------------------- */
/* Reliability diagram (stated confidence vs observed rate)                           */
/* ---------------------------------------------------------------------------------- */

export function Reliability({ statement, proof, ariaLabel }) {
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  // Fluid: a square plot as large as the target height allows, centred in the full-width box.
  const W = fit ? Math.max(260, fit.width) : 240
  const side = fit ? Math.max(160, Math.min(W - 80, fit.height - 64)) : 0
  const x0 = fit ? 64 + (W - 80 - side) / 2 : 0
  const H = fit ? 12 + side + 52 : 220
  const pad = 34
  const sx = fit ? (v) => x0 + side * v : (v) => pad + (W - pad - 10) * v
  const sy = fit ? (v) => 12 + side * (1 - v) : (v) => H - pad - (H - pad - 12) * v
  const radius = (n) => (fit ? Math.min(16, 6 + 1.4 * Math.sqrt(n)) : Math.min(10, 4 + Math.sqrt(n)))
  const ticks = fit ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1]
  const pts = (statement?.reliability || []).filter((b) => b.n > 0)
  const pts2 = (proof?.reliability || []).filter((b) => b.n > 0)
  return (
    <ChartFrame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Reliability diagram'}>
      {[0.25, 0.5, 0.75].map((g) => <g key={g}><line x1={sx(g)} x2={sx(g)} y1={sy(0)} y2={sy(1)} className="ch-grid" /><line x1={sx(0)} x2={sx(1)} y1={sy(g)} y2={sy(g)} className="ch-grid" /></g>)}
      <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} className="ch-ident" />
      <line x1={sx(0)} x2={sx(1)} y1={sy(0)} y2={sy(0)} className="ch-baseline" />
      <line x1={sx(0)} x2={sx(0)} y1={sy(0)} y2={sy(1)} className="ch-baseline" />
      {ticks.map((t) => <text key={t} x={sx(t)} y={fit ? sy(0) + 20 : H - pad + 14} textAnchor="middle" className="ch-axis">{pct(t)}</text>)}
      {ticks.map((t) => <text key={t} x={fit ? sx(0) - 8 : pad - 6} y={sy(t) + (fit ? 5 : 4)} textAnchor="end" className="ch-axis">{pct(t)}</text>)}
      {fit ? (
        <>
          <text x={sx(0.5)} y={H - 6} textAnchor="middle" className="ch-axis-title">stated confidence</text>
          <text x={sx(0) - 48} y={sy(0.5)} className="ch-axis-title" transform={`rotate(-90 ${sx(0) - 48} ${sy(0.5)})`} textAnchor="middle">observed</text>
        </>
      ) : (
        <>
          <text x={sx(0.5)} y={H - 4} textAnchor="middle" className="ch-axis">stated confidence</text>
          <text x={10} y={sy(0.5)} className="ch-axis" transform={`rotate(-90 10 ${sy(0.5)})`} textAnchor="middle">observed</text>
        </>
      )}
      {pts.map((b) => {
        const content = <span><b>Statement</b> · bin {b.lo}–{b.hi}%<br />n = {b.n} · confidence {pct(b.mean_confidence)} · faithful {pct(b.accuracy)}</span>
        return <circle key={`s${b.bin}`} tabIndex={0} cx={sx(b.mean_confidence)} cy={sy(b.accuracy)} r={radius(b.n)} fill="var(--s1)" className="ch-dot" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(sx(b.mean_confidence), sy(b.accuracy), content)} onBlur={hide} />
      })}
      {pts2.map((b) => {
        const content = <span><b>Proof audit</b> · bin {b.lo}–{b.hi}%<br />n = {b.n} · confidence {pct(b.mean_confidence)} · audit clean {pct(b.accuracy)}</span>
        const r = radius(b.n)
        return <rect key={`p${b.bin}`} tabIndex={0} x={sx(b.mean_confidence) - r} y={sy(b.accuracy) - r} width={2 * r} height={2 * r} rx={2} fill="var(--s2)" className="ch-dot" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(sx(b.mean_confidence), sy(b.accuracy), content)} onBlur={hide} />
      })}
    </ChartFrame>
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
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  // Fluid: same scheme as Heatmap, with horizontal column labels instead of rotated ones.
  const minCw = 64
  const padL = fit ? labelCol(fit.width, models.map((m) => m.label), minCw * models.length + 8) : 150
  const W = fit ? Math.max(fit.width, padL + minCw * models.length + 8) : padL + minCw * models.length + 8
  const cw = fit ? (W - padL - 8) / models.length : minCw
  const head = fit ? 34 : 40
  const ch = fit ? clamp((fit.height - head - 6) / Math.max(1, models.length), 44, 120) : 32
  const H = head + ch * models.length + 6
  const dy = fit ? 5 : 4
  const byKey = new Map()
  for (const p of pairs) { byKey.set(`${p.model_a}|${p.model_b}`, p); byKey.set(`${p.model_b}|${p.model_a}`, { ...p, flipped: true }) }
  const scale = Math.max(1, ...pairs.map((p) => Math.abs(p.diff_pp || 0)))
  const labelOf = (id) => models.find((m) => m.id === id)?.label || id
  return (
    <ChartFrame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Pairwise comparison matrix'} style={{ maxWidth: `${W}px` }}>
      {models.map((c, j) => (fit
        ? <text key={c.id} x={padL + cw * j + cw / 2} y={20} textAnchor="middle" className="ch-axis"><title>{c.label}</title>{fitLabel(c.label, cw - 8, AXIS)}</text>
        : <text key={c.id} x={padL + cw * j + cw / 2} y={30} textAnchor="middle" className="ch-axis" transform={`rotate(-20 ${padL + cw * j + cw / 2} 30)`}>{trunc(c.label, 12)}</text>))}
      {models.map((r, i) => (
        <g key={r.id}>
          <text x={padL - 8} y={head + ch * i + ch / 2 + dy} textAnchor="end" className="ch-label"><title>{r.label}</title>{fit ? fitLabel(r.label, padL - 14) : trunc(r.label, 22)}</text>
          {models.map((c, j) => {
            const cx = padL + cw * j
            const cy = head + ch * i
            if (i === j) return <rect key={c.id} x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className="hm dv-diag" />
            const p = byKey.get(`${r.id}|${c.id}`)
            if (!p) return <rect key={c.id} x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className="hm seq-none" />
            // No common papers (e.g. one model answered nothing): no difference to show.
            if (typeof p.diff_pp !== 'number') {
              const none = <span><b>{labelOf(r.id)}</b> − <b>{labelOf(c.id)}</b><br />no common papers on which both models are determinate (n = {p.n ?? 0})</span>
              return (
                <g key={c.id} tabIndex={0} className="ch-cell" onPointerMove={(e) => showAtPointer(e, none)} onFocus={() => showAtSvg(cx + cw / 2, cy + ch / 2, none)} onBlur={hide}>
                  <rect x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className="hm seq-none" />
                  <text x={cx + cw / 2} y={cy + ch / 2 + dy} textAnchor="middle" className="hm-text">n/a</text>
                </g>
              )
            }
            const diff = p.flipped ? -p.diff_pp : p.diff_pp
            const lo = p.flipped ? (p.diff_ci_hi === null ? null : -p.diff_ci_hi) : p.diff_ci_lo
            const hi = p.flipped ? (p.diff_ci_lo === null ? null : -p.diff_ci_lo) : p.diff_ci_hi
            const sig = p.p_holm !== null && p.p_holm !== undefined && p.p_holm < 0.05
            const content = <span><b>{labelOf(r.id)}</b> − <b>{labelOf(c.id)}</b><br />{diff >= 0 ? '+' : ''}{diff.toFixed(1)} pp {lo === null ? '' : `[${lo.toFixed(1)}, ${hi.toFixed(1)}]`}<br />discordant {p.flipped ? p.discordant_b_only : p.discordant_a_only} / {p.flipped ? p.discordant_a_only : p.discordant_b_only} · n = {p.n}<br />McNemar p = {p.p?.toFixed(4)} · Holm p = {p.p_holm === null ? 'n/a' : p.p_holm.toFixed(4)}{sig ? ' · supported' : ''}</span>
            return (
              <g key={c.id} tabIndex={0} className="ch-cell" onPointerMove={(e) => showAtPointer(e, content)} onFocus={() => showAtSvg(cx + cw / 2, cy + ch / 2, content)} onBlur={hide}>
                <rect x={cx + 1} y={cy + 1} width={cw - 2} height={ch - 2} rx={4} className={`hm ${dvClass(diff, scale)} ${sig ? 'sig' : ''}`} />
                <text x={cx + cw / 2} y={cy + ch / 2 + dy} textAnchor="middle" className={`hm-text ${dvClass(diff, scale)}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(0)}{sig ? '●' : ''}</text>
              </g>
            )
          })}
        </g>
      ))}
    </ChartFrame>
  )
}
