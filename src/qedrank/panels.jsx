import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { TARGET_KINDS, TARGET_LABELS, download } from './helpers.js'

const STAGES = ['discovery', 'preparation', 'generation', 'compilation', 'audit', 'comparison', 'statistics']

/* ------------------------------------------------------------------ */
/* Corpus discovery: GitHub URL + ref -> preview manifest               */
/* ------------------------------------------------------------------ */

export function CorpusPanel({ onManifest }) {
  const [repoUrl, setRepoUrl] = useState('')
  const [ref, setRef] = useState('')
  const [token, setToken] = useState('')
  const [expected, setExpected] = useState(108)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manifest, setManifest] = useState(null)

  const isSsh = /^(ssh:\/\/)?git@github\.com[:/]/.test(repoUrl.trim())
  const branchFromUrl = /github\.com\/[^/]+\/[^/]+\/tree\/([^?#]+)/.exec(repoUrl.trim())?.[1]

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (isSsh) {
      setError('SSH URLs work only with the local runner (it uses your own SSH keys): node qedrank/cli.js discover --repo ' + repoUrl.trim() + '. For the web preview use https://github.com/<owner>/<repo> and, for a private repository, a GitHub token.')
      return
    }
    if (!/^(https?:\/\/)?(www\.)?github\.com\/[^/]+\/[^/?#]+/.test(repoUrl.trim())) {
      setError('Enter a GitHub repository or branch link: https://github.com/<owner>/<repo> or https://github.com/<owner>/<repo>/tree/<branch>')
      return
    }
    setBusy(true)
    try {
      const res = await axios.post('/api/qedrank/discover', {
        repoUrl: repoUrl.trim(),
        ref: ref.trim() || undefined,
        token: token.trim() || undefined,
        expectedCount: Number(expected) || 108,
      })
      setManifest(res.data)
      onManifest && onManifest(res.data)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Discovery failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="qr-card">
      <h2>1. Freeze and audit the corpus</h2>
      <p className="qr-muted">Paste a GitHub repository or branch link (…/tree/&lt;branch&gt;). The branch, tag or commit is resolved to an immutable commit; only the file listing and small Lean/metadata files are read for this preview. Nothing from the repository is executed and no model is called.</p>
      <form onSubmit={submit} className="qr-form">
        <label>Repository or branch link<input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/paper-corpus/tree/main" /></label>
        {branchFromUrl && !ref && <div className="qr-small">Branch from link: <code>{branchFromUrl}</code></div>}
        <label>Branch, tag or commit (optional, overrides the link)<input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" /></label>
        <label>GitHub token for a private repository (optional)
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_… or ghp_… with read access to Contents" />
        </label>
        <div className="qr-small">The token is sent only with this request and is never stored. Private repositories reachable only by SSH key or deploy key must be previewed and run with the local CLI (<code>--repo git@github.com:owner/repo.git</code>), which uses your own SSH agent.</div>
        <label>Expected paper count<input type="number" min="1" value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
        <button type="submit" className="qr-btn" disabled={busy}>{busy ? 'Discovering…' : 'Preview manifest'}</button>
      </form>
      {error && <div className="error-message">{error}</div>}
      {manifest && <ManifestView manifest={manifest} />}
    </section>
  )
}

export function ManifestView({ manifest }) {
  const c = manifest.counts || {}
  const src = manifest.source || {}
  const [showAll, setShowAll] = useState(false)
  const papers = manifest.papers || []
  const shown = showAll ? papers : papers.slice(0, 25)
  return (
    <div className="qr-manifest">
      <div className="qr-kv">
        <div><span>Source</span><code>{src.url}</code></div>
        <div><span>Ref</span><code>{src.resolved_ref || src.requested_ref || '(default branch)'} · {src.ref_type}</code></div>
        <div><span>Resolved commit</span><code>{src.commit}</code></div>
        <div><span>Papers discovered</span><b>{c.papers}</b> of expected {c.expected_count} — {c.expected_count_matches ? 'matches the expectation' : 'does NOT match the expectation'}</div>
        <div><span>With PDF</span><b>{c.papers_with_pdf}</b></div>
        <div><span>Targets</span>{TARGET_KINDS.map((k) => <b key={k}>{TARGET_LABELS[k]}: {c.targets?.[k] ?? 0}&nbsp;&nbsp;</b>)}</div>
        <div><span>All three bounds</span><b>{c.papers_with_all_three_bounds}</b></div>
        <div><span>Papers flagged for review</span><b>{c.papers_flagged}</b> {c.flags_by_code && Object.entries(c.flags_by_code).map(([k, v]) => <code key={k}>{k}×{v} </code>)}</div>
        {manifest.flags?.length > 0 && <div><span>Repository flags</span>{manifest.flags.map((f) => <code key={f.code}>{f.code}: {f.message}</code>)}</div>}
      </div>
      <div className="qr-actions">
        <button className="qr-btn qr-btn-secondary" onClick={() => download('manifest.json', JSON.stringify(manifest, null, 2), 'application/json')}>Download manifest JSON</button>
      </div>
      {manifest.next_step && (
        <div className="qr-note">
          <b>Run the benchmark locally</b> (models, Lean compilation and evaluation run on your machine, pinned to this commit):
          <pre>{manifest.next_step}</pre>
        </div>
      )}
      <div className="qr-table-wrap">
        <table className="qr-table">
          <thead><tr><th>Paper</th><th>Title</th><th>PDF</th>{TARGET_KINDS.map((k) => <th key={k}>{TARGET_LABELS[k]}</th>)}<th>Flags</th></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.paper_id} className={p.flags?.length ? 'qr-row-flagged' : ''}>
                <td><code>{p.paper_id}</code></td>
                <td>{p.title || <i className="qr-muted">unknown</i>}</td>
                <td>{p.pdf ? <code title={p.pdf.path}>{p.pdf.path.split('/').pop()}</code> : <span className="qr-bad">missing</span>}</td>
                {TARGET_KINDS.map((k) => {
                  const t = p.targets?.[k]
                  if (!t) return <td key={k} className="qr-muted">{k === 'disproof' ? 'none (optional)' : 'missing'}</td>
                  return (
                    <td key={k}>
                      <code title={t.lean_path || ''}>{t.lean_path ? t.lean_path.split('/').pop() : 'ambiguous'}</code>
                      <div className="qr-small">{t.declaration_name ? `decl: ${t.declaration_name}` : 'decl: ?'} · {t.mathematical_status} · ref: {t.reference_proof_status}</div>
                      {t.mapping_flags?.length > 0 && <div className="qr-small qr-warn">{t.mapping_flags.join(', ')}</div>}
                    </td>
                  )
                })}
                <td className="qr-small">{(p.flags || []).map((f) => f.code).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {papers.length > 25 && <button className="qr-link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show first 25' : `Show all ${papers.length} papers`}</button>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Run loader: local files or the local run server                     */
/* ------------------------------------------------------------------ */

export function RunPanel({ onLoaded }) {
  const [base, setBase] = useState('http://127.0.0.1:8787')
  const [runs, setRuns] = useState([])
  const [runId, setRunId] = useState('')
  const [poll, setPoll] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState(null)
  const [runMeta, setRunMeta] = useState(null)
  const timer = useRef(null)

  const listRuns = async () => {
    setStatus('')
    try {
      const res = await axios.get(`${base}/runs`)
      setRuns(res.data.runs || [])
      if (!runId && res.data.runs?.length) setRunId(res.data.runs[0].run_id)
    } catch (err) {
      setStatus(`Could not reach ${base}: ${err.message}. Start it with: npm run qedrank:serve`)
    }
  }

  const load = async () => {
    if (!runId) return
    setStatus('Loading…')
    try {
      const [run, prog, summary, items] = await Promise.all([
        axios.get(`${base}/runs/${runId}/run.json`).then((r) => r.data),
        axios.get(`${base}/runs/${runId}/progress.json`).then((r) => r.data).catch(() => null),
        axios.get(`${base}/runs/${runId}/summary.json`).then((r) => r.data).catch(() => null),
        axios.get(`${base}/runs/${runId}/exports/items.json`).then((r) => r.data.items).catch(() => null),
      ])
      setRunMeta(run)
      setProgress(prog)
      setStatus(summary ? '' : 'No summary yet (statistics stage not run). Showing progress only.')
      onLoaded({ run, summary, items })
    } catch (err) {
      setStatus(`Load failed: ${err.message}`)
    }
  }

  useEffect(() => {
    if (poll && runId) {
      timer.current = setInterval(load, 10000)
      return () => clearInterval(timer.current)
    }
    return undefined
  }, [poll, runId, base])

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    const bundle = { run: null, summary: null, items: null }
    for (const f of files) {
      try {
        const j = JSON.parse(await f.text())
        if (j.schema === 'qedrank-summary-v1') bundle.summary = j
        else if (j.schema === 'qedrank-run-v1') bundle.run = j
        else if (j.schema === 'qedrank-items-v1') bundle.items = j.items
        else if (j.schema === 'qedrank-results-v1') bundle.items = null // full records need the exports/items.json flat form
        else setStatus(`Unrecognised file ${f.name}`)
      } catch (err) {
        setStatus(`${f.name}: ${err.message}`)
      }
    }
    setRunMeta(bundle.run)
    onLoaded(bundle)
  }

  return (
    <section className="qr-card">
      <h2>2. Load a run</h2>
      <p className="qr-muted">Runs live in <code>runs/&lt;run id&gt;/</code>. Either serve them locally (<code>npm run qedrank:serve</code>) and pick one below, or drop <code>summary.json</code>, <code>run.json</code> and <code>exports/items.json</code> here.</p>
      <div className="qr-form qr-form-row">
        <label>Run server<input value={base} onChange={(e) => setBase(e.target.value)} /></label>
        <button type="button" className="qr-btn qr-btn-secondary" onClick={listRuns}>List runs</button>
        <label>Run
          <select value={runId} onChange={(e) => setRunId(e.target.value)}>
            <option value="">— choose —</option>
            {runs.map((r) => <option key={r.run_id} value={r.run_id}>{r.run_id} · {r.mode} · {r.source?.commit?.slice(0, 8) || 'no source'}</option>)}
          </select>
        </label>
        <button type="button" className="qr-btn" onClick={load} disabled={!runId}>Load</button>
        <label className="qr-check"><input type="checkbox" checked={poll} onChange={(e) => setPoll(e.target.checked)} /> Auto-refresh every 10 s (partial progress)</label>
      </div>
      <div className="qr-form qr-form-row">
        <label>Or open files<input type="file" multiple accept="application/json" onChange={onFiles} /></label>
      </div>
      {status && <div className="qr-note">{status}</div>}
      {runMeta && <RunMeta run={runMeta} />}
      {(progress || runMeta) && <ProgressView run={runMeta} progress={progress} />}
    </section>
  )
}

function RunMeta({ run }) {
  const tc = run.toolchain || {}
  return (
    <div className="qr-kv">
      <div><span>Run</span><code>{run.run_id}</code> · {run.mode} mode · created {run.created_at}</div>
      <div><span>Source</span><code>{run.source?.url}</code> @ <code>{run.source?.commit}</code> ({run.source?.ref_type})</div>
      <div><span>Models</span>{(run.models || []).map((m) => <code key={m}>{m}: {run.model_ids?.[m] || '?'} </code>)}</div>
      <div><span>Toolchain</span><code>{tc.toolchain || 'unavailable'}</code> · Mathlib <code>{tc.mathlib?.rev?.slice(0, 10) || 'unknown'}</code> {tc.available ? '' : <span className="qr-bad">unavailable: {tc.reason}</span>}</div>
      <div><span>Settings</span>temperature {run.settings?.temperature}, max tokens {run.settings?.max_tokens}, k={run.settings?.attempts_k}, repair rounds {run.settings?.repair_rounds}, Lean timeout {run.settings?.lean?.timeoutMs} ms, prompt {run.prompt_template_version}</div>
    </div>
  )
}

export function ProgressView({ run, progress }) {
  const stages = run?.stages || {}
  const items = progress?.items
  return (
    <div className="qr-progress">
      <div className="qr-stages">
        {STAGES.map((s) => {
          const st = stages[s]?.status || 'pending'
          return <div key={s} className={`qr-stage qr-stage-${st}`}><span className="qr-stage-dot" aria-hidden="true" />{s}<em>{st}</em>{stages[s]?.error && <div className="qr-bad qr-small">{stages[s].error}</div>}</div>
        })}
      </div>
      {progress?.discovery && <div className="qr-small">Discovery: {progress.discovery.papers} papers, {progress.discovery.flagged} flagged.</div>}
      {progress?.preparation && <div className="qr-small">Preparation: {progress.preparation.done}/{progress.preparation.total} papers{progress.preparation.errors?.length ? `, ${progress.preparation.errors.length} errors` : ''}.</div>}
      {items && (
        <div>
          <div className="qr-bar" role="progressbar" aria-valuenow={items.done} aria-valuemax={items.total}><div style={{ width: `${items.total ? (100 * items.done) / items.total : 0}%` }} /></div>
          <div className="qr-small">Items {items.done}/{items.total} · generated {items.generated} · generation failures {items.gen_failed} · skipped (resumed) {items.skipped} · compiled {items.compiled} · verified {items.verified} · infrastructure failures {items.infra} · errors {items.errors?.length || 0}</div>
          {items.errors?.length > 0 && <details><summary>Item errors</summary><ul className="qr-small">{items.errors.slice(0, 50).map((e, i) => <li key={i}><code>{e.item || e.paper_id}</code>: {e.error}</li>)}</ul></details>}
        </div>
      )}
    </div>
  )
}
