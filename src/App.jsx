import { useState, useEffect } from 'react'
import axios from 'axios'
import QEDRankPage from './qedrank/QEDRankPage.jsx'
import './App.css'

const STATUS_LABEL = {
  idle: 'Ready',
  pending: 'Generating…',
  ok: 'Done',
  error: 'Error',
  unconfigured: 'No API key',
  retired: 'Retired',
}

function App() {
  const [mathProblem, setMathProblem] = useState('')
  const [roster, setRoster] = useState([])
  const [rosterError, setRosterError] = useState('')
  const [results, setResults] = useState({})
  const [running, setRunning] = useState(false)
  const [feedback, setFeedback] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('single')

  useEffect(() => {
    axios.get('/api/models')
      .then((res) => setRoster(res.data.roster || []))
      .catch((err) => setRosterError(`Could not load the model list: ${err.response?.data?.error || err.message}`))
  }, [])

  const configured = roster.filter((m) => m.configured)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!mathProblem.trim()) {
      setError('Please enter a mathematical problem')
      return
    }
    if (configured.length === 0) {
      setError('No model has an API key yet. Add at least one key in the Vercel project settings (see .env.example).')
      return
    }

    setError('')
    setSubmitted(false)
    setFeedback({})
    setRunning(true)
    const initial = {}
    for (const m of roster) {
      initial[m.id] = m.retired ? { status: 'retired', leanCode: m.retired } : m.configured ? { status: 'pending' } : { status: 'unconfigured', leanCode: `Add ${m.env_key} to enable ${m.label}.` }
    }
    setResults(initial)

    // One request per model: each runs in its own serverless invocation, and cards fill in as answers arrive.
    await Promise.all(configured.map(async (m) => {
      try {
        const res = await axios.post('/api/verify', { mathProblem, provider: m.id })
        const r = res.data.results?.[0] || {}
        setResults((prev) => ({ ...prev, [m.id]: { ...r, status: r.success ? 'ok' : 'error' } }))
      } catch (err) {
        const msg = err.response?.data?.error || err.message || 'Request failed'
        setResults((prev) => ({ ...prev, [m.id]: { status: 'error', leanCode: `Error: ${msg}` } }))
      }
    }))
    setRunning(false)
  }

  const handleFeedback = (modelId, rating) => {
    setFeedback(prev => ({
      ...prev,
      [modelId]: rating
    }))
  }

  const handleSubmitFeedback = async () => {
    try {
      const completed = roster
        .filter((m) => results[m.id] && results[m.id].status === 'ok')
        .map((m) => ({ provider: m.id, model: results[m.id].model, modelId: results[m.id].modelId, leanCode: results[m.id].leanCode, success: true }))
      await axios.post('/api/feedback', {
        mathProblem,
        results: completed,
        feedback
      })
      setSubmitted(true)
    } catch (err) {
      console.error('Error submitting feedback:', err)
      setError('Failed to submit feedback. Please try again.')
    }
  }

  const hasResults = Object.keys(results).length > 0
  const anyOk = Object.values(results).some((r) => r.status === 'ok')

  return (
    <div className="app">
      <header className="header">
        <h1>QEDengine</h1>
        <p className="subtitle">AI-powered Proof Verification Tool</p>
        <p className="description">
          Enter a mathematical problem and get Lean4 code from up to {roster.length || 10} AI models.
          Help us improve by rating the quality of each result.
        </p>
      </header>

      <nav className="mode-tabs" aria-label="Mode">
        <button type="button" className={`mode-tab ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>Single problem</button>
        <button type="button" className={`mode-tab ${mode === 'qedrank' ? 'active' : ''}`} onClick={() => setMode('qedrank')}>QEDRank benchmark</button>
      </nav>

      <main className="main">
        {mode === 'qedrank' && <QEDRankPage />}
        {mode === 'single' && (<>
        <form onSubmit={handleSubmit} className="input-form">
          <div className="input-group">
            <label htmlFor="mathProblem">Mathematical Problem</label>
            <textarea
              id="mathProblem"
              value={mathProblem}
              onChange={(e) => setMathProblem(e.target.value)}
              placeholder="Enter a mathematical problem or theorem to convert to Lean4..."
              rows="4"
            />
          </div>
          <p className="model-summary">
            {rosterError || (roster.length
              ? `${configured.length} of ${roster.length} models have an API key: ${configured.map((m) => m.label).join(', ') || 'none yet'}.`
              : 'Loading the model list…')}
          </p>
          {error && <div className="error-message">{error}</div>}
          <button type="submit" disabled={running || roster.length === 0} className="submit-btn">
            {running ? 'Processing...' : 'Convert to Lean4'}
          </button>
        </form>

        {hasResults && (
          <div className="results-container">
            <h2>Results from AI Models</h2>
            <div className="results-grid">
              {roster.map((m) => (
                <ResultCard
                  key={m.id}
                  model={m}
                  result={results[m.id] || { status: 'idle' }}
                  onFeedback={handleFeedback}
                  feedback={feedback[m.id]}
                />
              ))}
            </div>

            <div className="feedback-actions">
              <button
                onClick={handleSubmitFeedback}
                className="submit-feedback-btn"
                disabled={submitted || running || !anyOk}
              >
                {submitted ? 'Feedback Submitted!' : 'Submit Feedback'}
              </button>
            </div>
          </div>
        )}
        </>)}
      </main>

      <footer className="footer">
        <p>Powered by multiple AI models • Built with React & Vercel</p>
      </footer>
    </div>
  )
}

function ResultCard({ model, result, onFeedback, feedback }) {
  const [expanded, setExpanded] = useState(false)
  const status = result.status || 'idle'
  const canRate = status === 'ok'

  return (
    <div className={`result-card status-${status}`}>
      <div className="card-header">
        <div className="model-info">
          <span className={`status-dot status-dot-${status}`} aria-hidden="true" />
          <div>
            <h3>{model.label}</h3>
            <div className="model-id">{result.modelId || model.model_id || 'model not set'}</div>
          </div>
        </div>
        <button
          className="expand-btn"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '−' : '+'}
        </button>
      </div>

      <div className="card-status">
        {STATUS_LABEL[status]}
        {status === 'ok' && typeof result.latencyMs === 'number' && ` · ${(result.latencyMs / 1000).toFixed(1)} s`}
        {status === 'ok' && result.usage?.outputTokens != null && ` · ${result.usage.outputTokens} output tokens`}
      </div>

      <div className={`result-content ${expanded ? 'expanded' : ''}`}>
        <pre>{status === 'pending' ? 'Waiting for the model…' : (result.leanCode || '')}</pre>
      </div>

      <div className="feedback-section">
        <p className="feedback-label">Rate this result:</p>
        <div className="rating-buttons">
          {[1, 2, 3, 4, 5].map((rating) => (
            <button
              key={rating}
              className={`rating-btn ${feedback === rating ? 'active' : ''}`}
              onClick={() => onFeedback(model.id, rating)}
              disabled={!canRate}
            >
              {rating}
            </button>
          ))}
        </div>
        <div className="feedback-status">
          {canRate ? (feedback ? `Selected: ${feedback} stars` : 'No rating yet') : 'Rating available once the model answers'}
        </div>
      </div>
    </div>
  )
}

export default App
