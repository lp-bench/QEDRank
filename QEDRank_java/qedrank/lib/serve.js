// Local run server for the QEDRank page: serves run folders read-only (GET /runs,
// GET /runs/<id>/<file>) and, when a JobManager is given, starts and watches benchmark runs
// (POST /jobs, GET /jobs, GET /jobs/<id>?from=N, POST /jobs/<id>/stop) so the page can do what
// the PowerShell command does, and compares benchmarks (POST /compare, see compare/serve.js). The server binds to 127.0.0.1 only; job endpoints answer only to
// the app's own origins and need a custom header, so another website in the browser cannot
// start a run.

import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJson } from './util.js';
import { createCompareHandler } from './compare/serve.js';

const TYPES = { '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8', '.lean': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf' };
const DEFAULT_ORIGINS = [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/];

export function originAllowed(origin, extra = []) {
  if (!origin) return false;
  return DEFAULT_ORIGINS.some((re) => re.test(origin)) || extra.includes(origin);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export function createServer({ runsDir, jobs = null, allowOrigins = [], compare = undefined, harnesses = null }) {
  const root = path.resolve(runsDir);
  // compare: false disables the endpoint; a function replaces the handler (tests).
  const compareHandler = compare === false ? null : compare || createCompareHandler({ runsDir: root });
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, 'http://localhost');
    const isJobs = url.pathname === '/jobs' || url.pathname.startsWith('/jobs/');
    const isCompare = url.pathname === '/compare';
    const guarded = isJobs || isCompare;
    res.setHeader('Cache-Control', 'no-store');
    // The page may be served from https://…vercel.app while this server is on the loopback
    // address: browsers treat that as a private-network request and require this header.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (guarded) {
      // Jobs and comparisons: only the app's origins, and a header that forces a preflight.
      if (originAllowed(origin, allowOrigins)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-QEDRank-Client');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      if (isCompare) {
        if (!compareHandler) return json(res, 404, { error: 'comparison is not enabled on this server' });
        if (!originAllowed(origin, allowOrigins) || !req.headers['x-qedrank-client']) return json(res, 403, { error: 'the compare endpoint accepts requests from the QEDRank page only' });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        try { return json(res, 200, await compareHandler(body)); } catch (err) { return json(res, 400, { error: err.message }); }
      }
      if (isJobs) {
        if (!jobs) return json(res, 404, { error: 'job control is not enabled on this server' });
        if (!originAllowed(origin, allowOrigins) || !req.headers['x-qedrank-client']) return json(res, 403, { error: 'job endpoints accept requests from the QEDRank page only' });
        if (req.method === 'GET' && url.pathname === '/jobs') return json(res, 200, { jobs: jobs.list() });
        if (req.method === 'POST' && url.pathname === '/jobs') {
          const body = await readBody(req);
          try { return json(res, 201, { job: await jobs.start(body) }); } catch (err) { return json(res, 400, { error: err.message }); }
        }
        const m = /^\/jobs\/([A-Za-z0-9-]+)(\/stop)?$/.exec(url.pathname);
        if (!m) return json(res, 404, { error: 'not found' });
        if (req.method === 'GET' && !m[2]) {
          const j = jobs.get(m[1], Number(url.searchParams.get('from') || 0));
          return j ? json(res, 200, { job: j }) : json(res, 404, { error: 'no such job' });
        }
        if (req.method === 'POST' && m[2]) {
          const j = jobs.stop(m[1]);
          return j ? json(res, 200, { job: j }) : json(res, 404, { error: 'no such job' });
        }
        return json(res, 405, { error: 'method not allowed' });
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end('GET only'); return; }
      // The harnesses this machine can run, with their integration state (paths, never secrets).
      if (url.pathname === '/harnesses') {
        if (!harnesses) return json(res, 404, { error: 'harness listing is not enabled on this server' });
        return json(res, 200, { harnesses: await harnesses() });
      }
      if (url.pathname === '/' || url.pathname === '/runs' || url.pathname === '/runs/') {
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const runs = [];
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const run = await readJson(path.join(root, e.name, 'run.json'), null);
          if (run) runs.push({ run_id: run.run_id, created_at: run.created_at, updated_at: run.updated_at, source: run.source, stages: run.stages, models: run.models, mode: run.mode, task: run.task ?? null, protocol: run.protocol ?? null });
        }
        runs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        return json(res, 200, { runs_dir: root, runs, jobs: Boolean(jobs) });
      }
      const m = /^\/runs\/([A-Za-z0-9._-]+)\/(.+)$/.exec(url.pathname);
      if (!m) { res.writeHead(404); res.end('not found'); return; }
      const [, runId, rel] = m;
      const file = path.resolve(root, runId, ...decodeURIComponent(rel).split('/'));
      if (!file.startsWith(path.join(root, runId))) { res.writeHead(403); res.end('forbidden'); return; }
      const ext = path.extname(file).toLowerCase();
      if (!TYPES[ext]) { res.writeHead(403); res.end('file type not served'); return; }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[ext] });
      res.end(data);
    } catch (err) {
      json(res, err.code === 'ENOENT' ? 404 : err instanceof SyntaxError ? 400 : 500, { error: err.message });
    }
  });
}
