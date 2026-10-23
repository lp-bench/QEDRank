import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAppState } from '../state/AppState.jsx'
import './home.css'

// Anchors of the single-problem page when it lived at "/"; old links are forwarded to /convert.
const CONVERT_ANCHORS = new Set(['#models', '#problem', '#results', '#performance'])

const EVALUATE_MEASURES = [
  'Lean compilation success',
  'Verified proof rate',
  'Statement fidelity',
  'Pass@1 and Pass@k performance',
  'Error types and failure patterns',
  'Latency and token usage',
  'Cost and resource consumption',
  'Performance by difficulty and subject area',
  'Performance of different LLMs on your own dataset (e.g. ProofBench)',
]
const COMPARE_AREAS = [
  'Number of problems',
  'Mathematical domain coverage',
  'Difficulty distribution',
  'Theorem and proof types',
  'Formalization language and Lean version',
]

export default function HomePage() {
  const { roster, selected, loaded } = useAppState()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (CONVERT_ANCHORS.has(location.hash)) navigate(`/convert${location.hash}`, { replace: true })
  }, [location.hash, navigate])

  return (
    <main className="page home">
      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow"><span className="dot ok" /> Lean 4 · Mathlib · {roster.length || 10} frontier models</span>
          <h1>Formal Mathematics <span className="grad">Benchmark Evaluation</span></h1>
          <p>QEDRank provides two complementary benchmark evaluation workflows. You can evaluate how effectively language models solve a selected corpus of formal mathematics problems, or compare different benchmark datasets to understand their scope, difficulty, coverage, and model performance.</p>
          <div className="hero-cta">
            <Link to="/benchmark" className="btn btn-lg">Evaluate Models</Link>
            <Link to="/versus" className="btn btn-secondary btn-lg">Compare Benchmarks</Link>
            {loaded.summary && <Link to="/evaluation" className="btn btn-ghost btn-lg">Open the loaded evaluation →</Link>}
          </div>
        </div>
        <div className="hero-stats">
          <div className="stat" style={{ '--stat-color': 'var(--s1)' }}><div className="label">Models in the roster</div><div className="value">{roster.length || '—'}</div><div className="sub">Claude, GPT, Qwen, GLM, DeepSeek</div></div>
          <div className="stat" style={{ '--stat-color': 'var(--s7)' }}><div className="label">Selected now</div><div className="value">{selected.length}</div><div className="sub">one selection shared by every page</div></div>
          <div className="stat" style={{ '--stat-color': 'var(--s3)' }}><div className="label">Benchmark targets</div><div className="value">4</div><div className="sub">main theorem · upper · lower · disproof</div></div>
        </div>
      </section>

      <section className="workflows" aria-label="Evaluation workflows">
        <article className="card workflow" style={{ '--wf-color': 'var(--s1)' }}>
          <span className="wf-glyph" aria-hidden="true">⊢</span>
          <h2>Evaluate Models</h2>
          <p>Evaluate one or more language models on a selected benchmark corpus. Generate Lean 4 formalizations, verify them with the Lean compiler, and compare model performance across correctness, reliability, efficiency, and difficulty.</p>
          <h3 className="wf-list-title"><span aria-hidden="true">∀ </span>Measures</h3>
          <ul className="wf-list">{EVALUATE_MEASURES.map((m) => <li key={m}>{m}</li>)}</ul>
          <Link to="/benchmark" className="btn btn-secondary wf-cta">Open Evaluate Models →</Link>
        </article>
        <article className="card workflow" style={{ '--wf-color': 'var(--s3)' }}>
          <span className="wf-glyph" aria-hidden="true">∑</span>
          <h2>Compare Benchmarks</h2>
          <p>Compare your benchmark corpus with other mathematical formalization benchmarks to understand how they differ in scale, scope, difficulty, coverage, reliability, and model performance. The analysis also examines dataset overlap and duplication, theorem categories, formalization environments, confidence intervals, and the potential for future progress across each benchmark.</p>
          <h3 className="wf-list-title"><span aria-hidden="true">∃ </span>Comparison areas</h3>
          <ul className="wf-list">{COMPARE_AREAS.map((m) => <li key={m}>{m}</li>)}</ul>
          <Link to="/versus" className="btn btn-secondary wf-cta">Open Compare Benchmarks →</Link>
        </article>
      </section>

      <p className="home-convert small">Need a single problem rather than a corpus? <Link to="/convert">Convert a Problem</Link> sends one statement to every selected model and shows the Lean 4 answers side by side.</p>
    </main>
  )
}
