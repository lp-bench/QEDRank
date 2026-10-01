// Corpus sources: a GitHub repository at an immutable commit, or a local
// directory (for fixtures and offline review). Only file listings and raw file
// bytes are ever fetched; nothing from the linked repository is executed.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from './util.js';

const execFileP = promisify(execFile);

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 20000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxFileBytes: 60 * 1024 * 1024,
  allowedExtensions: ['.pdf', '.lean', '.json', '.md', '.bib', '.yaml', '.yml', '.txt', '.toml', '.tex', '.csv'],
  ignoredPathParts: ['/.git/', '/.lake/', '/node_modules/', '/build/', '/dist/'],
});

export class SourceError extends Error {
  constructor(message, code = 'source_error', extra = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** Parse and validate a GitHub repository URL. Returns {owner, repo, refFromUrl}. */
export function parseGitHubUrl(input) {
  if (typeof input !== 'string') throw new SourceError('Repository URL is required', 'invalid_url');
  const s = input.trim();
  if (s.length > 500) throw new SourceError('Repository URL is too long', 'invalid_url');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/(?:tree|commit|blob|releases\/tag)\/([^?#]+?))?\/?(?:[?#].*)?$/.exec(s);
  if (!m) throw new SourceError('Only https://github.com/<owner>/<repo> URLs are accepted', 'invalid_url');
  const [, owner, repo, refFromUrl] = m;
  if (!OWNER_RE.test(owner)) throw new SourceError(`Invalid GitHub owner: ${owner}`, 'invalid_url');
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') throw new SourceError(`Invalid GitHub repository name: ${repo}`, 'invalid_url');
  return { owner, repo, refFromUrl: refFromUrl ? validateRef(refFromUrl) : null };
}

/** Validate a branch/tag/commit reference. Returns the normalized ref or null for "default branch". */
export function validateRef(ref) {
  if (ref === undefined || ref === null) return null;
  const s = String(ref).trim();
  if (!s) return null;
  if (s.length > 256) throw new SourceError('Ref is too long', 'invalid_ref');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s)) throw new SourceError(`Invalid ref: ${s}`, 'invalid_ref');
  if (s.includes('..') || s.includes('//') || s.includes('@{') || s.endsWith('.lock') || s.endsWith('/') || s.endsWith('.')) {
    throw new SourceError(`Invalid ref: ${s}`, 'invalid_ref');
  }
  return s;
}

function extOf(p) {
  return path.posix.extname(p).toLowerCase();
}

function allowedPath(p, limits) {
  const withSlash = `/${p}`;
  if (limits.ignoredPathParts.some((part) => withSlash.includes(part))) return false;
  return limits.allowedExtensions.includes(extOf(p));
}

export class GitHubSource {
  constructor({ owner, repo, ref = null, token = null, limits = {}, apiBase = 'https://api.github.com', rawBase = 'https://raw.githubusercontent.com', fetchImpl = globalThis.fetch }) {
    this.kind = 'github';
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.token = token || null;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.apiBase = apiBase;
    this.rawBase = rawBase;
    this.fetch = fetchImpl;
    this.commit = null;
    this.refType = null;
    this.defaultBranch = null;
    this.bytesDownloaded = 0;
    this.filesDownloaded = 0;
    this.treeTruncated = false;
  }

  get url() {
    return `https://github.com/${this.owner}/${this.repo}`;
  }

  headers(accept = 'application/vnd.github+json') {
    const h = { Accept: accept, 'User-Agent': 'QEDRank-benchmark', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async api(pathname) {
    const res = await this.fetch(`${this.apiBase}${pathname}`, { headers: this.headers() });
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const body = await res.text().catch(() => '');
      const code = res.status === 404 ? 'not_found' : res.status === 403 && remaining === '0' ? 'rate_limited' : 'api_error';
      throw new SourceError(`GitHub API ${res.status} for ${pathname}: ${body.slice(0, 200)}`, code, { httpStatus: res.status });
    }
    return res.json();
  }

  /** Resolve the requested ref to an immutable commit SHA. */
  async resolve() {
    if (this.commit) return this.descriptor();
    let ref = this.ref;
    if (!ref) {
      const repoInfo = await this.api(`/repos/${this.owner}/${this.repo}`);
      this.defaultBranch = repoInfo.default_branch;
      ref = this.defaultBranch;
      this.refType = 'default_branch';
    }
    const commit = await this.api(`/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}`);
    if (!commit || !/^[0-9a-f]{40}$/.test(commit.sha || '')) throw new SourceError('Could not resolve ref to a commit', 'resolve_failed');
    this.commit = commit.sha;
    this.resolvedRef = ref;
    if (!this.refType) {
      if (/^[0-9a-f]{7,40}$/i.test(ref) && this.commit.startsWith(ref.toLowerCase())) this.refType = 'commit';
      else {
        try {
          await this.api(`/repos/${this.owner}/${this.repo}/git/ref/tags/${encodeURIComponent(ref)}`);
          this.refType = 'tag';
        } catch {
          this.refType = 'branch';
        }
      }
    }
    this.commitDate = commit.commit?.committer?.date || null;
    return this.descriptor();
  }

  descriptor() {
    return {
      kind: 'github',
      url: this.url,
      owner: this.owner,
      repo: this.repo,
      requested_ref: this.ref,
      resolved_ref: this.resolvedRef || this.ref,
      ref_type: this.refType,
      commit: this.commit,
      commit_date: this.commitDate || null,
      default_branch: this.defaultBranch,
    };
  }

  /** List blobs at the resolved commit, filtered by the download policy. */
  async listTree() {
    await this.resolve();
    const tree = await this.api(`/repos/${this.owner}/${this.repo}/git/trees/${this.commit}?recursive=1`);
    this.treeTruncated = Boolean(tree.truncated);
    const entries = (tree.tree || []).filter((e) => e.type === 'blob');
    if (entries.length > this.limits.maxFiles) {
      throw new SourceError(`Repository has ${entries.length} files, above the limit of ${this.limits.maxFiles}`, 'too_many_files');
    }
    return {
      truncated: this.treeTruncated,
      totalBlobs: entries.length,
      files: entries
        .filter((e) => allowedPath(e.path, this.limits))
        .map((e) => ({ path: e.path, size: e.size ?? null, sha: e.sha })),
    };
  }

  /** Fetch one file's bytes with size accounting. */
  async readFile(p, { maxBytes = this.limits.maxFileBytes } = {}) {
    await this.resolve();
    if (!allowedPath(p, this.limits)) throw new SourceError(`Path not allowed by download policy: ${p}`, 'path_not_allowed');
    const url = `${this.rawBase}/${this.owner}/${this.repo}/${this.commit}/${p.split('/').map(encodeURIComponent).join('/')}`;
    const res = await this.fetch(url, { headers: this.headers('*/*') });
    if (!res.ok) throw new SourceError(`Raw fetch ${res.status} for ${p}`, res.status === 404 ? 'not_found' : 'fetch_error', { httpStatus: res.status });
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new SourceError(`${p} is ${declared} bytes, above the per-file limit ${maxBytes}`, 'file_too_large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new SourceError(`${p} is ${buf.length} bytes, above the per-file limit ${maxBytes}`, 'file_too_large');
    this.bytesDownloaded += buf.length;
    this.filesDownloaded += 1;
    if (this.bytesDownloaded > this.limits.maxTotalBytes) throw new SourceError('Total download budget exceeded', 'download_budget_exceeded');
    return buf;
  }
}

export class LocalSource {
  constructor(dir, { limits = {} } = {}) {
    this.kind = 'local';
    this.dir = path.resolve(dir);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.commit = null;
    this.bytesDownloaded = 0;
    this.filesDownloaded = 0;
    this.treeTruncated = false;
  }

  get url() {
    return `file://${this.dir.replace(/\\/g, '/')}`;
  }

  async resolve() {
    if (this.commit) return this.descriptor();
    try {
      // Inside a git repository: identify the corpus by the tree hash of this directory at HEAD,
      // which changes only when the corpus content changes (not on unrelated commits).
      const { stdout: prefixOut } = await execFileP('git', ['-C', this.dir, 'rev-parse', '--show-prefix'], { timeout: 10000 });
      const prefix = prefixOut.trim().replace(/\/$/, '');
      const { stdout } = await execFileP('git', ['-C', this.dir, 'rev-parse', `HEAD:${prefix}`], { timeout: 10000 });
      const tree = stdout.trim();
      if (/^[0-9a-f]{40}$/.test(tree)) {
        this.commit = tree;
        this.refType = 'local_git_tree';
        const { stdout: head } = await execFileP('git', ['-C', this.dir, 'rev-parse', 'HEAD'], { timeout: 10000 });
        this.headCommit = head.trim();
        const { stdout: st } = await execFileP('git', ['-C', this.dir, 'status', '--porcelain', '--', '.'], { timeout: 10000 });
        this.dirty = st.trim().length > 0;
      }
    } catch {
      /* not a git repo, or directory not tracked */
    }
    if (!this.commit) {
      const { files } = await this.listTree();
      const listing = files.map((f) => `${f.path}:${f.size}`).sort().join('\n');
      this.commit = `local-${sha256(listing).slice(0, 16)}`;
      this.refType = 'local_directory_listing_hash';
    }
    return this.descriptor();
  }

  descriptor() {
    return { kind: 'local', url: this.url, requested_ref: null, resolved_ref: null, ref_type: this.refType, commit: this.commit, head_commit: this.headCommit ?? null, dirty: this.dirty ?? null };
  }

  async listTree() {
    const files = [];
    const walk = async (rel) => {
      const abs = path.join(this.dir, rel);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (['.git', '.lake', 'node_modules'].includes(e.name)) continue;
          await walk(relPath);
        } else if (e.isFile()) {
          if (!allowedPath(relPath, this.limits)) continue;
          const st = await fs.stat(path.join(this.dir, relPath));
          files.push({ path: relPath, size: st.size, sha: null });
        }
      }
    };
    await walk('');
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (files.length > this.limits.maxFiles) throw new SourceError('Too many files', 'too_many_files');
    return { truncated: false, totalBlobs: files.length, files };
  }

  async readFile(p, { maxBytes = this.limits.maxFileBytes } = {}) {
    const abs = path.join(this.dir, p);
    if (!abs.startsWith(this.dir)) throw new SourceError('Path escapes source directory', 'path_not_allowed');
    const st = await fs.stat(abs);
    if (st.size > maxBytes) throw new SourceError(`${p} is ${st.size} bytes, above the per-file limit ${maxBytes}`, 'file_too_large');
    const buf = await fs.readFile(abs);
    this.bytesDownloaded += buf.length;
    this.filesDownloaded += 1;
    return buf;
  }
}

/** Parse an SSH GitHub URL: git@github.com:owner/repo(.git) or ssh://git@github.com/owner/repo(.git). */
export function parseGitSshUrl(input) {
  if (typeof input !== 'string') return null;
  const m = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) return null;
  const [, owner, repo] = m;
  if (!OWNER_RE.test(owner)) throw new SourceError(`Invalid GitHub owner: ${owner}`, 'invalid_url');
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') throw new SourceError(`Invalid GitHub repository name: ${repo}`, 'invalid_url');
  return { owner, repo };
}

/**
 * Private repositories over SSH (local runner only). The repository is shallow-cloned with the
 * user's own SSH keys/agent into a temporary directory and then read like a local directory.
 * Nothing in the clone is executed: git hooks of a cloned repository never run, and the runner
 * never invokes lake/scripts from the corpus. Not available in the serverless preview.
 */
export class GitSshSource {
  constructor({ owner, repo, ref = null, limits = {}, cloneDir = null }) {
    this.kind = 'github-ssh';
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.cloneDir = cloneDir;
    this.local = null;
    this.commit = null;
    this.refType = null;
    this.bytesDownloaded = 0;
    this.filesDownloaded = 0;
    this.treeTruncated = false;
  }

