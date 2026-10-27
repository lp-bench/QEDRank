import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useAppState } from '../state/AppState.jsx'
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
      // Remembered (without the token) so the Head-to-head page can offer this corpus.
      try { localStorage.setItem('qedrank.lastCorpus', JSON.stringify({ url: repoUrl.trim(), ref: ref.trim(), subdir: subdir.trim(), commit: res.data?.source?.commit || null })) } catch { /* storage unavailable */ }
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
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** One line for a run configuration's generation block, as the launcher lists it. */
function describeGeneration(g = {}) {
  return `attempts ${g.attempts ?? 1} · T ${g.temperature ?? 0} · effort ${g.effort ?? 'default'} · ${(g.maxTokens ?? 16384).toLocaleString()} tokens · ${Math.round((g.timeoutMs ?? 300000) / 60000)} min · ${g.providerConcurrency ?? 1} in flight`
}

export function RunLauncher({ manifest, selectedModels = [], onLoaded = null }) {
  const src = manifest.source || {}
  const papers = manifest.papers || []
  const ids = papers.map((p) => p.paper_id)
  const withPdf = papers.filter((p) => p.pdf).map((p) => p.paper_id)
  const { runServer: base, setRunServer: setBase } = useAppState()
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

  // Harness: QEDRank's single call, or an agent harness the run server reports as ready.
  const [harness, setHarness] = useState('qedrank-single')
  const [harnesses, setHarnesses] = useState(null)
  const [attempts, setAttempts] = useState(1)
  // Run configurations (configs/*.json on the run server's machine) and generation settings for
  // the single-call protocol; a chosen configuration sets the defaults, the fields override it.
  const [configs, setConfigs] = useState([])
  const [runConfig, setRunConfig] = useState('')
  const [gen, setGen] = useState({ temperature: '', effort: '', maxTokens: '', timeoutMin: '', inFlight: '' })
  const [limits, setLimits] = useState({ sessions: 10, sessionOutputTokens: 30000, sessionWorkingTime: 1800, maxTokens: 16000, timeLimit: '', messageLimit: '', maxSamples: 2, maxCostUsd: '' })
  const [effort, setEffort] = useState('')
  const [comparator, setComparator] = useState(true)
  const [retryInfra, setRetryInfra] = useState(false)
  const [regrade, setRegrade] = useState(false)
  const [difficulty, setDifficulty] = useState('')
  const [subject, setSubject] = useState('')
  useEffect(() => {
    let alive = true
    axios.get(`${base}/harnesses`, { timeout: 4000 }).then((r) => { if (alive) setHarnesses(r.data.harnesses || []) }).catch(() => { if (alive) setHarnesses(null) })
    return () => { alive = false }
  }, [base])
  useEffect(() => {
    let alive = true
    axios.get(`${base}/configs`, { timeout: 4000 }).then((r) => { if (alive) setConfigs((r.data.configs || []).filter((c) => !c.error)) }).catch(() => { if (alive) setConfigs([]) })
    return () => { alive = false }
  }, [base])
  const harnessInfo = harnesses?.find((h) => h.id === harness) || null
  const cfgGen = configs.find((c) => c.file === runConfig)?.generation || {}
  const chooseConfig = (file) => {
    setRunConfig(file)
    const g = configs.find((c) => c.file === file)?.generation
    if (g?.attempts) setAttempts(Math.max(1, Math.min(16, Number(g.attempts))))
  }
  // Attempts above 1 need sampling: when neither a field nor the configuration gives a temperature above 0, 1.0 is sent.
  const effectiveTemperature = gen.temperature !== '' ? Number(gen.temperature) : (cfgGen.temperature ?? 0)
  const autoTemperature = harness !== 'proofbench' && attempts > 1 && !(effectiveTemperature > 0)
  const temperatureToSend = gen.temperature !== '' ? Number(gen.temperature) : autoTemperature ? 1 : undefined
  const genRequest = {
    config: runConfig || undefined,
    temperature: temperatureToSend,
    effort: gen.effort || undefined,
    maxTokens: gen.maxTokens !== '' ? Number(gen.maxTokens) : undefined,
    timeoutMs: gen.timeoutMin !== '' ? Math.round(Number(gen.timeoutMin) * 60000) : undefined,
    providerConcurrency: gen.inFlight !== '' ? Number(gen.inFlight) : undefined,
  }
  const genFlags = [runConfig ? `--config configs/${runConfig}` : '', temperatureToSend !== undefined ? `--temperature ${temperatureToSend}` : '', gen.effort ? `--effort ${gen.effort}` : '', genRequest.maxTokens !== undefined ? `--max-tokens ${genRequest.maxTokens}` : '', genRequest.timeoutMs !== undefined ? `--timeout-ms ${genRequest.timeoutMs}` : '', genRequest.providerConcurrency !== undefined ? `--provider-concurrency ${genRequest.providerConcurrency}` : '']
  const difficulties = [...new Set(papers.map((p) => p.difficulty).filter(Boolean))].sort()
  const subjects = [...new Set(papers.flatMap((p) => p.subject_tags || []))].sort()
  const applyFilters = () => setPapersText(papers.filter((p) => (!difficulty || p.difficulty === difficulty) && (!subject || (p.subject_tags || []).includes(subject))).map((p) => p.paper_id).join(','))
  const problemList = papersText.split(',').map((s) => s.trim()).filter(Boolean)
  const agentRun = harness === 'proofbench'

  const request = agentRun
    ? { command: 'agent-run', harness, runId: runId.trim(), ref: src.commit, models: selectedModels, papers: problemList, attempts, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== '' && v !== null && v !== undefined)), effort: effort || undefined, comparator, retryInfra, regrade }
    : {
      command: 'run', repo: src.url, ref: src.commit, subdir: src.subdir || undefined,
      models: selectedModels, targets, papers: problemList,
      runId: runId.trim(), task, leanProject: leanProject.trim() || undefined, dryRun,
      attempts: attempts > 1 ? attempts : undefined,
      ...genRequest,
    }
  const commandLine = agentRun
    ? ['node qedrank/cli.js agent-run', `--run-id ${runId.trim() || '<id>'}`, `--models ${selectedModels.join(',') || '<models>'}`, `--problems ${problemList.join(',') || '<problems>'}`, `--attempts ${attempts}`, `--ref ${src.commit}`, ...Object.entries(limits).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} ${v}`), effort ? `--effort ${effort}` : '', comparator ? '' : '--comparator off', retryInfra ? '--retry-infra' : '', regrade ? '--regrade' : ''].filter(Boolean).join(' ')
    : ['node qedrank/cli.js run', `--repo ${src.url}`, `--ref ${src.commit}`, src.subdir ? `--subdir "${src.subdir}"` : '', `--models ${selectedModels.join(',') || '<models>'}`, targets.length ? `--targets ${targets.join(',')}` : '', problemList.length ? `--papers ${problemList.join(',')}` : '', task !== 'formalize' ? `--task ${task}` : '', attempts > 1 ? `--attempts ${attempts}` : '', ...genFlags, leanProject.trim() ? `--lean-project "${leanProject.trim()}"` : '', dryRun ? '--dry-run' : '', `--run-id ${runId.trim() || '<id>'}`].filter(Boolean).join(' ')

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
    if (agentRun && !problemList.length) { setError('Select the problems to run: the agent harness needs an explicit list.'); return }
    if (agentRun && harnessInfo && !harnessInfo.ready) { setError(`The ProofBench harness is not ready on the run server's machine: ${harnessInfo.reason || 'see node qedrank/cli.js harnesses'}.`); return }
    setLog('')
    offset.current = 0
    try {
      const r = await axios.post(`${base}/jobs`, request, client)
      setJob(r.data.job)
      stopPolling()
      timer.current = setInterval(() => poll(r.data.job.id), 2000)
    } catch (err) {
      const msg = err.response?.data?.error || err.message
      setError(err.response ? msg : `Could not reach ${base}. The run server must be running on this computer: in PowerShell, cd C:\\QEDRank\\QEDRank_java, then git pull, then npm run qedrank:serve — and leave that window open. If it is running and your browser asked whether this site may access your local network, allow it; otherwise open the app locally (npm run dev → http://localhost:3000), where no such permission is needed. (${msg})`)
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
      onLoaded({ run, summary, items, server: base })
      if (!summary) setError('The run has no summary yet (it is still in progress or stopped before the statistics stage); progress only.')
    } catch (err) { setError(`Could not load the run: ${err.message}`) } finally { setLoading(false) }
  }

  const running = job && (job.status === 'running' || job.status === 'stopping')
  // A finished job's run is loaded into Evaluation by itself: nothing to click, no second step.
  const autoLoaded = useRef(null)
  useEffect(() => {
    if (!job || !onLoaded || running) return
    if (autoLoaded.current !== job.id) { autoLoaded.current = job.id; loadRun() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, running])
  return (
    <div className="qr-launch">
      <h3>2. Run the benchmark from here</h3>
      <p className="qr-muted">Starts the same command PowerShell would run, through the local run server (<code>npm run qedrank:serve</code>, listening on this machine only). The GitHub token comes from your <code>gh</code> login on that machine; it is never typed here. Model calls and Lean compilation run locally; the page follows the log.</p>
      <div className="qr-form">
        <label>Run server<input value={base} onChange={(e) => setBase(e.target.value)} /></label>
        <label>Harness and Lean environment
          <select value={harness} onChange={(e) => setHarness(e.target.value)}>
            <option value="qedrank-single">QEDRank single call (no tools) — graded in the Lean project below</option>
            <option value="proofbench">ProofBench agent harness (Inspect AI ReAct agent, Comparator grading) — pinned sandbox image</option>
          </select>
        </label>
        {harnesses === null && <div className="qr-small">The run server did not answer <code>/harnesses</code>; start it with <code>npm run qedrank:serve</code> to see which harnesses this machine can run.</div>}
        {harnesses && harnesses.filter((h) => h.id !== 'qedrank-single').map((h) => (
          <div key={h.id} className="qr-small">
            <b>{h.label}</b>: <span className={h.ready ? 'qr-good' : 'qr-muted'}>{h.integration}{h.ready ? ' · ready' : h.reason ? ` · ${h.reason}` : ''}</span>
            {h.id === 'proofbench' && h.checks?.dir_exists ? <> · harness <code>{(h.checks.harness_commit || '').slice(0, 10) || '?'}</code> · statements <code>{(h.checks.statements_commit || '').slice(0, 10) || '?'}</code>{h.checks.statements_dirty ? ' (dirty)' : ''} · image <code>{h.checks.image}</code>{h.checks.lean_project ? <> · re-grade project <code>{h.checks.lean_project}</code></> : ''}</> : null}
          </div>
        ))}
        {!agentRun && (
          <>
            <label>Task
              <select value={task} onChange={(e) => setTask(e.target.value)}>{TASKS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
            </label>
            <div className="qr-small">{TASKS.find((t) => t.id === task)?.note}</div>
            <div className="qr-form-row">
              {TARGET_KINDS.map((k) => <label key={k} className="qr-check"><input type="checkbox" checked={targets.includes(k)} onChange={(e) => setTargets(e.target.checked ? [...targets, k] : targets.filter((x) => x !== k))} /> {TARGET_LABELS[k]}</label>)}
            </div>
          </>
        )}
        {agentRun && <div className="qr-small">Task: prove the given statement (the harness's only task). Dataset: <code>{src.url}</code> at commit <code>{(src.commit || '').slice(0, 10)}</code>; the harness runs from its local statements clone, which must be checked out at this commit (the driver refuses otherwise). Each attempt is a fresh Inspect run with new sandbox containers; the run resumes where it stopped and never repeats a completed attempt.</div>}
        <label>Problems (comma-separated ids; {agentRun ? 'required' : `empty = all ${ids.length}`})
          <input value={papersText} onChange={(e) => setPapersText(e.target.value)} />
        </label>
        <div className="qr-form-row">
          <button type="button" className="qr-btn qr-btn-secondary" onClick={() => setPapersText(ids.slice(0, 5).join(','))}>First 5</button>
          <button type="button" className="qr-btn qr-btn-secondary" onClick={() => setPapersText(withPdf.join(','))}>With PDF ({withPdf.length})</button>
          <button type="button" className="qr-btn qr-btn-secondary" onClick={() => setPapersText(agentRun ? ids.join(',') : '')}>All ({ids.length})</button>
          {(difficulties.length > 0 || subjects.length > 0) && (
            <>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="Difficulty filter"><option value="">any difficulty</option>{difficulties.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject filter"><option value="">any subject</option>{subjects.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              <button type="button" className="qr-btn qr-btn-secondary" onClick={applyFilters}>Select by filter</button>
            </>
          )}
        </div>
        {difficulties.length === 0 && subjects.length === 0 && <div className="qr-small">This corpus carries no difficulty or subject labels; the results show them as “Unknown”.</div>}
        <label>Run id<input value={runId} onChange={(e) => setRunId(e.target.value)} /></label>
        <label>Independent attempts per problem and model (1–16)<input type="number" min="1" max="16" value={attempts} onChange={(e) => setAttempts(Math.max(1, Math.min(16, Number(e.target.value) || 1)))} /></label>
        <div className="qr-small">{agentRun ? 'Each attempt is a separate Inspect run (fresh agent state, fresh sandboxes).' : 'pass@k is reported for every k from 1 up to this number (16 at most). Attempts above 1 sample with the temperature below; when none is set, 1.0 is used.'}</div>
        {agentRun ? (
          <>
            <div className="qr-form-row">
              <label>Sessions per attempt<input type="number" min="1" max="50" value={limits.sessions} onChange={(e) => setLimits({ ...limits, sessions: e.target.value })} /></label>
              <label>Output tokens per session<input type="number" min="1000" value={limits.sessionOutputTokens} onChange={(e) => setLimits({ ...limits, sessionOutputTokens: e.target.value })} /></label>
              <label>Working seconds per session<input type="number" min="60" value={limits.sessionWorkingTime} onChange={(e) => setLimits({ ...limits, sessionWorkingTime: e.target.value })} /></label>
              <label>Max tokens per reply<input type="number" min="256" value={limits.maxTokens} onChange={(e) => setLimits({ ...limits, maxTokens: e.target.value })} /></label>
            </div>
            <div className="qr-form-row">
              <label>Wall-clock seconds per problem (optional)<input type="number" min="60" value={limits.timeLimit} onChange={(e) => setLimits({ ...limits, timeLimit: e.target.value })} placeholder="sessions × working time × 3" /></label>
              <label>Message limit ≈ tool-call cap (optional)<input type="number" min="2" value={limits.messageLimit} onChange={(e) => setLimits({ ...limits, messageLimit: e.target.value })} placeholder="about 2 per tool call" /></label>
              <label>Problems in parallel<input type="number" min="1" max="64" value={limits.maxSamples} onChange={(e) => setLimits({ ...limits, maxSamples: e.target.value })} /></label>
              <label>Cost cap, USD (estimated, optional)<input type="number" min="0" step="0.5" value={limits.maxCostUsd} onChange={(e) => setLimits({ ...limits, maxCostUsd: e.target.value })} placeholder="needs pricing in qedrank.config.json" /></label>
            </div>
            <div className="qr-form-row">
              <label>Reasoning effort (reasoning models)<select value={effort} onChange={(e) => setEffort(e.target.value)}><option value="">provider default</option>{['low', 'medium', 'high', 'xhigh', 'max'].map((e) => <option key={e} value={e}>{e}</option>)}</select></label>
              <label className="qr-check"><input type="checkbox" checked={comparator} onChange={(e) => setComparator(e.target.checked)} /> Comparator (layer 2) on</label>
              <label className="qr-check"><input type="checkbox" checked={retryInfra} onChange={(e) => setRetryInfra(e.target.checked)} /> Re-run attempts that ended in an infrastructure error</label>
              <label className="qr-check"><input type="checkbox" checked={regrade} onChange={(e) => setRegrade(e.target.checked)} /> Assess partial progress (re-grade final files in the pinned Lean project; slow)</label>
            </div>
            <div className="qr-small">Budgets map to the harness's own variables (SESSIONS, SESSION_OUTPUT_TOKENS, SESSION_WORKING_TIME, MAX_TOKENS, TIME_LIMIT, MESSAGE_LIMIT, MAX_SAMPLES); the cost cap is enforced by QEDRank between attempts from reported usage and configured prices. Every run records harness commit, image, Lean toolchain, tools and these budgets.</div>
          </>
        ) : (
          <>
            <label>Run configuration (a file under configs/ on the run server's machine; sets the defaults below)
              <select className="qr-run-config" value={runConfig} onChange={(e) => chooseConfig(e.target.value)}>
                <option value="">run defaults — {describeGeneration({})}{configs.length ? '' : ' (the run server lists no configs/*.json)'}</option>
                {configs.map((c) => <option key={c.file} value={c.file}>{c.file} — {describeGeneration(c.generation)}</option>)}
              </select>
            </label>
            <div className="qr-form-row">
              <label>Temperature<input type="number" min="0" max="2" step="0.1" value={gen.temperature} onChange={(e) => setGen({ ...gen, temperature: e.target.value })} placeholder={String(cfgGen.temperature ?? 0)} /></label>
              <label>Reasoning effort<select value={gen.effort} onChange={(e) => setGen({ ...gen, effort: e.target.value })}><option value="">{cfgGen.effort ? `configuration: ${cfgGen.effort}` : 'default (high)'}</option>{EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
              <label>Max output tokens<input type="number" min="256" step="1024" value={gen.maxTokens} onChange={(e) => setGen({ ...gen, maxTokens: e.target.value })} placeholder={String(cfgGen.maxTokens ?? 16384)} /></label>
              <label>Timeout per answer (minutes)<input type="number" min="1" max="120" value={gen.timeoutMin} onChange={(e) => setGen({ ...gen, timeoutMin: e.target.value })} placeholder={String(Math.round((cfgGen.timeoutMs ?? 300000) / 60000))} /></label>
              <label>Requests in flight per provider<input type="number" min="1" max="16" value={gen.inFlight} onChange={(e) => setGen({ ...gen, inFlight: e.target.value })} placeholder={String(cfgGen.providerConcurrency ?? 1)} /></label>
            </div>
            {autoTemperature && <div className="qr-small">Attempts above 1 need sampling: temperature 1.0 will be sent (set a temperature above to change it).</div>}
            <label>Lean project on this machine (optional)<input value={leanProject} onChange={(e) => setLeanProject(e.target.value)} placeholder="default for the prove task: the built ProofBench checkout named in qedrank.config.json (harnesses.proofbench.leanProject, e.g. C:\QEDRank\proofbench-statements); for formalize: this repository's lean/ (Mathlib only). The run stops before any model call if the challenges import a library the project lacks." /></label>
            <label className="qr-check"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run: discovery and preparation only, no model calls</label>
          </>
        )}
        <div className="qr-small">Models: <code>{selectedModels.join(', ') || 'none selected (step 0)'}</code></div>
        <pre className="qr-cmd">{commandLine}</pre>
        <div className="qr-form-row">
          <button type="button" className="qr-btn" onClick={start} disabled={running}>{running ? 'Running…' : 'Start run'}</button>
          {running && <button type="button" className="qr-btn qr-btn-secondary" onClick={stop}>Stop</button>}
          {job && !running && <span className="qr-small">{loading ? 'Loading the run into Evaluation…' : 'The run is loaded into Evaluation (see "Explore the loaded run" below).'}</span>}
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
/* Runs on this machine: loaded by themselves from the local run server */
/* ------------------------------------------------------------------ */

/** run.json, progress.json, summary.json and exports/items.json of one run on the run server. */
export async function fetchRunBundle(base, runId) {
  const [run, progress, summary, items] = await Promise.all([
    axios.get(`${base}/runs/${runId}/run.json`).then((r) => r.data),
    axios.get(`${base}/runs/${runId}/progress.json`).then((r) => r.data).catch(() => null),
    axios.get(`${base}/runs/${runId}/summary.json`).then((r) => r.data).catch(() => null),
    axios.get(`${base}/runs/${runId}/exports/items.json`).then((r) => r.data.items).catch(() => null),
  ])
  return { run, progress, summary, items }
}

function describeBundle(runId, { run, summary, items }) {
  if (summary) return ''
  if (items) return 'No summary yet (statistics stage not run). Showing item records only.'
  const pending = Object.entries(run?.stages || {}).filter(([, s]) => s?.status !== 'done').map(([k, s]) => `${k} ${s?.status || 'pending'}`)
  return `This run has no results yet${pending.length ? ` (${pending.join(', ')})` : ''}: no model answer has been graded. A dry run stops after preparation. Continue it on your machine with: node qedrank/cli.js resume --run-id ${runId}`
}

/**
 * The runs on the local run server, loaded without a dialog: when nothing is loaded yet, the
 * newest run with statistics (else the newest run) is fetched and shared with every page.
 * Returns the list, the loading status and `load(runId)` for switching.
 */
export function useAutoLoadRun({ auto = true } = {}) {
  const { loaded, setLoaded, runServer } = useAppState()
  const [runs, setRuns] = useState(null) // null: the server has not been asked yet
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [reachable, setReachable] = useState(null)
  const attempted = useRef(null)
  const hasRun = Boolean(loaded.summary || loaded.items)

  const load = async (runId) => {
    if (!runId) return
    setBusy(true)
    setStatus('Loading…')
    try {
      const bundle = await fetchRunBundle(runServer, runId)
      setStatus(describeBundle(runId, bundle))
      setLoaded({ run: bundle.run, summary: bundle.summary, items: bundle.items, server: runServer })
    } catch (err) {
      setStatus(`Load failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    try {
      const res = await axios.get(`${runServer}/runs`, { timeout: 4000 })
      const list = res.data.runs || []
      setRuns(list)
      setReachable(true)
      if (!list.length) setStatus(`No runs on ${runServer} yet: run a benchmark from Evaluate Models (or node qedrank/cli.js run …); the newest run appears here by itself.`)
      return list
    } catch (err) {
      setRuns([])
      setReachable(false)
      setStatus(`No run server at ${runServer} (${err.message}). Start it on this machine with npm run qedrank:serve, then run a benchmark from Evaluate Models; the newest run appears here by itself.`)
      return []
    }
  }

  useEffect(() => {
    let alive = true
    refresh().then((list) => {
      if (!alive || !auto || hasRun || attempted.current === runServer) return
      attempted.current = runServer
      const pick = list.find((r) => r.stages?.statistics?.status === 'done') || list[0]
      if (pick) load(pick.run_id)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runServer])

  return { runs: runs || [], asked: runs !== null, reachable, status, busy, load, refresh, loadedRunId: loaded.summary?.run?.run_id || loaded.run?.run_id || null, runServer }
}

/**
 * The runs on this machine as one row: a chooser to switch runs, the loading status, and —
 * folded away — the run server address and the run files for a page opened without a server.
 * Nothing to click in the usual case: the newest run is already loaded.
 */
export function RunSwitcher({ auto = true, compact = false }) {
  const { setLoaded, runServer, setRunServer } = useAppState()
  const { runs, asked, reachable, status, busy, load, refresh, loadedRunId } = useAutoLoadRun({ auto })
  const [runId, setRunId] = useState('')
  const [runMeta, setRunMeta] = useState(null)
  const [fileStatus, setStatus] = useState('')
  const onLoaded = setLoaded
  useEffect(() => { if (!runId && loadedRunId) setRunId(loadedRunId) }, [loadedRunId, runId])

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
    onLoaded({ ...bundle, server: null }) // opened from files: proof text cannot be fetched
  }

  const loadedLabel = loadedRunId ? `loaded: ${loadedRunId}` : !asked ? 'looking for runs…' : reachable === false ? 'no run server' : runs.length ? 'no run loaded' : 'no runs yet'
  return (
    <section className={compact ? 'qr-run-switch qr-run-switch-compact' : 'qr-card qr-run-switch'} data-loaded-run={loadedRunId || ''} data-run-server={runServer}>
      {!compact && <h2>Runs on this machine</h2>}
      <div className="qr-form qr-form-row">
        <label>{compact ? 'Run' : 'Runs on this machine'}
          <select className="qr-run-select" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={!runs.length}>
            {!runs.length && <option value="">— {loadedLabel} —</option>}
            {runs.map((r) => <option key={r.run_id} value={r.run_id}>{r.run_id} · {r.task || r.protocol || r.mode}{r.stages?.statistics?.status === 'done' ? '' : ' · in progress'}</option>)}
          </select>
        </label>
        <button type="button" className="qr-btn" onClick={() => load(runId)} disabled={!runId || busy || runId === loadedRunId}>{busy ? 'Loading…' : runId && runId === loadedRunId ? 'Loaded' : 'Load'}</button>
        <button type="button" className="qr-btn qr-btn-secondary" onClick={refresh} title={`Ask ${runServer} for its runs again`}>Refresh</button>
        <span className="qr-small">{loadedLabel}</span>
      </div>
      {status && <div className={reachable === false ? 'qr-note' : 'qr-small'}>{status}</div>}
      <details className="qr-small qr-run-switch-more">
        <summary>Run server and files</summary>
        <div className="qr-form qr-form-row">
          <label>Run server<input value={runServer} onChange={(e) => setRunServer(e.target.value)} /></label>
          <label>Open run files (summary.json, run.json, exports/items.json)<input type="file" multiple accept="application/json" onChange={onFiles} /></label>
        </div>
        {fileStatus && <div className="qr-note">{fileStatus}</div>}
        {runMeta && <RunMeta run={runMeta} />}
      </details>
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
