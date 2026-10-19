// The run server's comparison endpoint: POST /compare { base, selections } -> { comparison, tex }.
// Runs on the user's machine (clones, private tokens and measurements stay local); requests are
// handled one at a time so two comparisons never clone the same repository concurrently.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJson } from '../util.js';
import { parseGitHubUrl } from '../source.js';
import { buildComparisonFor } from './build.js';
import { comparisonTex } from './latex.js';

const MAX_SELECTIONS = 7;
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** owner/repo of a GitHub link, lower-cased, for matching runs to a corpus. */
function repoKey(url) {
  try { const p = parseGitHubUrl(url); return `${p.owner}/${p.repo}`.toLowerCase(); } catch { return null; }
}

export function validateCompareRequest(body) {
  const b = body?.base || {};
  const base = { name: str(b.name, 80) || 'ProofBench', url: str(b.url) || null, path: str(b.path) || null, ref: str(b.ref, 200) || null, subdir: str(b.subdir, 400) || null, token: str(b.token, 400) || null };
  if (!base.url && !base.path) throw new Error('your benchmark needs a GitHub link (or a local folder)');
  const sels = Array.isArray(body?.selections) ? body.selections : [];
  if (!sels.length) throw new Error('choose at least one benchmark to compare with');
  if (sels.length > MAX_SELECTIONS) throw new Error(`at most ${MAX_SELECTIONS} benchmarks at a time`);
  const selections = sels.map((s) => ({ id: str(s?.id, 80) || null, name: str(s?.name, 80) || null, url: str(s?.url) || null, ref: str(s?.ref, 200) || null, folder: str(s?.folder, 400) || null, token: str(s?.token, 400) || null }));
  for (const s of selections) if (!s.id && !s.url) throw new Error('a benchmark without a catalogue entry needs a URL');
  return { base, selections };
}

/** QEDRank runs on the same corpus, for the pass rates of your benchmark. */
async function runsOnCorpus(runsDir, base) {
  const key = base.url ? repoKey(base.url) : null;
  const out = [];
  for (const e of await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = path.join(runsDir, e.name);
    const run = await readJson(path.join(dir, 'run.json'), null);
    if (!run) continue;
    const runKey = repoKey(run.source?.url || run.source_request?.url || '');
    const sameFolder = !base.subdir || !run.source_request?.subdir || run.source_request.subdir === base.subdir;
    if (key && runKey === key && sameFolder) out.push(dir);
  }
  return out;
}

export function createCompareHandler({ runsDir, build = buildComparisonFor, log = () => {} }) {
  let queue = Promise.resolve();
  return function handle(body) {
    const job = queue.then(async () => {
      const { base, selections } = validateCompareRequest(body);
      const comparison = await build({
        base: { ...base, token: base.token || process.env.GITHUB_TOKEN || null },
        selections,
        runDirs: await runsOnCorpus(runsDir, base),
        cacheDir: path.join(runsDir, '_cache', 'benchmarks'),
        proofMetricsFile: path.join(runsDir, '_compare', 'proof-metrics.json'),
        log,
      });
      return { comparison, tex: comparisonTex(comparison) };
    });
    queue = job.catch(() => {});
    return job;
  };
}
