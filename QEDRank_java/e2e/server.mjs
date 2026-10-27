// Servers for the end-to-end tests: the built app with its API functions in-process, a run
// server over the fixture runs, and a stub of the job endpoint that records what the page sends.
// Nothing here reaches the network: discovery answers from the fixture corpora, the model
// endpoints run with no keys and answer as they would on a machine without keys.
//
//   node e2e/server.mjs            starts the three servers and prints their URLs (Ctrl+C stops)
//   import { startAll } from ...   the orchestrator (e2e/run.mjs) does the same in-process

import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Never a real model call from the tests: every credential and QEDRank override is removed from
// this process before the API functions load, so the page sees the roster of a machine without
// keys (what CI has) wherever the suite runs.
for (const k of Object.keys(process.env)) if (/_API_KEY$|^GITHUB_TOKEN$|^QEDRANK_/.test(k)) delete process.env[k];
const modelsHandler = (await import('../api/models.js')).default;
const verifyHandler = (await import('../api/verify.js')).default;
const { openSource } = await import('../qedrank/lib/source.js');
const { discoverCorpus } = await import('../qedrank/lib/corpus.js');
const { createServer: createRunServer } = await import('../qedrank/lib/serve.js');

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(APP_ROOT, 'dist');
export const FIXTURES = path.join(APP_ROOT, 'qedrank', 'test', 'fixtures');
export const FIXTURE_RUNS = path.join(FIXTURES, 'runs');
/** GitHub-looking links the Benchmark page may enter; they resolve to the fixture corpora. */
export const FIXTURE_CORPORA = {
  'https://github.com/e2e/corpus-a': { dir: path.join(FIXTURES, 'corpus-a'), subdir: null },
  'https://github.com/e2e/corpus-b': { dir: path.join(FIXTURES, 'corpus-b'), subdir: 'Bench/PROBLEMS' },
  'https://github.com/e2e/corpus-prove': { dir: path.join(FIXTURES, 'corpus-prove'), subdir: 'Bench/PROBLEMS' },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };

