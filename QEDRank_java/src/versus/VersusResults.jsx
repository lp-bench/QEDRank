// Results of a head-to-head comparison: a colour-coded performance matrix and charts in which every
// benchmark keeps one colour (yours orange). All numbers come from the run server's comparison.

import { useState } from 'react'
import { Figure, HBars, GroupedBars, StackedBars, DataTable, pct1 } from '../charts/primitives.jsx'
import { SizeRateScatter, LogBoxes } from '../compare/charts.jsx'
import { LEVELS } from '../compare/ComparePage.jsx'
import { download, toCsv } from '../qedrank/helpers.js'
import '../evaluation/evaluation.css'
import './versus.css'

const BUDGET_SHAPE = { single: 'circle', sampled: 'square', heavy: 'triangle', unknown: 'diamond' }
const BUDGET_LABEL = { single: 'one attempt', sampled: 'pass@2–64', heavy: 'pass@128+, refinement or compute budget', unknown: 'budget not reported' }
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? (d ? v.toFixed(d) : Math.round(v).toLocaleString()) : '—')
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? pct1(v) : '—')
const stats = (b) => (b.measured?.available ? b.measured.statements : null)
const structure = (b) => (b.measured?.available ? b.measured.structure || null : null)
const total = (o) => Object.values(o || {}).reduce((a, c) => a + c, 0)
const share = (k, n) => (n ? k / n : null)
const isBase = (b) => b.id === 'proofbench'
const PROOF_SOURCES = [['library', 'Own library'], ['solutions', 'Reference solutions'], ['models', 'Verified model answers']]
const shippedProofs = (b) => { const s = structure(b); return s ? s.proved_lemmas + (s.library?.proved_lemmas || 0) : null }
const topLinter = (lw) => { const e = Object.entries(lw?.by_linter || {}).sort((x, y) => y[1] - x[1])[0]; return e ? `${e[0].replace(/^linter\./, '')} ${e[1]}` : null }

/** Why a benchmark has no Lean proof measurements. */
function noProofs(b) {
  const n = shippedProofs(b)
  if (n == null) return 'not measured'
  return n ? `${num(n)} helper lemma${n === 1 ? '' : 's'}, not measured with Lean` : 'none: statements only'
}

function bestRate(b) {
  const best = b.facts?.best
  if (!best) return null
  return typeof best.rate === 'number' ? best.rate : best.of ? best.solved / best.of : null
}

