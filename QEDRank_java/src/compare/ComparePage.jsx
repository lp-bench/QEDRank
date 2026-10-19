// Benchmark comparison: ProofBench against the published Lean benchmarks. The numbers come from
// `node qedrank/cli.js compare`, which measures every benchmark's statements with the same rules
// and merges the facts reported in each benchmark's paper or leaderboard. The JSON is loaded from
// the local run server or from a file, so ProofBench's private corpus never ships with the site.

import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { ChartSizing, Figure, HBars, Heatmap, StackedBars, pct1 } from '../charts/primitives.jsx'
import { SizeRateScatter, LogBoxes } from './charts.jsx'
import { download } from '../qedrank/helpers.js'
import '../evaluation/evaluation.css'
import './compare.css'

const STORE = 'qedrank.compare'
const SERVER = 'qedrank.compare.server'
const FILE_PATH = 'runs/_compare/benchmark-comparison.json'

// The five ordered levels on one validated ramp; coursework, calibration and unlabelled items are
// not points on that scale and wear neutrals (named in the legend and the table).
export const LEVELS = [
  ['coursework', 'School coursework', 'var(--neutral-1)'],
  ['competition', 'Competition', 'var(--ord-1)'],
  ['undergraduate', 'Undergraduate', 'var(--ord-2)'],
  ['graduate', 'Graduate', 'var(--ord-3)'],
  ['research', 'Research', 'var(--ord-4)'],
  ['open', 'Open problem', 'var(--ord-5)'],
  ['calibration', 'Calibration', 'var(--neutral-2)'],
  ['unlabeled', 'Not labelled', 'var(--neutral-3)'],
]
const BUDGET = {
  single: ['circle', 'one attempt (incl. one agentic run)'],
  sampled: ['square', 'pass@2 – pass@64'],
  heavy: ['triangle', 'pass@128+, refinement or per-problem compute budget'],
  unknown: ['diamond', 'budget not reported'],
}

