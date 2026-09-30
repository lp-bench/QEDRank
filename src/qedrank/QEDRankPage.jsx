import { useState } from 'react'
import { CorpusPanel, RunPanel } from './panels.jsx'
import { MatrixView, ChartsView, ComparisonView, SubgroupView, CoverageView, ItemsView } from './results.jsx'
import { download } from './helpers.js'
import './qedrank.css'

export default function QEDRankPage() {
  const [loaded, setLoaded] = useState({ run: null, summary: null, items: null })
  const { run, summary, items } = loaded
  return (
    <div className="qr-page">
      <p className="qr-intro">
        <b>QEDRank</b> evaluates the five models on every paper of a corpus: main theorem, upper bound, lower bound and an optional disproof, each against its audited ground-truth Lean statement. Statement fidelity, compilation, dependency audit and strict verified success are measured separately, at pass@1, with paper-cluster confidence intervals. Preview the corpus here; run generation, Lean checking and evaluation locally with <code>npm run qedrank -- run</code>; then load the run to explore results.
      </p>
      <CorpusPanel />
      <RunPanel onLoaded={(b) => setLoaded((prev) => ({ run: b.run ?? prev.run, summary: b.summary ?? prev.summary, items: b.items ?? prev.items }))} />
      {summary && (
        <>
          <div className="qr-actions">
            <button className="qr-btn qr-btn-secondary" onClick={() => download(`${summary.run?.run_id || 'qedrank'}-summary.json`, JSON.stringify(summary, null, 2), 'application/json')}>Download summary JSON (aggregate matrix)</button>
            {items && <button className="qr-btn qr-btn-secondary" onClick={() => download(`${summary.run?.run_id || 'qedrank'}-items.json`, JSON.stringify({ schema: 'qedrank-items-v1', run_id: summary.run?.run_id, count: items.length, items }, null, 2), 'application/json')}>Download item-level JSON</button>}
          </div>
          <MatrixView summary={summary} />
          <ChartsView summary={summary} />
          <ComparisonView summary={summary} />
          <SubgroupView summary={summary} />
          <CoverageView summary={summary} />
        </>
      )}
      {items && <ItemsView items={items} runId={run?.run_id || summary?.run?.run_id} />}
      {!summary && !items && <p className="qr-muted qr-center">No run loaded yet.</p>}
    </div>
  )
}
