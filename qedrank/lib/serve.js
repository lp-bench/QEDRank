// Tiny read-only HTTP server so the QEDRank page can load local runs and poll
// progress: GET /runs, GET /runs/<id>/<file>. No writes, no directory escape.

import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJson } from './util.js';

const TYPES = { '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8', '.lean': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf' };

export function createServer({ runsDir }) {
  const root = path.resolve(runsDir);
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end('GET only'); return; }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/runs' || url.pathname === '/runs/') {
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const runs = [];
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const run = await readJson(path.join(root, e.name, 'run.json'), null);
          if (run) runs.push({ run_id: run.run_id, created_at: run.created_at, updated_at: run.updated_at, source: run.source, stages: run.stages, models: run.models, mode: run.mode });
        }
        runs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runs_dir: root, runs }));
        return;
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
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}
