// Charts for the benchmark comparison: a log-x scatter (benchmark size vs best reported success)
// and log-x box plots (statement length). Same conventions as charts/primitives.jsx: thin marks,
// text in text tokens, a tooltip on hover and keyboard focus, and a table twin in the Figure.

import { useTip, Tip, pct, niceTicks } from '../charts/primitives.jsx'
import { placeLabels } from '../../qedrank/lib/compare/labels.js'

function Frame({ chart, W, H, ariaLabel, children }) {
  const { ref, svgRef, tip, fit, hide } = chart
  return (
    <div className={`ch-wrap${fit ? ' ch-fluid' : ''}`} ref={ref} onPointerLeave={hide}>
      <div className="ch-scroll">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} style={fit ? { width: W, height: H } : undefined}>{children}</svg>
      </div>
      <Tip tip={tip} />
    </div>
  )
}

const LOG_TICKS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]
const fmtCount = (v) => (v >= 1000 ? `${v / 1000}k` : String(v))

function logScale(lo, hi, a, b) {
  const l0 = Math.log10(lo)
  const l1 = Math.log10(hi)
  return (v) => a + ((Math.log10(Math.max(lo, v)) - l0) / (l1 - l0)) * (b - a)
}

/** Marker path centred at (x, y) for a budget class. */
export function markerPath(shape, x, y, r) {
  switch (shape) {
    case 'square': return `M${x - r},${y - r}h${2 * r}v${2 * r}h${-2 * r}z`
    case 'triangle': return `M${x},${y - r * 1.2}L${x + r * 1.1},${y + r * 0.8}L${x - r * 1.1},${y + r * 0.8}z`
    case 'diamond': return `M${x},${y - r * 1.25}L${x + r * 1.1},${y}L${x},${y + r * 1.25}L${x - r * 1.1},${y}z`
    default: return `M${x - r},${y}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0`
  }
}

/**
 * points: [{ id, label, x (problems), y (rate 0..1) | null, lo, hi, shape, color, hollow, title }]
 * A point with lo/hi draws its interval; a point without y draws only the interval (an upper bound).
 */
export function SizeRateScatter({ points, ariaLabel }) {
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  const W = fit ? Math.max(fit.width, 420) : 640
  const H = fit ? Math.max(fit.height, 300) : 340
  const padL = 52
  const padR = 24
  const padT = 14
  const padB = 44
  const xs = points.map((p) => p.x).filter((v) => v > 0)
  const xmin = Math.max(1, 10 ** Math.floor(Math.log10(Math.min(...xs, 100))))
  const xmax = 10 ** Math.ceil(Math.log10(Math.max(...xs, 1000)))
  const x = logScale(xmin, xmax, padL, W - padR)
  const y = (v) => padT + (1 - v) * (H - padT - padB)
  const xt = LOG_TICKS.filter((t) => t >= xmin && t <= xmax && (W > 520 || [1, 10, 100, 1000, 10000].includes(t)))
  const content = (p) => p.title ?? <span><b>{p.label}</b></span>
  // Direct labels avoid every marker and each other (y flipped: the placer's y grows upwards).
  const at = (p) => ({ cx: x(p.x), cy: y(typeof p.y === 'number' ? p.y : (p.hi ?? 0)) })
  const sides = placeLabels(points.map((p) => { const { cx, cy } = at(p); return { id: p.id, x: cx, y: H - cy, w: 7 * String(p.label).length + 4, h: 14 } }), { gap: 9, r: 7, bounds: { x0: padL, x1: W - padR, y0: padB, y1: H - padT } })
  const labelAt = (p, cx, cy) => ({
    right: { x: cx + 10, y: cy + 4, anchor: 'start' },
    left: { x: cx - 10, y: cy + 4, anchor: 'end' },
    below: { x: cx, y: cy + 20, anchor: 'middle' },
    above: { x: cx, y: cy - 10, anchor: 'middle' },
  }[sides.get(p.id) || 'right'])
  return (
    <Frame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Benchmark size against best reported success rate'}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => <g key={t}><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="ch-grid" /><text x={padL - 8} y={y(t) + 4} textAnchor="end" className="ch-axis">{pct(t)}</text></g>)}
      {xt.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - padB + 16} textAnchor="middle" className="ch-axis">{fmtCount(t)}</text></g>)}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="ch-baseline" />
      <text x={(padL + W - padR) / 2} y={H - 8} textAnchor="middle" className="ch-axis">problems in the evaluated set (log scale)</text>
      <text x={14} y={(padT + H - padB) / 2} textAnchor="middle" className="ch-axis" transform={`rotate(-90 14 ${(padT + H - padB) / 2})`}>best reported success</text>
      {points.map((p) => {
        const cx = x(p.x)
        const hasY = typeof p.y === 'number'
        const cy = y(hasY ? p.y : (p.hi ?? 0))
        const r = 6
        return (
          <g key={p.id} tabIndex={0} className="ch-cell" onPointerMove={(e) => showAtPointer(e, content(p))} onFocus={() => showAtSvg(cx, cy, content(p))} onBlur={hide}>
            <circle cx={cx} cy={cy} r={16} fill="transparent" />
            {typeof p.lo === 'number' && typeof p.hi === 'number' && <g className="ch-ci"><line x1={cx} x2={cx} y1={y(p.lo)} y2={y(p.hi)} /><line x1={cx - 5} x2={cx + 5} y1={y(p.hi)} y2={y(p.hi)} /><line x1={cx - 5} x2={cx + 5} y1={y(p.lo)} y2={y(p.lo)} /></g>}
            {hasY && <path d={markerPath(p.shape, cx, cy, r)} fill={p.hollow ? 'var(--surface)' : p.color} stroke={p.hollow ? p.color : 'var(--surface)'} strokeWidth={2} />}
            {(() => { const l = labelAt(p, cx, cy); return <text x={l.x} y={l.y} textAnchor={l.anchor} className="ch-label">{p.label}</text> })()}
          </g>
        )
      })}
    </Frame>
  )
}

