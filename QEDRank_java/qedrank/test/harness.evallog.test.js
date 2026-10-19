import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import { writeZip, openZip, listZipEntries, crc32 } from '../lib/harness/zip.js';
import { readEvalLog, readEvalLogs, normalizeSample } from '../lib/harness/evallog.js';
import { sampleFixture, logFixture } from './helpers/harnesslog.js';

test('zip: entries written stored or deflated read back; crc32 and zstd handling', () => {
  const buf = writeZip([{ name: 'a.json', data: '{"a":1}' }, { name: 'dir/b.json', data: Buffer.from('{"b":[1,2,3]}'), deflate: true }]);
  const entries = listZipEntries(buf);
  assert.deepEqual(entries.map((e) => [e.name, e.method]), [['a.json', 0], ['dir/b.json', 8]]);
  const z = openZip(buf);
  assert.equal(z.text('a.json'), '{"a":1}');
  assert.deepEqual(JSON.parse(z.text('dir/b.json')), { b: [1, 2, 3] });
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => z.read('nope'), /no entry/);
  if (typeof zlib.zstdCompressSync === 'function') {
    // method 93 as Inspect writes it: build one entry by hand around a zstd frame
    const raw = Buffer.from('{"z":true}');
    const body = zlib.zstdCompressSync(raw);
    const name = Buffer.from('z.json');
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(93, 8); loc.writeUInt32LE(crc32(raw), 14); loc.writeUInt32LE(body.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(93, 10); cen.writeUInt32LE(crc32(raw), 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
    const cdOff = loc.length + name.length + body.length;
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cen.length + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
    const zbuf = Buffer.concat([loc, name, body, cen, name, eocd]);
    assert.deepEqual(JSON.parse(openZip(zbuf).text('z.json')), { z: true });
  }
});

test('eval logs: .eval (zip) and .json read to one shape; in-progress logs use the journal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-evallog-'));
  const log = logFixture({ samples: [sampleFixture('P001', { value: 'C', ok: true }), sampleFixture('P002'), sampleFixture('P003', { value: 'N', error: null, sessions: [{ session: 1, ended_by: 'provider_error: RateLimitError: 429', error_kind: 'provider', counted: false, output_tokens: 0, passed: false, errors: [] }] })] });
  const { samples, ...header } = log;
  const evalBuf = writeZip([{ name: 'header.json', data: JSON.stringify(header), deflate: true }, ...samples.map((s) => ({ name: `samples/${s.id}_epoch_${s.epoch}.json`, data: JSON.stringify(s), deflate: true })), { name: 'summaries.json', data: '[]' }]);
  await fs.writeFile(path.join(dir, 'a.eval'), evalBuf);
  await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify(log));
  await fs.writeFile(path.join(dir, 'manifest.json'), '{"harness_commit":"x"}');
  const started = writeZip([{ name: '_journal/start.json', data: JSON.stringify({ version: 2, eval: header.eval, plan: header.plan }) }, { name: 'samples/P001_epoch_1.json', data: JSON.stringify(samples[0]) }]);
  await fs.writeFile(path.join(dir, 'c.eval'), started);
  const a = await readEvalLog(path.join(dir, 'a.eval'));
  const b = await readEvalLog(path.join(dir, 'b.json'));
  assert.equal(a.format, 'eval'); assert.equal(b.format, 'json');
  assert.equal(a.status, 'success'); assert.equal(a.eval.model, 'openai-api/qwen/qwen3-30b');
  assert.deepEqual(a.samples.map((s) => s.id), ['P001', 'P002', 'P003']);
  assert.deepEqual(a.samples.map((s) => s.scores.lean_check.value), b.samples.map((s) => s.scores.lean_check.value));
  const s1 = a.samples[0];
  assert.equal(s1.usage.input_tokens, 1200); assert.equal(s1.events.tool_calls, 3); assert.equal(s1.events.tool_errors, 1); assert.equal(s1.events.model_calls, 1); assert.deepEqual(s1.events.tool_calls_by_tool, { bash: 2, submit: 1 });
  assert.equal(s1.total_time_s, 95.5); assert.equal(s1.scores.lean_check.metadata.ok, true);
  const c = await readEvalLog(path.join(dir, 'c.eval'));
  assert.equal(c.status, 'started'); assert.equal(c.samples.length, 1); assert.equal(c.eval.model, 'openai-api/qwen/qwen3-30b');
  const all = await readEvalLogs(dir);
  assert.deepEqual(all.map((l) => path.basename(l.file)), ['a.eval', 'b.json', 'c.eval'], 'manifest.json is not a log');
  assert.equal(normalizeSample({ id: 7, epoch: 2 }).id, '7');
  await fs.rm(dir, { recursive: true, force: true });
});