  get url() {
    return `git@github.com:${this.owner}/${this.repo}.git`;
  }

  async git(args, cwd) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
    const { stdout } = await execFileP('git', args, { cwd, env, timeout: 900000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  async resolve() {
    if (this.local) return this.descriptor();
    const os = await import('node:os');
    const dir = this.cloneDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'qedrank-src-')));
    await fs.mkdir(dir, { recursive: true });
    const ref = validateRef(this.ref);
    try {
      if (ref && /^[0-9a-f]{7,40}$/i.test(ref)) {
        await this.git(['init', '-q'], dir);
        await this.git(['remote', 'add', 'origin', '--', this.url], dir);
        await this.git(['fetch', '--depth', '1', '--no-tags', 'origin', '--', ref], dir);
        await this.git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir);
        this.refType = 'commit';
      } else {
        const args = ['clone', '-q', '--depth', '1', '--no-tags'];
        if (ref) args.push('--branch', ref);
        args.push('--', this.url, dir);
        await this.git(args, path.dirname(dir));
        this.refType = ref ? 'branch_or_tag' : 'default_branch';
      }
    } catch (err) {
      throw new SourceError(`SSH clone of ${this.url} failed (check your SSH key / deploy key): ${(err.stderr || err.message || '').toString().slice(0, 300)}`, 'ssh_clone_failed');
    }
    this.commit = (await this.git(['rev-parse', 'HEAD'], dir)).trim();
    this.resolvedRef = ref || (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
    this.local = new LocalSource(dir, { limits: this.limits });
    this.dir = dir;
    return this.descriptor();
  }