function read(kind, key, fallback) {
  try { const v = window[kind].getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function write(kind, key, value) {
  try { window[kind].setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? (d ? v.toFixed(d) : String(Math.round(v))) : '—')
const share = (v) => (typeof v === 'number' ? pct1(v) : '—')

export default function ComparePage() {
  const [data, setData] = useState(() => read('sessionStorage', STORE, null))
  const [server, setServer] = useState(() => read('localStorage', SERVER, 'http://127.0.0.1:8787'))
  const [status, setStatus] = useState('')

  const load = async () => {
    setStatus('Loading…')
    try {
      const res = await axios.get(`${server.replace(/\/+$/, '')}/runs/_compare/benchmark-comparison.json`)
      accept(res.data)
    } catch (err) {
      setStatus(`Could not load from ${server}: ${err.response?.status === 404 ? 'no comparison yet — run the compare command first' : err.message}. Start the server with: npm run qedrank:serve`)
    }
  }
  const accept = (j) => {
    if (j?.schema !== 'qedrank-benchmark-comparison-v1') { setStatus('This file is not a QEDRank benchmark comparison.'); return }
    setData(j)
    setStatus('')
    write('sessionStorage', STORE, j)
  }
  const onFile = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    try { accept(JSON.parse(await f.text())) } catch (err) { setStatus(`${f.name}: ${err.message}`) }
  }
  useEffect(() => { write('localStorage', SERVER, server) }, [server])

  return (
    <main className="page eval compare">
      <div className="page-head">
        <span className="eyebrow">QEDRank · benchmark landscape</span>
        <h1>ProofBench and the Lean benchmarks</h1>
        <p>Compare ProofBench with established Lean formalization benchmarks, including miniF2F, PutnamBench, FormalMATH, MSC-180, ProofNet, CombiBench, AMBER, FormalProofBench, LeanEval, and other supported datasets. The comparison covers benchmark size, difficulty, mathematical subject coverage, statement complexity, theorem and proof types, Lean and Mathlib versions, dataset diversity, overlap, and headroom for future progress. Statement-level statistics are calculated using a consistent measurement protocol for every benchmark, while dataset sizes and best reported results are taken from the original benchmark papers or public leaderboards, with links provided to their sources.</p>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Load a comparison</h2>
            <p>Generate it with <code>node qedrank/cli.js compare</code> (it writes <code>{FILE_PATH}</code> and the LaTeX file for the paper), then load it from the run server or open the JSON file.</p>
          </div>
        </div>
        <div className="form-grid">
          <label className="field">Run server<input value={server} onChange={(e) => setServer(e.target.value)} /></label>
          <button type="button" className="btn" onClick={load}>Load from server</button>
          <label className="field">Or open the file<input type="file" accept="application/json" onChange={onFile} /></label>
        </div>
        {status && <div className="note">{status}</div>}
      </section>

      {data && <Comparison data={data} />}
    </main>
  )
}

export function Comparison({ data }) {
  const pb = data.proofbench
  const all = data.benchmarks
  const measured = all.filter((b) => b.measured?.available)
  const [lengthField, setLengthField] = useState('closure_tokens')

  const scatter = useMemo(() => all.filter((b) => b.facts?.problems).map((b) => {
    const best = b.facts.best || {}
    const isPB = b.id === 'proofbench'
    const [shape] = BUDGET[best.budget_class] || BUDGET.unknown
    const title = (
      <span><b>{b.name}</b> · evaluated on {(best.evaluated_on || b.facts.problems).toLocaleString()} problems<br />
        {isPB ? <>best verified {best.solved}/{best.of} (95% CI {pct1(best.ci?.[0] ?? 0)}–{pct1(best.ci?.[1] ?? 0)}), {best.model}</> : typeof best.rate === 'number' ? <>{pct1(best.rate)} · {best.model || 'model not stated'} · {best.budget || 'budget not stated'}</> : 'no published result'}
        {best.date ? <><br />{best.date}</> : null}</span>
    )
    return {
      id: b.id,
      label: b.short || b.name,
      x: best.evaluated_on || b.facts.problems,
      y: typeof best.rate === 'number' ? best.rate : null,
      lo: isPB ? best.ci?.[0] : undefined,
      hi: isPB ? best.ci?.[1] : undefined,
      shape: isPB ? 'circle' : shape,
      hollow: isPB,
      color: isPB ? 'var(--s2)' : 'var(--s1)',
      title,
    }
  }).filter((p) => p.y !== null || p.hi !== undefined), [all])

  const boxes = measured.map((b) => {
    const s = b.measured.statements[lengthField] || {}
    return { id: b.id, label: b.short || b.name, n: s.n, p10: s.p10, q1: s.q1, median: s.median, q3: s.q3, p90: s.p90, color: b.id === 'proofbench' ? 'var(--s2)' : 'var(--s1)' }
  })

  const groups = data.subject_groups || []
  const withSubjects = all.filter((b) => b.subjects && Object.keys(b.subjects).length)
  const levelRows = all.filter((b) => b.levels && Object.keys(b.levels).length).map((b) => ({ id: b.id, label: `${b.short || b.name}${b.levels_source === 'stated' ? ' *' : ''}`, counts: b.levels }))
  const levelParts = LEVELS.filter(([k]) => levelRows.some((r) => r.counts[k])).map(([key, label, color]) => ({ key, label, color }))

  return (
    <ChartSizing.Provider value={{ height: 380, compactHeight: 300 }}>
      <section className="stat-tiles ev-kpis">
        <div className="stat" style={{ '--stat-color': 'var(--s2)' }}><div className="label">ProofBench problems</div><div className="value">{pb.problems}</div><div className="sub">{pb.targets?.disproof || 0} disproof variants · commit {pb.source?.commit?.slice(0, 7)}</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--ord-5)' }}><div className="label">Open claims</div><div className="value">{pb.claim_status?.open || 0}</div><div className="sub">{share((pb.claim_status?.open || 0) / pb.problems)} of the problems; no other benchmark ships open problems</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s1)' }}><div className="label">Statements needing own definitions</div><div className="value">{share(pb.statements.share_with_local_defs)}</div><div className="sub">median {num(pb.statements.defs_used.median)} definitions beyond Mathlib</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s3)' }}><div className="label">Median statement with definitions</div><div className="value">{num(pb.statements.closure_tokens.median)}</div><div className="sub">tokens (signature alone: {num(pb.statements.stmt_tokens.median)})</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s7)' }}><div className="label">Largest subject</div><div className="value" style={{ fontSize: '1.2rem' }}>{data.proofbench_top_subject?.label || '—'}</div><div className="sub">{data.proofbench_top_subject ? `${data.proofbench_top_subject.count} of ${pb.problems} problems` : ''}</div></div>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">1</span>Benchmark characteristics</h2>
        <p className="small">As reported by each benchmark (sources linked). “Best reported” is not comparable across rows unless the sampling budget matches.</p>
        <FactsTable benchmarks={all} />
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">2</span>Headroom: size against best reported success</h2>
        <Figure
          title="Best reported success rate by benchmark size"
          subtitle="Each benchmark at its best verified result, placed at the size of the set that result was reported on; marker shape is the budget behind it. ProofBench (hollow) shows the QEDRank runs: the best verified rate with its exact 95% interval."
          legend={[...Object.entries(BUDGET).map(([, [, label]]) => ({ label, color: 'var(--s1)' })), { label: 'ProofBench (QEDRank runs)', color: 'var(--s2)' }]}
          table={{ columns: ['Benchmark', 'Evaluated on', 'Best reported', 'Model', 'Budget', 'Source'], rows: all.filter((b) => b.facts).map((b) => [b.name, (b.facts.best?.evaluated_on || b.facts.problems)?.toLocaleString() ?? '—', b.id === 'proofbench' ? `${b.facts.best?.solved ?? '—'}/${b.facts.best?.of ?? '—'}` : typeof b.facts.best?.rate === 'number' ? pct1(b.facts.best.rate) : '—', b.facts.best?.model || '—', b.facts.best?.budget || '—', b.facts.best?.source_url ? <a href={b.facts.best.source_url} target="_blank" rel="noreferrer">link</a> : '—']) }}
        >
          <SizeRateScatter points={scatter} />
        </Figure>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">3</span>Statement complexity</h2>
        <p className="small">{data.method?.summary}</p>
        <div className="tabs">
          {[['closure_tokens', 'Statement with its definitions'], ['stmt_tokens', 'Theorem signature only']].map(([k, l]) => <button key={k} type="button" className={`tab ${lengthField === k ? 'active' : ''}`} onClick={() => setLengthField(k)}>{l}</button>)}
        </div>
        <div className="ev-grid-2">
          <Figure
            title={lengthField === 'closure_tokens' ? 'Tokens a reader must understand per problem' : 'Tokens in the theorem signature'}
            subtitle="Box: middle half of the problems; line: median; whiskers: 10th to 90th percentile."
            table={{ columns: ['Benchmark', 'Measured', 'P10', 'Q1', 'Median', 'Q3', 'P90', 'Max'], rows: measured.map((b) => { const s = b.measured.statements[lengthField] || {}; return [b.name, s.n ?? 0, num(s.p10), num(s.q1), num(s.median), num(s.q3), num(s.p90), num(s.max)] }) }}
          >
            <LogBoxes rows={boxes} />
          </Figure>
          <Figure
            title="Problems whose statement uses definitions beyond the standard libraries"
            subtitle="Same-file definitions or the benchmark's own library, followed transitively. The label is count / measured problems."
            table={{ columns: ['Benchmark', 'Uses own definitions', 'Imports a benchmark library', 'Median definitions used'], rows: measured.map((b) => { const s = b.measured.statements; return [b.name, `${s.count_with_local_defs}/${s.measured} (${share(s.share_with_local_defs)})`, `${s.count_with_project_library}/${s.measured}`, num(s.defs_used?.median)] }) }}
          >
            <HBars series={measured.map((b) => { const s = b.measured.statements; return { id: b.id, label: b.short || b.name, value: s.share_with_local_defs, text: `${s.count_with_local_defs}/${s.measured}`, color: b.id === 'proofbench' ? 'var(--s2)' : 'var(--s1)' } })} />
          </Figure>
        </div>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">4</span>Subject coverage</h2>
        <Figure
          title="Share of problems by subject area"
          subtitle={`Share of labelled problems; a problem with several labels counts in each. ${all.filter((b) => !withSubjects.includes(b)).length ? `No subject labels: ${all.filter((b) => !withSubjects.includes(b)).map((b) => b.short || b.name).join(', ')}. ` : ''}Rows marked * use counts stated in the benchmark's paper. Darker is a larger share.`}
          table={{ columns: ['Benchmark', ...groups.map((g) => g.label), 'Labelled', 'Source'], rows: withSubjects.map((b) => { const t = Object.values(b.subjects).reduce((a, c) => a + c, 0); return [b.name, ...groups.map((g) => `${num(b.subjects[g.id] || 0, (b.subjects[g.id] || 0) % 1 ? 1 : 0)} (${share((b.subjects[g.id] || 0) / t)})`), num(t), b.subjects_source || '—'] }) }}
        >
          <Heatmap rows={withSubjects.map((b) => ({ id: b.id, label: `${b.short || b.name}${b.subjects_source === 'stated' ? ' *' : ''}` }))} cols={groups.map((g) => ({ id: g.id, label: g.short || g.label }))} cell={(bid, gid) => { const b = withSubjects.find((x) => x.id === bid); const t = Object.values(b.subjects).reduce((a, c) => a + c, 0); const n = b.subjects[gid] || 0; return { value: t ? n / t : null, text: n ? `${Math.round((100 * n) / t)}%` : '·', title: <span><b>{b.name}</b> · {groups.find((g) => g.id === gid)?.label}<br />{num(n, n % 1 ? 1 : 0)} of {num(t)} labelled problems ({share(t ? n / t : null)})</span> } }} />
        </Figure>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">5</span>Difficulty composition</h2>
        <Figure
          title="Problems by level"
          subtitle={`Per-problem labels where the benchmark has them; rows marked * use the level or counts stated by the benchmark.${all.filter((b) => !levelRows.find((r) => r.id === b.id)).length ? ` No level breakdown published: ${all.filter((b) => !levelRows.find((r) => r.id === b.id)).map((b) => b.short || b.name).join(', ')}.` : ''}`}
          legend={levelParts.map((p) => ({ label: p.label, color: p.color }))}
          table={{ columns: ['Benchmark', ...levelParts.map((p) => p.label), 'Source'], rows: levelRows.map((r) => [r.label, ...levelParts.map((p) => r.counts[p.key] || 0), all.find((b) => b.id === r.id)?.levels_source || '—']) }}
        >
          <StackedBars rows={levelRows} parts={levelParts} />
        </Figure>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">6</span>ProofBench composition</h2>
        <div className="ev-grid-2">
          <Figure title="MSC 2020 sections" subtitle="Primary MSC code of each problem, by three-character section." table={{ columns: ['Section', 'Problems'], rows: Object.entries(pb.msc_section || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]) }}>
            <HBars series={Object.entries(pb.msc_section || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ id: k, label: `${k} ${data.msc_names?.[k] || ''}`.trim(), value: v / pb.problems, text: String(v), color: 'var(--s2)' }))} />
          </Figure>
          <Figure title="Claim status and performance" subtitle="Main theorems; verified answers in the QEDRank runs loaded into the comparison, over established claims with a determinate outcome." table={{ columns: ['Run', 'Model', 'Verified', '95% CI', 'Provider/grader failures'], rows: (pb.performance || []).map((p) => [p.run_id, p.model, `${p.verified}/${p.den}`, p.ci ? `${pct1(p.ci[0])}–${pct1(p.ci[1])}` : '—', p.infra]) }}>
            <HBars series={Object.entries(pb.claim_status || {}).map(([k, v]) => ({ id: k, label: k, value: v / pb.problems, text: String(v), color: k === 'open' ? 'var(--ord-5)' : 'var(--s2)' }))} />
          </Figure>
        </div>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">7</span>Sources and reproducibility</h2>
        <SourcesTable data={data} />
        <div className="row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => download('benchmark-comparison.json', JSON.stringify(data, null, 2), 'application/json')}>Download JSON</button>
        </div>
      </section>
    </ChartSizing.Provider>
  )
}

