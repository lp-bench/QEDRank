import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, DEFAULT_ROSTER, getRoster, resolveModelId, resolveBaseUrl, resolveApiKey, resolveEffort, isConfigured, describeProvider,
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
const anthropicMessage = (blocks, extra = {}) => okResponse({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: blocks, stop_reason: extra.stop || 'end_turn', stop_details: extra.stop_details ?? null, usage: { input_tokens: 40, output_tokens: 900 } });

test('the default roster has the eleven models in UI order; optional and retired slots sit outside it', () => {
  assert.deepEqual(DEFAULT_ROSTER, ['fable', 'opus', 'qwen', 'mistral', 'gpt6_astra', 'gpt6_sol', 'gpt56_terra', 'gpt54', 'kimi', 'llama', 'deepseek']);
  assert.ok(!DEFAULT_ROSTER.includes('github'));
  assert.ok(!DEFAULT_ROSTER.includes('custom'));
  assert.ok(PROVIDERS.find((p) => p.id === 'github').retired);
  for (const p of PROVIDERS) assert.equal(typeof p.envKey, 'string', `${p.id} names its key variable`);
  assert.equal(resolveModelId('fable', {}), 'claude-fable-5-1');
  assert.equal(resolveModelId('opus', {}), 'claude-opus-5-5');
  assert.equal(resolveModelId('gpt54', {}), 'gpt-5.4');
  assert.equal(resolveModelId('gpt6_astra', {}), 'gpt-6-astra');
  assert.equal(resolveModelId('kimi', {}), 'kimi-k3');
});

test('roster, model, base URL, auth header, effort and per-slot key overrides come from the environment', () => {
  assert.deepEqual(getRoster({ QEDRANK_MODELS: 'gpt54, mistral' }), ['gpt54', 'mistral']);
  assert.throws(() => getRoster({ QEDRANK_MODELS: 'gpt54,nope' }), /unknown provider ids: nope/);
  assert.equal(resolveModelId('mistral', {}), 'labs-leanstral-2603');
  assert.equal(resolveModelId('mistral', { QEDRANK_MODEL_MISTRAL: 'leanstral-x' }), 'leanstral-x');
  assert.equal(resolveBaseUrl('gemini', {}), 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(resolveBaseUrl('gpt6_astra', { QEDRANK_BASEURL_GPT6_ASTRA: 'https://res.services.ai.azure.com/models/' }), 'https://res.services.ai.azure.com/models');
  assert.equal(resolveModelId('custom', {}), null);
  assert.equal(isConfigured('custom', { QEDRANK_CUSTOM_API_KEY: 'k' }), false);
  assert.equal(isConfigured('custom', { QEDRANK_CUSTOM_API_KEY: 'k', QEDRANK_CUSTOM_BASE_URL: 'https://x.example/v1', QEDRANK_CUSTOM_MODEL: 'm' }), true);

  // Vendor key shared by several slots; a slot-specific key wins; fallbacks are last.
  assert.deepEqual(resolveApiKey('opus', { ANTHROPIC_API_KEY: 'a' }), { key: 'a', source: 'ANTHROPIC_API_KEY' });
  assert.deepEqual(resolveApiKey('opus', { ANTHROPIC_API_KEY: 'a', QEDRANK_API_KEY_OPUS: 'b' }), { key: 'b', source: 'QEDRANK_API_KEY_OPUS' });
  // The Llama slot is served by GWDG Chat AI: another vendor's key must never be sent there.
  assert.deepEqual(resolveApiKey('llama', { OPENROUTER_API_KEY: 'or' }), { key: null, source: null });
  assert.deepEqual(resolveApiKey('llama', { LLAMA_API_KEY: 'k' }), { key: 'k', source: 'LLAMA_API_KEY' });
  assert.equal(resolveBaseUrl('llama', {}), 'https://chat-ai.academiccloud.de/v1');
  assert.equal(resolveModelId('llama', {}), 'meta-llama-3.1-8b-instruct');
  assert.equal(isConfigured('gpt54', { OPENAI_API_KEY: 'sk' }), true);
  assert.equal(isConfigured('gpt54', {}), false);

  // Effort only applies to reasoning models; the env override wins over the caller's request.
  assert.equal(resolveEffort('fable', {}, 'medium'), 'medium');
  assert.equal(resolveEffort('fable', { QEDRANK_EFFORT_FABLE: 'max' }, 'medium'), 'max');
  assert.equal(resolveEffort('deepseek', {}, 'high'), null);

  const d = describeProvider('gpt54', { OPENAI_API_KEY: 'sk-secretvalue' });
  assert.equal(d.configured, true);
  assert.equal(d.host, 'api.openai.com');
  assert.equal(d.vendor, 'OpenAI');
  assert.equal(d.key_env_in_use, 'OPENAI_API_KEY');
  assert.equal(d.reasoning, true);
  assert.doesNotMatch(JSON.stringify(d), /sk-secretvalue/);
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
  assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 22, reasoningTokens: 7, cachedInputTokens: null });
  assert.deepEqual(r.sampling, { temperature: 0.1, effort: null });
  assert.equal(r.attempts, 1);
  assert.equal(r.baseUrlHost, 'openrouter.ai');
  assert.doesNotMatch(JSON.stringify(r), /or-key-123456/);
});