/** rows: [{ id, label, p10, q1, median, q3, p90, n, color }] on a log axis. */
export function LogBoxes({ rows, unit = 'tokens', ariaLabel, linear = false }) {
  const chart = useTip()
  const { fit, showAtPointer, showAtSvg, hide } = chart
  const W = fit ? Math.max(fit.width, 420) : 640
  const rowH = fit ? 40 : 30
  // Label column sized to the longest label (about 7.5 px per character), within limits.
  const padL = Math.min(Math.round(W * 0.4), Math.max(90, Math.ceil(Math.max(...rows.map((r) => String(r.label).length)) * 7.5) + 18))
  const padR = 64
  const padT = 8
  const padB = 40
  const H = padT + padB + rowH * Math.max(1, rows.length)
  // `linear` for small counts that can be 0 (tactics per proof); otherwise a log scale.
  const vals = rows.flatMap((r) => [r.p10, r.p90]).filter((v) => typeof v === 'number' && (linear ? v >= 0 : v > 0))
  const lo = linear ? 0 : 10 ** Math.floor(Math.log10(Math.max(1, Math.min(...vals, 10))))
  const linTicks = linear ? niceTicks(Math.max(1, ...vals), W > 520 ? 6 : 4) : null
  const hi = linear ? linTicks[linTicks.length - 1] : 10 ** Math.ceil(Math.log10(Math.max(...vals, 100)))
  const x = linear ? (v) => padL + (Math.max(0, Math.min(hi, v)) / hi) * (W - padR - padL) : logScale(lo, hi, padL, W - padR)
  const xt = linear ? linTicks : LOG_TICKS.filter((t) => t >= lo && t <= hi && (W > 520 || [1, 10, 100, 1000, 10000].includes(t)))
  const content = (r) => <span><b>{r.label}</b> · n = {r.n}<br />median <b>{r.median}</b> {unit}<br />middle half {r.q1}–{r.q3} · 10th–90th percentile {r.p10}–{r.p90}</span>
  return (
    <Frame chart={chart} W={W} H={H} ariaLabel={ariaLabel || 'Statement length by benchmark'}>
      {xt.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} className="ch-grid" /><text x={x(t)} y={H - padB + 16} textAnchor="middle" className="ch-axis">{fmtCount(t)}</text></g>)}
      <text x={(padL + W - padR) / 2} y={H - 8} textAnchor="middle" className="ch-axis">{linear ? unit : `${unit} (log scale)`}</text>
      {rows.map((r, i) => {
        const cy = padT + rowH * i + rowH / 2
        const has = typeof r.median === 'number'
        const bh = Math.min(16, rowH * 0.5)
        return (
          <g key={r.id} tabIndex={0} className="ch-row" onPointerMove={(e) => has && showAtPointer(e, content(r))} onFocus={() => has && showAtSvg(x(r.median), cy, content(r))} onBlur={hide}>
            <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill="transparent" />
            <text x={padL - 8} y={cy + 4} textAnchor="end" className="ch-label">{r.label}</text>
            {has ? (
              <>
                <line x1={x(r.p10)} x2={x(r.q1)} y1={cy} y2={cy} stroke={r.color} strokeWidth={2} />
                <line x1={x(r.q3)} x2={x(r.p90)} y1={cy} y2={cy} stroke={r.color} strokeWidth={2} />
                <rect x={x(r.q1)} y={cy - bh / 2} width={Math.max(2, x(r.q3) - x(r.q1))} height={bh} rx={3} fill={r.color} opacity={0.35} />
                <line x1={x(r.median)} x2={x(r.median)} y1={cy - bh / 2 - 2} y2={cy + bh / 2 + 2} stroke={r.color} strokeWidth={3} />
                <text x={W - padR + 8} y={cy + 4} className="ch-value">{r.median}</text>
              </>
            ) : <text x={padL + 4} y={cy + 4} className="ch-axis">not measured</text>}
          </g>
        )
      })}
    </Frame>
  )
}
