// LLM provider registry shared by QEDengine (single-problem mode) and QEDRank
// (batch benchmark mode).
//
// The default roster is ten slots, nine of them OpenAI-compatible chat-completions
// providers plus one "custom" slot. Endpoints and model ids were checked against
// each provider's live catalog or documentation on 2026-10-01; see
// PROVIDER_NOTES / qedrank/README.md for what changed from the original table.
//
// Every value can be overridden without code changes:
//   QEDRANK_MODELS=mistral,groq,...      roster (order kept) for both modes
//   QEDRANK_MODEL_<ID>=<model id>        model, e.g. QEDRANK_MODEL_MISTRAL=labs-leanstral-2603
//   QEDRANK_BASEURL_<ID>=<url>           base URL
//   QEDRANK_CUSTOM_BASE_URL / _MODEL / _API_KEY / _AUTH_HEADER   the custom slot
//
// API keys are read from environment variables only and are never included in
// any return value, error message or log line.

export const SYSTEM_PROMPT = 'You are an expert Lean 4 formal verification agent. Provide valid Lean 4 code.';

const OPENAI = 'openai_compatible';

export const PROVIDERS = Object.freeze([
  {
    id: 'mistral', label: 'Mistral AI', kind: OPENAI,
    baseUrl: 'https://api.mistral.ai/v1', defaultModelId: 'labs-leanstral-2603', envKey: 'MISTRAL_API_KEY',
    portal: 'https://console.mistral.ai', tier: 'free (Experiment plan); Labs model',
    note: 'Lean 4 specialist. labs-leanstral-1-5 was retired on 2026-09-30, so the active Leanstral 2603 is the default.',
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: OPENAI,
    baseUrl: 'https://api.deepseek.com', defaultModelId: 'deepseek-v4-pro', envKey: 'DEEPSEEK_API_KEY',
    portal: 'https://platform.deepseek.com', tier: 'paid (no free tier found)',
    note: 'The API now serves deepseek-v4-pro and deepseek-flash; deepseek-prover-v2 is not served by the API.',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: OPENAI,
    baseUrl: 'https://openrouter.ai/api/v1', defaultModelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', envKey: 'OPENROUTER_API_KEY',
    portal: 'https://openrouter.ai/keys', tier: 'free (":free" models, daily request caps)',
    headers: { 'HTTP-Referer': 'https://qedrank.vercel.app', 'X-Title': 'QEDRank' },
    note: 'deepseek/deepseek-r1:free is no longer listed; the largest current free reasoning model is the default.',
  },
  {
    id: 'groq', label: 'Groq Cloud', kind: OPENAI,
    baseUrl: 'https://api.groq.com/openai/v1', defaultModelId: 'openai/gpt-oss-120b', envKey: 'GROQ_API_KEY',
    portal: 'https://console.groq.com/keys', tier: 'free (rate-limited)',
    note: 'deepseek-r1-distill-llama-70b was shut down on 2025-10-02; Groq names openai/gpt-oss-120b as its replacement.',
  },
  {
    id: 'siliconflow', label: 'SiliconFlow', kind: OPENAI,
    baseUrl: 'https://api.siliconflow.cn/v1', defaultModelId: 'deepseek-ai/DeepSeek-R1', envKey: 'SILICONFLOW_API_KEY',
    portal: 'https://cloud.siliconflow.cn/account/ak', tier: 'paid model (trial credits on sign-up)',
    note: 'Model list needs a key to read; DeepSeek-R1 is kept from the original table but is unverified.',
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', kind: OPENAI,
    baseUrl: null, defaultModelId: null, envKey: 'QEDRANK_CUSTOM_API_KEY',
    baseUrlEnv: 'QEDRANK_CUSTOM_BASE_URL', modelEnv: 'QEDRANK_CUSTOM_MODEL', authHeaderEnv: 'QEDRANK_CUSTOM_AUTH_HEADER',
    portal: null, tier: 'depends on the provider you configure',
    note: 'Replaces GitHub Models (retired 2026-07-30). Point it at any OpenAI-compatible endpoint, e.g. Azure AI Foundry.',
  },
  {
    id: 'together', label: 'Together AI', kind: OPENAI,
    baseUrl: 'https://api.together.xyz/v1', defaultModelId: 'Qwen/Qwen3.8-Flash', envKey: 'TOGETHER_API_KEY',
    portal: 'https://api.together.ai/settings/api-keys', tier: 'paid (no free reasoning model)',
    note: 'DeepSeek-R1 is no longer served serverless; a Qwen model avoids duplicating the DeepSeek V4 slots.',
  },
  {
    id: 'gemini', label: 'Google AI Studio', kind: OPENAI,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModelId: 'gemini-3.8-flash', envKey: 'GEMINI_API_KEY',
    portal: 'https://aistudio.google.com/apikey', tier: 'free tier (rate-limited)',
    note: 'gemini-2.5-pro is no longer in the current model list; gemini-3.8-flash is the latest stable model.',
  },
  {
    id: 'huggingface', label: 'Hugging Face', kind: OPENAI,
    baseUrl: 'https://router.huggingface.co/v1', defaultModelId: 'Qwen/Qwen2.5-Coder-32B-Instruct', envKey: 'HF_TOKEN',
    portal: 'https://huggingface.co/settings/tokens', tier: 'free monthly credits',
    note: 'api-inference.huggingface.co no longer answers; the Inference Providers router serves the same model.',
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM', kind: OPENAI,
    baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModelId: 'deepseek-ai/deepseek-v4.1-flash', envKey: 'NVIDIA_API_KEY',
    portal: 'https://build.nvidia.com', tier: 'free developer access (rate-limited)',
    note: 'DeepSeek-R1 is no longer in the catalog; deepseek-ai/deepseek-v4.1-flash is the DeepSeek model served today.',
  },
  // ---- Not in the default roster -------------------------------------------------------
  {
    id: 'github', label: 'GitHub Models', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://models.github.ai/inference', defaultModelId: 'deepseek/DeepSeek-R1', envKey: 'GITHUB_MODELS_TOKEN',
    portal: 'https://github.com/marketplace/models', tier: 'retired',
    retired: 'GitHub Models was fully retired on 2026-07-30 (playground, catalog and inference API). Use the custom slot instead.',
  },
  {
    id: 'openai', label: 'OpenAI', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-4', envKey: 'OPENAI_API_KEY',
    portal: 'https://platform.openai.com/api-keys', tier: 'paid', note: 'Original QEDengine model; optional.',
  },
  {
    id: 'anthropic', label: 'Anthropic', kind: 'anthropic_legacy', inDefaultRoster: false,
    baseUrl: 'https://api.anthropic.com/v1', defaultModelId: 'claude-3-sonnet-20240229', envKey: 'ANTHROPIC_API_KEY',
    portal: 'https://console.anthropic.com', tier: 'paid', note: 'Original QEDengine integration (legacy completions endpoint); optional.',
  },
  {
    id: 'cohere', label: 'Cohere', kind: 'cohere_legacy', inDefaultRoster: false,
    baseUrl: 'https://api.cohere.ai/v1', defaultModelId: 'command-r-plus', envKey: 'COHERE_API_KEY',
    portal: 'https://dashboard.cohere.com/api-keys', tier: 'trial key', note: 'Original QEDengine integration (legacy generate endpoint); optional.',
  },
]);

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);
export const DEFAULT_ROSTER = Object.freeze(PROVIDERS.filter((p) => p.inDefaultRoster !== false).map((p) => p.id));

