import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { TARGET_KINDS, TARGET_LABELS, download } from './helpers.js'

const STAGES = ['discovery', 'preparation', 'generation', 'compilation', 'audit', 'comparison', 'statistics']

/* ------------------------------------------------------------------ */
/* Corpus discovery: GitHub URL + ref -> preview manifest               */
/* ------------------------------------------------------------------ */

export function CorpusPanel({ onManifest, modelsArg = '', selectedModels = [], onLoaded = null }) {
  const [repoUrl, setRepoUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subdir, setSubdir] = useState('')
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
        subdir: subdir.trim() || undefined,
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
        <label>Repository, branch or folder link<input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo/tree/branch/path/to/PROBLEMS" /></label>
        {branchFromUrl && !ref && <div className="qr-small">From the link: <code>{branchFromUrl}</code> (GitHub decides which part is the branch and which part is a folder)</div>}
        <label>Branch, tag or commit (optional, overrides the link)<input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" /></label>
        <label>Sub-folder holding the paper folders (optional)<input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="ProofBench/PROBLEMS" /></label>
        <label>GitHub token for a private repository (optional)
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_… or ghp_… with read access to Contents" />
        </label>
        <div className="qr-small">The token is sent only with this request and is never stored. Private repositories reachable only by SSH key or deploy key must be previewed and run with the local CLI (<code>--repo git@github.com:owner/repo.git</code>), which uses your own SSH agent.</div>
        <label>Expected paper count<input type="number" min="1" value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
        <button type="submit" className="qr-btn" disabled={busy}>{busy ? 'Discovering…' : 'Preview manifest'}</button>
      </form>
      {error && <div className="error-message">{error}</div>}
      {manifest && <ManifestView manifest={manifest} modelsArg={modelsArg} />}
      {manifest && manifest.counts?.papers > 0 && <RunLauncher manifest={manifest} selectedModels={selectedModels} onLoaded={onLoaded} />}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Start a run from the page through the local run server               */
/* ------------------------------------------------------------------ */

const TASKS = [
  { id: 'prove', label: 'Prove the given statement (fill the sorry)', note: 'The challenge file is sent as it is; the completed file is checked for compilation, no sorry, standard axioms, unchanged statement and definitions as compiled, and kernel replay. Needs no PDF. The task ProofBench is built for.' },
  { id: 'formalize', label: 'Formalize statement and proof from the paper', note: 'The model writes the Lean statement from the paper text and proves it; its statement is compared with the audited reference. Needs the paper PDF.' },
]

export function RunLauncher({ manifest, selectedModels = [], onLoaded = null }) {
  const src = manifest.source || {}
  const papers = manifest.papers || []
  const ids = papers.map((p) => p.paper_id)
  const withPdf = papers.filter((p) => p.pdf).map((p) => p.paper_id)
  const [base, setBase] = useState('http://127.0.0.1:8787')
  const [task, setTask] = useState('prove')
  const [targets, setTargets] = useState(['main_theorem'])
  const [papersText, setPapersText] = useState(ids.slice(0, 5).join(','))
  const [runId, setRunId] = useState(() => `${new Date().toISOString().slice(0, 10)}-${(src.commit || 'run').slice(0, 7)}`)
  const [leanProject, setLeanProject] = useState('')
  const [dryRun, setDryRun] = useState(false)
  const [job, setJob] = useState(null)
  const [log, setLog] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const offset = useRef(0)
  const timer = useRef(null)
  const client = { headers: { 'X-QEDRank-Client': 'web' } }

  const request = {
    command: 'run', repo: src.url, ref: src.commit, subdir: src.subdir || undefined,
    models: selectedModels, targets, papers: papersText.split(',').map((s) => s.trim()).filter(Boolean),
    runId: runId.trim(), task, leanProject: leanProject.trim() || undefined, dryRun,
  }
  const commandLine = ['node qedrank/cli.js run', `--repo ${src.url}`, `--ref ${src.commit}`, src.subdir ? `--subdir "${src.subdir}"` : '', `--models ${selectedModels.join(',') || '<models>'}`, targets.length ? `--targets ${targets.join(',')}` : '', request.papers.length ? `--papers ${request.papers.join(',')}` : '', task !== 'formalize' ? `--task ${task}` : '', leanProject.trim() ? `--lean-project "${leanProject.trim()}"` : '', dryRun ? '--dry-run' : '', `--run-id ${runId.trim() || '<id>'}`].filter(Boolean).join(' ')

  const stopPolling = () => { if (timer.current) { clearInterval(timer.current); timer.current = null } }
  useEffect(() => () => stopPolling(), [])

  const poll = async (id) => {
    try {
      const r = await axios.get(`${base}/jobs/${id}?from=${offset.current}`, client)
      const j = r.data.job
      if (j.log) setLog((l) => (l + j.log).slice(-200000))
      offset.current = j.next
      setJob(j)
      if (j.status !== 'running' && j.status !== 'stopping') stopPolling()
    } catch (err) {
      setError(`Lost the run server: ${err.message}`)
      stopPolling()
    }
  }

  const start = async () => {
    setError('')
    if (!selectedModels.length) { setError('Select at least one model in step 0.'); return }
    if (!runId.trim()) { setError('Give the run an id.'); return }
    setLog('')
    offset.current = 0
    try {
      const r = await axios.post(`${base}/jobs`, request, client)
      setJob(r.data.job)
      stopPolling()
      timer.current = setInterval(() => poll(r.data.job.id), 2000)
    } catch (err) {
      const msg = err.response?.data?.error || err.message
      setError(err.response ? msg : `Could not reach ${base}. Start the run server in PowerShell from C:\\QEDRank-QEDRank:  npm run qedrank:serve   (${msg})`)
    }
  }

  const stop = async () => { if (job) { try { await axios.post(`${base}/jobs/${job.id}/stop`, {}, client) } catch (err) { setError(err.message) } } }

  const loadRun = async () => {
    if (!onLoaded || !job) return
    setLoading(true)
    try {
      const [run, summary, items] = await Promise.all([
        axios.get(`${base}/runs/${job.run_id}/run.json`).then((r) => r.data),
        axios.get(`${base}/runs/${job.run_id}/summary.json`).then((r) => r.data).catch(() => null),
        axios.get(`${base}/runs/${job.run_id}/exports/items.json`).then((r) => r.data.items).catch(() => null),
      ])
      onLoaded({ run, summary, items })
      if (!summary) setError('The run has no summary yet (it is still in progress or stopped before the statistics stage); progress only.')
    } catch (err) { setError(`Could not load the run: ${err.message}`) } finally { setLoading(false) }
  }

  const running = job && (job.status === 'running' || job.status === 'stopping')
  return (
    <div className="qr-launch">
      <h3>2. Run the benchmark from here</h3>
      <p className="qr-muted">Starts the same command PowerShell would run, through the local run server (<code>npm run qedrank:serve</code>, listening on this machine only). The GitHub token comes from your <code>gh</code> login on that machine; it is never typed here. Model calls and Lean compilation run locally; the page follows the log.</p>
      <div className="qr-form">
        <label>Task
          <select value={task} onChange={(e) => setTask(e.target.value)}>{TASKS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
        </label>
        <div className="qr-small">{TASKS.find((t) => t.id === task)?.note}</div>
        <div className="qr-form-row">
          {TARGET_KINDS.map((k) => <label key={k} className="qr-check"><input type="checkbox" checked={targets.includes(k)} onChange={(e) => setTargets(e.target.checked ? [...targets, k] : targets.filter((x) => x !== k))} /> {TARGET_LABELS[k]}</label>)}
        </div>
        <label>Problems (comma-separated ids; empty = all {ids.length})
          <input value={papersText} onChange={(e) => setPapersText(e.target.value)} />
        </label>
        <div className="qr-form-row">
          <button type="button" className="qr-btn qr-btn-secondary" onClick={() => setPapersText(ids.slice(0, 5).join(','))}>First 5</button>
          <button type="button" className="qr-btn qr-btn-secondary" onClick={() => setPapersText(withPdf.join(','))}>With PDF ({withPdf.length})</button>
          <button type="button" className="qr-btn qr-btn-secondary" onClick={() => setPapersText('')}>All ({ids.length})</button>
        </div>
        <label>Run id<input value={runId} onChange={(e) => setRunId(e.target.value)} /></label>
        <label>Lean project on this machine (optional)<input value={leanProject} onChange={(e) => setLeanProject(e.target.value)} placeholder="default: this repository's lean/ (Mathlib only); for ProofBench.Mathlib_Problems imports give a built ProofBench checkout, e.g. C:\ProofBench" /></label>
        <label>Run server<input value={base} onChange={(e) => setBase(e.target.value)} /></label>
        <label className="qr-check"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run: discovery and preparation only, no model calls</label>
        <div className="qr-small">Models: <code>{selectedModels.join(', ') || 'none selected (step 0)'}</code></div>
        <pre className="qr-cmd">{commandLine}</pre>
        <div className="qr-form-row">
          <button type="button" className="qr-btn" onClick={start} disabled={running}>{running ? 'Running…' : 'Start run'}</button>
          {running && <button type="button" className="qr-btn qr-btn-secondary" onClick={stop}>Stop</button>}
          {job && !running && <button type="button" className="qr-btn qr-btn-secondary" onClick={loadRun} disabled={loading}>{loading ? 'Loading…' : 'Load into Evaluation'}</button>}
        </div>
      </div>
      {error && <div className="error-message">{error}</div>}
      {job && (
        <div className="qr-note">
          <b>{job.status}</b> · job <code>{job.id}</code> · run <code>{job.run_id}</code>{job.exit_code !== null && job.exit_code !== undefined ? ` · exit code ${job.exit_code}` : ''} · token: {job.token_source || 'none'}
          <pre className="qr-log">{log || '(waiting for output…)'}</pre>
        </div>
      )}
    </div>
  )
}

export function ManifestView({ manifest, modelsArg = '' }) {
  const c = manifest.counts || {}
  const src = manifest.source || {}
  const [showAll, setShowAll] = useState(false)
  const papers = manifest.papers || []
  const shown = showAll ? papers : papers.slice(0, 25)
  // The run command uses the models selected in the picker (the CLI default is the whole roster).
  const nextStep = manifest.next_step ? (modelsArg && !/--models/.test(manifest.next_step) ? `${manifest.next_step} --models ${modelsArg}` : manifest.next_step) : null
  return (
    <div className="qr-manifest">
      <div className="qr-kv">
        <div><span>Source</span><code>{src.url}</code></div>
        <div><span>Ref</span><code>{src.resolved_ref || src.requested_ref || '(default branch)'} · {src.ref_type}</code></div>
        <div><span>Resolved commit</span><code>{src.commit}</code>{src.private ? ' · private repository' : ''}</div>
        <div><span>Discovery folder</span><code>{src.subdir || '(whole repository)'}</code>{c.papers_by_parent_dir && <> · papers per parent folder: {Object.entries(c.papers_by_parent_dir).map(([k, v]) => <code key={k}>{k}: {v} </code>)}</>}</div>
        <div><span>Papers discovered</span><b>{c.papers}</b> of expected {c.expected_count} — {c.expected_count_matches ? 'matches the expectation' : 'does NOT match the expectation'}</div>
        <div><span>With PDF</span><b>{c.papers_with_pdf}</b></div>
        {c.index_files?.length > 0 && <div><span>Index metadata</span>{c.index_files.map((f) => <code key={f.path}>{f.path} ({f.entries} entries) </code>)} · matched {c.papers_with_index_entry} papers{c.index_entries_without_paper?.length ? ` · index ids without a folder: ${c.index_entries_without_paper.join(', ')}` : ''}</div>}
        <div><span>Lean files inspected</span>{c.lean_files_inspected} of {c.lean_files} in {(c.discovery_ms / 1000).toFixed(1)} s</div>
        <div><span>Targets</span>{TARGET_KINDS.map((k) => <b key={k}>{TARGET_LABELS[k]}: {c.targets?.[k] ?? 0}&nbsp;&nbsp;</b>)}</div>
        <div><span>All three bounds</span><b>{c.papers_with_all_three_bounds}</b></div>
        <div><span>Papers flagged for review</span><b>{c.papers_flagged}</b> {c.flags_by_code && Object.entries(c.flags_by_code).map(([k, v]) => <code key={k}>{k}×{v} </code>)}</div>
        {manifest.flags?.length > 0 && <div><span>Repository flags</span>{manifest.flags.map((f) => <code key={f.code}>{f.code}: {f.message}</code>)}</div>}
      </div>
      <div className="qr-actions">
        <button className="qr-btn qr-btn-secondary" onClick={() => download('manifest.json', JSON.stringify(manifest, null, 2), 'application/json')}>Download manifest JSON</button>
      </div>
      {nextStep && (
        <div className="qr-note">
          <b>Run the benchmark locally</b> (models, Lean compilation and evaluation run on your machine, pinned to this commit; <code>--models</code> is the selection above):
          <pre>{nextStep}</pre>
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
                      <div className="qr-small">{t.declaration_name ? `decl: ${t.declaration_name}` : 'decl: ?'} · {t.mathematical_status} · {t.reference_proof_status === 'contains_placeholder' && k === 'main_theorem' ? <span title="The challenge file states the theorem and leaves its proof as `sorry`: that sorry is the task, not a defect. The statement is what the models' answers are checked against.">statement + sorry (the task)</span> : `ref: ${t.reference_proof_status}`}</div>
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
        else if (j.schema === 'qedrank-results-v1') setStatus(`${f.name} holds the full item records; this page reads the flat form exports/items.json (written next to it by the statistics stage).`)
        else if (j.schema === 'qedrank-manifest-v1') {
          // The corpus preview from the Benchmark page: it lists the papers, it holds no results.
          const n = j.counts?.papers ?? j.papers?.length ?? '?'
          setStatus(`${f.name} is a corpus manifest (${n} papers at ${j.source?.commit?.slice(0, 10) || 'unknown commit'}), not a run: it describes what to evaluate, not results. Produce a run first — ${j.next_step ? `run this on your machine: ${j.next_step}` : 'node qedrank/cli.js run --repo <url> --ref <commit>'} — then load runs/<run id>/summary.json, run.json and exports/items.json here (or serve them with npm run qedrank:serve).`)
        } else setStatus(`Unrecognised file ${f.name}${j.schema ? ` (schema ${j.schema})` : ''}: this page reads summary.json, run.json and exports/items.json of a run.`)
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
      <p className="qr-muted">A <b>run</b> is the folder <code>runs/&lt;run id&gt;/</code> that <code>node qedrank/cli.js run …</code> (or <code>resume</code>, or <code>import-agent</code>) writes on your machine: the model answers, the Lean verdicts and the statistics. This page only displays such a folder; it computes nothing itself. Two ways to open one: start the small local server with <code>npm run qedrank:serve</code>, click <b>List runs</b>, choose a run and <b>Load</b> — or pick the run's <code>summary.json</code>, <code>run.json</code> and <code>exports/items.json</code> under <b>Or open files</b>. A <code>manifest.json</code> is the corpus preview, not a run.</p>
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
        <label className="qr-check"><input type="checkbox" checked={poll} onChange={(e) => setPoll(e.target.checked)} /> Auto-refresh every 10 s (for a run that is still in progress)</label>
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
