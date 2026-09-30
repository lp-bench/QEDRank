// Shared LLM provider integrations for QEDengine (single-problem mode) and
// QEDRank (batch benchmark mode).
//
// The five integrations below were extracted from api/verify.js without
// changing endpoints, model identifiers, or request shapes, so both modes use
// exactly the same provider configuration. API keys are read from environment
// variables only and are never included in any return value or log line.
//
// Model identifiers may be overridden per provider with QEDRANK_MODEL_<ID>
// (e.g. QEDRANK_MODEL_OPENAI=gpt-4o) so a benchmark run can be pinned to a
// specific version; the effective identifier is recorded in every run record.

export const PROVIDERS = Object.freeze([
  { id: 'gemini',    displayName: 'Gemini 1.5 Pro',  defaultModelId: 'gemini-1.5-pro',           envKey: 'GEMINI_API_KEY' },
  { id: 'openai',    displayName: 'GPT-4',           defaultModelId: 'gpt-4',                    envKey: 'OPENAI_API_KEY' },
  { id: 'anthropic', displayName: 'Claude 3 Sonnet', defaultModelId: 'claude-3-sonnet-20240229', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'cohere',    displayName: 'Command R+',      defaultModelId: 'command-r-plus',           envKey: 'COHERE_API_KEY' },
  { id: 'mistral',   displayName: 'Mistral Large',   defaultModelId: 'mistral-large-latest',     envKey: 'MISTRAL_API_KEY' },
]);

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export class ProviderError extends Error {
  constructor(provider, message, { httpStatus = null, body = null, kind = 'provider_error' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.httpStatus = httpStatus;
    this.body = body;
    this.kind = kind; // 'not_configured' | 'http_error' | 'timeout' | 'network' | 'provider_error'
  }
}

export function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider id: ${id}`);
  return p;
}

/** Effective model identifier (env override or default). Never includes secrets. */
export function resolveModelId(id, env = process.env) {
  const p = getProvider(id);
  const override = env[`QEDRANK_MODEL_${id.toUpperCase()}`];
  return override && override.trim() ? override.trim() : p.defaultModelId;
}

/** True when the provider's API key is present in the environment. */
export function isConfigured(id, env = process.env) {
  const p = getProvider(id);
  return Boolean(env[p.envKey]);
}

/** The prompt wrapper used by the original single-problem workflow. */
export function singleProblemPrompt(mathProblem) {
  return `Convert this mathematical problem to Lean4 code. Return ONLY the Lean4 code, no explanations or additional text:

${mathProblem}

Lean4 code:`;
}

function truncateBody(text, max = 2000) {
  if (typeof text !== 'string') return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function doFetch(provider, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const body = truncateBody(await response.text().catch(() => null));
      throw new ProviderError(provider, `${provider} API error: ${response.status}`, {
        httpStatus: response.status, body, kind: 'http_error',
      });
    }
    const data = await response.json();
    return { data, latencyMs, httpStatus: response.status };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err && err.name === 'AbortError') {
      throw new ProviderError(provider, `${provider} request timed out after ${timeoutMs} ms`, { kind: 'timeout' });
    }
    throw new ProviderError(provider, `${provider} network error: ${err.message}`, { kind: 'network' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// ---------------------------------------------------------------------------
// Provider calls. Each returns { text, usage, ... } where usage is
// { inputTokens, outputTokens } or null when the endpoint does not report it.
// ---------------------------------------------------------------------------

async function callGemini({ prompt, temperature, maxTokens, timeoutMs, modelId, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const { data, latencyMs, httpStatus } = await doFetch('gemini', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, topK: 32, topP: 1, maxOutputTokens: maxTokens, stopSequences: [] },
    }),
  }, timeoutMs);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const u = data.usageMetadata;
  const usage = u ? { inputTokens: num(u.promptTokenCount), outputTokens: num(u.candidatesTokenCount) } : null;
  return { text, usage, latencyMs, httpStatus, finishReason: data.candidates?.[0]?.finishReason ?? null, responseModel: null };
}

async function callOpenAI({ prompt, temperature, maxTokens, timeoutMs, modelId, apiKey }) {
  const { data, latencyMs, httpStatus } = await doFetch('openai', 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    }),
  }, timeoutMs);
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage;
  const usage = u ? { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens) } : null;
  return { text, usage, latencyMs, httpStatus, finishReason: data.choices?.[0]?.finish_reason ?? null, responseModel: data.model ?? null };
}

async function callAnthropic({ prompt, temperature, maxTokens, timeoutMs, modelId, apiKey }) {
  // Legacy Text Completions request shape, kept exactly as in the original integration.
  const wrapped = `\n\nHuman: ${prompt}\n\nAssistant:`;
  const { data, latencyMs, httpStatus } = await doFetch('anthropic', 'https://api.anthropic.com/v1/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: modelId,
      prompt: wrapped,
      max_tokens_to_sample: maxTokens,
      temperature,
      stop_sequences: ['\n\nHuman:'],
    }),
  }, timeoutMs);
  const text = data.completion || '';
  return { text, usage: null, latencyMs, httpStatus, finishReason: data.stop_reason ?? null, responseModel: data.model ?? null };
}

async function callCohere({ prompt, temperature, maxTokens, timeoutMs, modelId, apiKey }) {
  const { data, latencyMs, httpStatus } = await doFetch('cohere', 'https://api.cohere.ai/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      prompt,
      max_tokens: maxTokens,
      temperature,
      k: 0,
      p: 0.75,
      frequency_penalty: 0,
      presence_penalty: 0,
      stop_sequences: [],
      return_likelihoods: 'NONE',
    }),
  }, timeoutMs);
  const text = data.generations?.[0]?.text || '';
  const bu = data.meta?.billed_units;
  const usage = bu ? { inputTokens: num(bu.input_tokens), outputTokens: num(bu.output_tokens) } : null;
  return { text, usage, latencyMs, httpStatus, finishReason: data.generations?.[0]?.finish_reason ?? null, responseModel: null };
}

async function callMistral({ prompt, temperature, maxTokens, timeoutMs, modelId, apiKey }) {
  const { data, latencyMs, httpStatus } = await doFetch('mistral', 'https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    }),
  }, timeoutMs);
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage;
  const usage = u ? { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens) } : null;
  return { text, usage, latencyMs, httpStatus, finishReason: data.choices?.[0]?.finish_reason ?? null, responseModel: data.model ?? null };
}

const CALLERS = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic, cohere: callCohere, mistral: callMistral };

/**
 * Call one provider with a plain prompt.
 *
 * @param {string} id one of PROVIDER_IDS
 * @param {object} opts
 * @param {string} opts.prompt        full prompt text
 * @param {number} [opts.temperature] sampling temperature (default 0.3, as in the original app)
 * @param {number} [opts.maxTokens]   output token limit (default 2048, as in the original app)
 * @param {number} [opts.timeoutMs]   request timeout; 0/undefined = no timeout
 * @param {object} [opts.env]         environment to read keys from (default process.env)
 */
export async function callProvider(id, { prompt, temperature = 0.3, maxTokens = 2048, timeoutMs = 0, env = process.env } = {}) {
  const p = getProvider(id);
  if (typeof prompt !== 'string' || !prompt) throw new Error('prompt is required');
  const apiKey = env[p.envKey];
  if (!apiKey) {
    throw new ProviderError(id, `${p.envKey} not configured`, { kind: 'not_configured' });
  }
  const modelId = resolveModelId(id, env);
  const result = await CALLERS[id]({ prompt, temperature, maxTokens, timeoutMs, modelId, apiKey });
  return {
    provider: id,
    displayName: p.displayName,
    modelId,
    text: (result.text || '').trim(),
    usage: result.usage ?? null,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    finishReason: result.finishReason ?? null,
    responseModel: result.responseModel ?? null,
  };
}
