import { useAppState } from '../state/AppState.jsx'
import { slotColor } from './vendor.js'

/**
 * Checkbox cards for the roster. The viewer picks any number of models; every page that
 * calls models (single problem) or builds a run command (benchmark) uses this selection.
 */
export default function ModelPicker({ compact = false }) {
  const { roster, rosterError, rosterLoading, selected, setSelected, configured } = useAppState()
  const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const selectConfigured = () => setSelected(configured.map((m) => m.id))
  const selectAll = () => setSelected(roster.map((m) => m.id))
  const clear = () => setSelected([])

  if (rosterError) return <div className="error-message">{rosterError}</div>
  if (rosterLoading) return <p className="muted">Loading the model roster…</p>

  return (
    <div className={`picker ${compact ? 'picker-compact' : ''}`}>
      <div className="picker-actions">
        <span className="small"><b>{selected.length}</b> of {roster.length} selected</span>
        <div className="row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={selectConfigured} disabled={!configured.length}>Only models with a key</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={selectAll}>All</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Clear</button>
        </div>
      </div>
      <div className="model-grid">
        {roster.map((m) => {
          const on = selected.includes(m.id)
          return (
            <label key={m.id} className={`model-card ${on ? 'on' : ''}`} style={{ '--mc': slotColor(m.id) }} title={m.configured ? `Key set (${m.key_env_in_use})` : `No key yet — set ${m.env_key}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(m.id)} aria-label={`Select ${m.label}`} />
              <span className="mc-stripe" aria-hidden="true" />
              <div className="mc-body">
                <div className="mc-top"><span className="mc-vendor">{m.vendor}</span>{m.reasoning && <span className="mc-tag" title="Reasoning model: its thinking is separated from the answer and counted; an effort level is sent where the API has one (Claude and GPT take no temperature)">reasoning</span>}</div>
                <div className="mc-name">{m.label}</div>
                <code className="mc-id" title={m.host ? `${m.model_id} @ ${m.host}` : m.model_id}>{m.model_id}</code>
              </div>
              <span className="mc-check" aria-hidden="true">{on ? '✓' : ''}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
