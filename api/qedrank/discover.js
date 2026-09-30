// Vercel Serverless Function - QEDRank corpus preview.
//
// POST { repoUrl, ref? }  ->  preview manifest of the papers and ground-truth
// Lean targets discovered at an immutable commit. Only the file listing and a
// bounded number of small Lean/metadata files are read; nothing is executed
// and no model is called. The full benchmark runs locally (see qedrank/README.md).

import { openSource } from '../../qedrank/lib/source.js';
import { discoverCorpus } from '../../qedrank/lib/corpus.js';

const PREVIEW_LIMITS = {
  maxFiles: 20000,
  maxTotalBytes: 25 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
};
const MAX_LEAN_READS = 150;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const { repoUrl, ref, expectedCount } = body;
  if (!repoUrl || typeof repoUrl !== 'string') { res.status(400).json({ error: 'repoUrl is required' }); return; }
  try {
    const source = await openSource({ url: repoUrl, ref: typeof ref === 'string' ? ref : null, token: process.env.GITHUB_TOKEN || null, limits: PREVIEW_LIMITS });
    const manifest = await discoverCorpus(source, {
      expectedCount: Number.isInteger(expectedCount) ? expectedCount : 108,
      maxLeanReads: MAX_LEAN_READS,
    });
    manifest.preview = true;
    manifest.preview_limits = { ...PREVIEW_LIMITS, max_lean_reads: MAX_LEAN_READS };
    manifest.next_step = `node qedrank/cli.js run --repo ${source.url} --ref ${manifest.source.commit}`;
    res.status(200).json(manifest);
  } catch (err) {
    const status = err.code === 'invalid_url' || err.code === 'invalid_ref' ? 400 : err.code === 'not_found' ? 404 : err.code === 'rate_limited' ? 429 : 502;
    res.status(status).json({ error: err.message, code: err.code || 'discovery_failed' });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
