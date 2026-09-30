import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt, parseModelOutput, PROMPT_TEMPLATE } from '../lib/prompt.js';

const VARS = { paper_id: 'p1', target_kind: 'main_theorem', citation: 'A. Author (2026)', reviewed_paper_context: 'ctx', allowed_prelude: '-- none' };

test('renderPrompt fills every placeholder and hashes deterministically', () => {
  const a = renderPrompt(VARS);
  const b = renderPrompt(VARS);
  assert.equal(a.hash, b.hash);
  assert.doesNotMatch(a.text, /\{paper_id\}|\{target_kind\}|\{citation\}|\{reviewed_paper_context\}|\{allowed_prelude\}/);
  assert.ok(a.text.includes('Do not access or request benchmark ground-truth Lean files.'));
  assert.ok(a.text.includes('=== PART A ==='));
  assert.throws(() => renderPrompt({ ...VARS, citation: undefined }));
});

test('template never mentions the repository or ground-truth paths', () => {
  assert.doesNotMatch(PROMPT_TEMPLATE, /github\.com|lean_path|ground_truth_lean/);
});

test('parseModelOutput reads four delimited parts and confidences', () => {
  const p = parseModelOutput('intro\n=== PART A ===\n```lean\ntheorem foo : 1 = 1\n```\n=== PART B ===\n```lean\nimport Mathlib\ntheorem foo : 1 = 1 := rfl\n```\n=== PART C ===\nmap\n=== PART D ===\nstatement_confidence: 90\nproof_confidence: 75\n');
  assert.equal(p.statement, 'theorem foo : 1 = 1');
  assert.match(p.proofFile, /:= rfl/);
  assert.equal(p.mapping, 'map');
  assert.equal(p.statementConfidence, 90);
  assert.equal(p.proofConfidence, 75);
  assert.equal(p.abstained, false);
  assert.equal(p.partsFound, 4);
});

test('parseModelOutput records abstention when no proof file is returned', () => {
  const p = parseModelOutput('=== PART A ===\n```lean\ntheorem t : False\n```\n=== PART B ===\nI cannot complete the proof.\n=== PART C ===\nx\n=== PART D ===\nstatement_confidence: 40\nproof_confidence: 5');
  assert.equal(p.proofFile, null);
  assert.equal(p.abstained, true);
  assert.equal(p.statementConfidence, 40);
});

test('parseModelOutput falls back without markers and notes it', () => {
  const p = parseModelOutput('```lean\ntheorem t : 1 = 1 := rfl\n```');
  assert.ok(p.parseNotes.includes('part_markers_missing'));
  assert.match(p.proofFile, /theorem t/);
  assert.equal(p.statementConfidence, null);
  const empty = parseModelOutput('');
  assert.equal(empty.abstained, true);
  assert.ok(empty.parseNotes.includes('empty_response'));
});
