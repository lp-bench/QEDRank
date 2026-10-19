import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { useLocation } from 'react-router-dom'
import { useAppState } from '../state/AppState.jsx'
import ModelPicker from '../components/ModelPicker.jsx'
import KeyHint from '../components/KeyHint.jsx'
import { slotColor } from '../components/vendor.js'
import { Figure, HBars } from '../charts/primitives.jsx'
import { fmtMs } from '../qedrank/helpers.js'
import './home.css'

const STATUS_LABEL = { idle: 'Ready', pending: 'Generating…', ok: 'Done', error: 'Error', unconfigured: 'No API key', retired: 'Retired' }
const EXAMPLES = [
  'Prove that the square root of 2 is irrational.',
  'For all natural numbers a and b, a + b = b + a.',
  'There are infinitely many prime numbers.',
  'The sum of the first n odd numbers is n².',
]

export default function ConvertPage() {
  const { roster, selectedModels } = useAppState()
  const location = useLocation()
  const [mathProblem, setMathProblem] = useState('')
  const [results, setResults] = useState({})
  const [running, setRunning] = useState(false)
  const [feedback, setFeedback] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [startedAt, setStartedAt] = useState(null)

  // Deep links such as /convert#problem: client-side navigation does not scroll to the anchor.
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [location.hash])

  const runnable = selectedModels.filter((m) => m.configured && !m.retired)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!mathProblem.trim()) { setError('Please enter a mathematical problem.'); return }
    if (!selectedModels.length) { setError('Select at least one model above.'); return }
    if (!runnable.length) { setError('None of the selected models has an API key yet. Add keys with .\\scripts\\set-llm-keys.ps1 (see the hint below) or select a model that has one.'); return }
    setError('')
    setSubmitted(false)
    setFeedback({})
    setRunning(true)
    setStartedAt(Date.now())
    const initial = {}
    for (const m of selectedModels) {
      initial[m.id] = m.retired ? { status: 'retired', leanCode: m.retired } : m.configured ? { status: 'pending' } : { status: 'unconfigured', leanCode: `Add ${m.env_key} to enable ${m.label}.` }
    }
    setResults(initial)
    // One request per model: each runs in its own serverless invocation, and cards fill in as answers arrive.
    await Promise.all(runnable.map(async (m) => {
      const t0 = Date.now()
      try {
        const res = await axios.post('/api/verify', { mathProblem, provider: m.id })
        const r = res.data.results?.[0] || {}
        setResults((prev) => ({ ...prev, [m.id]: { ...r, status: r.success ? 'ok' : 'error', wallMs: Date.now() - t0 } }))
      } catch (err) {
        const msg = err.response?.data?.error || err.message || 'Request failed'
        setResults((prev) => ({ ...prev, [m.id]: { status: 'error', leanCode: `Error: ${msg}`, wallMs: Date.now() - t0 } }))
      }
    }))
    setRunning(false)
  }

  const handleSubmitFeedback = async () => {
    try {
      const completed = selectedModels
        .filter((m) => results[m.id]?.status === 'ok')
        .map((m) => ({ provider: m.id, model: results[m.id].model, modelId: results[m.id].modelId, leanCode: results[m.id].leanCode, success: true }))
      await axios.post('/api/feedback', { mathProblem, results: completed, feedback })
      setSubmitted(true)
    } catch (err) {
      setError(`Failed to submit feedback: ${err.response?.data?.error || err.message}`)
    }
  }

  const hasResults = Object.keys(results).length > 0
  const anyOk = Object.values(results).some((r) => r.status === 'ok')
  const perf = useMemo(() => selectedModels.map((m) => ({ model: m, r: results[m.id] })).filter((x) => x.r && x.r.status !== 'pending' && x.r.status !== 'idle'), [selectedModels, results])

  return (
    <main className="page home">
      <div className="page-head">
        <span className="eyebrow">QEDRank · single problem</span>
        <h1>Convert a Problem</h1>
        <p>Pick any set of models, send one problem, and compare every answer side by side — latency, tokens and your own rating. Answers are not compiled here; to verify them with Lean, use Evaluate Models.</p>
      </div>

      <section className="card" id="models">
        <div className="card-head">
          <div>
            <h2><span className="step">1</span>Choose your models</h2>
            <p>Any number, any mix. Models without a key stay in the comparison as “no key” so you can see what a fuller roster would cover. Key names are shown on each card.</p>
          </div>
          <KeyHint />
        </div>
        <ModelPicker />
      </section>

      <section className="card" id="problem">
        <div className="card-head">
          <div>
            <h2><span className="step">2</span>State the problem</h2>
            <p>Natural language or informal mathematics. Each selected model receives the same prompt and system message and returns Lean 4 code.</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="problem-form">
          <label className="field" htmlFor="mathProblem">Mathematical problem
            <textarea id="mathProblem" value={mathProblem} onChange={(e) => setMathProblem(e.target.value)} placeholder="Enter a mathematical problem or theorem to convert to Lean 4…" rows="5" />
          </label>
          <div className="examples">{EXAMPLES.map((ex) => <button type="button" key={ex} className="chip" onClick={() => setMathProblem(ex)}>{ex}</button>)}</div>
          {error && <div className="error-message">{error}</div>}
          <div className="row spread">
            <span className="small">{runnable.length} of {selectedModels.length} selected models will be called{selectedModels.length > runnable.length ? ` (${selectedModels.length - runnable.length} without a key are shown as placeholders)` : ''}.</span>
            <button type="submit" disabled={running || !roster.length} className="btn btn-lg">{running ? 'Generating…' : `Generate with ${runnable.length || selectedModels.length} model${(runnable.length || selectedModels.length) === 1 ? '' : 's'}`}</button>
          </div>
        </form>
      </section>

      {hasResults && (
        <section className="results" id="results">
          <div className="card-head">
            <div>
              <h2><span className="step">3</span>Results</h2>
              <p>Cards fill in as answers arrive. Rate each answer 1–5 and submit to build the preference dataset.</p>
            </div>
            <span className="pill"><span className={`dot ${running ? 'run' : 'ok'}`} />{running ? 'running' : 'complete'}{startedAt && !running ? ` · ${fmtMs(Math.max(...Object.values(results).map((r) => r.wallMs || 0)))}` : ''}</span>
          </div>
          <div className="results-grid">
            {selectedModels.map((m) => <ResultCard key={m.id} model={m} result={results[m.id] || { status: 'idle' }} onFeedback={(id, v) => setFeedback((prev) => ({ ...prev, [id]: v }))} feedback={feedback[m.id]} />)}
          </div>
          <div className="row spread" style={{ marginTop: '1rem' }}>
            <span className="small">{Object.values(results).filter((r) => r.status === 'ok').length} answered · {Object.values(results).filter((r) => r.status === 'error').length} errors</span>
            <button onClick={handleSubmitFeedback} className="btn btn-secondary" disabled={submitted || running || !anyOk}>{submitted ? 'Feedback submitted ✓' : 'Submit feedback'}</button>
          </div>
        </section>
      )}

      {perf.length > 0 && <PerformanceSnapshot perf={perf} />}
    </main>
  )
}