test('OpenAI reasoning models (GPT-5.x / GPT-6) get max_completion_tokens and reasoning_effort, never temperature', async () => {
  let body;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return completion('ok'); };
  const r = await callProvider('gpt6_astra', { prompt: 'P', temperature: 0.3, maxTokens: 500, effort: 'high', env: { OPENAI_API_KEY: 'sk-1' }, fetchImpl, sleep: noSleep });
  assert.equal(body.model, 'gpt-6-astra');
  assert.equal(body.max_completion_tokens, 500);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(r.sampling, { temperature: null, effort: 'high' });
  assert.equal(r.vendor, 'OpenAI');
});

test('Kimi K3 gets max_tokens but no temperature (the API allows only its default)', async () => {
  let body;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return completion('ok'); };
  const r = await callProvider('kimi', { prompt: 'P', temperature: 0, maxTokens: 500, env: { MOONSHOT_API_KEY: 'sk-1' }, fetchImpl, sleep: noSleep });
  assert.equal(body.model, 'kimi-k3');
  assert.equal(body.max_tokens, 500);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(r.sampling, { temperature: null, effort: null });
});

test('every roster slot accepts a per-slot endpoint, model and auth header (Azure AI Foundry style)', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, headers: init.headers, body: JSON.parse(init.body) }; return completion('ok'); };
  const env = { QEDRANK_API_KEY_LLAMA: 'azkey', QEDRANK_BASEURL_LLAMA: 'https://res.services.ai.azure.com/models/', QEDRANK_MODEL_LLAMA: 'Meta-Llama-3.1-8B-Instruct', QEDRANK_AUTH_HEADER_LLAMA: 'api-key' };
  const r = await callProvider('llama', { prompt: 'P', env, fetchImpl, sleep: noSleep });
  assert.equal(seen.url, 'https://res.services.ai.azure.com/models/chat/completions');
  assert.equal(seen.headers['api-key'], 'azkey');
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(seen.body.model, 'Meta-Llama-3.1-8B-Instruct');
  assert.equal(r.baseUrlHost, 'res.services.ai.azure.com');
  const d = describeProvider('llama', env);
  assert.equal(d.base_url_overridden, true);
  assert.equal(d.model_overridden, true);
  assert.equal(d.key_env_in_use, 'QEDRANK_API_KEY_LLAMA');
});

test('custom slot keeps its own variable names', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, headers: init.headers }; return completion('ok'); };
  const env = { QEDRANK_CUSTOM_API_KEY: 'azkey', QEDRANK_CUSTOM_BASE_URL: 'https://res.services.ai.azure.com/models/', QEDRANK_CUSTOM_MODEL: 'DeepSeek-R1', QEDRANK_CUSTOM_AUTH_HEADER: 'api-key' };
  await callProvider('custom', { prompt: 'P', env, fetchImpl, sleep: noSleep });
  assert.equal(seen.url, 'https://res.services.ai.azure.com/models/chat/completions');
  assert.equal(seen.headers['api-key'], 'azkey');
});