export class ProviderError extends Error {
  constructor(provider, message, { httpStatus = null, body = null, kind = 'provider_error', attempts = 1 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.httpStatus = httpStatus;
    this.body = body;
    this.kind = kind; // 'not_configured' | 'retired' | 'http_error' | 'rate_limited' | 'timeout' | 'network' | 'empty_response' | 'provider_error'
    this.attempts = attempts;
  }
}

export function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider id: ${id}`);
  return p;
}

const envName = (id) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** The active roster: QEDRANK_MODELS (comma-separated ids) or the default ten. */
export function getRoster(env = process.env) {
  const raw = env.QEDRANK_MODELS;
  if (!raw || !raw.trim()) return [...DEFAULT_ROSTER];
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((i) => !PROVIDER_IDS.includes(i));
  if (unknown.length) throw new Error(`QEDRANK_MODELS contains unknown provider ids: ${unknown.join(', ')}`);
  return ids;
}

/** Effective model identifier (env override or default). Never includes secrets. */
export function resolveModelId(id, env = process.env) {
  const p = getProvider(id);
  const override = env[`QEDRANK_MODEL_${envName(id)}`] || (p.modelEnv ? env[p.modelEnv] : null);
  return override && override.trim() ? override.trim() : p.defaultModelId;
}

export function resolveBaseUrl(id, env = process.env) {
  const p = getProvider(id);
  const override = env[`QEDRANK_BASEURL_${envName(id)}`] || (p.baseUrlEnv ? env[p.baseUrlEnv] : null);
  const url = override && override.trim() ? override.trim() : p.baseUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

/** True when the provider has a key, a base URL and a model, and is not retired. */
export function isConfigured(id, env = process.env) {
  const p = getProvider(id);
  return Boolean(!p.retired && env[p.envKey] && resolveBaseUrl(id, env) && resolveModelId(id, env));
}

/** Public description of a provider (safe to send to the browser; no secrets). */
export function describeProvider(id, env = process.env) {
  const p = getProvider(id);
  const modelId = resolveModelId(id, env);
  const baseUrl = resolveBaseUrl(id, env);
  let host = null;
  try { host = baseUrl ? new URL(baseUrl).host : null; } catch { host = null; }
  return {
    id: p.id,
    label: p.label,
    model_id: modelId,
    display_name: modelId ? `${p.label} · ${modelId}` : p.label,
    host,
    env_key: p.envKey,
    configured: isConfigured(id, env),
    retired: p.retired || null,
    tier: p.tier,
    portal: p.portal,
    note: p.note || null,
    in_default_roster: p.inDefaultRoster !== false,
  };
}

/** The prompt wrapper used by the original single-problem workflow. */
export function singleProblemPrompt(mathProblem) {
  return `Convert this mathematical problem to Lean4 code. Return ONLY the Lean4 code, no explanations or additional text:

${mathProblem}

Lean4 code:`;
}

// ---------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------

function truncateBody(text, max = 2000) {
  if (typeof text !== 'string') return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Remove any echo of a secret from provider error bodies before they are stored or shown. */
function redact(text, secrets) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6 && out) out = out.split(s).join('[redacted]');
  return out;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res, attempt, { baseDelayMs, maxDelayMs }) {
  const ra = res?.headers?.get?.('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(maxDelayMs, Math.max(0, secs * 1000));
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.min(maxDelayMs, Math.max(0, at - Date.now()));
  }
  const exp = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(maxDelayMs, exp + Math.floor(Math.random() * baseDelayMs));
}

/**
 * POST JSON with timeout and bounded retries on rate limits / transient errors.
 * Returns { data, latencyMs, httpStatus, attempts, retryWaitMs }.
 */
async function postJson(provider, url, headers, body, { timeoutMs, retries, baseDelayMs, maxDelayMs, secrets, sleep, fetchImpl }) {
  let attempt = 0;
  let retryWaitMs = 0;
  const started = Date.now();
  while (true) {
    attempt += 1;
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const isTimeout = err && err.name === 'AbortError';
      if (!isTimeout && attempt <= retries) {
        const wait = retryDelayMs(null, attempt, { baseDelayMs, maxDelayMs });
        retryWaitMs += wait;
        await sleep(wait);
        continue;
      }
      throw new ProviderError(provider, isTimeout ? `${provider} request timed out after ${timeoutMs} ms` : `${provider} network error: ${err.message}`, { kind: isTimeout ? 'timeout' : 'network', attempts: attempt });
    }
    if (timer) clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      return { data, latencyMs: Date.now() - started, httpStatus: res.status, attempts: attempt, retryWaitMs };
    }
    const text = redact(truncateBody(await res.text().catch(() => null)), secrets);
    if (RETRYABLE.has(res.status) && attempt <= retries) {
      const wait = retryDelayMs(res, attempt, { baseDelayMs, maxDelayMs });
      retryWaitMs += wait;
      await sleep(wait);
      continue;
    }
    const kind = res.status === 429 ? 'rate_limited' : 'http_error';
    let detail = '';
    try { const j = JSON.parse(text); detail = j?.error?.message || j?.message || j?.detail || ''; } catch { detail = ''; }
    throw new ProviderError(provider, `${provider} API error ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`, { httpStatus: res.status, body: text, kind, attempts: attempt });
  }
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Split reasoning-model output: <think>…</think> blocks are reasoning, not answer text. */
export function splitReasoning(content) {
  if (typeof content !== 'string') return { text: '', reasoning: '' };
  let reasoning = '';
  let text = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_, r) => { reasoning += r; return ''; });
  // An unterminated <think> (output cut off mid-reasoning) means there is no answer text.
  const open = text.search(/<think>/i);
  if (open !== -1) { reasoning += text.slice(open + 7); text = text.slice(0, open); }
  return { text: text.trim(), reasoning: reasoning.trim() };
}

function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return '';
}

async function callOpenAICompatible(p, { prompt, system, temperature, maxTokens, modelId, apiKey, baseUrl, env, transport }) {
  const authHeader = p.authHeaderEnv && env[p.authHeaderEnv] ? env[p.authHeaderEnv].trim() : 'Authorization';
  const headers = { 'Content-Type': 'application/json', ...(p.headers || {}) };
  if (authHeader.toLowerCase() === 'authorization') headers.Authorization = `Bearer ${apiKey}`;
  else headers[authHeader] = apiKey;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { model: modelId, messages, temperature, max_tokens: maxTokens };
  const r = await postJson(p.id, `${baseUrl}/chat/completions`, headers, body, { ...transport, secrets: [apiKey] });
  const choice = r.data?.choices?.[0];
  const raw = messageText(choice?.message);
  const split = splitReasoning(raw);
  const fieldReasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
  const u = r.data?.usage;
  return {
    text: split.text,
    reasoningChars: (split.reasoning.length || 0) + (typeof fieldReasoning === 'string' ? fieldReasoning.length : 0),
    usage: u ? {
      inputTokens: num(u.prompt_tokens),
      outputTokens: num(u.completion_tokens),
      reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
    } : null,
    latencyMs: r.latencyMs,
    httpStatus: r.httpStatus,
    attempts: r.attempts,
    retryWaitMs: r.retryWaitMs,
    finishReason: choice?.finish_reason ?? null,
    responseModel: r.data?.model ?? null,
  };
}

async function callAnthropicLegacy(p, { prompt, system, temperature, maxTokens, modelId, apiKey, baseUrl, transport }) {
  const wrapped = `\n\nHuman: ${system ? `${system}\n\n` : ''}${prompt}\n\nAssistant:`;
  const r = await postJson(p.id, `${baseUrl}/complete`, { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    { model: modelId, prompt: wrapped, max_tokens_to_sample: maxTokens, temperature, stop_sequences: ['\n\nHuman:'] }, { ...transport, secrets: [apiKey] });
  return { text: (r.data.completion || '').trim(), reasoningChars: 0, usage: null, latencyMs: r.latencyMs, httpStatus: r.httpStatus, attempts: r.attempts, retryWaitMs: r.retryWaitMs, finishReason: r.data.stop_reason ?? null, responseModel: r.data.model ?? null };
}

async function callCohereLegacy(p, { prompt, system, temperature, maxTokens, modelId, apiKey, baseUrl, transport }) {
  const r = await postJson(p.id, `${baseUrl}/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    { model: modelId, prompt: system ? `${system}\n\n${prompt}` : prompt, max_tokens: maxTokens, temperature, k: 0, p: 0.75, frequency_penalty: 0, presence_penalty: 0, stop_sequences: [], return_likelihoods: 'NONE' },
    { ...transport, secrets: [apiKey] });
  const bu = r.data.meta?.billed_units;
  return { text: (r.data.generations?.[0]?.text || '').trim(), reasoningChars: 0, usage: bu ? { inputTokens: num(bu.input_tokens), outputTokens: num(bu.output_tokens), reasoningTokens: null } : null, latencyMs: r.latencyMs, httpStatus: r.httpStatus, attempts: r.attempts, retryWaitMs: r.retryWaitMs, finishReason: r.data.generations?.[0]?.finish_reason ?? null, responseModel: null };
}

