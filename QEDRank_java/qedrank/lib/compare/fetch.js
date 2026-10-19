// Download helpers for the public benchmarks: shallow git clones (pinned to a commit when one is
// given) and HuggingFace dataset rows through the datasets-server API. Everything is cached under
// the cache directory, and every result records exactly what was read (commit, dataset revision).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDir, exists, readJson, writeJson } from '../util.js';

const execFileP = promisify(execFile);

async function git(args, cwd, extraEnv = {}) {
  try {
    const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv } });
    return stdout.trim();
  } catch (err) {
    // git's message names the URL, never the token (which only travels in the environment).
    throw new Error(`git ${args[0]} failed: ${String(err.stderr || err.message).trim().split('\n').slice(-2).join(' ')}`);
  }
}

/**
 * Environment that gives git an HTTPS Authorization header for github.com without writing the
 * token to the command line or to the clone's config (git >= 2.31 reads GIT_CONFIG_COUNT).
 */
function tokenEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

/**
 * Shallow clone of `url` into `<cacheDir>/<name>`, at `ref` (commit, branch or tag) or the default
 * branch. Reuses the clone when it already sits at the requested commit, unless `refresh`.
 * @returns {{ dir, commit, commit_date, url, ref }}
 */
export async function gitCheckout({ url, ref = null, cacheDir, name, refresh = false, log = () => {}, token = null }) {
  const auth = tokenEnv(token);
  const dir = path.join(cacheDir, name);
  const marker = path.join(dir, '.git', 'qedrank-ref');
  const wantedRef = `${url}#${ref || ''}`;
  if (await exists(path.join(dir, '.git'))) {
    const head = await git(['rev-parse', 'HEAD'], dir).catch(() => null);
    const recorded = await fs.readFile(marker, 'utf8').catch(() => null);
    const sameSha = ref && /^[0-9a-f]{40}$/i.test(ref) && head === ref.toLowerCase();
    if (head && !refresh && (sameSha || recorded === wantedRef)) {
      return { dir, commit: head, commit_date: await git(['log', '-1', '--format=%cI'], dir), url, ref, cached: true };
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
  await ensureDir(cacheDir);
  log(`cloning ${url}${ref ? ` @ ${ref}` : ''}`);
  try {
    if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
      await ensureDir(dir);
      await git(['init', '-q'], dir);
      await git(['remote', 'add', 'origin', url], dir);
      await git(['fetch', '-q', '--depth', '1', 'origin', ref], dir, auth);
      await git(['checkout', '-q', 'FETCH_HEAD'], dir);
    } else {
      await git(['clone', '-q', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, dir], cacheDir, auth);
    }
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await fs.writeFile(marker, wantedRef);
  return { dir, commit: await git(['rev-parse', 'HEAD'], dir), commit_date: await git(['log', '-1', '--format=%cI'], dir), url, ref, cached: false };
}

/** Recursively list files under `dir` whose repository-relative path matches `re`. */
export async function listFiles(dir, re) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.lake' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const rel = path.relative(dir, p).split(path.sep).join('/');
        if (re.test(rel)) out.push(rel);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

const HF_ROWS = 'https://datasets-server.huggingface.co';

async function getJson(url, { fetchImpl = globalThis.fetch, tries = 4 } = {}) {
  for (let i = 1; ; i += 1) {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (i >= tries || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 1500 * i));
  }
}

/**
 * All rows of a HuggingFace dataset split via the datasets-server API (100 rows per request),
 * cached as JSON. Records the dataset revision the API served.
 */
export async function hfRows({ dataset, config = 'default', split, cacheDir, refresh = false, log = () => {}, fetchImpl }) {
  const file = path.join(cacheDir, `hf__${dataset.replace(/[^\w.-]+/g, '_')}__${config}__${split}.json`);
  if (!refresh && (await exists(file))) return readJson(file);
  log(`downloading ${dataset} [${config}/${split}] from the HuggingFace datasets server`);
  // The Hub API names the dataset commit; the rows below are those the datasets server indexed for it.
  const hub = await getJson(`https://huggingface.co/api/datasets/${dataset}`, { fetchImpl }).catch(() => null);
  const rows = [];
  let total = Infinity;
  for (let offset = 0; offset < total; offset += 100) {
    const page = await getJson(`${HF_ROWS}/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=100`, { fetchImpl });
    total = page.num_rows_total ?? page.num_rows ?? rows.length + (page.rows || []).length;
    for (const r of page.rows || []) rows.push(r.row);
    if (!(page.rows || []).length) break;
  }
  const splits = await getJson(`${HF_ROWS}/splits?dataset=${encodeURIComponent(dataset)}`, { fetchImpl }).catch(() => null);
  const out = {
    dataset, config, split,
    fetched_at: new Date().toISOString(),
    commit: hub?.sha ?? null,
    last_modified: hub?.lastModified ?? null,
    num_rows: rows.length,
    splits_available: (splits?.splits || []).map((s) => `${s.config}/${s.split}`),
    rows,
  };
  await ensureDir(cacheDir);
  await writeJson(file, out);
  return out;
}

/** A raw file over HTTP (e.g. raw.githubusercontent.com or an HF `resolve` URL), cached. */
export async function rawFile({ url, cacheDir, name, refresh = false, headers = {}, fetchImpl = globalThis.fetch }) {
  const file = path.join(cacheDir, name.replace(/[^\w.-]+/g, '_'));
  if (!refresh && (await exists(file))) return fs.readFile(file, 'utf8');
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const text = await res.text();
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text);
  return text;
}