/** The subset of Vercel's response object the API functions use. */
function vercelRes(res) {
  const r = {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { res.statusCode = code; return r; },
    json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
    end(body) { res.end(body); },
  };
  return r;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/** Discovery over a fixture corpus, shaped like api/qedrank/discover.js answers. */
async function discoverFixture(body) {
  const key = String(body.repoUrl || '').trim().replace(/\/+$/, '');
  const fx = FIXTURE_CORPORA[key];
  if (!fx) return { status: 404, body: { error: `Repository not found: ${key}`, code: 'not_found' } };
  const source = await openSource({ path: fx.dir, subdir: body.subdir || fx.subdir });
  const manifest = await discoverCorpus(source, { expectedCount: Number.isInteger(body.expectedCount) ? body.expectedCount : 108 });
  manifest.preview = true;
  manifest.auth = { token_used: false, server_token_used: false };
  const sub = manifest.source.subdir ? ` --subdir "${manifest.source.subdir}"` : '';
  manifest.next_step = `node qedrank/cli.js run --repo ${key} --ref ${manifest.source.commit}${sub}`;
  return { status: 200, body: manifest };
}

/** The app: dist/ with the SPA fallback, plus /api/* served by the same functions Vercel runs. */
export function createAppServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        req.body = req.method === 'POST' ? await readBody(req) : undefined;
        const vr = vercelRes(res);
        if (url.pathname === '/api/models') return modelsHandler(req, vr);
        if (url.pathname === '/api/verify') return verifyHandler(req, vr);
        if (url.pathname === '/api/feedback') return vr.status(200).json({ ok: true, stored: false, note: 'e2e stub' });
        if (url.pathname === '/api/qedrank/discover') {
          if (req.method !== 'POST') return vr.status(405).json({ error: 'Method not allowed' });
          const r = await discoverFixture(req.body || {});
          return vr.status(r.status).json(r.body);
        }
        return vr.status(404).json({ error: `no such endpoint: ${url.pathname}` });
      }
      let file = path.join(DIST, decodeURIComponent(url.pathname));
      let stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.isDirectory()) { file = path.join(DIST, 'index.html'); stat = await fs.stat(file).catch(() => null); }
      if (!stat) { res.writeHead(404); res.end('dist/ not built: npx vite build'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await fs.readFile(file));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

/**
 * A run server that also accepts jobs, but never starts one: POST /jobs is recorded and answered
 * with a finished job, so the test can read back exactly what the page sent (GET /__recorded).
 * The page then loads the finished job's run by itself; whatever run id it asks for is served
 * from the `e2e-prove` fixture run, so that step can be checked without starting anything.
 */
export function createJobsStub({ runsDir = FIXTURE_RUNS, aliasRun = 'e2e-prove' } = {}) {
  const recorded = [];
  const runTypes = { '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8', '.lean': 'text/plain; charset=utf-8' };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-QEDRank-Client');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/harnesses') return json(200, { harnesses: [{ id: 'qedrank-single', label: 'QEDRank single call', kind: 'single', integration: 'operational', ready: true, checks: {}, reason: null }, { id: 'proofbench', label: 'ProofBench agent harness (proofbench-eval-apptainer)', kind: 'agent', integration: 'integrated', ready: false, checks: { dir_exists: false }, reason: 'not configured on the e2e machine' }] });
    if (url.pathname === '/__recorded') return json(200, { recorded });
    if (url.pathname === '/configs') return json(200, { configs: [{ file: 'glm-prove-pass4.json', path: 'configs/glm-prove-pass4.json', task: 'prove', generation: { attempts: 4, temperature: 1, topP: 0.95, effort: 'max', maxTokens: 65536, timeoutMs: 1800000, providerConcurrency: 2, retries: 6 }, lean: { concurrency: 3 }, concurrency: { items: 6 } }] });
    if (url.pathname === '/jobs' && req.method === 'POST') {
      const body = await readBody(req);
      recorded.push({ at: new Date().toISOString(), body, client: req.headers['x-qedrank-client'] || null });
      return json(200, { job: { id: `e2e-job-${recorded.length}`, run_id: body.runId || null, status: 'done', exit_code: 0, next: 0, summary: 'stub' } });
    }
    if (url.pathname.startsWith('/jobs/') && req.method === 'GET') return json(200, { job: { id: url.pathname.split('/')[2], status: 'done', exit_code: 0, log: '[e2e] stub job: nothing was started\n', next: 1 } });
    if (url.pathname === '/runs' || url.pathname === '/') return json(200, { runs: [] });
    const m = /^\/runs\/[A-Za-z0-9._-]+\/(.+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const file = path.resolve(runsDir, aliasRun, ...decodeURIComponent(m[1]).split('/'));
      if (!file.startsWith(path.join(runsDir, aliasRun))) return json(403, { error: 'forbidden' });
      try {
        const data = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': runTypes[path.extname(file)] || 'application/octet-stream' });
        return res.end(data);
      } catch { return json(404, { error: 'not found' }); }
    }
    return json(404, { error: 'not found' });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); });
}

/** Start everything; returns { app, runs, jobs, close }. Ports 0 pick free ones. */
export async function startAll({ appPort = 4180, runsPort = 8790, jobsPort = 8791, runsDir = FIXTURE_RUNS } = {}) {
  const app = createAppServer();
  const runs = createRunServer({ runsDir, jobs: null, compare: false });
  const jobs = createJobsStub();
  const [a, r, j] = await Promise.all([listen(app, appPort), listen(runs, runsPort), listen(jobs, jobsPort)]);
  const urls = { app: `http://127.0.0.1:${a}`, runs: `http://127.0.0.1:${r}`, jobs: `http://127.0.0.1:${j}` };
  const close = () => Promise.all([app, runs, jobs].map((s) => new Promise((res) => s.close(() => res()))));
  return { ...urls, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startAll();
  console.log(`app ${s.app}\nruns ${s.runs} (${FIXTURE_RUNS})\njobs stub ${s.jobs}`);
}
