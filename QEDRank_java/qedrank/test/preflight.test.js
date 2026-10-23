import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { checkChallengeImports, leanPathDirs, moduleAvailable, prefixPresent } from '../lib/preflight.js';

async function fakeLib(root, modules) {
  for (const m of modules) {
    const file = path.join(root, ...m.split('.')) + '.olean';
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
  }
  return root;
}

const challenge = (paper_id, imports) => ({ paper_id, kind: 'main_theorem', src: `/- Paper: ${paper_id} -/\n${imports.map((i) => `import ${i}`).join('\n')}\n\nopen Nat\n\ntheorem t : True := by sorry\n` });

test('import check: every challenge import resolves to an .olean on LEAN_PATH', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-preflight-'));
  const mathlib = await fakeLib(path.join(tmp, 'mathlib', '.lake', 'build', 'lib', 'lean'), ['Mathlib', 'Mathlib.Tactic', 'Mathlib.Combinatorics.SimpleGraph.Basic']);
  const project = await fakeLib(path.join(tmp, 'proofbench', '.lake', 'build', 'lib', 'lean'), ['ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Minor', 'ProofBench.Mathlib_Problems.Algebra.Group']);
  const toolchain = { lean_dir: path.join(tmp, 'proofbench'), lean_path: [project, mathlib].join(path.delimiter) };
  assert.deepEqual(leanPathDirs(toolchain), [project, mathlib]);
  assert.equal(await moduleAvailable('Mathlib.Tactic', [project, mathlib]), mathlib);
  assert.equal(await moduleAvailable('Mathlib.Nope', [project, mathlib]), null);
  assert.equal(await prefixPresent('ProofBench', [project, mathlib]), true);
  assert.equal(await prefixPresent('QEDRank', [project, mathlib]), false);

  const ok = await checkChallengeImports({
    challenges: [challenge('P001', ['ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Minor', 'Mathlib.Tactic']), challenge('P002', ['Mathlib', 'ProofBench.Mathlib_Problems.Algebra.Group'])],
    toolchain,
  });
  assert.equal(ok.fatal, false);
  assert.equal(ok.modules, 4);
  assert.equal(ok.available, 4);
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.message, null);
  assert.equal(ok.challenge_papers, 2);
});

test('import check: a module missing while its prefix exists is not fatal (project behind the corpus); an absent prefix is fatal (wrong project)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-preflight-'));
  const mathlib = await fakeLib(path.join(tmp, 'mathlib'), ['Mathlib', 'Mathlib.Tactic']);
  const project = await fakeLib(path.join(tmp, 'proofbench'), ['ProofBench.Mathlib_Problems.Algebra.Group']);
  const challenges = [
    challenge('P001', ['ProofBench.Mathlib_Problems.Algebra.Group']),
    challenge('P116', ['ProofBench.Mathlib_Problems.New.Added_Later', 'Mathlib.Tactic']),
  ];
  // Behind the corpus: one module missing, prefix present -> warn, not fatal.
  const behind = await checkChallengeImports({ challenges, toolchain: { lean_dir: project, lean_path: [project, mathlib].join(path.delimiter) } });
  assert.equal(behind.fatal, false);
  assert.deepEqual(behind.missing, [{ module: 'ProofBench.Mathlib_Problems.New.Added_Later', papers: ['P116'] }]);
  assert.deepEqual(behind.missing_prefixes, []);

  // Wrong project (the audit project: Mathlib only): the whole ProofBench prefix is absent -> fatal with a clear message.
  const audit = path.join(tmp, 'audit');
  await fakeLib(audit, ['QEDRank.Audit']);
  const wrong = await checkChallengeImports({ challenges, toolchain: { lean_dir: audit, lean_path: [audit, mathlib].join(path.delimiter) } });
  assert.equal(wrong.fatal, true);
  assert.equal(wrong.missing.length, 2);
  assert.equal(wrong.missing_prefixes.length, 1);
  assert.equal(wrong.missing_prefixes[0].prefix, 'ProofBench');
  assert.deepEqual(wrong.missing_prefixes[0].papers, ['P001', 'P116']);
  assert.match(wrong.message, /no module prefix 'ProofBench' at all/);
  assert.match(wrong.message, /2 of 2 challenge files import it/);
  assert.match(wrong.message, /stops before any model call/);
  assert.ok(wrong.message.includes(audit));

  // extraLeanPath is searched first, like the grader's --extra-lean-path.
  const extra = await fakeLib(path.join(tmp, 'extra'), ['ProofBench.Mathlib_Problems.New.Added_Later']);
  const fixed = await checkChallengeImports({ challenges, toolchain: { lean_dir: project, lean_path: [project, mathlib].join(path.delimiter) }, extraLeanPath: [extra] });
  assert.equal(fixed.missing.length, 0);
});

test('import check: no challenges, no LEAN_PATH, or Mathlib-only challenges never throw', async () => {
  const none = await checkChallengeImports({ challenges: [], toolchain: { lean_dir: 'x', lean_path: null } });
  assert.deepEqual([none.modules, none.fatal, none.message], [0, false, null]);
  const nopath = await checkChallengeImports({ challenges: [challenge('P001', ['Mathlib'])], toolchain: { lean_dir: 'x', lean_path: '' } });
  assert.equal(nopath.fatal, true, 'an empty LEAN_PATH cannot resolve anything: fatal, with the message naming the project');
  assert.match(nopath.message, /no module prefix 'Mathlib'/);
});