function FactsTable({ benchmarks }) {
  return (
    <div className="table-wrap">
      <table className="table cmp-facts">
        <thead><tr><th>Benchmark</th><th>Problems</th><th>Proof assistant</th><th>Level</th><th>Source of problems</th><th>Task</th><th>Judged by</th><th>Statements</th><th>Best reported</th></tr></thead>
        <tbody>
          {benchmarks.map((b) => {
            const f = b.facts || {}
            const best = f.best || {}
            return (
              <tr key={b.id} className={b.id === 'proofbench' ? 'cmp-self' : ''}>
                <td><b>{b.name}</b>{b.cite ? <div className="small mono">{b.cite}</div> : null}</td>
                <td className="num">{f.problems?.toLocaleString() ?? '—'}{f.problems_note ? <div className="small">{f.problems_note}</div> : null}</td>
                <td>{(f.languages || []).join(', ') || '—'}</td>
                <td>{f.level || '—'}</td>
                <td>{f.source || '—'}</td>
                <td>{f.task || '—'}</td>
                <td>{f.judged_by || '—'}</td>
                <td>{f.statements || '—'}</td>
                <td>{b.id === 'proofbench' ? (best.of ? `${best.solved}/${best.of} verified` : '—') : typeof best.rate === 'number' ? pct1(best.rate) : '—'}{best.model ? <div className="small">{best.model}{best.budget ? ` · ${best.budget}` : ''}</div> : null}{best.source_url ? <div className="small"><a href={best.source_url} target="_blank" rel="noreferrer">source</a></div> : null}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SourcesTable({ data }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Benchmark</th><th>Statements measured from</th><th>Version</th><th>Problems measured</th><th>Facts from</th></tr></thead>
        <tbody>
          {data.benchmarks.map((b) => (
            <tr key={b.id}>
              <td>{b.name}</td>
              <td>{b.measured?.available ? <a href={b.measured.source?.url} target="_blank" rel="noreferrer">{b.measured.source?.label || b.measured.source?.url}</a> : <span className="muted">{b.measured?.reason || 'not measured'}</span>}</td>
              <td className="mono small">{b.measured?.source?.commit ? b.measured.source.commit.slice(0, 10) : '—'}{b.measured?.source?.date ? ` · ${b.measured.source.date.slice(0, 10)}` : ''}</td>
              <td className="num">{b.measured?.available ? `${b.measured.statements.measured}/${b.measured.statements.problems}` : '—'}</td>
              <td className="small">{(b.facts?.sources || []).map((u, i) => <div key={i}><a href={u} target="_blank" rel="noreferrer">{u.replace(/^https?:\/\//, '').slice(0, 60)}</a></div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">Generated {data.generated_at?.replace('T', ' ').slice(0, 19)} UTC. {data.method?.detail}</p>
    </div>
  )
}
