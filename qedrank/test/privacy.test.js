import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { hostOf, hostAllowed, privacyPolicy, checkPrivateCorpus, assertPrivateCorpus, LOOPBACK_HOSTS } from '../lib/privacy.js';
import { loadConfig } from '../lib/config.js';

const env = (extra = {}) => ({ GWDG_API_KEY: 'k', MOONSHOT_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', ...extra });

test('hostOf: host name without port, null when unparsable', () => {
  assert.equal(hostOf('http://127.0.0.1:8080/v1'), '127.0.0.1');
  assert.equal(hostOf('https://Chat-AI.AcademicCloud.de/v1'), 'chat-ai.academiccloud.de');
  assert.equal(hostOf('http://[::1]:8000/v1'), '::1');
  assert.equal(hostOf(null), null);
  assert.equal(hostOf('not a url'), null);
});

test('hostAllowed: loopback always, exact names, leading-dot suffixes, nothing else', () => {
  for (const h of LOOPBACK_HOSTS) assert.equal(hostAllowed(h, []), true, h);
  assert.equal(hostAllowed('127.0.0.5', []), true);
  assert.equal(hostAllowed('dgx-2', ['dgx-2']), true);
  assert.equal(hostAllowed('DGX-2', ['dgx-2']), true);
  assert.equal(hostAllowed('lgnode001.tu-freiberg.de', ['.tu-freiberg.de']), true);
  assert.equal(hostAllowed('tu-freiberg.de', ['.tu-freiberg.de']), true);
  assert.equal(hostAllowed('evil-tu-freiberg.de', ['.tu-freiberg.de']), false);
  assert.equal(hostAllowed('api.moonshot.ai', ['dgx-2']), false);
  assert.equal(hostAllowed(null, ['dgx-2']), false);
  assert.equal(hostAllowed('', []), false);
});

test('policy: off by default; allowed hosts always include loopback', async () => {
  const cfg = await loadConfig({ cwd: os.tmpdir() });
  const p = privacyPolicy(cfg);
  assert.equal(p.private_corpus, false);
  for (const h of LOOPBACK_HOSTS) assert.ok(p.allowed_hosts.includes(h));
  const on = privacyPolicy({ privacy: { privateCorpus: true, allowedHosts: ['DGX-2', ' .tu-freiberg.de '] } });
  assert.deepEqual(on.allowed_hosts, [...LOOPBACK_HOSTS, 'dgx-2', '.tu-freiberg.de']);
});

test('check: hosted vendor endpoints are refused for a private corpus, local endpoints pass', () => {
  const config = { privacy: { privateCorpus: true, allowedHosts: ['dgx-2'] } };
  const e = env({ QEDRANK_BASEURL_QWEN: 'http://127.0.0.1:8080/v1', QEDRANK_BASEURL_LLAMA: 'http://dgx-2:8081/v1' });
  const c = checkPrivateCorpus({ config, slots: ['qwen', 'llama', 'kimi', 'fable'], env: e });
  assert.equal(c.enforced, true);
  const by = Object.fromEntries(c.slots.map((r) => [r.slot, r]));
  assert.equal(by.qwen.allowed, true); assert.equal(by.qwen.host, '127.0.0.1');
  assert.equal(by.llama.allowed, true); assert.equal(by.llama.host, 'dgx-2');
  assert.equal(by.kimi.allowed, false); assert.match(by.kimi.host, /moonshot/);
  assert.equal(by.fable.allowed, false); assert.match(by.fable.host, /anthropic/);
  assert.deepEqual(c.refused, ['kimi', 'fable']);
  assert.ok(!JSON.stringify(c).includes('"k"'), 'the check never carries a key value');
});

test('check: policy off or fixture mode refuses nothing; the vendor default host is still reported', () => {
  const off = checkPrivateCorpus({ config: { privacy: { privateCorpus: false } }, slots: ['kimi'], env: env() });
  assert.equal(off.enforced, false); assert.deepEqual(off.refused, []); assert.match(off.slots[0].host, /moonshot/);
  const fx = checkPrivateCorpus({ config: { privacy: { privateCorpus: true } }, slots: ['kimi'], env: env(), mode: 'fixture' });
  assert.equal(fx.enforced, false); assert.deepEqual(fx.refused, []); assert.equal(fx.fixture, true);
});

test('assert: throws before any request, naming the slot, its host and how to proceed', () => {
  const config = { privacy: { privateCorpus: true } };
  assert.throws(() => assertPrivateCorpus({ config, slots: ['qwen'], env: env() }), (err) => {
    assert.match(err.message, /private corpus: refusing/);
    assert.match(err.message, /qwen \(chat-ai\.academiccloud\.de\)/);
    assert.match(err.message, /Allowed hosts: localhost, 127\.0\.0\.1, ::1/);
    assert.match(err.message, /allowedHosts|--allow-host/);
    return true;
  });
  const ok = assertPrivateCorpus({ config, slots: ['qwen'], env: env({ QEDRANK_BASEURL_QWEN: 'http://localhost:8080/v1' }) });
  assert.equal(ok.enforced, true); assert.deepEqual(ok.refused, []);
});
