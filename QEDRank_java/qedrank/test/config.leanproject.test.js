import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../lib/config.js';

test('the prove task defaults its Lean project to the built ProofBench checkout named in the machine config', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-cfg-'));
  const built = path.join(cwd, 'proofbench-statements');
  await fs.mkdir(built);
  await fs.writeFile(path.join(cwd, 'qedrank.config.json'), JSON.stringify({ harnesses: { proofbench: { leanProject: built } } }));

  const prove = await loadConfig({ cwd, overrides: { task: 'prove' } });
  assert.equal(prove.leanDir, path.resolve(built));
  assert.equal(prove.leanDirDefault, 'harnesses.proofbench.leanProject');

  // formalize keeps the audit project lean/; an explicit --lean-project or a leanDir in the file always wins.
  const formalize = await loadConfig({ cwd });
  assert.equal(formalize.leanDir, path.resolve(cwd, 'lean'));
  assert.equal(formalize.leanDirDefault, undefined);
  const explicit = await loadConfig({ cwd, overrides: { task: 'prove', leanDir: path.join(cwd, 'other') } });
  assert.equal(explicit.leanDir, path.resolve(cwd, 'other'));
  assert.equal(explicit.leanDirDefault, undefined);
  await fs.writeFile(path.join(cwd, 'qedrank.config.json'), JSON.stringify({ leanDir: 'mine', harnesses: { proofbench: { leanProject: built } } }));
  const fromFile = await loadConfig({ cwd, overrides: { task: 'prove' } });
  assert.equal(fromFile.leanDir, path.resolve(cwd, 'mine'));

  // A configured project that does not exist on this machine is not used.
  await fs.writeFile(path.join(cwd, 'qedrank.config.json'), JSON.stringify({ harnesses: { proofbench: { leanProject: path.join(cwd, 'missing') } } }));
  const absent = await loadConfig({ cwd, overrides: { task: 'prove' } });
  assert.equal(absent.leanDir, path.resolve(cwd, 'lean'));

  // The pre-flight import check is on by default and can be downgraded to a warning.
  assert.deepEqual(absent.preflight, { importCheck: true, allowMissingImports: false });
});
