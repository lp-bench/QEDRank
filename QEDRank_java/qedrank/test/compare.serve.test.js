import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../lib/serve.js';
import { validateCompareRequest, createCompareHandler } from '../lib/compare/serve.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://localhost:3000';

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

test('requests are validated: a base, one to seven selections, a URL for anything uncatalogued', () => {
  assert.throws(() => validateCompareRequest({ selections: [{ id: 'minif2f' }] }), /GitHub link/);
  assert.throws(() => validateCompareRequest({ base: { url: 'https://github.com/o/r' } }), /at least one/);
  assert.throws(() => validateCompareRequest({ base: { url: 'https://github.com/o/r' }, selections: Array(8).fill({ id: 'minif2f' }) }), /at most 7/);
  assert.throws(() => validateCompareRequest({ base: { url: 'https://github.com/o/r' }, selections: [{ name: 'x' }] }), /needs a URL/);
  const v = validateCompareRequest({ base: { url: ' https://github.com/o/r ', token: 't' }, selections: [{ id: 'minif2f', extra: 1 }] });
  assert.equal(v.base.url, 'https://github.com/o/r');
  assert.equal(v.base.name, 'ProofBench');
  assert.deepEqual(Object.keys(v.selections[0]).sort(), ['folder', 'id', 'name', 'ref', 'token', 'url']);
});

test('POST /compare answers only the app with its header; the response carries the comparison and LaTeX', async () => {
  const calls = [];
  const fake = async (body) => { calls.push(body); return { comparison: { schema: 'x' }, tex: '\\documentclass{article}' }; };
  await withServer({ runsDir: os.tmpdir(), compare: fake }, async (base) => {
    const body = JSON.stringify({ base: { url: 'https://github.com/o/r' }, selections: [{ id: 'minif2f' }] });
    const noHeader = await fetch(`${base}/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body });
    assert.equal(noHeader.status, 403);
    const evil = await fetch(`${base}/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-QEDRank-Client': 'web' }, body });
    assert.equal(evil.status, 403);
    const ok = await fetch(`${base}/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-QEDRank-Client': 'web' }, body });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.deepEqual(await ok.json(), { comparison: { schema: 'x' }, tex: '\\documentclass{article}' });
    const pre = await fetch(`${base}/compare`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /X-QEDRank-Client/);
  });
  assert.equal(calls.length, 1);
});

test('the real handler compares a local corpus with a local URL benchmark, one request at a time', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-cmp-runs-'));
  const handle = createCompareHandler({ runsDir });
  const body = { base: { name: 'Fixture A', path: path.join(HERE, 'fixtures', 'corpus-a') }, selections: [{ name: 'Corpus B', url: path.join(HERE, 'fixtures', 'corpus-b'), folder: 'Bench/PROBLEMS' }] };
  const [a, b] = await Promise.all([handle(body), handle(body)]);
  assert.equal(a.comparison.benchmarks.length, 2);
  assert.equal(a.comparison.benchmarks[1].measured.available, true);
  assert.match(a.tex, /\\begin\{document\}/);
  assert.deepEqual(b.comparison.benchmarks.map((x) => x.name), ['Fixture A', 'Corpus B']);
  await assert.rejects(handle({ base: {}, selections: [] }), /GitHub link/);
});
