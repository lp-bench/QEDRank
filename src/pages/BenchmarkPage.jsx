import { Link } from 'react-router-dom'
import { useAppState } from '../state/AppState.jsx'
import ModelPicker from '../components/ModelPicker.jsx'
import { CorpusPanel, RunPanel } from '../qedrank/panels.jsx'
import { download } from '../qedrank/helpers.js'
import '../qedrank/qedrank.css'
import './home.css'

export default function BenchmarkPage() {
  const { selected, loaded, setLoaded } = useAppState()
  const { run, summary, items } = loaded
  const modelsArg = selected.length ? selected.join(',') : ''
  return (
    <main className="page">
      <div className="page-head">
        <span className="eyebrow">QEDRank · batch benchmark</span>
        <h1>Benchmark the roster on a paper corpus</h1>
        <p>
          Every selected model is evaluated on every paper: main theorem, upper bound, lower bound and an optional disproof, each against its audited ground-truth Lean statement. Statement fidelity, compilation, dependency audit and strict verified success are measured separately, at pass@1, with paper-cluster confidence intervals. Preview the corpus here, run generation and Lean checking locally, then load the run and open the <Link to="/evaluation">Evaluation</Link> page.
        </p>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2><span className="step">0</span>Models for this run</h2>
            <p>The selection is shared with the front page. The run command below uses it as <code>--models</code>; models without a key are recorded as infrastructure failures, never as successes.</p>
          </div>
        </div>
        <ModelPicker compact />
      </section>

      <CorpusPanel modelsArg={modelsArg} />
      <RunPanel onLoaded={setLoaded} />

      {(summary || items) && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2><span className="step">3</span>Explore the loaded run</h2>
              <p>Run <code>{run?.run_id || summary?.run?.run_id}</code>{summary ? ` · ${summary.models.length} models · ${summary.coverage.items_total} items` : ''}{items ? ` · ${items.length} item records` : ''}. The complete evaluation matrix, every chart and the statistical analysis are on their own page.</p>
            </div>
            <div className="row">
              <Link to="/evaluation" className="btn">Open the evaluation →</Link>
              {summary && <button className="btn btn-secondary" onClick={() => download(`${summary.run?.run_id || 'qedrank'}-summary.json`, JSON.stringify(summary, null, 2), 'application/json')}>Summary JSON</button>}
              {items && <button className="btn btn-secondary" onClick={() => download(`${summary?.run?.run_id || run?.run_id || 'qedrank'}-items.json`, JSON.stringify({ schema: 'qedrank-items-v1', run_id: summary?.run?.run_id, count: items.length, items }, null, 2), 'application/json')}>Items JSON</button>}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}