  descriptor() {
    return { kind: 'github-ssh', url: this.url, owner: this.owner, repo: this.repo, requested_ref: this.ref, resolved_ref: this.resolvedRef || this.ref, ref_type: this.refType, commit: this.commit, clone_dir: this.dir || null };
  }

  async listTree() {
    await this.resolve();
    return this.local.listTree();
  }

  async readFile(p, opts) {
    await this.resolve();
    const buf = await this.local.readFile(p, opts);
    this.bytesDownloaded += buf.length;
    this.filesDownloaded += 1;
    return buf;
  }
}

/**
 * Open a corpus source from a GitHub HTTPS URL (optionally with a token for private
 * repositories), a GitHub SSH URL (local runner only), or a local directory path.
 * @param {{url?:string, path?:string, ref?:string, token?:string, limits?:object, allowSsh?:boolean}} opts
 */
export async function openSource({ url, path: localPath, ref, token, limits, allowSsh = true } = {}) {
  if (localPath) {
    const src = new LocalSource(localPath, { limits });
    await src.resolve();
    return src;
  }
  const ssh = parseGitSshUrl(url);
  if (ssh) {
    if (!allowSsh) throw new SourceError('SSH URLs are only supported by the local runner; use an https://github.com URL with a token here', 'ssh_not_allowed');
    const src = new GitSshSource({ owner: ssh.owner, repo: ssh.repo, ref: validateRef(ref), limits });
    await src.resolve();
    return src;
  }
  const parsed = parseGitHubUrl(url);
  const chosenRef = validateRef(ref) || parsed.refFromUrl || null;
  const src = new GitHubSource({ owner: parsed.owner, repo: parsed.repo, ref: chosenRef, token: token ?? process.env.GITHUB_TOKEN ?? null, limits });
  await src.resolve();
  return src;
}
