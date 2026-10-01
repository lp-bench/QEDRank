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

const FIXB = path.join(here, 'fixtures', 'corpus-b');

test('ProofBench-style layout: <Id>/<Id>.lean, _UB/_LB/_DISPROVE, two PDFs, central PDF, index file', async () => {
  const m = await discoverCorpus(new LocalSource(FIXB), { subdir: 'Bench/PROBLEMS' });
  assert.equal(m.counts.subdir, 'Bench/PROBLEMS');
  assert.equal(m.counts.papers, 3);
  assert.deepEqual(m.papers.map((p) => p.paper_id), ['P001', 'P014', 'P099']);
  const by = Object.fromEntries(m.papers.map((p) => [p.paper_id, p]));

  const p14 = by.P014;
  assert.equal(p14.targets.main_theorem.lean_path, 'Bench/PROBLEMS/P014/P014.lean');
  assert.equal(p14.targets.main_theorem.mapping_rule, 'file_name_equals_paper_id');
  assert.equal(p14.targets.main_theorem.declaration_name, 'P014');
  assert.equal(p14.targets.main_theorem.declaration_source, 'name_equals_file_name');
  assert.equal(p14.targets.upper_bound.lean_path, 'Bench/PROBLEMS/P014/P014_UB.lean');
  assert.ok(p14.targets.upper_bound.mapping_flags.includes('ambiguous_declaration'));
  assert.equal(p14.targets.lower_bound.declaration_name, 'P014_LB');
  assert.equal(p14.targets.disproof, null);
  assert.ok(p14.unclassified_lean_files.some((f) => f.path.endsWith('P014_sol.lean')));
  // two PDFs in one folder stay ONE paper; the paper PDF wins by title match, not by size
  assert.equal(p14.pdf_candidates.length, 2);
  assert.equal(p14.pdf.path, 'Bench/PROBLEMS/P014/Essentially tight bounds for rainbow cycles.pdf');
  assert.ok(p14.flags.some((f) => f.code === 'multiple_pdfs'));
  // index metadata: title, MSC code, difficulty; Research difficulty does not decide the status
  assert.equal(p14.title, 'Essentially tight bounds for rainbow cycles in proper edge-colourings');
  assert.match(p14.title_source, /^index:Bench\/DATABASE\/Database\.json$/);
  assert.deepEqual(p14.subject_tags, ['05C38']);
  assert.equal(p14.difficulty, 'Research');
  assert.equal(p14.targets.main_theorem.mathematical_status, 'uncertain');

  const p1 = by.P001;
  assert.equal(p1.pdf.path, 'Bench/DATABASE/content/pdf/P001.pdf');
  assert.equal(p1.pdf.origin, 'matched_by_file_name');
  assert.ok(p1.flags.some((f) => f.code === 'pdf_from_other_folder'));
  assert.equal(p1.targets.disproof.lean_path, 'Bench/PROBLEMS/P001/P001_DISPROVE.lean');
  assert.ok(p1.targets.disproof.mapping_flags.includes('disproof_polarity_unconfirmed'));
  assert.equal(p1.targets.main_theorem.mathematical_status, 'open');
  assert.ok(p1.targets.main_theorem.mapping_flags.includes('mathematical_status_from_index_needs_review'));
  assert.equal(p1.targets.upper_bound.mathematical_status, 'uncertain'); // index status applies to the main claim only
  assert.ok(p1.flags.some((f) => f.code === 'missing_target_file' && /lower_bound/.test(f.message)));
  assert.equal(p1.flags.filter((f) => f.code === 'missing_pdf').length, 0);

  const p99 = by.P099;
  assert.equal(p99.index_entry, null);
  assert.equal(p99.title, 'On the pre- and post-positional semi-random graph');
  assert.equal(p99.title_source, 'pdf_file_name');
  assert.ok(p99.targets.main_theorem.mapping_flags.includes('declaration_names_other_paper:P050'));
  assert.ok(!p14.targets.main_theorem.mapping_flags.some((x) => x.startsWith('declaration_names_other_paper')));

  assert.deepEqual(m.counts.index_entries_without_paper, ['050']);
  // formal statements/proofs from the index never reach the manifest
  assert.doesNotMatch(JSON.stringify(m), /SECRET_GROUND_TRUTH/);
});

test('without a sub-folder, library files and central PDF folders create no phantom papers', async () => {
  const m = await discoverCorpus(new LocalSource(FIXB));
  assert.deepEqual(m.papers.map((p) => p.paper_id), ['P001', 'P014', 'P099']);
  assert.equal(m.counts.orphan_lean_files, 1); // Library/Graphs/Hypercube.lean
});

test('discoverCorpus preview budget flags uninspected targets instead of guessing', async () => {
  const src = new LocalSource(FIX);
  const m = await discoverCorpus(src, { maxLeanReads: 1 });
  const flagged = m.papers.flatMap((p) => Object.values(p.targets).filter(Boolean)).filter((t) => t.mapping_flags.includes('not_inspected_preview_budget'));
  assert.ok(flagged.length >= 5);
});