// Rows of the performance matrix. `get` is numeric (tinted by its share of the row maximum); `show`
// renders the cell; `sub` adds a second line. `pm` is the Lean measurement of your benchmark's proofs.
function matrixRows(subjectGroups, pm, note) {
  const groupName = (id) => subjectGroups.find((g) => g.id === id)?.label || id
  const lib = pm?.sources?.library?.summary || null
  const st = pm?.sources?.statements?.summary || null
  const missing = note && !pm ? 'measured on another corpus' : 'run proof-metrics'
  const leanCell = (b, value, text, sub) => (isBase(b) && pm ? { value, text, sub } : { value: null, text: isBase(b) ? missing : noProofs(b), sub: null })
  const stmtCell = (b, value, text, sub) => (isBase(b) && st ? { value, text, sub } : { value: null, text: isBase(b) ? missing : 'not measured (needs its Lean project)', sub: null })
  const sourcesSub = (f) => (pm ? PROOF_SOURCES.filter(([k]) => pm.sources[k] && k !== 'library').map(([k, l]) => `${l.toLowerCase()} ${f(pm.sources[k].summary)}`).join(' · ') || null : null)
  const lean = (label, cell) => ({ label, get: (b) => cell(b).value, show: (b) => cell(b).text, sub: (b) => cell(b).sub })
  const fileRows = [
    { label: 'Theorems per file (median)', get: (b) => structure(b)?.theorems_per_file?.median ?? null, show: (b) => num(structure(b)?.theorems_per_file?.median), sub: (b) => (structure(b) ? `${num(structure(b).files_with_several_theorems)} of ${num(structure(b).files)} files have several` : null) },
    { label: 'Definitions per file (median)', get: (b) => structure(b)?.definitions_per_file?.median ?? null, show: (b) => num(structure(b)?.definitions_per_file?.median), sub: (b) => (structure(b) ? `longest 10% from ${num(structure(b).definitions_per_file.p90)}` : null) },
    { label: 'Lemmas shipped with a proof', get: shippedProofs, show: (b) => num(shippedProofs(b)), sub: (b) => { const s = structure(b); if (!s) return null; return s.library ? `${num(s.proved_lemmas)} in problem files, ${num(s.library.proved_lemmas)} in its library` : `median ${num(s.proof_lines.median)} lines` } },
  ]
  const proofRows = [
    lean('Proofs measured with Lean', (b) => { const n = total(Object.fromEntries(PROOF_SOURCES.map(([k]) => [k, pm?.sources?.[k]?.summary?.proofs || 0]))); return leanCell(b, n, num(n), pm ? PROOF_SOURCES.filter(([k]) => pm.sources[k]).map(([k, l]) => `${l.toLowerCase()} ${pm.sources[k].summary.proofs}`).join(' · ') : null) }),
    lean('Proof length (median lines)', (b) => leanCell(b, lib?.proof_lines?.median ?? null, num(lib?.proof_lines?.median), sourcesSub((m) => num(m.proof_lines.median)))),
    lean('Tactics per proof (median)', (b) => leanCell(b, lib?.tactics?.median ?? null, num(lib?.tactics?.median), sourcesSub((m) => num(m.tactics.median)))),
    lean('Automation share of tactic calls', (b) => leanCell(b, lib?.automation_share ?? null, pct(lib?.automation_share), sourcesSub((m) => pct(m.automation_share)))),
    lean('Proofs with an unused hypothesis', (b) => leanCell(b, lib ? share(lib.hypotheses.proofs_with_unused, lib.hypotheses.proofs_with_hypotheses) : null, lib ? `${lib.hypotheses.proofs_with_unused} of ${lib.hypotheses.proofs_with_hypotheses}` : '—', sourcesSub((m) => `${m.hypotheses.proofs_with_unused}/${m.hypotheses.proofs_with_hypotheses}`))),
    lean('Linter warnings in proof files', (b) => leanCell(b, lib?.linter_warnings?.total ?? null, num(lib?.linter_warnings?.total), lib ? topLinter(lib.linter_warnings) : null)),
    { label: 'Statements proved outright by automation', get: (b) => stmtCell(b, st ? share(st.closed_by_automation, st.targets_found) : null).value, show: (b) => stmtCell(b, null, st ? `${st.closed_by_automation} of ${st.targets_found}` : '—').text, sub: (b) => (isBase(b) && st ? st.portfolio.join(', ') : null) },
    { label: 'Statements with contradictory hypotheses', get: (b) => stmtCell(b, st ? share(st.contradictory, st.targets_found) : null).value, show: (b) => stmtCell(b, null, st ? `${st.contradictory} of ${st.targets_found}` : '—').text, sub: (b) => (isBase(b) && st ? `${st.with_hypotheses} have hypotheses` : null) },
    { label: 'Linter warnings in statement files', get: (b) => stmtCell(b, st?.linter_warnings?.total ?? null).value, show: (b) => stmtCell(b, null, num(st?.linter_warnings?.total)).text, sub: (b) => (isBase(b) && st ? topLinter(st.linter_warnings) : null) },
  ]
  return [
    { label: 'Problems (as published)', get: (b) => b.facts?.problems ?? null, show: (b) => num(b.facts?.problems), sub: (b) => b.facts?.problems_note },
    { label: 'Problems measured here', get: (b) => stats(b)?.measured ?? null, show: (b) => (stats(b) ? `${num(stats(b).measured)} of ${num(stats(b).problems)}` : b.measured?.reason || 'not measured'), tintless: true },
    { label: 'Level', show: (b) => b.facts?.level || '—' },
    { label: 'Best reported success', get: bestRate, show: (b) => (b.id === 'proofbench' && b.facts?.best ? `${b.facts.best.solved}/${b.facts.best.of} (${pct(bestRate(b))})` : pct(bestRate(b))), sub: (b) => (b.facts?.best ? `${b.facts.best.model_short || b.facts.best.model || ''}${b.facts.best.budget_short || b.facts.best.budget ? ` · ${b.facts.best.budget_short || b.facts.best.budget}` : ''}` : null) },
    { label: 'Theorem signature (median tokens)', get: (b) => stats(b)?.stmt_tokens?.median ?? null, show: (b) => num(stats(b)?.stmt_tokens?.median) },
    { label: 'Statement with its definitions (median tokens)', get: (b) => stats(b)?.closure_tokens?.median ?? null, show: (b) => num(stats(b)?.closure_tokens?.median), sub: (b) => (stats(b) ? `middle half ${num(stats(b).closure_tokens.q1)}–${num(stats(b).closure_tokens.q3)}` : null) },
    { label: 'Longest 10% start at (tokens)', get: (b) => stats(b)?.closure_tokens?.p90 ?? null, show: (b) => num(stats(b)?.closure_tokens?.p90) },
    { label: 'Statements that use their own definitions', get: (b) => stats(b)?.share_with_local_defs ?? null, show: (b) => pct(stats(b)?.share_with_local_defs), sub: (b) => (stats(b) ? `${stats(b).count_with_local_defs} of ${stats(b).measured}` : null) },
    { label: 'Definitions used per statement (median)', get: (b) => stats(b)?.defs_used?.median ?? null, show: (b) => num(stats(b)?.defs_used?.median) },
    { label: "Import the benchmark's own library", get: (b) => stats(b)?.share_with_project_library ?? null, show: (b) => pct(stats(b)?.share_with_project_library) },
    { label: 'Ask for an answer to construct', get: (b) => (stats(b) ? (stats(b).count_with_answer_slot || 0) / stats(b).measured : null), show: (b) => (stats(b) ? pct((stats(b).count_with_answer_slot || 0) / stats(b).measured) : '—') },
    { label: 'Research-level or open problems', get: (b) => (b.levels ? ((b.levels.research || 0) + (b.levels.open || 0)) / total(b.levels) : null), show: (b) => (b.levels ? pct(((b.levels.research || 0) + (b.levels.open || 0)) / total(b.levels)) : '—'), sub: (b) => (b.levels_source === 'stated' ? 'level stated by the authors' : null) },
    { label: 'Open problems', get: (b) => (b.levels ? (b.levels.open || 0) / total(b.levels) : null), show: (b) => (b.levels ? pct((b.levels.open || 0) / total(b.levels)) : '—') },
    { label: 'Largest subject area', show: (b) => { if (!b.subjects) return '—'; const [g, n] = Object.entries(b.subjects).sort((x, y) => y[1] - x[1])[0]; return `${groupName(g)} (${pct(n / total(b.subjects))})` } },
    ...fileRows,
    ...proofRows,
    { label: 'Statements', show: (b) => b.facts?.statements || '—' },
    { label: 'Measured from', show: (b) => (b.measured?.available ? `${b.measured.source?.label || b.measured.source?.url || ''}${b.measured.source?.commit ? ` @ ${String(b.measured.source.commit).slice(0, 7)}` : ''}` : '—') },
  ]
}

