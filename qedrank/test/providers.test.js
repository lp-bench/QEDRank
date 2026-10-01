import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, DEFAULT_ROSTER, getRoster, resolveModelId, resolveBaseUrl, isConfigured, describeProvider,
  callProvider, splitReasoning, SYSTEM_PROMPT, ProviderError,
} from '../../lib/providers.js';
import { leanFromAnswer, PING_PROMPT } from '../lib/ping.js';

const noSleep = async () => {};

function okResponse(body, headers = {}) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map(Object.entries(headers)) };
}
function errResponse(status, body = '{}', headers = {}) {
  return { ok: false, status, json: async () => JSON.parse(body), text: async () => body, headers: new Map(Object.entries(headers)) };
}
const completion = (content, extra = {}) => okResponse({ model: 'served-model', choices: [{ message: { content, ...extra.message }, finish_reason: extra.finish || 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22, completion_tokens_details: { reasoning_tokens: 7 } } });

test('the default roster has ten slots in table order; retired and legacy providers are outside it', () => {
  assert.equal(DEFAULT_ROSTER.length, 10);
  assert.deepEqual(DEFAULT_ROSTER, ['mistral', 'deepseek', 'openrouter', 'groq', 'siliconflow', 'custom', 'together', 'gemini', 'huggingface', 'nvidia']);
  assert.ok(!DEFAULT_ROSTER.includes('github'));
  assert.ok(PROVIDERS.find((p) => p.id === 'github').retired);
  assert.equal(new Set(PROVIDERS.map((p) => p.envKey)).size, PROVIDERS.length, 'every provider has its own key variable');
});

test('roster, model and base URL overrides come from the environment', () => {
  assert.deepEqual(getRoster({ QEDRANK_MODELS: 'groq, mistral' }), ['groq', 'mistral']);
  assert.throws(() => getRoster({ QEDRANK_MODELS: 'groq,nope' }), /unknown provider ids: nope/);
  assert.equal(resolveModelId('mistral', {}), 'labs-leanstral-2603');
  assert.equal(resolveModelId('mistral', { QEDRANK_MODEL_MISTRAL: 'leanstral-x' }), 'leanstral-x');
  assert.equal(resolveBaseUrl('gemini', {}), 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(resolveBaseUrl('groq', { QEDRANK_BASEURL_GROQ: 'http://localhost:9/v1/' }), 'http://localhost:9/v1');
  assert.equal(resolveModelId('custom', {}), null);
  assert.equal(isConfigured('custom', { QEDRANK_CUSTOM_API_KEY: 'k' }), false);
  assert.equal(isConfigured('custom', { QEDRANK_CUSTOM_API_KEY: 'k', QEDRANK_CUSTOM_BASE_URL: 'https://x.example/v1', QEDRANK_CUSTOM_MODEL: 'm' }), true);
  const d = describeProvider('groq', { GROQ_API_KEY: 'gsk_secretvalue' });
  assert.equal(d.configured, true);
  assert.equal(d.host, 'api.groq.com');
  assert.doesNotMatch(JSON.stringify(d), /gsk_secretvalue/);
});

test('OpenAI-compatible request: URL, auth, system + user messages, model and limits', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return completion('```lean\ntheorem t : 1 = 1 := rfl\n```'); };
  const env = { OPENROUTER_API_KEY: 'or-key-123456' };
  const r = await callProvider('openrouter', { prompt: 'P', temperature: 0.1, maxTokens: 99, env, fetchImpl, sleep: noSleep });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  const h = calls[0].init.headers;
  assert.equal(h.Authorization, 'Bearer or-key-123456');
  assert.equal(h['X-Title'], 'QEDRank');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.deepEqual(body.messages, [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'P' }]);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.max_tokens, 99);
  assert.equal(r.text, '```lean\ntheorem t : 1 = 1 := rfl\n```');
  assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 22, reasoningTokens: 7 });
  assert.equal(r.attempts, 1);
  assert.equal(r.baseUrlHost, 'openrouter.ai');
  assert.doesNotMatch(JSON.stringify(r), /or-key-123456/);
});

