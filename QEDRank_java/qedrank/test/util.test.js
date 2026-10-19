import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { writeJson, readJson } from '../lib/util.js';

test('concurrent writeJson calls on one file all succeed and leave valid JSON, no tmp files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-util-'));
  const file = path.join(dir, 'progress.json');
  await Promise.all(Array.from({ length: 200 }, (_, i) => writeJson(file, { i, pad: 'x'.repeat(2000) })));
  const doc = await readJson(file);
  assert.equal(typeof doc.i, 'number');
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  await fs.rm(dir, { recursive: true, force: true });
});
