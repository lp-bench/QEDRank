import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubUrl, validateRef, GitHubSource, SourceError } from '../lib/source.js';

test('parseGitHubUrl accepts canonical forms and extracts tree refs', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo', refFromUrl: null });
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo', refFromUrl: null });
  assert.deepEqual(parseGitHubUrl('github.com/owner/repo/tree/v1.2'), { owner: 'owner', repo: 'repo', refFromUrl: 'v1.2' });
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo/tree/feature/x?tab=1'), { owner: 'owner', repo: 'repo', refFromUrl: 'feature/x' });
});

test('parseGitHubUrl rejects non-GitHub and malformed input', () => {
  for (const bad of ['https://gitlab.com/o/r', 'javascript:alert(1)', 'https://github.com/o', 'https://github.com/../x', '', 'file:///etc/passwd']) {
    assert.throws(() => parseGitHubUrl(bad), SourceError);
  }
});

test('validateRef enforces git ref hygiene', () => {
  assert.equal(validateRef(''), null);
  assert.equal(validateRef(undefined), null);
  assert.equal(validateRef('main'), 'main');
  assert.equal(validateRef('1f477d41ff046b42947643c93104ce9a5d62ce71'), '1f477d41ff046b42947643c93104ce9a5d62ce71');
  for (const bad of ['-x', 'a..b', 'a//b', 'x@{1}', 'r.lock', 'a/', 'a b', '$(rm)']) assert.throws(() => validateRef(bad), SourceError);
});

test('GitHubSource enforces download policy with a fake fetch', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/repos/o/r')) return json({ default_branch: 'main' });
    if (url.includes('/commits/main')) return json({ sha: 'a'.repeat(40), commit: { committer: { date: '2026-01-01T00:00:00Z' } } });
    if (url.includes('/git/ref/tags/')) return { ok: false, status: 404, text: async () => 'nf', headers: new Map() };
    if (url.includes('/git/trees/')) return json({ truncated: false, tree: [{ type: 'blob', path: 'papers/x/paper.pdf', size: 10 }, { type: 'blob', path: 'papers/x/main.lean', size: 5 }, { type: 'blob', path: 'evil.exe', size: 1 }, { type: 'blob', path: 'node_modules/a.lean', size: 1 }] });
    if (url.includes('raw.githubusercontent.com')) return { ok: true, status: 200, headers: new Map([['content-length', '5']]), arrayBuffer: async () => new TextEncoder().encode('hello').buffer };
    return { ok: false, status: 500, text: async () => 'boom', headers: new Map() };
  };
  const src = new GitHubSource({ owner: 'o', repo: 'r', fetchImpl, limits: { maxFileBytes: 4 } });
  const d = await src.resolve();
  assert.equal(d.commit, 'a'.repeat(40));
  assert.equal(d.ref_type, 'default_branch');
  const tree = await src.listTree();
  assert.deepEqual(tree.files.map((f) => f.path), ['papers/x/paper.pdf', 'papers/x/main.lean']);
  await assert.rejects(() => src.readFile('papers/x/main.lean'), /above the per-file limit/);
  await assert.rejects(() => src.readFile('evil.exe'), /not allowed/);
  assert.ok(!calls.some((u) => /Authorization/.test(u)));
});

function json(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() };
}
