// Attempt-level views of the evaluation page: the problems × models status grid with its
// drawer (attempt records, proof text, grading record, sessions), the pass@k table for every k,
// attempt-status and failure-class charts, and the protocol / budget disclosure. Everything is
// read from summary.json and items.json; proof text and grading records are fetched from the
// local run server on demand and never leave the loopback address.

import { Fragment, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { ATTEMPT_STATUS, ATTEMPT_STATUS_LABELS, FAILURE_CLASS_LABELS } from '../../qedrank/lib/harness/status.js'
import { fmtMs, fmtInt, fmtNum, download, toCsv } from '../qedrank/helpers.js'
import { Enlargeable, Figure, StackedBars, GroupedBars, pct1 } from '../charts/primitives.jsx'
import { shortLabel, slotColor } from '../components/vendor.js'

export const STATUS_GLYPH = { fully_solved: '●', partially_solved: '◐', failed: '○', infrastructure_error: '!', pending: '·', running: '…', cancelled: '✕' }
export const STATUS_COLOR = { fully_solved: 'var(--good)', partially_solved: 'var(--s4)', failed: 'var(--axis)', infrastructure_error: 'var(--critical)', pending: 'var(--surface-3)', running: 'var(--warn)', cancelled: 'var(--s8)' }
const STATUS_RANK = { fully_solved: 0, partially_solved: 1, failed: 2, infrastructure_error: 3, cancelled: 4, running: 5, pending: 6 }
const ATTEMPT_RE = /^(pass@1|agent)$/

/** The directory name of an item (mirrors qedrank/lib/util.js slug). */
export function itemDir(key) {
  return String(key).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
}

function bestStatus(statuses) {
  return statuses.slice().sort((a, b) => (STATUS_RANK[a] ?? 9) - (STATUS_RANK[b] ?? 9))[0] || 'pending'
}

/** Rows (problems) × columns (models, grouped by harness) of attempt statuses. */
export function useProblemGrid(summary, items, targetKind = 'main_theorem') {
  return useMemo(() => {
    const rows = (items || []).filter((r) => ATTEMPT_RE.test(r.setting) && r.repair_round === 0 && r.target_kind === targetKind)
    const models = (summary?.models || []).map((m) => ({ id: m.id, label: shortLabel(m), display: m.display_name, harness: m.harness || 'qedrank-single' }))
    const planned = summary?.attempts?.planned ?? summary?.settings?.attempts ?? 1
    const plan = summary?.attempts?.by_attempt || {}
    const byCell = new Map()
    const problems = new Map()
    for (const r of rows) {
      const key = `${r.paper_id}|${r.provider}`
      if (!byCell.has(key)) byCell.set(key, [])
      byCell.get(key).push(r)
      if (!problems.has(r.paper_id)) problems.set(r.paper_id, { paper_id: r.paper_id, difficulty: r.difficulty || 'Unknown', subject: r.subject_tags || 'Unknown', status: r.mathematical_status })
    }
    for (const cell of byCell.values()) cell.sort((a, b) => a.attempt - b.attempt)
    const cellOf = (paperId, modelId) => {
      const recs = byCell.get(`${paperId}|${modelId}`) || []
      const slots = []
      for (let a = 1; a <= Math.max(planned, ...recs.map((r) => r.attempt)); a += 1) {
        const r = recs.find((x) => x.attempt === a)
        if (r) slots.push({ attempt: a, status: r.status || (r.infrastructure_failure ? 'infrastructure_error' : r.verified === 1 ? 'fully_solved' : 'failed'), item: r })
        else {
          const p = plan[a]
          const st = !p ? 'pending' : p.status === 'running' ? 'running' : p.status === 'cancelled' || p.status === 'interrupted' ? 'cancelled' : 'pending'
          slots.push({ attempt: a, status: st, item: null })
        }
      }
      return { paperId, modelId, slots, best: bestStatus(slots.filter((s) => s.item).map((s) => s.status).concat(slots.some((s) => s.item) ? [] : slots.map((s) => s.status))), solved: slots.filter((s) => s.status === 'fully_solved').length, partial: slots.filter((s) => s.status === 'partially_solved').length, attempts: slots.filter((s) => s.item).length }
    }
    const harnesses = [...new Set(models.map((m) => m.harness))]
    return { problems: [...problems.values()].sort((a, b) => a.paper_id.localeCompare(b.paper_id)), models, harnesses, planned, cellOf }
  }, [summary, items, targetKind])
}

export function ProblemMatrix({ summary, items, runId, server }) {
  const grid = useProblemGrid(summary, items)
  const [filters, setFilters] = useState({ status: '', difficulty: '', subject: '', harness: '' })
  const [sort, setSort] = useState({ key: 'paper_id', dir: 1 })
  const [open, setOpen] = useState(null)
  const difficulties = [...new Set(grid.problems.map((p) => p.difficulty))].sort()
  const subjects = [...new Set(grid.problems.map((p) => p.subject))].sort()
  const models = grid.models.filter((m) => !filters.harness || m.harness === filters.harness)
  const cells = useMemo(() => Object.fromEntries(grid.problems.flatMap((p) => models.map((m) => [`${p.paper_id}|${m.id}`, grid.cellOf(p.paper_id, m.id)]))), [grid, models])
  let rows = grid.problems.filter((p) => (!filters.difficulty || p.difficulty === filters.difficulty) && (!filters.subject || p.subject === filters.subject) && (!filters.status || models.some((m) => cells[`${p.paper_id}|${m.id}`].slots.some((s) => s.status === filters.status))))
  rows = rows.slice().sort((a, b) => {
    if (sort.key === 'paper_id') return sort.dir * a.paper_id.localeCompare(b.paper_id)
    if (sort.key === 'difficulty') return sort.dir * String(a.difficulty).localeCompare(String(b.difficulty))
    const ca = cells[`${a.paper_id}|${sort.key}`]; const cb = cells[`${b.paper_id}|${sort.key}`]
    return sort.dir * ((STATUS_RANK[ca?.best] ?? 9) - (STATUS_RANK[cb?.best] ?? 9) || (cb?.solved ?? 0) - (ca?.solved ?? 0))
  })
  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))
  const totals = Object.fromEntries(models.map((m) => { const cs = grid.problems.map((p) => cells[`${p.paper_id}|${m.id}`]); return [m.id, { solvedProblems: cs.filter((c) => c.solved > 0).length, partialProblems: cs.filter((c) => c.solved === 0 && c.partial > 0).length, covered: cs.filter((c) => c.attempts > 0).length }] }))
  const csv = () => toCsv(rows.flatMap((p) => models.map((m) => { const c = cells[`${p.paper_id}|${m.id}`]; return { problem: p.paper_id, difficulty: p.difficulty, subject: p.subject, model: m.display, harness: m.harness, attempts: c.attempts, fully_solved: c.solved, partially_solved: c.partial, best_status: c.best, statuses: c.slots.map((s) => `${s.attempt}:${s.status}`).join(' ') } })))
  if (!grid.problems.length) return <p className="muted">No attempt records for the main theorem in this run.</p>
  return (
    <div>
      <div className="form-grid ev-grid-filters">
        <label className="field">Status (any attempt)<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">all</option>{ATTEMPT_STATUS.map((s) => <option key={s} value={s}>{ATTEMPT_STATUS_LABELS[s]}</option>)}</select></label>
        <label className="field">Difficulty<select value={filters.difficulty} onChange={(e) => setFilters({ ...filters, difficulty: e.target.value })}><option value="">all</option>{difficulties.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="field">Subject<select value={filters.subject} onChange={(e) => setFilters({ ...filters, subject: e.target.value })}><option value="">all</option>{subjects.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        {grid.harnesses.length > 1 && <label className="field">Harness<select value={filters.harness} onChange={(e) => setFilters({ ...filters, harness: e.target.value })}><option value="">all</option>{grid.harnesses.map((h) => <option key={h} value={h}>{h}</option>)}</select></label>}
      </div>
      <p className="small">{rows.length} of {grid.problems.length} problems · {grid.planned} attempt{grid.planned === 1 ? '' : 's'} planned per problem and model. Glyphs per attempt: ● fully solved · ◐ partially solved (verified lemmas, no complete proof) · ○ failed · ! infrastructure error · ✕ cancelled · … running · · pending. Click a cell for the attempts, the proof and the grading record. Click a column header to sort by it.</p>
      <Enlargeable title="Problems × models" toolbar={<button className="btn btn-secondary btn-sm" onClick={() => download(`${runId || 'qedrank'}-problem-matrix.csv`, csv(), 'text/csv')}>Download grid CSV</button>}>
        <div className="table-wrap">
          <table className="table ev-matrix ev-pgrid">
            <thead>
              {grid.harnesses.length > 1 && <tr><th colSpan={2} />{grid.harnesses.filter((h) => !filters.harness || h === filters.harness).map((h) => <th key={h} colSpan={models.filter((m) => m.harness === h).length} className="ev-harness-head">{h}</th>)}</tr>}
              <tr>
                <th><button className="link-btn" onClick={() => toggleSort('paper_id')}>Problem</button></th>
                <th><button className="link-btn" onClick={() => toggleSort('difficulty')}>Difficulty · subject</button></th>
                {models.map((m) => <th key={m.id} className="ev-model-head" style={{ '--mc': slotColor(m.id) }}><button className="link-btn" onClick={() => toggleSort(m.id)} title={m.display}><i className="chip-dot" />{m.label}</button><div className="small">{totals[m.id].solvedProblems} solved{totals[m.id].partialProblems ? ` · ${totals[m.id].partialProblems} partial` : ''} · {totals[m.id].covered}/{grid.problems.length} covered</div></th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.paper_id}>
                  <td><code>{p.paper_id}</code>{p.status && p.status !== 'established' && <span className="badge" title="not on the proof track">{p.status}</span>}</td>
                  <td className="small">{p.difficulty}{p.subject && p.subject !== 'Unknown' ? ` · ${p.subject}` : ''}</td>
                  {models.map((m) => { const c = cells[`${p.paper_id}|${m.id}`]; return (
                    <td key={m.id} className={`ev-cell ev-cell-${c.best}`}>
                      <button type="button" className="ev-cell-btn" onClick={() => setOpen(c)} title={c.slots.map((s) => `attempt ${s.attempt}: ${ATTEMPT_STATUS_LABELS[s.status]}`).join('\n')}>
                        {c.slots.map((s) => <span key={s.attempt} className={`ev-glyph ev-glyph-${s.status}`} style={{ color: STATUS_COLOR[s.status] }}>{STATUS_GLYPH[s.status]}</span>)}
                      </button>
                    </td>) })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Enlargeable>
      {open && <AttemptDrawer cell={open} model={grid.models.find((m) => m.id === open.modelId)} runId={runId} server={server} onClose={() => setOpen(null)} />}
    </div>
  )
}

function fetchText(server, runId, rel) {
  return axios.get(`${server.replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}/${rel}`, { transformResponse: [(d) => d] }).then((r) => r.data)
}

export function AttemptDrawer({ cell, model, runId, server, onClose }) {
  const attempts = cell.slots.filter((s) => s.item)
  const [sel, setSel] = useState(attempts[0]?.attempt ?? null)
  const [view, setView] = useState('summary')
  const [doc, setDoc] = useState({ loading: false, text: null, error: null })
  const slot = attempts.find((s) => s.attempt === sel)
  const it = slot?.item
  useEffect(() => {
    setDoc({ loading: false, text: null, error: null })
    if (!it || view === 'summary' || !server || !runId) return
    const dir = itemDir(it.item_key)
    const rel = view === 'proof' ? (it.submission_artifact ? `items/${dir}/${it.submission_artifact}` : null) : view === 'grade' ? (it.grade_artifact ? `items/${dir}/${it.grade_artifact}` : null) : `items/${dir}/attempt-a${it.attempt}r${it.repair_round || 0}.json`
    if (!rel) { setDoc({ loading: false, text: null, error: 'not recorded for this attempt' }); return }
    let alive = true
    setDoc({ loading: true, text: null, error: null })
    fetchText(server, runId, rel).then((t) => { if (alive) setDoc({ loading: false, text: t, error: null }) }).catch((err) => { if (alive) setDoc({ loading: false, text: null, error: err.response?.status === 404 ? 'file not found on the run server' : err.message }) })
    return () => { alive = false }
  }, [it, view, server, runId])
  const record = view === 'record' && doc.text ? safeJson(doc.text) : null
  return (
    <div className="ev-drawer card" role="dialog" aria-label={`Attempts of ${cell.paperId} by ${model?.display || cell.modelId}`}>
      <div className="row spread">
        <h3 className="ev-h3"><code>{cell.paperId}</code> · {model?.display || cell.modelId} <span className="small">({model?.harness})</span></h3>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      {!attempts.length ? <p className="muted">No attempt has run yet ({cell.slots.map((s) => `attempt ${s.attempt}: ${ATTEMPT_STATUS_LABELS[s.status]}`).join(', ')}).</p> : (
        <>
          <div className="table-wrap">
            <table className="table ev-items">
              <thead><tr><th>Attempt</th><th>Status</th><th>Failure class</th><th>Evidence</th><th className="num">Sessions</th><th className="num">Tokens in / out</th><th className="num">Tool calls</th><th className="num">Time (total / working)</th><th className="num">Lean compile</th><th className="num">Lines (file / proof)</th><th className="num">Cost</th><th /></tr></thead>
              <tbody>
                {attempts.map(({ attempt, status, item: r }) => (
                  <tr key={attempt} className={sel === attempt ? 'ev-sig-row' : ''}>
                    <td>{attempt}</td>
                    <td><span style={{ color: STATUS_COLOR[status] }}>{STATUS_GLYPH[status]}</span> {ATTEMPT_STATUS_LABELS[status]}{r.partial_assessed === false ? <span className="badge" title={r.partial_method || ''}>partial not assessed</span> : null}{r.partial_assessed && r.partial_verified_aux_lemmas > 0 ? <span className="badge accent" style={{ '--badge-color': 'var(--s4)' }}>{r.partial_verified_aux_lemmas} verified lemma{r.partial_verified_aux_lemmas === 1 ? '' : 's'}</span> : null}</td>
                    <td>{r.failure_class ? FAILURE_CLASS_LABELS[r.failure_class] || r.failure_class : '—'}</td>
                    <td className="small ev-evidence">{r.failure_evidence || r.compile_first_error || '—'}</td>
                    <td className="num">{r.sessions_used ?? '—'}{r.solved_at_session ? ` (solved in ${r.solved_at_session})` : ''}</td>
                    <td className="num">{fmtInt(r.input_tokens)} / {fmtInt(r.output_tokens)}</td>
                    <td className="num">{r.tool_calls ?? '—'}</td>
                    <td className="num">{fmtMs(r.total_item_ms)} / {fmtMs(r.working_item_ms)}</td>
                    <td className="num">{fmtMs(r.lean_compile_ms)}</td>
                    <td className="num">{r.model_total_lines ?? '—'} / {r.model_proof_lines ?? '—'}</td>
                    <td className="num">{r.cost_usd === null || r.cost_usd === undefined ? <span className="muted" title="no price configured or no usage reported">n/a</span> : `$${fmtNum(r.cost_usd, 4)} (est.)`}</td>
                    <td><button className="link-btn" onClick={() => { setSel(attempt); setView('summary') }}>inspect</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {it && (
            <div className="ev-inspect">
              <div className="tabs">
                {[['summary', 'Summary'], ['proof', 'Proof (final file)'], ['grade', 'Grading record'], ['record', 'Attempt record & sessions']].map(([k, l]) => <button key={k} className={`tab ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{l}</button>)}
              </div>
              {view === 'summary' && (
                <div className="qr-kv">
                  <div><span>Status</span>{ATTEMPT_STATUS_LABELS[slot.status]} · verified {String(it.verified)} · compiled {String(it.compiled)} · statement faithful {String(it.statement_faithful)} · audit {it.audit_status}</div>
                  {it.failure_class && <div><span>Failure</span>{FAILURE_CLASS_LABELS[it.failure_class] || it.failure_class}{it.failure_evidence ? `: ${it.failure_evidence}` : ''}</div>}
                  <div><span>Partial progress</span>{it.partial_assessed ? `${it.partial_verified_aux_lemmas} independently verified auxiliary lemma(s); method: ${it.partial_method}` : `not assessed (${it.partial_method || 'no re-grade'})`}</div>
                  <div><span>Model</span><code>{it.model_id}</code>{it.api_host ? ` @ ${it.api_host}` : ''} · {it.harness}{it.temperature !== null && it.temperature !== undefined ? ` · T=${it.temperature}` : ''}{it.max_tokens ? ` · max tokens ${it.max_tokens}` : ''}</div>
                  {it.generation_error && <div><span>Generation error</span><code>{it.generation_error}</code></div>}
                  {it.lean_diagnostics && <div><span>Lean diagnostics</span><pre>{it.lean_diagnostics}</pre></div>}
                  {it.axioms && <div><span>Axioms</span><code>{it.axioms}</code></div>}
                  {it.notes && <div><span>Notes</span>{it.notes}</div>}
                  <div><span>Artifacts</span>{it.submission_artifact ? `proof file ${it.submission_artifact}` : 'no proof file recorded'} · {it.grade_artifact ? `grading record ${it.grade_artifact}` : 'no grading record'}{server ? '' : ' · open the run from the run server to read them'}</div>
                </div>
              )}
              {view !== 'summary' && (
                <div className="ev-doc">
                  {!server && <p className="muted">Proof text and grading records are read from the local run server; this run was opened from files. Load it with <b>List runs → Load</b> to inspect them.</p>}
                  {doc.loading && <p className="muted">loading…</p>}
                  {doc.error && <p className="muted">{doc.error}</p>}
                  {view === 'record' && record && <SessionsView record={record} />}
                  {doc.text && view !== 'record' && <pre className="ev-pre">{doc.text}</pre>}
                  {view === 'record' && doc.text && !record && <pre className="ev-pre">{doc.text}</pre>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function safeJson(t) { try { return JSON.parse(t) } catch { return null } }

function SessionsView({ record }) {
  const a = record.agent || {}
  const sessions = a.sessions || []
  return (
    <div>
      {sessions.length > 0 && (
        <div className="table-wrap">
          <table className="table ev-items">
            <thead><tr><th>Session</th><th>Ended by</th><th className="num">Output tokens</th><th className="num">Working time</th><th>Layer-1 check</th><th>Errors</th></tr></thead>
            <tbody>{sessions.map((s) => <tr key={s.index}><td>{s.index}{s.counted === false ? <span className="badge">not counted</span> : null}</td><td><code>{s.ended_by || s.stop_reason}</code></td><td className="num">{fmtInt(s.output_tokens)}</td><td className="num">{fmtMs(s.working_ms)}</td><td>{s.passed ? <b className="good">passed</b> : 'failed'}</td><td className="small">{(s.errors || []).join(' | ')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {a.layer1 && <div className="qr-kv"><div><span>Layer 1</span>{a.layer1.ok ? 'passed' : `failed: ${(a.layer1.errors || []).join(' | ')}`} · files {(a.layer1.files || []).join(', ') || '—'} · compile {a.layer1.compile_seconds ?? '?'} s · axioms {(a.layer1.axioms || []).join(', ') || '—'}</div>
        <div><span>Layer 2</span>{a.comparator === 'off' ? 'Comparator off' : a.comparator ? `Comparator ${a.comparator.ok ? 'accepted' : 'rejected'} (ran as ${a.comparator.ran_as || '?'})${a.comparator.tail ? `: ${a.comparator.tail.slice(-300)}` : ''}` : 'not run'}</div>
        <div><span>Graded in</span>{a.graded_in || '—'} · tool calls {JSON.stringify(a.totals?.tool_calls_by_tool || {})}</div></div>}
      {record.partial && <div className="qr-kv"><div><span>Partial progress</span>{JSON.stringify(record.partial)}</div></div>}
      <details className="small"><summary>Full record (JSON)</summary><pre className="ev-pre">{JSON.stringify(record, null, 2)}</pre></details>
    </div>
  )
}

/** pass@k for every k with the prominent ones highlighted; estimate and observed kept apart. */
export function PassKTable({ summary }) {
  const models = summary.models
  const curves = models.map((m) => ({ m, pk: summary.by_target.all?.[m.id]?.pass_at_k })).filter((x) => x.pk?.curve?.length)
  if (!curves.length) return <p className="muted">pass@k needs more than one attempt per problem (or an agent run); this run has k = 1.</p>
  const ks = [...new Set(curves.flatMap((x) => x.pk.curve.map((c) => c.k)))].sort((a, b) => a - b)
  const cov = summary.coverage?.coverage_differences || []
  return (
    <div>
      <p className="small">{curves[0].pk.curve_note} Cells show the unbiased estimate with its 95% paper-cluster interval, and below it the observed share of problems solved within the first k attempts (num/den). A dash means fewer than k attempts exist for every problem: unavailable, not zero. Prominent columns: k = 1, 2, 4, 8.</p>
      <Enlargeable title="pass@k by model">
        <div className="table-wrap">
          <table className="table ev-matrix ev-passk">
            <thead><tr><th>Model</th><th className="num">Problems · attempts</th>{ks.map((k) => <th key={k} className={`num ${[1, 2, 4, 8].includes(k) ? 'pk-prominent' : ''}`}>pass@{k}</th>)}</tr></thead>
            <tbody>
              {curves.map(({ m, pk }) => (
                <tr key={m.id}>
                  <td className="ev-model-cell" style={{ '--mc': slotColor(m.id) }}><i className="chip-dot" /><b>{shortLabel(m)}</b><div className="small mono">{m.model_id}</div></td>
                  <td className="num">{pk.items_with_attempts ?? '—'} · {pk.attempts_total ?? '—'}</td>
                  {ks.map((k) => { const c = pk.curve.find((x) => x.k === k); return (
                    <td key={k} className={`num ${[1, 2, 4, 8].includes(k) ? 'pk-prominent' : ''}`}>
                      {c && typeof c.value === 'number' ? <><b>{pct1(c.value)}</b>{typeof c.ci_lo === 'number' ? <div className="small">[{pct1(c.ci_lo)}, {pct1(c.ci_hi)}]</div> : null}<div className="small muted">obs {c.observed_within_k?.num}/{c.observed_within_k?.den} · n={c.items}{c.items_short ? ` (+${c.items_short} short)` : ''}</div></> : <span className="muted" title="no problem has that many attempts">—</span>}
                    </td>) })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Enlargeable>
      {cov.length > 0 ? <p className="small"><b>Coverage differs:</b> {cov.map((d) => `${shortLabel(models.find((m) => m.id === d.model) || { id: d.model })} lacks ${d.missing.length} of ${d.of} problems (${d.missing.slice(0, 8).join(', ')}${d.missing.length > 8 ? ', …' : ''})`).join('; ')}. Rates above are per model over its own problems; the comparison in section 8 uses the {summary.coverage?.common_problems?.length ?? '?'} common problems.</p> : <p className="small">All models cover the same {summary.coverage?.common_problems?.length ?? '?'} problems.</p>}
    </div>
  )
}

export function PassKProminentFigure({ summary }) {
  const models = summary.models
  const curves = models.map((m) => ({ m, pk: summary.by_target.all?.[m.id]?.pass_at_k })).filter((x) => x.pk?.curve?.length)
  if (!curves.length) return null
  const ks = [1, 2, 4, 8].filter((k) => curves.some((x) => x.pk.curve.some((c) => c.k === k && typeof c.value === 'number')))
  if (!ks.length) return null
  const rows = curves.map(({ m, pk }) => ({ id: m.id, label: shortLabel(m), values: Object.fromEntries(ks.map((k) => { const c = pk.curve.find((x) => x.k === k); return [`k${k}`, { value: typeof c?.value === 'number' ? c.value : null, text: typeof c?.value === 'number' ? pct1(c.value) : 'n/a' }] })) }))
  const series = ks.map((k, i) => ({ key: `k${k}`, label: `pass@${k}`, color: `var(--s${(i % 8) + 1})` }))
  const table = { columns: ['Model', ...ks.map((k) => `pass@${k}`)], rows: curves.map(({ m, pk }) => [m.display_name, ...ks.map((k) => { const c = pk.curve.find((x) => x.k === k); return typeof c?.value === 'number' ? pct1(c.value) : 'unavailable' })]) }
  return (
    <Figure title="pass@k, prominent k" subtitle="Unbiased estimate from all attempts; a missing bar means unavailable (too few attempts), never zero." legend={series.map((s) => ({ label: s.label, color: s.color }))} table={table}>
      <GroupedBars rows={rows} series={series} labelKey={series[series.length - 1].key} ariaLabel="pass@k by model" />
    </Figure>
  )
}

export function StatusFigure({ summary }) {
  const models = summary.models
  const parts = ATTEMPT_STATUS.slice(0, 4).map((s) => ({ key: s, label: ATTEMPT_STATUS_LABELS[s], color: STATUS_COLOR[s], ink: s === 'failed' ? 'var(--text)' : '#fff' }))
  const rows = models.map((m) => ({ id: m.id, label: shortLabel(m), counts: summary.by_target.all?.[m.id]?.status_counts || {} }))
  const table = { columns: ['Model', ...parts.map((p) => p.label), 'Attempts', 'Partial assessed'], rows: rows.map((r) => [models.find((m) => m.id === r.id)?.display_name, ...parts.map((p) => r.counts[p.key] || 0), r.counts.attempts || 0, r.counts.partial_assessed || 0]) }
  return (
    <Figure title="Attempt status, all attempts" subtitle="Every attempt record of the model. Partially solved means independently verified lemmas without a complete proof; it never counts as verified." legend={parts.map((p) => ({ label: p.label, color: p.color }))} table={table}>
      <StackedBars rows={rows} parts={parts} ariaLabel="Attempt status by model" />
    </Figure>
  )
}

export function FailureFigure({ summary }) {
  const models = summary.models
  const rows = models.map((m) => ({ id: m.id, label: shortLabel(m), counts: summary.by_target.all?.[m.id]?.failure_counts || {} }))
  const present = Object.keys(FAILURE_CLASS_LABELS).filter((c) => rows.some((r) => r.counts[c]))
  if (!present.length) return <p className="muted">No failed attempts to classify.</p>
  const palette = ['var(--s8)', 'var(--s2)', 'var(--s4)', 'var(--s5)', 'var(--s7)', 'var(--s1)', 'var(--s3)', 'var(--s6)', 'var(--axis)', 'var(--surface-3)', 'var(--critical)', 'var(--warn)', 'var(--muted)']
  const parts = present.map((c, i) => ({ key: c, label: FAILURE_CLASS_LABELS[c], color: palette[i % palette.length], ink: i >= 8 ? 'var(--text)' : '#fff' }))
  const table = { columns: ['Model', ...parts.map((p) => p.label)], rows: rows.map((r) => [models.find((m) => m.id === r.id)?.display_name, ...parts.map((p) => r.counts[p.key] || 0)]) }
  return (
    <Figure title="Failure classes, failed and infrastructure-error attempts" subtitle="First identifiable cause per attempt: provider and infrastructure failures are kept apart from the model's own errors (syntax, elaboration, type, tactic, timeout, dependency, statement changed, disallowed construct, incomplete proof)." legend={parts.map((p) => ({ label: p.label, color: p.color }))} table={table}>
      <StackedBars rows={rows} parts={parts} ariaLabel="Failure classes by model" />
    </Figure>
  )
}

/** Harness, environment and budgets of the run, and where models differ. */
export function ProtocolView({ summary }) {
  const hp = summary.run?.harness_protocol
  const s = summary.settings || {}
  const lim = hp?.limits || s.limits || null
  const mm = summary.run?.protocol_mismatches || []
  const machine = summary.run?.machine
  const rules = summary.counting_rules
  return (
    <div className="ev-protocol">
      <div className="qr-kv">
        <div><span>Harness</span>{hp ? <>{hp.label} · commit <code>{(hp.commit || '').slice(0, 10) || 'n/a'}</code>{hp.dirty ? ' (dirty)' : ''} · Inspect {hp.inspect_version || 'n/a'} · sandbox {hp.sandbox || 'n/a'} · image <code>{String(hp.image_id || 'n/a').replace(/^sha256:/, '').slice(0, 12)}</code></> : 'QEDRank single call (no tools)'}</div>
        <div><span>Lean environment</span>{hp ? <>{hp.lean_toolchain || 'n/a'} · Mathlib <code>{(hp.mathlib_commit || '').slice(0, 10) || 'n/a'}</code> · statements <code>{(hp.statements_commit || '').slice(0, 10) || 'n/a'}</code></> : <>{summary.run?.toolchain?.toolchain || 'n/a'} · Mathlib <code>{(summary.run?.toolchain?.mathlib?.rev || '').slice(0, 10) || 'n/a'}</code></>}</div>
        <div><span>Tools</span>{hp ? (hp.tools || []).join(', ') : 'none'} · network {hp ? String(hp.network) : 'n/a'} · web search {hp ? String(hp.search) : 'n/a'} · Comparator {hp ? (hp.comparator === false ? 'off' : 'on') : 'n/a (QEDRank grade)'}</div>
        <div><span>Budgets</span>{lim ? Object.entries(lim).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k} ${v}`).join(' · ') : `max tokens ${s.max_tokens ?? 'n/a'} · temperature ${s.temperature ?? 'n/a'}`} · attempts {s.attempts ?? s.k ?? 1}{hp?.effort ? ` · effort ${hp.effort}` : s.effort ? ` · effort ${s.effort}` : ''}</div>
        <div><span>Resources</span>{machine ? `${machine.cpus ?? '?'} CPUs · ${machine.total_memory_mb ? `${Math.round(machine.total_memory_mb / 1024)} GB RAM` : '?'} · GPUs ${machine.gpus?.length ? machine.gpus.join('; ') : 'none detected'} (import host)` : 'not recorded'} · per-attempt CPU, GPU and memory use: <span className="muted">unavailable (not measured by the harness)</span></div>
        <div><span>Differences</span>{mm.length ? <b className="warn">{[...new Set(mm.map((x) => x.field))].join(', ')} differ between {[...new Set(mm.map((x) => x.model))].length + 1} model/attempt combinations: see the attempt records; their rows are not under one protocol</b> : 'none recorded: every model and attempt ran under the same harness commit, image, Lean environment, tools and budgets'}</div>
        {summary.attempts && <div><span>Attempts</span>{Object.entries(summary.attempts.by_attempt || {}).map(([a, b]) => `a${a}: ${b.status} (${b.completed} done${b.missing?.length ? `, ${b.missing.length} missing` : ''})`).join(' · ')}{summary.attempts.stop_reason ? ` · stop reason ${summary.attempts.stop_reason}` : ''}</div>}
      </div>
      {rules && <details className="small"><summary>Counting rules (attempts, statuses, pass@k, cancellation, retries, coverage)</summary><ul>{Object.entries(rules).map(([k, v]) => <li key={k}><b>{k}</b>: {v}</li>)}</ul></details>}
    </div>
  )
}

export function AttemptsSection({ summary }) {
  return (
    <Fragment>
      <ProtocolView summary={summary} />
      <div className="ev-grid-2">
        <StatusFigure summary={summary} />
        <FailureFigure summary={summary} />
      </div>
    </Fragment>
  )
}
