import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOnce, providerHalt, resetProviderHalts, RATE_LIMIT_HALT_AFTER } from '../lib/models.js';

const reply = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });
const ask = () => generateOnce({ provider: 'kimi', prompt: 'P', maxTokens: 10, timeoutMs: 1000, retries: 0, env: { MOONSHOT_API_KEY: 'k' } });

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  resetProviderHalts();
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
    resetProviderHalts();
  }
}

test('an exhausted balance halts the provider: later requests are not sent', async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; return reply(429, 'Your account is suspended due to insufficient balance'); }, async () => {
    assert.equal((await ask()).error.kind, 'insufficient_quota');
    assert.equal(providerHalt('kimi').kind, 'insufficient_quota');
    const next = await ask();
    assert.equal(next.error.kind, 'halted');
    assert.equal(calls, 1);
  });
});

test('rate limits halt the provider only after several requests in a row fail every retry', async () => {
  let calls = 0;
  let ok = false;
  await withFetch(async () => {
    calls += 1;
    if (ok) return new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return reply(429, 'request reached max organization concurrency: 1');
  }, async () => {
    for (let i = 1; i < RATE_LIMIT_HALT_AFTER; i += 1) assert.equal((await ask()).error.kind, 'rate_limited');
    assert.equal(providerHalt('kimi'), null);
    ok = true;
    assert.equal((await ask()).error, null); // a success resets the streak
    ok = false;
    for (let i = 1; i < RATE_LIMIT_HALT_AFTER; i += 1) await ask();
    assert.equal(providerHalt('kimi'), null);
    await ask();
    assert.equal(providerHalt('kimi').kind, 'rate_limited');
    const before = calls;
    assert.equal((await ask()).error.kind, 'halted');
    assert.equal(calls, before);
  });
});
