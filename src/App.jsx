import { NavLink, Route, Routes, Navigate } from 'react-router-dom'
import { useAppState } from './state/AppState.jsx'
import HomePage from './pages/HomePage.jsx'
import BenchmarkPage from './pages/BenchmarkPage.jsx'
import EvaluationPage from './evaluation/EvaluationPage.jsx'
import './App.css'

const THEME_NEXT = { auto: 'light', light: 'dark', dark: 'auto' }
const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' }

export default function App() {
  const { roster, configured, selectedModels, theme, setTheme, loaded } = useAppState()
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand"><span className="brand-mark">QED</span><span>QEDengine<small>Lean 4 · model benchmark</small></span></NavLink>
          <nav className="nav" aria-label="Pages">
            <NavLink to="/" end>Convert</NavLink>
            <NavLink to="/benchmark">Benchmark</NavLink>
            <NavLink to="/evaluation">Evaluation</NavLink>
          </nav>
          <div className="topbar-right">
            {roster.length > 0 && <span className="pill" title="Models with an API key / models in the roster"><span className={`dot ${configured.length ? 'ok' : 'off'}`} /><b>{configured.length}</b>/{roster.length} keys · <b>{selectedModels.length}</b> selected</span>}
            {loaded.summary && <span className="pill" title="A benchmark run is loaded"><span className="dot ok" />run loaded</span>}
            <button type="button" className="theme-btn" onClick={() => setTheme(THEME_NEXT[theme])} title="Theme: auto → light → dark">{THEME_ICON[theme]} {theme}</button>
          </div>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/benchmark" element={<BenchmarkPage />} />
        <Route path="/evaluation" element={<EvaluationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <footer className="footer">
        QEDengine · QEDRank — every answer is checked by the pinned Lean 4 toolchain; no composite score is ever computed. <a href="https://github.com/leanprover-community/mathlib4" target="_blank" rel="noreferrer">Mathlib</a>
      </footer>
    </div>
  )
}
