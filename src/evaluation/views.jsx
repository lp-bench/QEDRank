// Tabular views for the evaluation page: the full matrix, the pairwise table, corpus coverage
// and the filterable item-level table.

import { Fragment, useMemo, useState } from 'react'
import { TARGET_KINDS, TARGET_LABELS, fmtRate, fmtCI, fmtMs, fmtNum, fmtInt, download, toCsv, rateOf } from '../qedrank/helpers.js'
import { Enlargeable, pct1 } from '../charts/primitives.jsx'
import { shortLabel, slotColor } from '../components/vendor.js'

export function Unavail({ note }) {
  return <span className="muted">unavailable{note ? ` (${note})` : ''}</span>
}

/** A rate with its numerator/denominator, interval and an inline mini-bar. */
export function Rate({ r, color = 'var(--s1)' }) {
  if (!r || r.den === undefined || r.den === null) return <Unavail />
  if (r.den === 0) return <Unavail note="0 eligible" />
  const ci = fmtCI(r)
  return (
    <span className="rate-cell">
      <span className="rate-bar" aria-hidden="true"><i style={{ width: `${Math.round(100 * r.value)}%`, background: color }} /></span>
      <b>{r.num}/{r.den}</b> <span className="muted">({pct1(r.value)})</span>
      {ci && <div className="small">{ci}</div>}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Performance matrix (every column)                                    */
/* ------------------------------------------------------------------ */

const MATRIX_COLUMNS = [
  ['Eligible n (stmt / proof)', (mm) => `${mm.eligible_statement} / ${mm.eligible_proof}`],
  ['GT-faithful statement', (mm) => <Rate r={mm.statement_faithful} color="var(--s2)" />],
  ['Compile', (mm) => <><Rate r={mm.compile} color="var(--s3)" /><div className="small">abstained {mm.compile.abstained}, screened out {mm.compile.screen_rejected}</div></>],
  ['Audit clean', (mm) => <Rate r={mm.audit_clean} color="var(--s4)" />],
  ['Verified pass@1', (mm) => <Rate r={mm.verified_pass1} color="var(--s1)" />],
  ['Verified pass@k', (mm) => (mm.pass_at_k ? <Rate r={mm.pass_at_k} color="var(--s1)" /> : <Unavail note="k = 1" />)],
  ['Repair setting', (mm) => (mm.repair ? <Rate r={mm.repair} color="var(--s1)" /> : <Unavail note="disabled" />)],
  ['RMS calibration (stmt / proof)', (mm) => `${fmtNum(mm.calibration.statement.rms_calibration_error, 3)} / ${fmtNum(mm.calibration.proof_audit.rms_calibration_error, 3)}`],
  ['Median total time', (mm) => `${fmtMs(mm.time.total_item_ms.median)} (timeouts ${mm.time.total_item_ms.timeouts})`],
  ['Median working time', (mm) => (mm.time.working_item_ms?.n ? fmtMs(mm.time.working_item_ms.median) : <Unavail note="not recorded" />)],
  ['Median latency / Lean', (mm) => `${fmtMs(mm.time.observed_model_latency_ms.median)} / ${fmtMs(mm.time.lean_total_ms.median)}`],
  ['Median tokens in / out', (mm) => (mm.tokens.n_with_usage ? `${fmtInt(mm.tokens.median_input)} / ${fmtInt(mm.tokens.median_output)}` : <Unavail note="no usage data" />)],
  ['Cost / verified success', (mm) => (mm.cost.available ? (mm.cost.per_verified_success_usd === null ? <Unavail note="no verified successes" /> : `$${fmtNum(mm.cost.per_verified_success_usd, 3)}`) : <Unavail note="pricing not configured" />)],
  ['Median proof LOC (model / eligible ref)', (mm) => `${mm.loc.median_model_proof_lines ?? 'unavailable'} / ${mm.loc.median_reference_proof_lines_eligible ?? 'unavailable'}`],
  ['Unresolved · abstention', (mm) => `${fmtRate(mm.unresolved)} · ${fmtRate(mm.abstention)}`],
  ['Infra failures', (mm) => mm.infrastructure_failures],
]

export function MatrixTable({ summary, scope }) {
  const rows = summary.by_target[scope] || {}
  return (
    <div className="table-wrap">
      <table className="table ev-matrix">
        <thead><tr><th>Model</th>{MATRIX_COLUMNS.map(([h]) => <th key={h} className="num">{h}</th>)}{scope === 'all' && <th className="num">Sandwich coverage</th>}{scope === 'all' && <th className="num">Paper-level verified</th>}</tr></thead>
        <tbody>
          {summary.models.map((m) => {
            const mm = rows[m.id]
            if (!mm) return null
            const pl = summary.paper_level?.[m.id]
            return (
              <tr key={m.id}>
                <td className="ev-model-cell" style={{ '--mc': slotColor(m.id) }}><i className="chip-dot" /><b>{shortLabel(m)}</b><div className="small mono">{m.model_id}{m.host ? ` @ ${m.host}` : ''}</div></td>
                {MATRIX_COLUMNS.map(([h, fn]) => <td key={h} className="num">{fn(mm)}</td>)}
                {scope === 'all' && <td className="num">{pl ? <Rate r={pl.sandwich_coverage} color="var(--s3)" /> : <Unavail />}</td>}
                {scope === 'all' && <td className="num">{pl ? <Rate r={pl.paper_verified_all_eligible_bounds} color="var(--s1)" /> : <Unavail />}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Agent runs: sessions, budgets, tool calls, audit state               */
/* ------------------------------------------------------------------ */

export function AgentView({ summary }) {
  const a = summary.agent
  const models = summary.models
  const ms = (v) => (typeof v === 'number' ? fmtMs(v) : 'n/a')
  return (
    <section id="agent" className="ev-section">
      <h2 className="ev-h2"><span className="ev-num">0</span>Agent protocol</h2>
      <p className="small">At most {a.sessions_max} fresh session{a.sessions_max === 1 ? '' : 's'} per problem, joined by a handoff note; the independent Lean check after every session decides. "Solved within k" counts a problem when the check passed in one of its first k sessions (95% paper-cluster intervals). Web search {a.web_search ? 'on' : 'off'}. Unaudited solves are counted and listed; a hand audit (<code>review/audit.json</code>) can withdraw them.</p>
      <Enlargeable title="Agent protocol">
      <div className="table-wrap">
        <table className="table ev-matrix">
          <thead><tr><th>Model</th>{a.tiers.map((k) => <th key={k} className="num">Solved within {k}</th>)}<th className="num">Sessions to success (median)</th><th className="num">Sessions ended by budget</th><th className="num">Output tokens (total)</th><th className="num">Working time (total)</th><th className="num">Tool calls (total)</th><th className="num">Completeness, unsolved (mean)</th><th className="num">Awaiting audit</th><th>Open-claim escalations</th></tr></thead>
          <tbody>
            {models.map((m) => {
              const r = a.by_model?.[m.id]
              if (!r) return null
              return (
                <tr key={m.id}>
                  <td className="ev-model-cell" style={{ '--mc': slotColor(m.id) }}><i className="chip-dot" /><b>{shortLabel(m)}</b><div className="small mono">{m.model_id}</div></td>
                  {a.tiers.map((k) => <td key={k} className="num"><Rate r={r.solved_within[k]} color="var(--s1)" /></td>)}
                  <td className="num">{r.sessions_to_success.median ?? 'n/a'}</td>
                  <td className="num">{fmtRate(r.sessions_ended_by_output_budget)}</td>
                  <td className="num">{fmtInt(r.totals.output_tokens)}</td>
                  <td className="num">{ms(r.totals.working_ms)}</td>
                  <td className="num">{fmtInt(r.totals.tool_calls)}{r.totals.tool_calls_by_tool && Object.keys(r.totals.tool_calls_by_tool).length ? <div className="small">{Object.entries(r.totals.tool_calls_by_tool).map(([t, n]) => `${t} ${n}`).join(' · ')}</div> : null}</td>
                  <td className="num">{r.completeness_unsolved.n ? `${fmtNum(r.completeness_unsolved.mean, 2)} (n = ${r.completeness_unsolved.n})` : 'n/a'}</td>
                  <td className="num">{r.awaiting_manual_audit.length}</td>
                  <td>{r.open_claim_escalations.length ? r.open_claim_escalations.join(', ') : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      </Enlargeable>
      {summary.run?.protocol_mismatches?.length > 0 && <p className="small"><b>Warning:</b> the imported models did not run under one protocol — {[...new Set(summary.run.protocol_mismatches.map((x) => x.field))].join(', ')} differ. Their rows are not comparable.</p>}
    </section>
  )
}

/** Flat rows (one per scope × model) for the CSV download; mirrors qedrank/lib/metrics.js matrixRows. */
export function matrixCsvRows(summary) {
  const rows = []
  for (const scope of ['all', ...TARGET_KINDS]) {
    for (const m of summary.models) {
      const mm = summary.by_target[scope]?.[m.id]
      if (!mm) continue
      const pl = summary.paper_level?.[m.id]
      rows.push({
        scope, model: m.display_name, model_id: m.model_id,
        eligible_statement_n: mm.eligible_statement, eligible_proof_n: mm.eligible_proof, infrastructure_failures: mm.infrastructure_failures,
        statement_faithful: fmtRate(mm.statement_faithful), statement_faithful_ci: fmtCI(mm.statement_faithful),
        compile: fmtRate(mm.compile), audit_clean: fmtRate(mm.audit_clean),
        verified_pass1: fmtRate(mm.verified_pass1), verified_pass1_ci: fmtCI(mm.verified_pass1),
        verified_passk: mm.pass_at_k ? fmtRate(mm.pass_at_k) : 'n/a (k=1)', repair: mm.repair ? fmtRate(mm.repair) : 'n/a',
        sandwich_coverage: scope === 'all' && pl ? fmtRate(pl.sandwich_coverage) : scope === 'all' ? 'unavailable' : 'n/a',
        unresolved: fmtRate(mm.unresolved), abstention: fmtRate(mm.abstention),
        rms_calibration_statement: mm.calibration.statement.rms_calibration_error, rms_calibration_proof: mm.calibration.proof_audit.rms_calibration_error,
        median_latency_ms: mm.time.observed_model_latency_ms.median, median_lean_ms: mm.time.lean_total_ms.median, median_total_ms: mm.time.total_item_ms.median, timeouts: mm.time.total_item_ms.timeouts,
        median_input_tokens: mm.tokens.median_input ?? 'unavailable', median_output_tokens: mm.tokens.median_output ?? 'unavailable',
        cost_per_verified_usd: mm.cost.per_verified_success_usd ?? 'unavailable',
        median_model_proof_loc: mm.loc.median_model_proof_lines ?? 'unavailable', median_reference_proof_loc: mm.loc.median_reference_proof_lines_eligible ?? 'unavailable',
      })
    }
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* Pairwise table                                                       */
/* ------------------------------------------------------------------ */

export function ComparisonTable({ comparison, models }) {
  const name = (id) => shortLabel(models.find((m) => m.id === id) || { id })
  return (
    <div className="table-wrap">
      <table className="table ev-pairs">
        <thead><tr><th>Pair</th><th className="num">Successes A / B</th><th className="num">Diff (pp)</th><th className="num">95% CI</th><th className="num">Discordant A-only / B-only</th><th className="num">McNemar p</th><th className="num">Holm p</th></tr></thead>
        <tbody>
          {comparison.pairwise.map((p) => {
            const sig = p.p_holm !== null && p.p_holm < 0.05
            return (
              <tr key={p.key} className={sig ? 'ev-sig-row' : ''}>
                <td>{name(p.model_a)} vs {name(p.model_b)}{sig && <span className="badge accent" style={{ '--badge-color': 'var(--good)' }}>supported</span>}</td>
                <td className="num">{p.a_successes} / {p.b_successes} of {p.n}</td>
                <td className="num">{fmtNum(p.diff_pp, 1)}</td>
                <td className="num">{p.diff_ci_lo === null ? 'unavailable' : `[${fmtNum(p.diff_ci_lo, 1)}, ${fmtNum(p.diff_ci_hi, 1)}]`}</td>
                <td className="num">{p.discordant_a_only} / {p.discordant_b_only}</td>
                <td className="num">{fmtNum(p.p, 4)}</td>
                <td className="num">{fmtNum(p.p_holm, 4)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Corpus coverage, reference audit, subsets, caveats                   */
/* ------------------------------------------------------------------ */

export function CoverageView({ summary }) {
  const c = summary.coverage
  const d = summary.reference_defects || {}
  return (
    <div className="ev-coverage">
      <div className="qr-kv">
        <div><span>Papers</span>{c.papers_discovered} discovered (expected {c.expected_count}; {c.expected_count_matches ? 'matches' : 'does not match'}), {c.papers_with_pdf ?? '?'} with PDF</div>
        <div><span>Audited reference statements</span>{TARGET_KINDS.map((k) => <b key={k}>{TARGET_LABELS[k]}: {c.references_audited?.[k] ?? 0}&nbsp;&nbsp;</b>)}</div>
        <div><span>Reference proof status</span>{TARGET_KINDS.map((k) => <code key={k}>{k}: {JSON.stringify(c.reference_proof_status?.[k] || {})} </code>)}</div>
        <div><span>Mathematical status</span>{TARGET_KINDS.map((k) => <code key={k}>{k}: {JSON.stringify(c.mathematical_status?.[k] || {})} </code>)}</div>
        <div><span>Eligible items</span>statement track {JSON.stringify(c.eligible_items?.statement_track)} · proof track {JSON.stringify(c.eligible_items?.proof_track)}</div>
        <div><span>Items</span>{c.items_total} total, {c.items_infrastructure_failed} infrastructure failures (excluded from denominators)</div>
        {c.open_claim_escalations?.length > 0 && <div><span className="bad">Escalations</span>apparent proofs of open claims need independent review: {c.open_claim_escalations.join(', ')}</div>}
        <div><span>Reference defects</span>{d.references_reviewed ?? 0}/{d.references_total ?? 0} references expert-reviewed; {d.defects_recorded ?? 0} defects recorded {Object.keys(d.defects_by_type || {}).length ? JSON.stringify(d.defects_by_type) : ''}; automated findings: {JSON.stringify(d.automated_findings || {})}</div>
        {d.corrections?.length > 0 && <div><span>Corrections</span>{d.corrections.map((x, i) => <code key={i}>{x.reference}: {x.type} — {x.reason}</code>)}</div>}
      </div>
      <h3 className="ev-h3">Subsets</h3>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Model</th><th className="num">Common input set: verified pass@1</th><th className="num">Common input set: GT-faithful</th><th className="num">Text-only subset: verified pass@1</th></tr></thead>
          <tbody>{summary.models.map((m) => { const s = summary.subsets?.[m.id]; return s ? <tr key={m.id}><td>{m.display_name}</td><td className="num"><Rate r={s.common_input_set.verified_pass1} /></td><td className="num"><Rate r={s.common_input_set.statement_faithful} color="var(--s2)" /></td><td className="num">{s.text_only_subset.note ? <Unavail note={s.text_only_subset.note} /> : <Rate r={s.text_only_subset.verified_pass1} />}</td></tr> : null })}</tbody>
        </table>
      </div>
      <details className="small"><summary>Caveats</summary><ul>{(summary.caveats || []).map((x, i) => <li key={i}>{x}</li>)}</ul></details>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Item-level table with filters and exports                            */
/* ------------------------------------------------------------------ */

const ITEM_FILTERS = [
  ['model', 'Model'], ['paper_id', 'Paper'], ['target_kind', 'Target'], ['mathematical_status', 'Math status'], ['statement_match', 'Statement match'], ['compile_status', 'Compile'], ['audit_status', 'Audit'], ['setting', 'Setting'], ['status', 'Status'], ['failure_class', 'Failure class'], ['harness', 'Harness'],
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
    <div className="card">
      <div className="form-grid">
        {ITEM_FILTERS.map(([k, label]) => (
          <label key={k} className="field">{label}
            <select value={filters[k] || ''} onChange={(e) => { setFilters({ ...filters, [k]: e.target.value }); setPage(0) }}>
              <option value="">all</option>
              {options[k].map((v) => <option key={v} value={v}>{String(v)}</option>)}
            </select>
          </label>
        ))}
        <label className="field">Search<input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="paper, note, error…" /></label>
      </div>
      <p className="small">{filtered.length} records match. Filtered pass@1 rates (no CI): GT-faithful {fmtRate(rStmt)} · compile {fmtRate(rComp)} · verified {fmtRate(rVer)}. Infrastructure failures excluded: {filtered.filter((r) => r.infrastructure_failure).length}.</p>
      <Enlargeable title="Item-level results" toolbar={(
        <div className="row">
          <button className="btn btn-secondary btn-sm" onClick={() => download(`${runId || 'qedrank'}-items-filtered.csv`, toCsv(filtered), 'text/csv')}>Download filtered CSV</button>
          <button className="btn btn-secondary btn-sm" onClick={() => download(`${runId || 'qedrank'}-items-filtered.json`, JSON.stringify({ schema: 'qedrank-items-v1', run_id: runId, count: filtered.length, items: filtered }, null, 2), 'application/json')}>Download filtered JSON</button>
        </div>
      )}>
      <div className="table-wrap">
        <table className="table ev-items">
          <thead><tr><th>Paper</th><th>Target</th><th>Model</th><th>Setting</th><th>Compile</th><th>Audit</th><th>Statement match</th><th>Verified</th><th className="num">Conf (stmt/proof)</th><th className="num">Latency</th><th className="num">Lean</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => {
              const key = `${r.item_key}-${r.setting}-${r.attempt}-${r.repair_round}`
              return (
                <Fragment key={key}>
                  <tr className={r.infrastructure_failure ? 'qr-row-infra' : r.verified === 1 ? 'qr-row-ok' : ''}>
                    <td><code>{r.paper_id}</code></td><td>{TARGET_LABELS[r.target_kind] || r.target_kind}</td><td>{r.model}</td><td>{r.setting} a{r.attempt}{r.repair_round ? ` r${r.repair_round}` : ''}</td>
                    <td><Status v={r.compile_status} /></td><td><Status v={r.audit_status} /></td><td><Status v={r.statement_match} />{r.statement_match_source === 'expert_review' && <span className="badge">expert</span>}</td>
                    <td>{r.infrastructure_failure ? <span className="muted">infra</span> : r.verified === 1 ? <b className="good">yes</b> : r.verified === 0 ? 'no' : <span className="muted">n/e</span>}</td>
                    <td className="num">{r.statement_confidence ?? '–'} / {r.proof_confidence ?? '–'}</td><td className="num">{fmtMs(r.observed_latency_ms)}</td><td className="num">{fmtMs(r.lean_total_ms)}</td>
                    <td><button className="link-btn" onClick={() => setOpen(open === key ? null : key)}>{open === key ? 'hide' : 'details'}</button></td>
                  </tr>
                  {open === key && (
                    <tr className="qr-details"><td colSpan="12">
                      <div className="qr-kv">
                        <div><span>Model id</span><code>{r.model_id}</code>{r.response_model ? <code> ({r.response_model})</code> : null} · prompt {r.prompt_hash?.slice(0, 12)} · T={r.temperature === null || r.temperature === undefined ? 'n/a' : r.temperature} · max tokens {r.max_tokens}</div>
                        <div><span>Eligibility</span>statement {String(r.eligible_statement_track)} · proof {String(r.eligible_proof_track)} {r.eligibility_reasons && <code>{r.eligibility_reasons}</code>}</div>
                        <div><span>Reference</span>{r.reference_proof_status === 'contains_placeholder' ? 'statement + sorry (the task)' : r.reference_proof_status} · statement available: {String(r.reference_statement_available)} · math status {r.mathematical_status}</div>
                        {r.generation_error && <div><span>Generation error</span><code>{r.generation_error}</code></div>}
                        {r.static_screen_rejections && <div><span>Static screen</span><code>{r.static_screen_rejections}</code></div>}
                        {r.axioms && <div><span>Axioms</span><code>{r.axioms}</code></div>}
                        {r.audit_static_flags && <div><span>Static flags</span><code>{r.audit_static_flags}</code></div>}
                        <div><span>A/B consistent</span>{String(r.ab_consistent)}</div>
                        {r.comparison_notes && <div><span>Comparison</span>{r.statement_match_method}: {r.comparison_notes}</div>}
                        {r.lean_diagnostics && <div><span>Lean diagnostics</span><pre>{r.lean_diagnostics}</pre></div>}
                        <div><span>LOC</span>model {r.model_code_lines ?? '–'} code / {r.model_proof_lines ?? '–'} proof · reference {r.reference_code_lines ?? '–'} / {r.reference_proof_lines ?? '–'}</div>
                        <div><span>Tokens / cost</span>{r.input_tokens ?? 'n/a'} in, {r.output_tokens ?? 'n/a'} out{r.reasoning_tokens != null ? `, ${r.reasoning_tokens} reasoning` : ''}, {r.cost_usd === null || r.cost_usd === undefined ? 'cost unavailable' : `$${r.cost_usd}`}</div>
                        {r.notes && <div><span>Notes</span>{r.notes}</div>}
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="small">page {page + 1} of {Math.max(1, Math.ceil(filtered.length / pageSize))}</span>
        <button className="btn btn-secondary btn-sm" disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage(page + 1)}>Next</button>
      </div>
      </Enlargeable>
    </div>
  )
}

function Status({ v }) {
  if (v === null || v === undefined) return <span className="muted">–</span>
  const good = ['compiler_success', 'clean', 'definitionally_identical', 'equivalent', 'expert_confirmed_equivalent']
  const bad = ['compiler_failure', 'placeholder', 'user_axiom', 'unsafe', 'forbidden_command', 'disallowed_import', 'different', 'rejected_by_static_screen']
  const cls = good.includes(v) ? 'good' : bad.includes(v) ? 'bad' : v === 'infrastructure_failure' || v === 'timeout' ? 'warn' : ''
  return <span className={cls}>{v.replace(/_/g, ' ')}</span>
}