function ResultCard({ model, result, onFeedback, feedback }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const status = result.status || 'idle'
  const canRate = status === 'ok'
  const copy = async () => {
    try { await navigator.clipboard.writeText(result.leanCode || ''); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard unavailable */ }
  }
  return (
    <article className={`result-card status-${status}`} style={{ '--mc': slotColor(model.id) }}>
      <div className="rc-head">
        <div className="rc-title">
          <span className="rc-stripe" aria-hidden="true" />
          <div>
            <h3>{model.label}</h3>
            <code className="mc-id">{result.responseModel && result.responseModel !== result.modelId ? `${result.modelId} → ${result.responseModel}` : result.modelId || model.model_id || 'model not set'}</code>
          </div>
        </div>
        <span className={`pill status-pill-${status}`}><span className={`dot ${status === 'ok' ? 'ok' : status === 'pending' ? 'run' : status === 'error' ? 'bad' : 'off'}`} />{STATUS_LABEL[status]}</span>
      </div>
      <div className="rc-metrics">
        <span><b>{typeof result.latencyMs === 'number' ? fmtMs(result.latencyMs) : '—'}</b> latency</span>
        <span><b>{result.usage?.outputTokens ?? '—'}</b> out tokens</span>
        <span><b>{result.usage?.inputTokens ?? '—'}</b> in tokens</span>
        <span><b>{result.leanCode && status === 'ok' ? result.leanCode.split('\n').length : '—'}</b> lines</span>
        {result.sampling && <span className="muted">{result.sampling.effort ? `effort ${result.sampling.effort}` : `T=${result.sampling.temperature}`}</span>}
      </div>
      <div className={`rc-code ${expanded ? 'expanded' : ''}`}>
        <pre>{status === 'pending' ? 'Waiting for the model…' : (result.leanCode || '')}</pre>
        {status === 'ok' && <div className="rc-code-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse' : 'Expand'}</button></div>}
      </div>
      <div className="rc-rating">
        <span className="small">Rate this answer</span>
        <div className="rating-buttons" role="radiogroup" aria-label={`Rating for ${model.label}`}>
          {[1, 2, 3, 4, 5].map((rating) => <button key={rating} type="button" role="radio" aria-checked={feedback === rating} className={`rating-btn ${feedback === rating ? 'active' : ''}`} onClick={() => onFeedback(model.id, rating)} disabled={!canRate}>{rating}</button>)}
        </div>
        <span className="small muted">{canRate ? (feedback ? `${feedback} / 5` : 'not rated') : 'available once the model answers'}</span>
      </div>
    </article>
  )
}

function PerformanceSnapshot({ perf }) {
  const maxMs = Math.max(1, ...perf.map((x) => x.r.latencyMs || x.r.wallMs || 0))
  const series = perf.map(({ model, r }) => {
    const ms = typeof r.latencyMs === 'number' ? r.latencyMs : r.wallMs
    return { id: model.id, label: model.label, value: typeof ms === 'number' ? ms / maxMs : null, text: typeof ms === 'number' ? fmtMs(ms) : 'n/a', title: <span><b>{model.label}</b><br />{STATUS_LABEL[r.status]} · {typeof ms === 'number' ? fmtMs(ms) : 'no timing'}{r.usage?.outputTokens != null ? ` · ${r.usage.outputTokens} output tokens` : ''}{r.reasoningChars ? ` · ${r.reasoningChars} reasoning chars` : ''}</span> }
  })
  const table = {
    columns: ['Model', 'Status', 'Latency', 'Input tokens', 'Output tokens', 'Reasoning chars', 'Lines', 'Sampling'],
    rows: perf.map(({ model, r }) => [model.label, STATUS_LABEL[r.status], typeof r.latencyMs === 'number' ? fmtMs(r.latencyMs) : '—', r.usage?.inputTokens ?? '—', r.usage?.outputTokens ?? '—', r.reasoningChars ?? '—', r.status === 'ok' ? r.leanCode.split('\n').length : '—', r.sampling ? (r.sampling.effort ? `effort ${r.sampling.effort}` : `T=${r.sampling.temperature}`) : '—']),
  }
  const ok = perf.filter((x) => x.r.status === 'ok')
  const fastest = ok.slice().sort((a, b) => (a.r.latencyMs ?? Infinity) - (b.r.latencyMs ?? Infinity))[0]
  return (
    <section className="card" id="performance">
      <div className="card-head">
        <div>
          <h2><span className="step">4</span>Performance of the selected models</h2>
          <p>Observed latency includes network and provider queueing. Correctness is not judged here — only Evaluate Models compiles answers against ground truth.</p>
        </div>
      </div>
      <div className="stat-tiles" style={{ marginBottom: '1rem' }}>
        <div className="stat" style={{ '--stat-color': 'var(--good)' }}><div className="label">Answered</div><div className="value">{ok.length}<span className="muted" style={{ fontSize: '1rem' }}> / {perf.length}</span></div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s1)' }}><div className="label">Fastest</div><div className="value" style={{ fontSize: '1.15rem' }}>{fastest ? fastest.model.label : '—'}</div><div className="sub">{fastest && typeof fastest.r.latencyMs === 'number' ? fmtMs(fastest.r.latencyMs) : ''}</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s2)' }}><div className="label">Median latency</div><div className="value" style={{ fontSize: '1.15rem' }}>{ok.length ? fmtMs(median(ok.map((x) => x.r.latencyMs).filter((v) => typeof v === 'number'))) : '—'}</div></div>
        <div className="stat" style={{ '--stat-color': 'var(--s3)' }}><div className="label">Output tokens (total)</div><div className="value" style={{ fontSize: '1.15rem' }}>{ok.reduce((s, x) => s + (x.r.usage?.outputTokens || 0), 0) || '—'}</div></div>
      </div>
      <Figure title="Latency per model" subtitle="Bar length is observed latency; the label at the end is the exact value. Hover or focus a row for tokens." table={table}>
        <HBars series={series} max={1} fmtTick={(v) => fmtMs(v * maxMs)} ariaLabel="Latency per model" />
      </Figure>
    </section>
  )
}

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
