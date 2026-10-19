import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchmarkUrl, detectFields, normalizeLevel, rowsToProblems, leanFileProblems, customSource } from '../lib/compare/custom.js';
import { buildComparisonFor } from '../lib/compare/build.js';
import { measureFile } from '../lib/compare/measure.js';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('URLs: GitHub repos, branches, folders and files; HuggingFace datasets; raw files; local folders', () => {
  assert.deepEqual(parseBenchmarkUrl('https://github.com/MoonshotAI/CombiBench'), { kind: 'git', url: 'https://github.com/MoonshotAI/CombiBench.git', web: 'https://github.com/MoonshotAI/CombiBench', ref: null, folder: null, owner: 'MoonshotAI', repo: 'CombiBench' });
  const t = parseBenchmarkUrl('https://github.com/o/r/tree/main/lean/Problems');
  assert.equal(t.ref, 'main');
  assert.equal(t.folder, 'lean/Problems');
  // An explicit branch with a slash wins over the guess from the link.
  const s = parseBenchmarkUrl('https://github.com/o/r/tree/feat/x/lean', { ref: 'feat/x' });
  assert.equal(s.ref, 'feat/x');
  assert.equal(s.folder, 'lean');
  assert.deepEqual(parseBenchmarkUrl('https://github.com/o/r/blob/main/data/x.jsonl'), { kind: 'file', url: 'https://raw.githubusercontent.com/o/r/main/data/x.jsonl', name: 'x.jsonl', github: true });
  assert.deepEqual(parseBenchmarkUrl('https://huggingface.co/datasets/PAug/ProofNetSharp'), { kind: 'hf', dataset: 'PAug/ProofNetSharp' });
  assert.equal(parseBenchmarkUrl('https://example.org/bench/problems.json').kind, 'file');
  assert.equal(parseBenchmarkUrl('C:\\data\\bench').kind, 'local');
  assert.throws(() => parseBenchmarkUrl('http://github.com/o/r'), /https/);
  assert.throws(() => parseBenchmarkUrl('https://example.org/page'), /GitHub repository/);
});

test('row datasets: statement, header, id, subject and level fields are detected', () => {
  const rows = [
    { name: 'a1', header: 'import Mathlib\n', formal_statement: 'theorem a1 (x : ℕ) : x + 0 = x := by', split: 'test', domain: 'Mathematics -> Number Theory -> Primes', difficulty: 'Olympiad' },
    { name: 'a2', header: 'import Mathlib\n', formal_statement: 'theorem a2 : (2 : ℕ) + 2 = 4 := by', split: 'valid', domain: 'Mathematics -> Algebra', difficulty: 'Undergraduate' },
  ];
  const f = detectFields(rows);
  assert.deepEqual(f, { statement: 'formal_statement', header: 'header', id: 'name', subject: 'domain', level: 'difficulty', split: 'split' });
  const problems = rowsToProblems(rows, f);
  assert.equal(problems[0].subject, 'Number Theory');
  assert.equal(problems[0].level, 'competition');
  assert.equal(problems[1].level, 'undergraduate');
  assert.match(problems[0].text, /^import Mathlib\ntheorem a1[\s\S]*:= by sorry\n$/);
  const [m] = measureFile(problems[0].text);
  assert.equal(m.ok, true);
  assert.equal(m.target, 'a1');
  assert.throws(() => rowsToProblems([{ question: 'no Lean here' }], detectFields([{ question: 'no Lean here' }])), /no field with Lean theorem statements/);
});

test('levels: free-text labels map to the shared scale, or to nothing', () => {
  assert.equal(normalizeLevel('Graduate-Level\u200b'), 'graduate');
  assert.equal(normalizeLevel('Undergraduate-Level'), 'undergraduate');
  assert.equal(normalizeLevel('IMO'), 'competition');
  assert.equal(normalizeLevel('open problem'), 'open');
  assert.equal(normalizeLevel('middle school'), 'coursework');
  assert.equal(normalizeLevel('hard'), null);
});

test('Lean folders: each theorem left as sorry is a problem; library imports resolve by module suffix', async () => {
  const text = 'import Mathlib\n\ntheorem helper : True := trivial\n\ntheorem p1 : 1 = 1 := by sorry\n\nlemma p2 : 2 = 2 := sorry\n';
  assert.deepEqual(leanFileProblems('Bench/X.lean', text).map((p) => p.target), ['p1', 'p2']);
  // corpus-b: P001 imports nothing from the library, but the folder resolves `Bench.Library.*`.
  const src = customSource({ url: path.join(HERE, 'fixtures', 'corpus-b'), folder: 'Bench/PROBLEMS' });
  const got = await src.problems({ cacheDir: os.tmpdir() });
  assert.ok(got.problems.length > 0);
  assert.match(got.source.target_rule, /one problem per file|left as sorry/);
  assert.equal(await got.readModule('Library.Graphs.Hypercube') !== null, true, 'module found by path suffix');
  assert.equal(await got.readModule('Nope.Missing'), null);
});

test('your benchmark against a catalogued, a not-public and a URL benchmark', async () => {
  const d = await buildComparisonFor({
    base: { name: 'Fixture A', path: path.join(HERE, 'fixtures', 'corpus-a') },
    selections: [{ id: 'amber' }, { name: 'Corpus B', url: path.join(HERE, 'fixtures', 'corpus-b'), folder: 'Bench/PROBLEMS' }, { name: 'Bad', url: 'ftp://x' }],
    cacheDir: path.join(os.tmpdir(), 'qr-cmp-cache'),
  });
  assert.deepEqual(d.benchmarks.map((b) => b.id), ['proofbench', 'amber', 'custom-1', 'custom-2']);
  assert.equal(d.benchmarks[0].name, 'Fixture A');
  assert.equal(d.benchmarks[0].facts.statements, 'local folder', 'catalogued ProofBench facts are not attached to another benchmark');
  assert.equal(d.benchmarks[0].cite_key, null);
  assert.match(d.benchmarks[1].measured.reason, /add a URL/);
  assert.equal(d.benchmarks[1].facts.best.rate, 0.06, 'published facts stay attached');
  assert.equal(d.benchmarks[2].measured.available, true);
  assert.equal(d.benchmarks[2].facts.problems, d.benchmarks[2].measured.problems);
  assert.match(d.benchmarks[3].measured.reason, /https/);
  assert.equal(d.benchmarks[0].measured.statements.closure_histogram.length, 7);
});
