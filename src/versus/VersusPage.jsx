// Head-to-head: your benchmark (any corpus QEDRank can read, ProofBench by default) against the
// benchmarks you choose — catalogued ones measured from their public repositories, catalogued ones
// that are not public from a URL you give, or any other benchmark by URL. The local run server
// does the work (POST /compare): clones, tokens and measurements stay on this computer.

import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import literature from '../../qedrank/data/benchmark-literature.json'
import { useAppState } from '../state/AppState.jsx'
import { ChartSizing } from '../charts/primitives.jsx'
import VersusResults from './VersusResults.jsx'
import '../evaluation/evaluation.css'
import './versus.css'

const STORE = 'qedrank.versus'
const RESULT = 'qedrank.versus.result'
const SERVER = 'qedrank.compare.server'
const MAX = 7
// Your benchmark is always slot 2 (orange); the others take the first free slot when added and keep it.
export const BASE_COLOR = 'var(--s2)'
const SLOTS = ['var(--s1)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)']
const CATALOG = literature.benchmarks.filter((b) => b.id !== 'proofbench')
const client = { headers: { 'X-QEDRank-Client': 'web' } }

function read(kind, key, fallback) {
  try { const v = window[kind].getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function write(kind, key, value) {
  try { window[kind].setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}
const newKey = () => Math.random().toString(36).slice(2, 10)
const pct = (x) => (typeof x === 'number' ? `${(100 * x).toFixed(1)}%` : '—')

export default function VersusPage() {
  const { loaded } = useAppState()
  const saved = read('localStorage', STORE, null)
  const [server, setServer] = useState(() => read('localStorage', SERVER, 'http://127.0.0.1:8787'))
  const [base, setBase] = useState(() => saved?.base || { name: 'ProofBench', url: '', ref: '', subdir: '' })
  const [baseToken, setBaseToken] = useState('')
  const [selections, setSelections] = useState(() => saved?.selections || [])
  const [tokens, setTokens] = useState({})
  const [corpora, setCorpora] = useState([])
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState(() => read('sessionStorage', RESULT, null))

  // Remember the choices (never the tokens).
  useEffect(() => { write('localStorage', STORE, { base, selections }) }, [base, selections])
  useEffect(() => { write('localStorage', SERVER, server) }, [server])
  useEffect(() => {
    if (!busy) return undefined
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(id)
  }, [busy])

  // Corpora this UI has already used: QEDRank runs on the server, the loaded run, the last preview.
  useEffect(() => {
    const found = []
    const add = (c) => { if (c?.url && !found.some((x) => x.url === c.url && x.subdir === c.subdir && x.ref === c.ref)) found.push(c) }
    const last = read('localStorage', 'qedrank.lastCorpus', null)
    if (last?.url) add({ url: last.url, ref: last.commit || last.ref || '', subdir: last.subdir || '', label: 'last corpus previewed on Evaluate Models' })
    const src = loaded?.run?.source || loaded?.summary?.run?.source
    if (src?.url) add({ url: src.url, ref: src.commit || '', subdir: src.subdir || '', label: `loaded run ${loaded?.run?.run_id || loaded?.summary?.run?.run_id || ''}`.trim() })
    setCorpora([...found])
    axios.get(`${server.replace(/\/+$/, '')}/runs`, { timeout: 4000 })
      .then((r) => {
        for (const run of r.data.runs || []) if (run.source?.url && run.source.kind !== 'local') add({ url: run.source.url, ref: run.source.commit || '', subdir: run.source.subdir || '', label: `run ${run.run_id}` })
        setCorpora([...found])
      })
      .catch(() => { /* server not running yet: the fields stay editable */ })
  }, [server, loaded])

  // A first visit starts from the newest corpus the UI knows.
  useEffect(() => {
    if (!base.url && corpora.length) setBase((b) => ({ ...b, url: corpora[0].url, ref: corpora[0].ref, subdir: corpora[0].subdir }))
  }, [corpora]) // eslint-disable-line react-hooks/exhaustive-deps

  const used = new Set(selections.map((s) => s.color))
  const freeSlot = SLOTS.find((c) => !used.has(c))
  const addSelection = (value) => {
    if (!value || selections.length >= MAX || !freeSlot) return
    const entry = CATALOG.find((b) => b.id === value)
    setSelections([...selections, entry
      ? { key: newKey(), id: entry.id, name: entry.name, url: '', ref: '', folder: '', color: freeSlot, override: false }
      : { key: newKey(), id: null, name: '', url: '', ref: '', folder: '', color: freeSlot, override: true }])
  }
  const update = (key, patch) => setSelections(selections.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  const remove = (key) => setSelections(selections.filter((s) => s.key !== key))

  const problems = useMemo(() => {
    const out = []
    if (!base.url.trim()) out.push('Your benchmark needs a GitHub link.')
    if (!selections.length) out.push('Choose at least one benchmark to compare with.')
    for (const s of selections) {
      const entry = s.id && CATALOG.find((b) => b.id === s.id)
      if (!entry && !s.url.trim()) out.push(`${s.name || 'A benchmark'} needs a URL.`)
      if (entry && entry.statements_public === false && !s.url.trim()) out.push(`${entry.name} is not public: give a URL to a copy you can access.`)
    }
    return out
  }, [base, selections])

  const compare = async () => {
    setError('')
    if (problems.length) { setError(problems.join(' ')); return }
    setBusy(true)
    setElapsed(0)
    const body = {
      base: { name: base.name, url: base.url.trim(), ref: base.ref.trim() || null, subdir: base.subdir.trim() || null, token: baseToken.trim() || null },
      selections: selections.map((s) => ({ id: s.id, name: s.name, url: s.id && !s.override ? null : s.url.trim() || null, ref: s.ref.trim() || null, folder: s.folder.trim() || null, token: (tokens[s.key] || '').trim() || null })),
    }
    try {
      const r = await axios.post(`${server.replace(/\/+$/, '')}/compare`, body, client)
      const colors = { proofbench: BASE_COLOR }
      r.data.comparison.benchmarks.slice(1).forEach((b, i) => { colors[b.id] = selections[i]?.color || SLOTS[i % SLOTS.length] })
      const next = { ...r.data, colors }
      setResult(next)
      write('sessionStorage', RESULT, next)
    } catch (err) {
      const msg = err.response?.data?.error || err.message
      setError(err.response ? msg : `Could not reach the run server at ${server}. Start it in PowerShell: cd C:\\QEDRank-QEDRank, then npm run qedrank:serve, and leave the window open. If your browser asks whether this site may access your local network, allow it. (${msg})`)
    } finally {
      setBusy(false)
    }
  }

  const options = { public: CATALOG.filter((b) => b.statements_public !== false), closed: CATALOG.filter((b) => b.statements_public === false) }
  const chosen = new Set(selections.map((s) => s.id).filter(Boolean))

  return (
    <main className="page eval versus">
      <div className="page-head">
        <span className="eyebrow">QEDRank · compare benchmarks</span>
        <h1>Compare Benchmarks</h1>
        <p>Compare your benchmark corpus with other mathematical formalization benchmarks to understand how they differ in scale, scope, difficulty, coverage, reliability, and model performance. The analysis also examines dataset overlap and duplication, theorem categories, formalization environments, confidence intervals, and the potential for future progress across each benchmark.</p>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2><span className="step vs-dot" style={{ background: BASE_COLOR }}>A</span>Your benchmark</h2>
            <p>Any corpus QEDRank can read — the same GitHub link, branch and folder as on Evaluate Models. Pass rates come from your QEDRank runs on this corpus.</p>
          </div>
        </div>
        <div className="form-grid">
          <label className="field">Name<input value={base.name} onChange={(e) => setBase({ ...base, name: e.target.value })} placeholder="ProofBench" /></label>
          <label className="field vs-wide">Repository, branch or folder link
            {/* Corpora this UI has used are offered as suggestions; picking one also fills its ref and folder. */}
            <input list="vs-known-corpora" value={base.url} onChange={(e) => { const c = corpora.find((x) => x.url === e.target.value); setBase(c ? { ...base, url: c.url, ref: c.ref, subdir: c.subdir } : { ...base, url: e.target.value }) }} placeholder="https://github.com/owner/repo/tree/branch/folder" />
            <datalist id="vs-known-corpora">{corpora.slice(0, 6).map((c) => <option key={`${c.url}|${c.ref}|${c.subdir}`} value={c.url}>{c.label}</option>)}</datalist>
          </label>
          <label className="field">Branch, tag or commit<input value={base.ref} onChange={(e) => setBase({ ...base, ref: e.target.value })} placeholder="main" /></label>
          <label className="field">Sub-folder<input value={base.subdir} onChange={(e) => setBase({ ...base, subdir: e.target.value })} placeholder="ProofBench" /></label>
          <label className="field">GitHub token (private repository)<input type="password" autoComplete="off" value={baseToken} onChange={(e) => setBaseToken(e.target.value)} placeholder="not needed if the server has GITHUB_TOKEN" /></label>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2><span className="step">B</span>Compare with</h2>
            <p>Up to {MAX} benchmarks. Each keeps its colour in every chart while it stays selected.</p>
          </div>
          <label className="field vs-picker">Add a benchmark
            <select value="" onChange={(e) => addSelection(e.target.value)} disabled={selections.length >= MAX}>
              <option value="">Choose…</option>
              <optgroup label="Public — measured from their own repository">
                {options.public.map((b) => <option key={b.id} value={b.id} disabled={chosen.has(b.id)}>{b.name} · {b.facts?.problems?.toLocaleString()} problems · {b.facts?.level}</option>)}
              </optgroup>
              <optgroup label="Not public — give a URL to a copy you can access">
                {options.closed.map((b) => <option key={b.id} value={b.id} disabled={chosen.has(b.id)}>{b.name} · {b.facts?.statements}</option>)}
              </optgroup>
              <optgroup label="Other">
                <option value="__custom">Another benchmark by URL…</option>
              </optgroup>
            </select>
          </label>
        </div>

        {!selections.length && <p className="muted">Nothing chosen yet. Start with one from the list, for example miniF2F or CombiBench.</p>}
        <div className="vs-selections">
          {selections.map((s) => {
            const entry = s.id && CATALOG.find((b) => b.id === s.id)
            const closed = entry && entry.statements_public === false
            const showUrl = !entry || closed || s.override
            return (
              <div key={s.key} className="vs-sel" style={{ '--mc': s.color }}>
                <span className="vs-swatch" aria-hidden="true" />
                <div className="vs-sel-body">
                  <div className="row spread">
                    <div>
                      {entry ? <b>{entry.name}</b> : <input className="vs-name" value={s.name} onChange={(e) => update(s.key, { name: e.target.value })} placeholder="Name of the benchmark" aria-label="Benchmark name" />}
                      {entry && <span className={`badge ${closed ? '' : 'accent'}`} style={{ '--badge-color': closed ? 'var(--serious)' : 'var(--good)' }}>{closed ? 'not public' : 'public'}</span>}
                      {entry && <div className="small">{entry.facts?.problems?.toLocaleString()} problems · {entry.facts?.level} · best reported {pct(entry.facts?.best?.rate)}{entry.facts?.best?.budget_short ? ` (${entry.facts.best.budget_short})` : ''}</div>}
                    </div>
                    <div className="row">
                      {entry && !closed && <label className="check"><input type="checkbox" checked={s.override} onChange={(e) => update(s.key, { override: e.target.checked })} /> use another copy</label>}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(s.key)} aria-label={`Remove ${s.name || 'benchmark'}`}>Remove</button>
                    </div>
                  </div>
                  {showUrl && (
                    <div className="form-grid vs-url">
                      <label className="field vs-wide">URL<input value={s.url} onChange={(e) => update(s.key, { url: e.target.value })} placeholder="https://github.com/owner/repo/tree/branch/folder · https://huggingface.co/datasets/owner/name · https://…/problems.jsonl" /></label>
                      <label className="field">Branch / tag / commit<input value={s.ref} onChange={(e) => update(s.key, { ref: e.target.value })} placeholder="optional" /></label>
                      <label className="field">Folder<input value={s.folder} onChange={(e) => update(s.key, { folder: e.target.value })} placeholder="optional" /></label>
                      <label className="field">Token<input type="password" autoComplete="off" value={tokens[s.key] || ''} onChange={(e) => setTokens({ ...tokens, [s.key]: e.target.value })} placeholder="private source only" /></label>
                    </div>
                  )}
                  {closed && <div className="small muted">Its published facts (size, level, best result) are shown either way; statement statistics need the URL.</div>}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card">
        <div className="form-grid">
          <label className="field">Run server<input value={server} onChange={(e) => setServer(e.target.value)} /></label>
          <button type="button" className="btn btn-lg" onClick={compare} disabled={busy}>{busy ? `Comparing… ${elapsed}s` : `Compare ${base.name || 'your benchmark'} with ${selections.length || '…'} benchmark${selections.length === 1 ? '' : 's'}`}</button>
        </div>
        <p className="small">The first comparison downloads the benchmarks (up to a minute for FormalMATH or PutnamBench); later ones reuse the local copies and measurements.</p>
        {error && <div className="error-message">{error}</div>}
      </section>

      {result && (
        <ChartSizing.Provider value={{ height: 380, compactHeight: 300 }}>
          <VersusResults result={result} />
        </ChartSizing.Provider>
      )}
    </main>
  )
}