const CALLERS = { [OPENAI]: callOpenAICompatible, anthropic_legacy: callAnthropicLegacy, cohere_legacy: callCohereLegacy };

/**
 * Call one provider.
 *
 * @param {string} id provider id
 * @param {object} opts
 * @param {string} opts.prompt         user message
 * @param {string|null} [opts.system]  system message (defaults to SYSTEM_PROMPT; pass null for none)
 * @param {number} [opts.temperature]  default 0.3, as in the original app
 * @param {number} [opts.maxTokens]    default 2048, as in the original app
 * @param {number} [opts.timeoutMs]    per-attempt timeout; 0 = none
 * @param {number} [opts.retries]      retries on 429/5xx/network errors (default 0)
 * @param {number} [opts.baseDelayMs]  backoff base (default 2000); Retry-After is honoured
 * @param {number} [opts.maxDelayMs]   backoff cap (default 60000)
 * @param {object} [opts.env]          environment to read keys/overrides from
 */
export async function callProvider(id, {
  prompt, system = SYSTEM_PROMPT, temperature = 0.3, maxTokens = 2048, timeoutMs = 0,
  retries = 0, baseDelayMs = 2000, maxDelayMs = 60000, env = process.env,
  fetchImpl = globalThis.fetch, sleep = defaultSleep,
} = {}) {
  const p = getProvider(id);
  if (typeof prompt !== 'string' || !prompt) throw new Error('prompt is required');
  if (p.retired) throw new ProviderError(id, p.retired, { kind: 'retired' });
  const apiKey = env[p.envKey];
  if (!apiKey) throw new ProviderError(id, `${p.envKey} not configured`, { kind: 'not_configured' });
  const baseUrl = resolveBaseUrl(id, env);
  const modelId = resolveModelId(id, env);
  if (!baseUrl || !modelId) throw new ProviderError(id, `${p.label} needs ${p.baseUrlEnv || 'a base URL'} and ${p.modelEnv || 'a model id'}`, { kind: 'not_configured' });
  const transport = { timeoutMs, retries, baseDelayMs, maxDelayMs, sleep, fetchImpl };
  const result = await CALLERS[p.kind](p, { prompt, system, temperature, maxTokens, modelId, apiKey, baseUrl, env, transport });
  if (!result.text && result.finishReason === 'length') {
    throw new ProviderError(id, `${p.label} hit the output token limit before producing an answer (reasoning used the budget; raise maxTokens)`, { kind: 'empty_response', attempts: result.attempts });
  }
  return {
    provider: id,
    label: p.label,
    displayName: `${p.label} · ${modelId}`,
    modelId,
    baseUrlHost: new URL(baseUrl).host,
    text: result.text,
    reasoningChars: result.reasoningChars,
    usage: result.usage ?? null,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    attempts: result.attempts,
    retryWaitMs: result.retryWaitMs,
    finishReason: result.finishReason ?? null,
    responseModel: result.responseModel ?? null,
  };
}
