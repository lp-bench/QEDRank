import { useState, useEffect } from 'react'
import axios from 'axios'
import './App.css'

const LLM_MODELS = [
  { id: 'gemini', name: 'Gemini 3 Pro', color: '#4285F4' },
  { id: 'openai', name: 'GPT-4', color: '#1F2937' },
  { id: 'anthropic', name: 'Claude 3', color: '#3B82F6' },
  { id: 'cohere', name: 'Command R+', color: '#22C55E' },
  { id: 'mistral', name: 'Mistral Large', color: '#EF4444' }
]

function App() {
  const [mathProblem, setMathProblem] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [feedback, setFeedback] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!mathProblem.trim()) {
      setError('Please enter a mathematical problem')
      return
    }
    
    setError('')
    setLoading(true)
    setSubmitted(false)
    
    try {
      const response = await axios.post('/api/verify', { mathProblem })
      setResults(response.data.results || [])
    } catch (err) {
      console.error('Error:', err)
      setError('Failed to process the request. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleFeedback = (modelId, rating) => {
    setFeedback(prev => ({
      ...prev,
      [modelId]: rating
    }))
  }

  const handleSubmitFeedback = async () => {
    try {
      await axios.post('/api/feedback', {
        mathProblem,
        results,
        feedback
      })
      setSubmitted(true)
    } catch (err) {
      console.error('Error submitting feedback:', err)
      setError('Failed to submit feedback. Please try again.')
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>QEDengine</h1>
        <p className="subtitle">AI-powered Proof Verification Tool</p>
        <p className="description">
          Enter a mathematical problem and get Lean4 code from multiple AI models.
          Help us improve by rating the quality of each result.
        </p>
      </header>

      <main className="main">
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
          {error && <div className="error-message">{error}</div>}
          <button type="submit" disabled={loading} className="submit-btn">
            {loading ? 'Processing...' : 'Convert to Lean4'}
          </button>
        </form>

        {results.length > 0 && (
          <div className="results-container">
            <h2>Results from AI Models</h2>
            <div className="results-grid">
              {results.map((result, index) => (
                <ResultCard
                  key={index}
                  model={LLM_MODELS[index]}
                  result={result}
                  onFeedback={handleFeedback}
                  feedback={feedback[LLM_MODELS[index]?.id]}
                />
              ))}
            </div>
            
            <div className="feedback-actions">
              <button 
                onClick={handleSubmitFeedback} 
                className="submit-feedback-btn"
                disabled={submitted}
              >
                {submitted ? 'Feedback Submitted!' : 'Submit Feedback'}
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="footer">
        <p>Powered by multiple AI models • Built with React & Vercel</p>
      </footer>
    </div>
  )
}

function ResultCard({ model, result, onFeedback, feedback }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="result-card">
      <div className="card-header">
        <div className="model-info">
          <div 
            className="model-dot" 
            style={{ backgroundColor: model.color }}
          />
          <h3>{model.name}</h3>
        </div>
        <button 
          className="expand-btn"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '−' : '+'}
        </button>
      </div>
      
      <div className={`result-content ${expanded ? 'expanded' : ''}`}>
        <pre>{result.leanCode || 'Loading...'}</pre>
      </div>

      <div className="feedback-section">
        <p className="feedback-label">Rate this result:</p>
        <div className="rating-buttons">
          {[1, 2, 3, 4, 5].map((rating) => (
            <button
              key={rating}
              className={`rating-btn ${feedback === rating ? 'active' : ''}`}
              onClick={() => onFeedback(model.id, rating)}
            >
              {rating}
            </button>
          ))}
        </div>
        <div className="feedback-status">
          {feedback ? `Selected: ${feedback} stars` : 'No rating yet'}
        </div>
      </div>
    </div>
  )
}

export default App