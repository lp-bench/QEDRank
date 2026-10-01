// Vercel Serverless Function - QEDRank corpus preview.
//
// POST { repoUrl, ref?, token?, expectedCount? }  ->  preview manifest of the papers and
// ground-truth Lean targets discovered at an immutable commit.
//
// repoUrl: https://github.com/<owner>/<repo>[/tree/<branch-or-tag>]   (branch links are accepted)
// ref:     optional branch, tag or commit; overrides the /tree/ part of the URL
// token:   optional GitHub token for PRIVATE repositories. It is used for this request only,
//          never stored or logged. Alternatively set GITHUB_TOKEN in the Vercel project
//          environment to apply one server-side token to every preview. SSH URLs cannot be
//          used from the serverless preview; the local runner supports them.
//
// Only the file listing and a bounded number of small Lean/metadata files are read; nothing is
// executed and no model is called. The full benchmark runs locally (see qedrank/README.md).

import { openSource, parseGitSshUrl } from '../../qedrank/lib/source.js';
import { discoverCorpus } from '../../qedrank/lib/corpus.js';

const PREVIEW_LIMITS = {
  maxFiles: 20000,
  maxTotalBytes: 25 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
};
const MAX_LEAN_READS = 150;
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const { repoUrl, ref, expectedCount } = body;
  if (!repoUrl || typeof repoUrl !== 'string') { res.status(400).json({ error: 'repoUrl is required' }); return; }
  let sshParsed = null;
  try { sshParsed = parseGitSshUrl(repoUrl); } catch { /* reported below as invalid url */ }
  if (sshParsed) {
    res.status(400).json({
      error: 'SSH URLs cannot be used from the web preview. Use https://github.com/<owner>/<repo> with a GitHub token for a private repository, or run the local CLI: node qedrank/cli.js discover --repo git@github.com:<owner>/<repo>.git',
      code: 'ssh_not_allowed',
    });
    return;
  }
  let token = null;
  if (body.token !== undefined && body.token !== null && body.token !== '') {
    if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token.trim())) {
      res.status(400).json({ error: 'token must be a GitHub personal access token (ghp_…, github_pat_…)', code: 'invalid_token' });
      return;
    }
    token = body.token.trim();
  }
  try {
    const source = await openSource({
      url: repoUrl,
      ref: typeof ref === 'string' ? ref : null,
      token: token || process.env.GITHUB_TOKEN || null,
      limits: PREVIEW_LIMITS,
      allowSsh: false,
    });
    const manifest = await discoverCorpus(source, {
      expectedCount: Number.isInteger(expectedCount) ? expectedCount : 108,
      maxLeanReads: MAX_LEAN_READS,
    });
    manifest.preview = true;
    manifest.preview_limits = { ...PREVIEW_LIMITS, max_lean_reads: MAX_LEAN_READS };
    manifest.auth = { token_used: Boolean(token), server_token_used: !token && Boolean(process.env.GITHUB_TOKEN) };
    manifest.next_step = `node qedrank/cli.js run --repo ${source.url} --ref ${manifest.source.commit}${token ? ' --token <your token>' : ''}`;
    res.status(200).json(manifest);
  } catch (err) {
    const status = err.code === 'invalid_url' || err.code === 'invalid_ref' ? 400 : err.code === 'not_found' ? 404 : err.code === 'rate_limited' ? 429 : 502;
    const hint = err.code === 'not_found' && !token && !process.env.GITHUB_TOKEN
      ? ' If the repository is private, provide a GitHub token with read access to its contents.'
      : '';
    res.status(status).json({ error: `${err.message}${hint}`, code: err.code || 'discovery_failed' });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
