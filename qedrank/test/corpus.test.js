import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalSource } from '../lib/source.js';
import { discoverCorpus, classifyLeanFile } from '../lib/corpus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'corpus-a');

test('classifyLeanFile maps names to target kinds and flags ambiguity', () => {
  assert.equal(classifyLeanFile('main_theorem.lean').kind, 'main_theorem');
  assert.equal(classifyLeanFile('lean/UpperBound.lean').kind, 'upper_bound');
  assert.equal(classifyLeanFile('lb.lean').kind, 'lower_bound');
  assert.equal(classifyLeanFile('DISPROVE.lean').kind, 'disproof');
  assert.equal(classifyLeanFile('Defs.lean').shared, true);
  const amb = classifyLeanFile('upper_and_lower_bounds.lean');
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.kind, null);
  assert.equal(classifyLeanFile('Lemma3.lean').kind, null);
});

test('discoverCorpus builds a reviewed manifest from the fixture corpus', async () => {
  const src = new LocalSource(FIX);
  const m = await discoverCorpus(src, { expectedCount: 108 });
  assert.equal(m.counts.papers, 3);
  assert.equal(m.counts.expected_count_matches, false);
  const byId = Object.fromEntries(m.papers.map((p) => [p.paper_id, p]));
  const p1 = byId.p001_sum_bound;
  assert.equal(p1.title, 'A Bound on the Sum of the First n Naturals');
  assert.equal(p1.targets.main_theorem.declaration_name, 'main_theorem');
  assert.equal(p1.targets.main_theorem.mathematical_status, 'established');
  assert.deepEqual(p1.targets.main_theorem.local_imports, ['Defs']);
  assert.equal(p1.shared_definition_files.length, 1);
  assert.equal(p1.targets.lower_bound.reference_proof_status, 'contains_placeholder');
  assert.equal(p1.targets.disproof, null);
  assert.ok(p1.flags.some((f) => f.code === 'missing_pdf'));
  assert.deepEqual(p1.subject_tags, ['05A', '11B']);
  assert.equal(p1.requires_figures, false);
  const p2 = byId.p002_parity;
  assert.ok(p2.pdf);
  assert.equal(p2.targets.disproof.lean_path, 'papers/p002_parity/lean/Disprove.lean');
  assert.ok(p2.targets.disproof.mapping_flags.includes('disproof_polarity_unconfirmed'));
  assert.equal(p2.targets.disproof.mathematical_status, 'uncertain');
  assert.equal(p2.targets.main_theorem.mathematical_status, 'established');
  assert.equal(p2.targets.main_theorem.declaration_name, 'two_mul_even');
  const p3 = byId.p003_open;
  assert.equal(p3.targets.main_theorem.mathematical_status, 'open');
  assert.equal(p3.targets.main_theorem.reference_proof_status, 'contains_placeholder');
  assert.equal(p3.title, 'An Open Bound Conjecture');
  assert.equal(m.counts.targets.upper_bound, 2);
  assert.equal(m.source.kind, 'local');
});

test('discoverCorpus preview budget flags uninspected targets instead of guessing', async () => {
  const src = new LocalSource(FIX);
  const m = await discoverCorpus(src, { maxLeanReads: 1 });
  const flagged = m.papers.flatMap((p) => Object.values(p.targets).filter(Boolean)).filter((t) => t.mapping_flags.includes('not_inspected_preview_budget'));
  assert.ok(flagged.length >= 5);
});