function PerformanceMatrix({ benchmarks, colors, rows }) {
  return (
    <div className="table-wrap vs-matrix-wrap">
      <table className="table vs-matrix">
        <thead>
          <tr>
            <th>Measure</th>
            {benchmarks.map((b) => <th key={b.id} style={{ '--mc': colors[b.id] }}><span className="vs-head"><i />{b.short || b.name}</span></th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const vals = benchmarks.map((b) => (r.get ? r.get(b) : null))
            const max = Math.max(0, ...vals.filter((v) => typeof v === 'number'))
            return (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                {benchmarks.map((b, i) => {
                  const v = vals[i]
                  const tint = !r.tintless && typeof v === 'number' && max > 0 ? Math.round(8 + 42 * (v / max)) : 0
                  const sub = r.sub ? r.sub(b) : null
                  return (
                    <td key={b.id} style={tint ? { background: `color-mix(in oklab, ${colors[b.id]} ${tint}%, transparent)` } : undefined}>
                      <span className="vs-cell">{r.show(b)}</span>
                      {sub && <div className="small">{sub}</div>}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Rows of a count histogram (`theorems_histogram`, `definitions_histogram`) as shares per benchmark. */
function bucketRows(benchmarks, key, unit) {
  const labels = (structure(benchmarks[0])?.[key] || []).map((h) => h.label)
  return labels.map((bucket, i) => ({
    id: bucket,
    label: `${bucket} ${unit}`,
    values: Object.fromEntries(benchmarks.map((b) => { const s = structure(b); const n = s[key]?.[i]?.count || 0; return [b.id, { value: share(n, s.files), text: `${n} (${pct(share(n, s.files))})` }] })),
  }))
}

function FileStructureSection({ number, benchmarks, colors, label }) {
  const withS = benchmarks.filter(structure)
  if (!withS.length) return null
  const series = withS.map((b) => ({ key: b.id, label: label(b), color: colors[b.id] }))
  const legend = series.map((s) => ({ label: s.label, color: s.color }))
  const thm = bucketRows(withS, 'theorems_histogram', 'theorems')
  const defs = bucketRows(withS, 'definitions_histogram', 'definitions')
  const histTable = (rows, head) => ({ columns: [head, ...withS.map((b) => b.name)], rows: rows.map((r) => [r.label, ...withS.map((b) => r.values[b.id].text)]) })
  return (
    <section className="ev-section">
      <h2 className="ev-h2"><span className="ev-num">{number}</span>File structure</h2>
      <p className="small">{structure(withS[0]).rule}</p>
      <div className="ev-grid-2">
        <Figure title="Theorems per file" subtitle="Share of problem files by the theorems and lemmas they state, the target included; each benchmark sums to 100%." legend={legend} table={histTable(thm, 'Theorems')}>
          <GroupedBars rows={thm} series={series} labelKey={withS[0].id} ariaLabel="Theorems per file" />
        </Figure>
        <Figure title="Definitions per file" subtitle="Share of problem files by their own definitions (def, abbrev, structure, inductive, class, instance, opaque)." legend={legend} table={histTable(defs, 'Definitions')}>
          <GroupedBars rows={defs} series={series} labelKey={withS[0].id} ariaLabel="Definitions per file" />
        </Figure>
        <Figure title="Proofs the benchmarks ship" subtitle="Problem files with at least one theorem proved in the file (no sorry). The table adds the benchmark's own library modules, each counted once." table={{ columns: ['Benchmark', 'Files', 'Theorems', 'Files with several', 'Proofs in problem files', 'Median proof lines', 'Median proof tokens', 'Library modules', 'Proofs in library', 'Median library proof lines'], rows: withS.map((b) => { const s = structure(b); return [b.name, num(s.files), num(s.theorems), num(s.files_with_several_theorems), num(s.proved_lemmas), num(s.proof_lines.median), num(s.proof_tokens.median), s.library ? num(s.library.modules) : '—', s.library ? num(s.library.proved_lemmas) : '—', s.library ? num(s.library.proof_lines.median) : '—'] }) }}>
          <HBars series={withS.map((b) => { const s = structure(b); return { id: b.id, label: label(b), value: share(s.files_with_proved_lemmas, s.files), text: `${num(s.files_with_proved_lemmas)} files · ${num(s.proved_lemmas)} proofs`, color: colors[b.id] } })} />
        </Figure>
      </div>
    </section>
  )
}

const SOURCE_COLOR = { library: 'var(--s1)', solutions: 'var(--s7)', models: 'var(--s3)' }

/** Why the Lean measurements are missing, or that they are from another commit. */
function MetricsNote({ pm, note, base }) {
  if (note) return <p className="small vs-note">{note}</p>
  if (!pm) return <p className="small">No Lean measurements of {base.name} yet: run <code>node qedrank/cli.js proof-metrics --project &lt;its Lean project&gt; [--solutions &lt;dir&gt;] [--runs id]</code>, then compare again.</p>
  return null
}

function StatementChecksSection({ number, pm, note, base, others }) {
  const st = pm?.sources?.statements
  return (
    <section className="ev-section">
      <h2 className="ev-h2"><span className="ev-num">{number}</span>Statement checks</h2>
      <p className="small">Automatic flags of statement fidelity, measured with Lean in the benchmark's own project. A research statement that automation proves outright, or whose hypotheses contradict each other, is suspect. No flag is not evidence that a statement formalizes its paper faithfully: that needs a reviewer. {others.length ? `Not measured for ${others.map((b) => b.name).join(', ')}: each needs its own Lean project and Mathlib.` : ''}</p>
      <MetricsNote pm={pm} note={note} base={base} />
      {!st ? null : (() => {
        const s = st.summary
        const n = s.targets_found
        const series = [
          { id: 'closed', label: 'Proved outright by automation', value: share(s.closed_by_automation, n), text: `${s.closed_by_automation} of ${n}`, color: SOURCE_COLOR.library },
          { id: 'contra', label: 'Hypotheses contradict each other', value: share(s.contradictory, n), text: `${s.contradictory} of ${n}`, color: SOURCE_COLOR.solutions },
          { id: 'lint', label: 'Files with linter warnings', value: share(s.linter_warnings.files_with_warnings, s.measured), text: `${s.linter_warnings.files_with_warnings} of ${s.measured}`, color: SOURCE_COLOR.models },
        ]
        return (
          <div className="ev-grid-2">
            <Figure title={`${base.name}: statements flagged`} subtitle={`Each of ${s.portfolio.join(', ')} tried alone (the portfolio of QED_LEAF's vacuity probe). ${s.targets_found} of ${s.files} targets found${s.not_elaborated.length ? `; ${s.not_elaborated.length} files did not elaborate` : ''}.`} table={{ columns: ['Check', 'Statements', 'Share'], rows: series.map((x) => [x.label, x.text, pct(x.value)]) }}>
              <HBars series={series} />
            </Figure>
            <Figure title="Flagged statements and linter warnings" subtitle="The statements a flag applies to, and the warnings Lean's and Mathlib's linters printed in the statement files." table={{ columns: ['Problem', 'Target', 'Proved outright by', 'False derived by'], rows: s.flagged.length ? s.flagged.map((f) => [f.id, f.target, f.closed_by || '—', f.contradictory_by || '—']) : [['none', '—', '—', '—']] }}>
              {s.linter_warnings.total
                ? <HBars series={Object.entries(s.linter_warnings.by_linter).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ id: k, label: k.replace(/^linter\./, ''), value: share(v, s.linter_warnings.total), text: `${v}`, color: SOURCE_COLOR.models }))} />
                : <div className="ch-empty">No linter warnings in the statement files.</div>}
            </Figure>
          </div>
        )
      })()}
    </section>
  )
}

function ProofsSection({ number, pm, note, base, others }) {
  const [lengthKey, setLengthKey] = useState('proof_lines')
  const sources = pm ? PROOF_SOURCES.filter(([k]) => pm.sources[k]).map(([k, l]) => ({ id: k, label: l, src: pm.sources[k], s: pm.sources[k].summary, color: SOURCE_COLOR[k] })) : []
  const withProofs = sources.filter((x) => x.s.proofs > 0)
  const legend = withProofs.map((x) => ({ label: x.label, color: x.color }))
  const box = (field) => withProofs.map((x) => { const d = x.s[field] || {}; return { id: x.id, label: `${x.label} (${x.s.proofs})`, n: d.n, p10: d.p10, q1: d.q1, median: d.median, q3: d.q3, p90: d.p90, color: x.color } })
  const boxTable = (field) => ({ columns: ['Source', 'Proofs', 'P10', 'Q1', 'Median', 'Q3', 'P90', 'Max'], rows: withProofs.map((x) => { const d = x.s[field] || {}; return [x.label, num(x.s.proofs), num(d.p10), num(d.q1), num(d.median), num(d.q3), num(d.p90), num(d.max)] }) })
  const tacticTotals = Object.create(null) // `constructor` is a tactic name
  for (const x of withProofs) for (const [k, n] of Object.entries(x.s.tactic_counts || {})) tacticTotals[k] = (tacticTotals[k] || 0) + n
  const topNames = Object.entries(tacticTotals).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k)
  const tacticRows = topNames.map((name) => ({
    id: name,
    label: name,
    values: Object.fromEntries(withProofs.map((x) => { const c = Object.hasOwn(x.s.tactic_counts || {}, name) ? x.s.tactic_counts[name] : 0; return [x.id, { value: share(c, x.s.tactic_calls), text: `${c} (${pct(share(c, x.s.tactic_calls))})` }] })),
  }))
  const tacticMax = Math.min(1, Math.ceil(10 * Math.max(0.1, ...tacticRows.flatMap((r) => Object.values(r.values).map((v) => v.value || 0)))) / 10)
  const records = sources.flatMap((x) => (x.src.records || []).filter((r) => r.complete).map((r) => ({ ...r, sourceLabel: x.label })))
  const lemmaColumns = ['Source', 'Lemma', 'File', 'Lines', 'Tokens', 'Term size', 'Tactics', 'Automation', 'Unused hypotheses', 'Linter warnings']
  const lemmaRows = records.map((r) => [r.sourceLabel + (r.model ? ` · ${r.model}` : ''), r.name, r.file || '—', num(r.proof_lines), num(r.proof_tokens), r.term_size_capped ? '>2M' : num(r.term_size), num(r.tactics), num(r.automation), r.hypotheses ? `${r.unused_hypotheses.length}/${r.hypotheses}${r.unused_hypotheses.length ? ` (${r.unused_hypotheses.join(', ')})` : ''}` : '—', num(total(r.linter_warnings))])
  const lemmaCsv = () => toCsv(lemmaRows.map((row) => Object.fromEntries(lemmaColumns.map((c, i) => [c, row[i]]))), lemmaColumns)
  const project = pm?.projects?.[0]
  return (
    <section className="ev-section">
      <h2 className="ev-h2"><span className="ev-num">{number}</span>Proofs, measured with Lean</h2>
      <p className="small">Each file elaborated in its own Lean project{project ? ` (${pm.projects.map((p) => `${p.dir.split(/[\\/]/).pop()} @ ${String(p.commit || '').slice(0, 7)}, Lean ${String(p.lean_version || '').match(/\d+\.\d+\.\d+/)?.[0] || '?'}`).join('; ')})` : ''}. {others.length ? `No proofs to measure in ${others.map((b) => `${b.name} (${noProofs(b)})`).join(', ')}.` : ''}</p>
      <MetricsNote pm={pm} note={note} base={base} />
      {!pm ? null : !withProofs.length ? <p className="small">The measured sources contain no complete proofs.</p> : (
        <>
          <div className="tabs">
            {[['proof_lines', 'Lines'], ['proof_tokens', 'Tokens'], ['term_size', 'Proof-term size']].map(([k, l]) => <button key={k} type="button" className={`tab ${lengthKey === k ? 'active' : ''}`} onClick={() => setLengthKey(k)}>{l}</button>)}
          </div>
          <div className="ev-grid-2">
            <Figure title="Length of each proof" subtitle={`${pm.rules?.[lengthKey] || ''}. Box: middle half; line: median; whiskers: 10th to 90th percentile (log scale).`} table={boxTable(lengthKey)}>
              <LogBoxes rows={box(lengthKey)} unit={lengthKey === 'proof_lines' ? 'lines' : lengthKey === 'proof_tokens' ? 'tokens' : 'term nodes'} ariaLabel="Proof length by source" />
            </Figure>
            <Figure title="Tactics per proof" subtitle={`A term-mode proof has none. Automation: ${withProofs.map((x) => `${x.label.toLowerCase()} ${pct(x.s.automation_share)}`).join(', ')} of tactic calls.`} table={{ columns: ['Source', 'Proofs', 'Term-mode proofs', 'Tactic calls', 'Automation', 'Median tactics', 'P90', 'Max'], rows: withProofs.map((x) => [x.label, num(x.s.proofs), num(x.s.term_mode_proofs), num(x.s.tactic_calls), pct(x.s.automation_share), num(x.s.tactics.median), num(x.s.tactics.p90), num(x.s.tactics.max)]) }}>
              <LogBoxes rows={box('tactics')} unit="tactics" linear ariaLabel="Tactics per proof by source" />
            </Figure>
            <Figure title="Most used tactics" subtitle="Share of each source's tactic calls; the twelve tactics used most overall." legend={legend} table={{ columns: ['Tactic', ...withProofs.map((x) => x.label)], rows: tacticRows.map((r) => [r.label, ...withProofs.map((x) => r.values[x.id].text)]) }}>
              <GroupedBars rows={tacticRows} series={withProofs.map((x) => ({ key: x.id, label: x.label, color: x.color }))} max={tacticMax} labelKey={withProofs[0].id} ariaLabel="Most used tactics" />
            </Figure>
            <Figure title="Unused hypotheses and linter warnings" subtitle={`Share of proofs with hypotheses that leave at least one unused. ${pm.rules?.unused_hypothesis || ''}.`} table={{ columns: ['Source', 'Proofs with hypotheses', 'With an unused one', 'Unused / all hypotheses', 'Linter warnings', 'Most frequent linter', 'Files with warnings'], rows: withProofs.map((x) => [x.label, num(x.s.hypotheses.proofs_with_hypotheses), num(x.s.hypotheses.proofs_with_unused), `${x.s.hypotheses.unused}/${x.s.hypotheses.total}`, num(x.s.linter_warnings.total), topLinter(x.s.linter_warnings) || '—', `${x.s.linter_warnings.files_with_warnings}/${x.s.files}`]) }}>
              <HBars series={withProofs.map((x) => ({ id: x.id, label: x.label, value: share(x.s.hypotheses.proofs_with_unused, x.s.hypotheses.proofs_with_hypotheses), text: `${x.s.hypotheses.proofs_with_unused}/${x.s.hypotheses.proofs_with_hypotheses}`, color: x.color }))} />
            </Figure>
          </div>
          <details className="vs-details">
            <summary>Every proof ({records.length}): length, tactics, unused hypotheses, linter warnings</summary>
            <div className="row"><button type="button" className="btn btn-secondary btn-sm" onClick={() => download(`proofs-${(pm.generated_at || '').slice(0, 10)}.csv`, lemmaCsv(), 'text/csv')}>Proofs CSV</button></div>
            <DataTable table={{ columns: lemmaColumns, rows: lemmaRows }} />
          </details>
        </>
      )}
    </section>
  )
}

export default function VersusResults({ result }) {
  const data = result.comparison
  const colors = result.colors || {}
  const all = data.benchmarks
  const measured = all.filter((b) => b.measured?.available)
  const groups = data.subject_groups || []
  const pm = data.proof_metrics || null
  const rows = matrixRows(groups, pm, data.proof_metrics_note)
  const [lengthField, setLengthField] = useState('closure_tokens')
  const label = (b) => b.short || b.name
  const series = measured.map((b) => ({ key: b.id, label: label(b), color: colors[b.id] }))

  const histKey = lengthField === 'closure_tokens' ? 'closure_histogram' : 'stmt_histogram'
  const buckets = (measured[0]?.measured.statements[histKey] || []).map((h) => h.label)
  const histRows = buckets.map((bucket, i) => ({
    id: bucket,
    label: `${bucket} tokens`,
    values: Object.fromEntries(measured.map((b) => { const s = b.measured.statements; const n = s[histKey]?.[i]?.count || 0; return [b.id, { value: s.measured ? n / s.measured : null, text: `${n} (${pct(s.measured ? n / s.measured : null)})` }] })),
  }))

  const withSubjects = all.filter((b) => b.subjects && total(b.subjects))
  const usedGroups = groups.filter((g) => withSubjects.some((b) => b.subjects[g.id]))
  const subjectRows = usedGroups.map((g) => ({
    id: g.id,
    label: g.short || g.label,
    values: Object.fromEntries(withSubjects.map((b) => [b.id, { value: (b.subjects[g.id] || 0) / total(b.subjects), text: pct((b.subjects[g.id] || 0) / total(b.subjects)) }])),
  }))

  const levelRows = all.filter((b) => b.levels && total(b.levels)).map((b) => ({ id: b.id, label: `${label(b)}${b.levels_source === 'stated' ? ' *' : ''}`, counts: b.levels }))
  const levelParts = LEVELS.filter(([k]) => levelRows.some((r) => r.counts[k])).map(([key, l, color]) => ({ key, label: l, color }))

  const points = all.filter((b) => b.facts?.problems && (typeof b.facts?.best?.rate === 'number' || b.facts?.best?.ci)).map((b) => {
    const best = b.facts.best
    const isBase = b.id === 'proofbench'
    return {
      id: b.id,
      label: label(b),
      x: best.evaluated_on || b.facts.problems,
      y: typeof best.rate === 'number' ? best.rate : null,
      lo: isBase ? best.ci?.[0] : undefined,
      hi: isBase ? best.ci?.[1] : undefined,
      shape: isBase ? 'circle' : BUDGET_SHAPE[best.budget_class] || 'diamond',
      hollow: isBase,
      color: colors[b.id],
      title: <span><b>{b.name}</b> · {pct(best.rate)} on {num(best.evaluated_on || b.facts.problems)} problems<br />{best.model || ''}{best.budget ? ` · ${best.budget}` : ''}{best.date ? <><br />{best.date}</> : null}</span>,
    }
  })

  const baseRow = all[0]
  const perf = data.proofbench?.performance || []
  const matrixCsv = () => toCsv(rows.map((r) => Object.fromEntries([['measure', r.label], ...all.map((b) => [b.name, String(r.show(b)).replace(/\s+/g, ' ')])])))
  const stamp = data.generated_at?.slice(0, 10) || 'comparison'

  return (
    <>
      <section className="vs-legend card">
        <div className="row spread">
          <div className="row">
            {all.map((b) => <span key={b.id} className="pill vs-pill" style={{ '--mc': colors[b.id] }}><i />{b.name}{b.measured?.available ? '' : ' (facts only)'}</span>)}
          </div>
          <div className="row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => download(`compare-benchmarks-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json')}>JSON</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => download(`compare-benchmarks-${stamp}.csv`, matrixCsv(), 'text/csv')}>Matrix CSV</button>
            {result.tex && <button type="button" className="btn btn-secondary btn-sm" onClick={() => download(`compare-benchmarks-${stamp}.tex`, result.tex, 'application/x-tex')}>LaTeX for the paper</button>}
          </div>
        </div>
        {all.some((b) => !b.measured?.available) && <p className="small">Facts only (no statements measured): {all.filter((b) => !b.measured?.available).map((b) => `${b.name} — ${b.measured?.reason}`).join('; ')}.</p>}
      </section>

      <section className="stat-tiles vs-cards">
        {all.map((b) => {
          const s = stats(b)
          return (
            <div key={b.id} className="stat" style={{ '--stat-color': colors[b.id] }}>
              <div className="label">{b.name}</div>
              <div className="value">{num(b.facts?.problems ?? s?.problems)}<span className="muted vs-unit"> problems</span></div>
              <div className="sub">{s ? `${num(s.closure_tokens.median)} tokens per statement · ${pct(s.share_with_local_defs)} use own definitions` : 'statements not measured'}</div>
              <div className="sub">best reported {b.id === 'proofbench' && b.facts?.best ? `${b.facts.best.solved}/${b.facts.best.of}` : pct(bestRate(b))}</div>
            </div>
          )
        })}
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">1</span>Performance matrix</h2>
        <p className="small">Each cell is tinted in its benchmark's colour, darker for a larger value within the row. Success rates are comparable only at equal sampling budget; statement measures use one rule for every benchmark.</p>
        <PerformanceMatrix benchmarks={all} colors={colors} rows={rows} />
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">2</span>Statement length</h2>
        <div className="tabs">
          {[['closure_tokens', 'Statement with its definitions'], ['stmt_tokens', 'Theorem signature only']].map(([k, l]) => <button key={k} type="button" className={`tab ${lengthField === k ? 'active' : ''}`} onClick={() => setLengthField(k)}>{l}</button>)}
        </div>
        <div className="ev-grid-2">
          <Figure title="Spread of statement length" subtitle="Box: middle half of the problems; line: median; whiskers: 10th to 90th percentile (log scale)." table={{ columns: ['Benchmark', 'P10', 'Q1', 'Median', 'Q3', 'P90', 'Max'], rows: measured.map((b) => { const s = b.measured.statements[lengthField]; return [b.name, num(s.p10), num(s.q1), num(s.median), num(s.q3), num(s.p90), num(s.max)] }) }}>
            <LogBoxes rows={measured.map((b) => { const s = b.measured.statements[lengthField]; return { id: b.id, label: label(b), n: s.n, p10: s.p10, q1: s.q1, median: s.median, q3: s.q3, p90: s.p90, color: colors[b.id] } })} />
          </Figure>
          <Figure title="Share of problems by length" subtitle={`Each benchmark sums to 100%. The label at the end is ${label(baseRow)}.`} legend={series.map((s) => ({ label: s.label, color: s.color }))} table={{ columns: ['Tokens', ...measured.map((b) => b.name)], rows: histRows.map((r) => [r.label, ...measured.map((b) => r.values[b.id].text)]) }}>
            <GroupedBars rows={histRows} series={series} labelKey={measured[0]?.id} ariaLabel="Share of problems by statement length" />
          </Figure>
        </div>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">3</span>What the statements depend on</h2>
        <div className="ev-grid-2">
          <Figure title="Statements that use their own definitions" subtitle="Same-file definitions or the benchmark's own library, followed transitively; answer slots excluded." table={{ columns: ['Benchmark', 'Own definitions', 'Own library', 'Answer slot', 'Median definitions used'], rows: measured.map((b) => { const s = b.measured.statements; return [b.name, `${s.count_with_local_defs}/${s.measured}`, `${s.count_with_project_library}/${s.measured}`, `${s.count_with_answer_slot || 0}/${s.measured}`, num(s.defs_used.median)] }) }}>
            <HBars series={measured.map((b) => { const s = b.measured.statements; return { id: b.id, label: label(b), value: s.share_with_local_defs, text: `${s.count_with_local_defs}/${s.measured}`, color: colors[b.id] } })} />
          </Figure>
          <Figure title="Headroom: size against best reported success" subtitle={`Marker shape is the budget behind each published result; ${label(baseRow)} (hollow) shows your QEDRank runs with the exact 95% interval.`} legend={[...Object.entries(BUDGET_LABEL).filter(([k]) => points.some((p) => p.shape === BUDGET_SHAPE[k])).map(([k, l]) => ({ label: `${l} (${BUDGET_SHAPE[k]})`, color: 'var(--muted)' }))]} table={{ columns: ['Benchmark', 'Evaluated on', 'Best', 'Model', 'Budget'], rows: all.filter((b) => b.facts?.best).map((b) => [b.name, num(b.facts.best.evaluated_on || b.facts.problems), b.id === 'proofbench' ? `${b.facts.best.solved}/${b.facts.best.of}` : pct(b.facts.best.rate), b.facts.best.model || '—', b.facts.best.budget || '—']) }}>
            {points.length ? <SizeRateScatter points={points} /> : <div className="ch-empty">No published results for this selection.</div>}
          </Figure>
        </div>
      </section>

      <section className="ev-section">
        <h2 className="ev-h2"><span className="ev-num">4</span>Subjects and levels</h2>
        <div className="ev-grid-2">
          <Figure title="Subject coverage" subtitle={`Share of labelled problems per subject area.${all.filter((b) => !withSubjects.includes(b)).length ? ` No subject labels: ${all.filter((b) => !withSubjects.includes(b)).map(label).join(', ')}.` : ''}`} legend={withSubjects.map((b) => ({ label: label(b), color: colors[b.id] }))} table={{ columns: ['Subject', ...withSubjects.map((b) => b.name)], rows: subjectRows.map((r) => [r.label, ...withSubjects.map((b) => r.values[b.id].text)]) }}>
            {subjectRows.length ? <GroupedBars rows={subjectRows} series={withSubjects.map((b) => ({ key: b.id, label: label(b), color: colors[b.id] }))} labelKey={withSubjects[0]?.id} ariaLabel="Subject coverage" /> : <div className="ch-empty">No subject labels in this selection.</div>}
          </Figure>
          <Figure title="Problems by level" subtitle="Per-problem labels where the benchmark has them; * marks a level stated by its authors." legend={levelParts.map((p) => ({ label: p.label, color: p.color }))} table={{ columns: ['Benchmark', ...levelParts.map((p) => p.label)], rows: levelRows.map((r) => [r.label, ...levelParts.map((p) => r.counts[p.key] || 0)]) }}>
            {levelRows.length ? <StackedBars rows={levelRows} parts={levelParts} ariaLabel="Problems by level" /> : <div className="ch-empty">No level information in this selection.</div>}
          </Figure>
        </div>
      </section>

      <FileStructureSection number={5} benchmarks={measured} colors={colors} label={label} />
      <StatementChecksSection number={6} pm={pm} note={data.proof_metrics_note} base={baseRow} others={measured.filter((b) => !isBase(b))} />
      <ProofsSection number={7} pm={pm} note={data.proof_metrics_note} base={baseRow} others={measured.filter((b) => !isBase(b))} />

      {perf.length > 0 && (
        <section className="ev-section">
          <h2 className="ev-h2"><span className="ev-num">8</span>{baseRow.name}: your QEDRank runs</h2>
          <Figure title="Verified answers by model" subtitle="Established main theorems with a determinate outcome; whiskers are exact 95% intervals." table={{ columns: ['Run', 'Model', 'Verified', '95% interval', 'Provider/grader failures', 'Problems covered', 'Lacks vs other models'], rows: perf.map((p) => [p.run_id, p.model, `${p.verified}/${p.den}`, p.ci ? `${pct(p.ci[0])}–${pct(p.ci[1])}` : '—', p.infra, p.covered == null ? '—' : `${p.covered}${p.problems_discovered ? ` of ${p.problems_discovered}` : ''}`, p.missing ?? '—']) }}>
            <HBars series={perf.filter((p) => p.den > 0).map((p, i) => ({ id: `${p.run_id}-${p.model}-${i}`, label: `${p.model} (${p.run_id})`, value: p.verified / p.den, lo: p.ci?.[0], hi: p.ci?.[1], text: `${p.verified}/${p.den}`, color: colors.proofbench }))} />
          </Figure>
          {data.proofbench?.run_facts?.reference_defects && (() => { const d = data.proofbench.run_facts.reference_defects; const a = d.automated_findings || {}; return (
            <p className="small">Reference defects (run {data.proofbench.run_facts.run_id}): {num(d.defects_recorded)} recorded by review, {num(d.references_reviewed)} of {num(d.references_total)} references reviewed; automated findings: {num(a.invalid)} invalid, {num(a.contains_placeholder)} with a placeholder, {num(a.missing)} missing, {num(a.statement_unavailable)} statement unavailable.{data.proofbench.run_facts.coverage ? ` Common problems of all models in that run: ${num(data.proofbench.run_facts.coverage.common_problems)}.` : ''}</p>
          ) })()}
        </section>
      )}
    </>
  )
}
