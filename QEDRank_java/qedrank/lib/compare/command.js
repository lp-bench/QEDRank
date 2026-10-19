// `node qedrank/cli.js compare` — ProofBench against the published Lean benchmarks.
//
//   node qedrank/cli.js compare [--repo <corpus url> --ref <commit|branch> --subdir <folder> | --path <dir>]
//                               [--runs id1,id2] [--only minif2f,putnambench,...] [--refresh]
//                               [--out <dir>] [--tex <file.tex>] [--pdf] [--proof-metrics <file>]
//
// Defaults: the corpus, folder and commit of the newest QEDRank run with a summary, every run on that
// corpus for the pass rates, output in runs/_compare/ (served to the Compare page by `serve`), and
// paper/benchmark-comparison.tex. A private corpus needs --token or GITHUB_TOKEN (e.g. `gh auth token`).
// ProofBench's Lean proof measurements come from runs/_compare/proof-metrics.json (`proof-metrics`).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, exists } from '../util.js';
import { buildComparison, writeComparison } from './build.js';
import { comparisonTex } from './latex.js';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function runsWithSummaries(runsDir) {
  const out = [];
  for (const e of await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = path.join(runsDir, e.name);
    const run = await readJson(path.join(dir, 'run.json'), null);
    if (!run || !(await exists(path.join(dir, 'summary.json')))) continue;
    out.push({ dir, run });
  }
  return out.sort((a, b) => String(b.run.created_at || '').localeCompare(String(a.run.created_at || '')));
}

export async function compareCommand(args, { config, log, list }) {
  const runs = await runsWithSummaries(config.runsDir);
  const newest = runs.find((r) => r.run.source?.kind === 'github' || r.run.source_request?.url);
  const proofbench = args.path
    ? { path: args.path, subdir: args.subdir || null }
    : {
      url: args.repo || newest?.run.source_request?.url || newest?.run.source?.url,
      ref: args.ref || (args.repo ? null : newest?.run.source?.commit) || null,
      subdir: args.subdir ?? newest?.run.source_request?.subdir ?? newest?.run.source?.subdir ?? null,
      token: args.token || process.env.GITHUB_TOKEN || null,
    };
  if (!proofbench.path && !proofbench.url) throw new Error('compare needs --repo <corpus url> (or --path <dir>); no previous run names a corpus');
  const corpora = [...new Map(runs.map((r) => [String(r.run.source?.url || r.run.source_request?.url || '').toLowerCase(), r])).values()].filter((r) => r.run.source?.url);
  if (!args.repo && !args.path && corpora.length > 1) {
    log(`runs use ${corpora.length} corpora; using the newest run's (${proofbench.url}). Choose with --repo/--subdir/--ref:`);
    for (const r of corpora) log(`  --repo ${r.run.source.url} --subdir ${r.run.source_request?.subdir ?? r.run.source.subdir ?? '""'} --ref ${String(r.run.source.commit || '').slice(0, 10)}   (run ${r.run.run_id})`);
  }
  const sameCorpus = (r) => !proofbench.url || String(r.run.source?.url || r.run.source_request?.url || '').toLowerCase() === String(proofbench.url).toLowerCase();
  const runDirs = list(args.runs).length
    ? list(args.runs).map((id) => path.join(config.runsDir, id))
    : runs.filter(sameCorpus).map((r) => r.dir);
  log(`ProofBench from ${proofbench.path || `${proofbench.url}${proofbench.ref ? ` @ ${String(proofbench.ref).slice(0, 10)}` : ''}${proofbench.subdir ? ` (${proofbench.subdir})` : ''}`}; pass rates from ${runDirs.length} run(s)`);

  const data = await buildComparison({
    proofbench,
    runDirs,
    cacheDir: path.join(config.runsDir, '_cache', 'benchmarks'),
    only: list(args.only).length ? list(args.only) : null,
    refresh: Boolean(args.refresh),
    proofMetricsFile: args['proof-metrics'] ? path.resolve(args['proof-metrics']) : path.join(config.runsDir, '_compare', 'proof-metrics.json'),
    log,
  });
  const outDir = path.resolve(args.out || path.join(config.runsDir, '_compare'));
  const jsonFile = await writeComparison(data, outDir);
  log(`wrote ${jsonFile}`);

  const texFile = path.resolve(args.tex || path.join(REPO_ROOT, 'paper', 'benchmark-comparison.tex'));
  await fs.mkdir(path.dirname(texFile), { recursive: true });
  await fs.writeFile(texFile, comparisonTex(data));
  log(`wrote ${texFile}`);
  if (args.pdf) {
    for (let i = 0; i < 2; i += 1) {
      await execFileP('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', path.basename(texFile)], { cwd: path.dirname(texFile), windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
        .catch((err) => { throw new Error(`pdflatex failed: ${(err.stdout || '').split('\n').filter((l) => l.startsWith('!')).slice(0, 5).join(' | ') || err.message}`); });
    }
    for (const ext of ['.aux', '.log', '.out']) await fs.rm(texFile.replace(/\.tex$/, ext), { force: true });
    log(`wrote ${texFile.replace(/\.tex$/, '.pdf')}`);
  }
  printSummary(data);
}

function printSummary(data) {
  const pct = (x) => (typeof x === 'number' ? `${(100 * x).toFixed(1)}%` : 'n/a');
  console.log('\nbenchmark | problems | best reported | statement tokens (median sig / with defs) | own definitions | measured from');
  for (const b of data.benchmarks) {
    const f = b.facts || {};
    const best = f.best || {};
    const s = b.measured?.available ? b.measured.statements : null;
    const bestText = b.id === 'proofbench' ? (best.of ? `${best.solved}/${best.of} (${best.model})` : 'n/a') : typeof best.rate === 'number' ? `${pct(best.rate)} ${best.budget || ''}`.trim() : 'n/a';
    console.log(`${b.name} | ${f.problems ?? '?'} | ${bestText} | ${s ? `${s.stmt_tokens.median} / ${s.closure_tokens.median}` : '-'} | ${s ? `${s.count_with_local_defs}/${s.measured}` : '-'} | ${b.measured?.available ? `${b.measured.source?.label || b.measured.source?.url} @ ${String(b.measured.source?.commit || '').slice(0, 10)}` : b.measured?.reason}`);
  }
}
