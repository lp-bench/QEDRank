import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProvePrompt, parseProveResponse, PROVE_TEMPLATE_VERSION } from '../lib/prove.js';

const CHALLENGE = 'import Mathlib\n\ndef weight (n : Nat) : Nat := n + n\n\ntheorem P900 (n : Nat) : weight n = 2 * n := by\n  sorry\n';

test('prove prompt carries the challenge file, the target and the rules, and is the same for every model', () => {
  const p = renderProvePrompt({ paper_id: 'P900', target: 'P900', challenge: CHALLENGE, lean_toolchain: 'leanprover/lean4:v4.34.1', mathlib_version: 'abc' });
  assert.ok(p.text.includes(CHALLENGE.trim()));
  assert.ok(p.text.includes('Main theorem: P900'));
  assert.ok(p.text.includes('leanprover/lean4:v4.34.1'));
  assert.match(p.text, /No `sorry` or `admit` anywhere/);
  assert.equal(p.templateVersion, PROVE_TEMPLATE_VERSION);
  assert.equal(p.hash, renderProvePrompt({ paper_id: 'P900', target: 'P900', challenge: CHALLENGE, lean_toolchain: 'leanprover/lean4:v4.34.1', mathlib_version: 'abc' }).hash);
  assert.throws(() => renderProvePrompt({ paper_id: 'P900' }), /missing target/);
});

test('prove response: the largest lean block is the file; prose alone is an abstention', () => {
  const r = parseProveResponse('Here it is:\n```lean\nimport Mathlib\ntheorem P900 : True := trivial\n```\nand a snippet\n```lean\nexact rfl\n```');
  assert.equal(r.file, 'import Mathlib\ntheorem P900 : True := trivial');
  assert.deepEqual(r.notes, ['multiple_blocks_largest_used']);
  assert.equal(r.abstained, false);
  const bare = parseProveResponse('import Mathlib\n\ntheorem P900 : True := trivial\n');
  assert.equal(bare.file.startsWith('import Mathlib'), true);
  assert.deepEqual(bare.notes, ['unfenced_file']);
  const none = parseProveResponse('I cannot complete this proof: the bound needs a lemma that is not in Mathlib.');
  assert.equal(none.file, null);
  assert.equal(none.abstained, true);
  assert.equal(parseProveResponse('').abstained, true);
  // a fenced block in another language is not a Lean file
  assert.equal(parseProveResponse('```python\nprint(1)\n```').abstained, true);
});