test('custom slot supports a non-Bearer auth header (e.g. Azure api-key)', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, headers: init.headers }; return completion('ok'); };
  const env = { QEDRANK_CUSTOM_API_KEY: 'azkey', QEDRANK_CUSTOM_BASE_URL: 'https://res.services.ai.azure.com/models/', QEDRANK_CUSTOM_MODEL: 'DeepSeek-R1', QEDRANK_CUSTOM_AUTH_HEADER: 'api-key' };
  await callProvider('custom', { prompt: 'P', env, fetchImpl, sleep: noSleep });
  assert.equal(seen.url, 'https://res.services.ai.azure.com/models/chat/completions');
  assert.equal(seen.headers['api-key'], 'azkey');
  assert.equal(seen.headers.Authorization, undefined);
});

test('reasoning output: <think> blocks and reasoning_content are separated from the answer', async () => {
  assert.deepEqual(splitReasoning('<think>try omega\n```lean\nwrong\n```</think>\nFinal:\n```lean\nright\n```'), { text: 'Final:\n```lean\nright\n```', reasoning: 'try omega\n```lean\nwrong\n```' });
  assert.deepEqual(splitReasoning('<think>cut off mid-thought'), { text: '', reasoning: 'cut off mid-thought' });
  const fetchImpl = async () => completion('answer', { message: { reasoning_content: 'long hidden reasoning' } });
  const r = await callProvider('deepseek', { prompt: 'P', env: { DEEPSEEK_API_KEY: 'sk-x' }, fetchImpl, sleep: noSleep });
  assert.equal(r.text, 'answer');
  assert.equal(r.reasoningChars, 'long hidden reasoning'.length);
});

test('an answer cut off while reasoning is an explicit empty_response, not a silent blank', async () => {
  const fetchImpl = async () => completion('<think>still thinking', { finish: 'length' });
  await assert.rejects(() => callProvider('groq', { prompt: 'P', env: { GROQ_API_KEY: 'g' }, fetchImpl, sleep: noSleep }), (e) => e.kind === 'empty_response' && /raise maxTokens/.test(e.message));
});

test('429 and 5xx are retried with Retry-After / backoff; the key never appears in errors', async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return errResponse(429, '{"error":{"message":"rate limited for key nv-secret-key"}}', { 'retry-after': '3' });
    if (n === 2) return errResponse(503, 'busy');
    return completion('done');
  };
  const r = await callProvider('nvidia', { prompt: 'P', retries: 3, baseDelayMs: 10, env: { NVIDIA_API_KEY: 'nv-secret-key' }, fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r.text, 'done');
  assert.equal(r.attempts, 3);
  assert.equal(waits[0], 3000); // honoured Retry-After
  assert.ok(waits[1] >= 20 && waits[1] < 40); // exponential backoff: base * 2^(attempt-1) + jitter

  const always429 = async () => errResponse(429, '{"error":{"message":"quota exceeded for nv-secret-key"}}');
  await assert.rejects(
    () => callProvider('nvidia', { prompt: 'P', retries: 1, baseDelayMs: 1, env: { NVIDIA_API_KEY: 'nv-secret-key' }, fetchImpl: always429, sleep: noSleep }),
    (e) => e instanceof ProviderError && e.kind === 'rate_limited' && e.attempts === 2 && !/nv-secret-key/.test(e.message + e.body),
  );
});

test('missing keys, the unconfigured custom slot and retired providers fail clearly before any request', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  await assert.rejects(() => callProvider('mistral', { prompt: 'P', env: {}, fetchImpl }), (e) => e.kind === 'not_configured' && /MISTRAL_API_KEY/.test(e.message));
  await assert.rejects(() => callProvider('custom', { prompt: 'P', env: { QEDRANK_CUSTOM_API_KEY: 'k' }, fetchImpl }), (e) => e.kind === 'not_configured' && /QEDRANK_CUSTOM_BASE_URL/.test(e.message));
  await assert.rejects(() => callProvider('github', { prompt: 'P', env: { GITHUB_MODELS_TOKEN: 't' }, fetchImpl }), (e) => e.kind === 'retired' && /2026-07-30/.test(e.message));
});

test('ping helper extracts the Lean block and adds an import when the model gave none', () => {
  assert.match(PING_PROMPT, /theorem add_comm_example \(a b : ℕ\) : a \+ b = b \+ a := by/);
  const code = leanFromAnswer('Here you go:\n```lean\ntheorem add_comm_example (a b : ℕ) : a + b = b + a := by\n  omega\n```');
  assert.match(code, /^import Mathlib\.Tactic\n\ntheorem add_comm_example/);
  assert.equal(leanFromAnswer('```lean\nimport Mathlib\ntheorem x : True := trivial\n```'), 'import Mathlib\ntheorem x : True := trivial');
});