test('Anthropic Messages API: request shape, text/thinking blocks, usage and stop reasons', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return anthropicMessage([{ type: 'thinking', thinking: 'plan the proof' }, { type: 'text', text: '```lean\ntheorem t : 1 = 1 := rfl\n```' }]); };
  const r = await callProvider('opus', { prompt: 'P', temperature: 0.3, maxTokens: 4096, effort: 'high', env: { ANTHROPIC_API_KEY: 'sk-ant-secret' }, fetchImpl, sleep: noSleep });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const h = calls[0].init.headers;
  assert.equal(h['x-api-key'], 'sk-ant-secret');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h.Authorization, undefined);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'P' }]);
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.temperature, undefined, 'Opus 5.5 / Fable 5.1 reject sampling parameters');
  assert.equal(body.thinking, undefined, 'thinking stays at the API default (adaptive)');
  assert.equal(body.fallbacks, undefined, 'no server-side fallback: the answer must come from the named model');
  assert.equal(r.text, '```lean\ntheorem t : 1 = 1 := rfl\n```');
  assert.equal(r.reasoningChars, 'plan the proof'.length);
  assert.deepEqual(r.usage, { inputTokens: 40, outputTokens: 900, reasoningTokens: null, cachedInputTokens: null });
  assert.equal(r.finishReason, 'stop');
  assert.equal(r.responseModel, 'claude-opus-5-5');
  assert.deepEqual(r.sampling, { temperature: null, effort: 'high' });
  assert.doesNotMatch(JSON.stringify(r), /sk-ant-secret/);

  // max_tokens maps to the shared 'length' finish reason so truncation is handled uniformly.
  const cut = async () => anthropicMessage([{ type: 'thinking', thinking: '…' }], { stop: 'max_tokens' });
  await assert.rejects(() => callProvider('fable', { prompt: 'P', env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: cut, sleep: noSleep }), (e) => e.kind === 'empty_response');

  // A refusal is an explicit failure, never a silent blank or another model's answer.
  const refused = async () => anthropicMessage([], { stop: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' } });
  await assert.rejects(() => callProvider('fable', { prompt: 'P', env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: refused, sleep: noSleep }), (e) => e instanceof ProviderError && e.kind === 'refusal' && /cyber/.test(e.message));

  // Anthropic error bodies are {type:'error', error:{type,message}}.
  const bad = async () => errResponse(400, '{"type":"error","error":{"type":"invalid_request_error","message":"temperature is not supported"}}');
  await assert.rejects(() => callProvider('fable', { prompt: 'P', env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: bad, sleep: noSleep }), (e) => e.kind === 'http_error' && e.httpStatus === 400 && /temperature is not supported/.test(e.message));
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

  // An exhausted balance also arrives as 429, but waiting cannot fix it: no retry, distinct kind.
  let calls = 0;
  const noCredits = async () => { calls += 1; return errResponse(429, '{"error":{"message":"You have no credits remaining.","type":"insufficient_quota","code":"insufficient_quota"}}'); };
  await assert.rejects(
    () => callProvider('gpt54', { prompt: 'P', retries: 4, baseDelayMs: 1, env: { OPENAI_API_KEY: 'sk-1' }, fetchImpl: noCredits, sleep: noSleep }),
    (e) => e.kind === 'insufficient_quota' && e.attempts === 1 && calls === 1 && /no credits remaining/.test(e.message),
  );
});

test('missing keys, the unconfigured custom slot and retired providers fail clearly before any request', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  await assert.rejects(() => callProvider('mistral', { prompt: 'P', env: {}, fetchImpl }), (e) => e.kind === 'not_configured' && /MISTRAL_API_KEY/.test(e.message));
  await assert.rejects(() => callProvider('fable', { prompt: 'P', env: {}, fetchImpl }), (e) => e.kind === 'not_configured' && /ANTHROPIC_API_KEY/.test(e.message));
  await assert.rejects(() => callProvider('custom', { prompt: 'P', env: { QEDRANK_CUSTOM_API_KEY: 'k' }, fetchImpl }), (e) => e.kind === 'not_configured' && /QEDRANK_CUSTOM_BASE_URL/.test(e.message));
  await assert.rejects(() => callProvider('github', { prompt: 'P', env: { GITHUB_MODELS_TOKEN: 't' }, fetchImpl }), (e) => e.kind === 'retired' && /2026-07-30/.test(e.message));
});

test('ping helper extracts the Lean block and adds an import when the model gave none', () => {
  assert.match(PING_PROMPT, /theorem add_comm_example \(a b : ℕ\) : a \+ b = b \+ a := by/);
  const code = leanFromAnswer('Here you go:\n```lean\ntheorem add_comm_example (a b : ℕ) : a + b = b + a := by\n  omega\n```');
  assert.match(code, /^import Mathlib\.Tactic\n\ntheorem add_comm_example/);
  assert.equal(leanFromAnswer('```lean\nimport Mathlib\ntheorem x : True := trivial\n```'), 'import Mathlib\ntheorem x : True := trivial');
});
