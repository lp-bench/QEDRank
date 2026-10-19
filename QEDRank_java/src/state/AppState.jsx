// App-wide state: the model roster (from /api/models), which models the viewer selected,
// the loaded benchmark run (shared by the Benchmark and Evaluation pages) and the theme.
// Selection and theme persist in localStorage; the loaded run in sessionStorage (best effort).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import axios from 'axios'

const Ctx = createContext(null)
const KEYS = { selected: 'qedrank.selectedModels', theme: 'qedrank.theme', run: 'qedrank.loadedRun' }

function storage(kind) {
  try { return typeof window !== 'undefined' ? window[kind] : null } catch { return null }
}
function read(kind, key, fallback) {
  try { const v = storage(kind)?.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function write(kind, key, value) {
  try { storage(kind)?.setItem(key, JSON.stringify(value)) } catch { /* quota or private mode: state stays in memory */ }
}

// `server` is the run server a run was loaded from (null when opened from files); the Evaluation
// page reads proof text and grading records from it on demand.
const EMPTY_RUN = { run: null, summary: null, items: null, server: null }

export function AppStateProvider({ children, initialRoster = null, initialRun = null }) {
  const [roster, setRoster] = useState(initialRoster || [])
  const [optional, setOptional] = useState([])
  const [rosterError, setRosterError] = useState('')
  const [rosterLoading, setRosterLoading] = useState(!initialRoster)
  const [selected, setSelectedState] = useState(() => read('localStorage', KEYS.selected, null))
  const [theme, setThemeState] = useState(() => read('localStorage', KEYS.theme, 'auto'))
  const [loaded, setLoadedState] = useState(() => initialRun || read('sessionStorage', KEYS.run, EMPTY_RUN))

  useEffect(() => {
    if (initialRoster) return undefined
    let alive = true
    axios.get('/api/models')
      .then((res) => { if (!alive) return; setRoster(res.data.roster || []); setOptional(res.data.optional || []) })
      .catch((err) => { if (alive) setRosterError(`Could not load the model list: ${err.response?.data?.error || err.message}`) })
      .finally(() => { if (alive) setRosterLoading(false) })
    return () => { alive = false }
  }, [initialRoster])

  // First visit: pre-select every model that has a key (or all of them when none has one yet).
  useEffect(() => {
    if (selected === null && roster.length) {
      const configured = roster.filter((m) => m.configured).map((m) => m.id)
      setSelectedState(configured.length ? configured : roster.map((m) => m.id))
    }
  }, [roster, selected])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const el = document.documentElement
    if (theme === 'auto') el.removeAttribute('data-theme')
    else el.setAttribute('data-theme', theme)
    write('localStorage', KEYS.theme, theme)
  }, [theme])

  const setSelected = useCallback((ids) => { setSelectedState(ids); write('localStorage', KEYS.selected, ids) }, [])
  const setTheme = useCallback((t) => setThemeState(t), [])
  const setLoaded = useCallback((bundle) => {
    setLoadedState((prev) => {
      const next = { run: bundle.run ?? prev.run, summary: bundle.summary ?? prev.summary, items: bundle.items ?? prev.items, server: bundle.server !== undefined ? bundle.server : prev.server ?? null }
      write('sessionStorage', KEYS.run, next)
      return next
    })
  }, [])
  const clearLoaded = useCallback(() => { setLoadedState(EMPTY_RUN); write('sessionStorage', KEYS.run, EMPTY_RUN) }, [])

  const value = useMemo(() => {
    const sel = selected || []
    const selectedModels = roster.filter((m) => sel.includes(m.id))
    return {
      roster, optional, rosterError, rosterLoading,
      configured: roster.filter((m) => m.configured),
      selected: sel, selectedModels, setSelected,
      theme, setTheme,
      loaded, setLoaded, clearLoaded,
    }
  }, [roster, optional, rosterError, rosterLoading, selected, setSelected, theme, setTheme, loaded, setLoaded, clearLoaded])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAppState must be used inside AppStateProvider')
  return v
}
