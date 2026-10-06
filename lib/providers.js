// LLM model registry shared by QEDengine (single-problem mode) and QEDRank (batch
// benchmark mode).
//
// The default roster is eleven models, offered in the UI in this order. Nine are reached
// through the OpenAI-compatible chat-completions protocol (OpenAI, Mistral, DeepSeek,
// Moonshot, Alibaba Model Studio, OpenRouter) and two through the Anthropic Messages API.
// Model ids and endpoints were checked against the vendors' documentation on 2026-10-01.
//
// Every value can be overridden without code changes (ID = slot id upper-cased, e.g. GPT54,
// GPT6_ASTRA):
//   QEDRANK_MODELS=fable,gpt54,...   roster (order kept) for both modes
//   QEDRANK_API_KEY_<ID>             key for this slot only (wins over the vendor key)
//   QEDRANK_BASEURL_<ID>             endpoint, e.g. an Azure AI Foundry or gateway URL
//   QEDRANK_MODEL_<ID>               model or deployment id
//   QEDRANK_AUTH_HEADER_<ID>         "api-key" for Azure; default "Authorization: Bearer <key>"
//   QEDRANK_EFFORT_<ID>              reasoning effort (low | medium | high | …) for reasoning models
//
// API keys are read from environment variables only and are never included in any return
// value, error message or log line.

export const SYSTEM_PROMPT = 'You are an expert Lean 4 formal verification agent. Provide valid Lean 4 code.';

const OPENAI = 'openai_compatible';
const ANTHROPIC = 'anthropic_messages';
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://qedrank.vercel.app', 'X-Title': 'QEDRank' };

export const PROVIDERS = Object.freeze([
  // ---- Default roster (eleven models, UI order) ------------------------------------------
  {
    id: 'fable', label: 'Claude Fable 5.1', vendor: 'Anthropic', kind: ANTHROPIC, reasoning: true,
    baseUrl: 'https://api.anthropic.com/v1', defaultModelId: 'claude-fable-5-1', envKey: 'ANTHROPIC_API_KEY',
    portal: 'https://console.anthropic.com/settings/keys', tier: 'paid · $10 / $50 per MTok',
    note: "Anthropic's most capable model. Thinking is always on; depth is set with QEDRANK_EFFORT_FABLE (default high). Sampling parameters are not accepted, so temperature is recorded as null.",
  },
  {
    id: 'opus', label: 'Claude Opus 5.5', vendor: 'Anthropic', kind: ANTHROPIC, reasoning: true,
    baseUrl: 'https://api.anthropic.com/v1', defaultModelId: 'claude-opus-5-5', envKey: 'ANTHROPIC_API_KEY',
    portal: 'https://console.anthropic.com/settings/keys', tier: 'paid · $4 / $20 per MTok',
    note: 'Current Opus. Thinking cannot be disabled; the API default effort is medium, so QEDRank always sends an explicit effort. Shares ANTHROPIC_API_KEY with Fable 5.1.',
  },
  {
    id: 'qwen', label: 'Qwen3 30B-A3B Instruct', vendor: 'Alibaba Cloud Model Studio', kind: OPENAI,
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', defaultModelId: 'qwen3-30b-a3b-instruct-2507', envKey: 'DASHSCOPE_API_KEY',
    portal: 'https://modelstudio.console.alibabacloud.com/?tab=model#/api-key', tier: 'free quota on sign-up, then paid',
    note: 'Instruct (non-thinking) variant of the 30B mixture-of-experts model. Singapore endpoint by default; the Beijing endpoint is https://dashscope.aliyuncs.com/compatible-mode/v1.',
  },
  {
    id: 'mistral', label: 'Leanstral', vendor: 'Mistral AI', kind: OPENAI,
    baseUrl: 'https://api.mistral.ai/v1', defaultModelId: 'labs-leanstral-2603', envKey: 'MISTRAL_API_KEY',
    portal: 'https://console.mistral.ai/api-keys', tier: 'free (Experiment plan); Labs model',
    note: 'Lean 4 specialist. labs-leanstral-1-5 was retired on 2026-09-30; Leanstral 2603 is the active release.',
  },
  {
    id: 'gpt6_astra', label: 'GPT-6 Astra', vendor: 'OpenAI', kind: OPENAI, openaiReasoning: true, reasoning: true,
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-6-astra', envKey: 'OPENAI_API_KEY',
    portal: 'https://platform.openai.com/api-keys', tier: 'paid',
    note: 'Flagship GPT-6 tier (September 2026). Reasoning model: max_completion_tokens and reasoning_effort are sent; temperature is not accepted and is recorded as null.',
  },
  {
    id: 'gpt6_sol', label: 'GPT-6 Sol', vendor: 'OpenAI', kind: OPENAI, openaiReasoning: true, reasoning: true,
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-6-sol', envKey: 'OPENAI_API_KEY',
    portal: 'https://platform.openai.com/api-keys', tier: 'paid',
    note: 'Balanced GPT-6 tier (released 2026-09-22). Shares OPENAI_API_KEY with the other GPT slots.',
  },
  {
    id: 'gpt56_terra', label: 'GPT-5.6 Terra', vendor: 'OpenAI', kind: OPENAI, openaiReasoning: true, reasoning: true,
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-5.6-terra', envKey: 'OPENAI_API_KEY',
    portal: 'https://platform.openai.com/api-keys', tier: 'paid · $2.50 / $15 per MTok',
    note: 'Mid tier of the GPT-5.6 family (OpenAI spells it "Terra"). Reasoning model.',
  },
  {
    id: 'gpt54', label: 'GPT-5.4', vendor: 'OpenAI', kind: OPENAI, openaiReasoning: true, reasoning: true,
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-5.4', envKey: 'OPENAI_API_KEY',
    portal: 'https://platform.openai.com/api-keys', tier: 'paid',
    note: 'GPT-5.4 frontier model. Reasoning model.',
  },
  {
    id: 'kimi', label: 'Kimi K3', vendor: 'Moonshot AI', kind: OPENAI,
    baseUrl: 'https://api.moonshot.ai/v1', defaultModelId: 'kimi-k3', envKey: 'MOONSHOT_API_KEY',
    portal: 'https://platform.moonshot.ai/console/api-keys', tier: 'paid (trial credit on sign-up)',
    note: 'OpenAI-compatible endpoint. Use https://api.moonshot.cn/v1 for the China platform.',
  },
  {
    id: 'llama', label: 'Llama 3.1 8B Instruct', vendor: 'Meta · served by GWDG Chat AI', kind: OPENAI,
    baseUrl: 'https://chat-ai.academiccloud.de/v1', defaultModelId: 'meta-llama-3.1-8b-instruct', envKey: 'LLAMA_API_KEY',
    portal: 'https://docs.hpc.gwdg.de/services/ai-services/saia/index.html', tier: 'free for academic users (AcademicCloud); 10 requests/min, 400/day',
    note: 'Served by the GWDG Chat AI service (AcademicCloud), OpenAI-compatible. For another host point QEDRANK_BASEURL_LLAMA / QEDRANK_MODEL_LLAMA at it: OpenRouter meta-llama/llama-3.1-8b-instruct, Groq llama-3.1-8b-instant, NVIDIA NIM meta/llama-3.1-8b-instruct, Azure AI Foundry Meta-Llama-3.1-8B-Instruct (with QEDRANK_AUTH_HEADER_LLAMA=api-key).',
  },
  {
    id: 'deepseek', label: 'DeepSeek V4', vendor: 'DeepSeek', kind: OPENAI,
    baseUrl: 'https://api.deepseek.com', defaultModelId: 'deepseek-v4-pro', envKey: 'DEEPSEEK_API_KEY',
    portal: 'https://platform.deepseek.com/api_keys', tier: 'paid',
    note: 'The API serves deepseek-v4-pro and deepseek-flash; reasoning_content is separated from the answer before parsing.',
  },
  // ---- Optional provider slots outside the default roster (QEDRANK_MODELS=… to enable) ---
  {
    id: 'openrouter', label: 'OpenRouter', vendor: 'OpenRouter', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://openrouter.ai/api/v1', defaultModelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', envKey: 'OPENROUTER_API_KEY',
    portal: 'https://openrouter.ai/keys', tier: 'free (":free" models, daily request caps)', headers: OPENROUTER_HEADERS,
    note: 'Any OpenRouter model id via QEDRANK_MODEL_OPENROUTER.',
  },
  {
    id: 'groq', label: 'Groq Cloud', vendor: 'Groq', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://api.groq.com/openai/v1', defaultModelId: 'openai/gpt-oss-120b', envKey: 'GROQ_API_KEY',
    portal: 'https://console.groq.com/keys', tier: 'free (rate-limited)',
    note: 'deepseek-r1-distill-llama-70b was shut down on 2025-10-02; Groq names openai/gpt-oss-120b as its replacement.',
  },
  {
    id: 'siliconflow', label: 'SiliconFlow', vendor: 'SiliconFlow', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://api.siliconflow.cn/v1', defaultModelId: 'deepseek-ai/DeepSeek-R1', envKey: 'SILICONFLOW_API_KEY',
    portal: 'https://cloud.siliconflow.cn/account/ak', tier: 'paid model (trial credits on sign-up)',
    note: 'Model list needs a key to read; DeepSeek-R1 is unverified.',
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', vendor: 'custom', kind: OPENAI, inDefaultRoster: false,
    baseUrl: null, defaultModelId: null, envKey: 'QEDRANK_CUSTOM_API_KEY',
    baseUrlEnv: 'QEDRANK_CUSTOM_BASE_URL', modelEnv: 'QEDRANK_CUSTOM_MODEL', authHeaderEnv: 'QEDRANK_CUSTOM_AUTH_HEADER',
    portal: null, tier: 'depends on the provider you configure',
    note: 'Any OpenAI-compatible endpoint, e.g. Azure AI Foundry (QEDRANK_CUSTOM_AUTH_HEADER=api-key). Every roster slot accepts the same overrides, so this slot is only needed for a twelfth model.',
  },
  {
    id: 'together', label: 'Together AI', vendor: 'Together AI', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://api.together.xyz/v1', defaultModelId: 'Qwen/Qwen3.8-Flash', envKey: 'TOGETHER_API_KEY',
    portal: 'https://api.together.ai/settings/api-keys', tier: 'paid', note: null,
  },
  {
    id: 'gemini', label: 'Google AI Studio', vendor: 'Google', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModelId: 'gemini-3.8-flash', envKey: 'GEMINI_API_KEY',
    portal: 'https://aistudio.google.com/apikey', tier: 'free tier (rate-limited)', note: null,
  },
  {
    id: 'huggingface', label: 'Hugging Face', vendor: 'Hugging Face', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://router.huggingface.co/v1', defaultModelId: 'Qwen/Qwen2.5-Coder-32B-Instruct', envKey: 'HF_TOKEN',
    portal: 'https://huggingface.co/settings/tokens', tier: 'free monthly credits', note: 'Inference Providers router.',
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM', vendor: 'NVIDIA', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModelId: 'deepseek-ai/deepseek-v4.1-flash', envKey: 'NVIDIA_API_KEY',
    portal: 'https://build.nvidia.com', tier: 'free developer access (rate-limited)', note: null,
  },
  {
    id: 'openai', label: 'OpenAI (legacy slot)', vendor: 'OpenAI', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-4', envKey: 'OPENAI_API_KEY',
    portal: 'https://platform.openai.com/api-keys', tier: 'paid', note: 'Original QEDengine slot; use the gpt54 / gpt56_terra / gpt6_* slots for current models.',
  },
  {
    id: 'anthropic', label: 'Anthropic (legacy slot)', vendor: 'Anthropic', kind: ANTHROPIC, reasoning: true, inDefaultRoster: false,
    baseUrl: 'https://api.anthropic.com/v1', defaultModelId: 'claude-opus-5-5', envKey: 'ANTHROPIC_API_KEY',
    portal: 'https://console.anthropic.com/settings/keys', tier: 'paid', note: 'Original QEDengine slot, now on the Messages API; use the fable / opus slots.',
  },
  {
    id: 'cohere', label: 'Cohere', vendor: 'Cohere', kind: 'cohere_legacy', inDefaultRoster: false,
    baseUrl: 'https://api.cohere.ai/v1', defaultModelId: 'command-r-plus', envKey: 'COHERE_API_KEY',
    portal: 'https://dashboard.cohere.com/api-keys', tier: 'trial key', note: 'Original QEDengine integration (legacy generate endpoint); optional.',
  },
  {
    id: 'github', label: 'GitHub Models', vendor: 'GitHub', kind: OPENAI, inDefaultRoster: false,
    baseUrl: 'https://models.github.ai/inference', defaultModelId: 'deepseek/DeepSeek-R1', envKey: 'GITHUB_MODELS_TOKEN',
    portal: 'https://github.com/marketplace/models', tier: 'retired',
    retired: 'GitHub Models was fully retired on 2026-07-30 (playground, catalog and inference API). Use the custom slot instead.',
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
    this.kind = kind; // 'not_configured' | 'retired' | 'http_error' | 'rate_limited' | 'insufficient_quota' | 'timeout' | 'network' | 'empty_response' | 'refusal' | 'provider_error'
    this.attempts = attempts;
  }
}

export function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider id: ${id}`);
  return p;
}

const envName = (id) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The active roster: QEDRANK_MODELS (comma-separated ids) or the default eleven. */
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
  return trimmed(env[`QEDRANK_MODEL_${envName(id)}`]) || (p.modelEnv ? trimmed(env[p.modelEnv]) : null) || p.defaultModelId;
}

export function resolveBaseUrl(id, env = process.env) {
  const p = getProvider(id);
  const url = trimmed(env[`QEDRANK_BASEURL_${envName(id)}`]) || (p.baseUrlEnv ? trimmed(env[p.baseUrlEnv]) : null) || p.baseUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

/** Name of the HTTP header that carries the key ("Authorization" means "Authorization: Bearer <key>"). */
export function resolveAuthHeader(id, env = process.env) {
  const p = getProvider(id);
  return trimmed(env[`QEDRANK_AUTH_HEADER_${envName(id)}`]) || (p.authHeaderEnv ? trimmed(env[p.authHeaderEnv]) : null) || 'Authorization';
}

/** Reasoning effort for reasoning models: env override, then the caller's request, else none. */
export function resolveEffort(id, env = process.env, requested = null) {
  const p = getProvider(id);
  if (!p.reasoning) return null;
  return trimmed(env[`QEDRANK_EFFORT_${envName(id)}`]) || trimmed(requested) || null;
}

/**
 * The key for a slot and the NAME of the variable it came from. The slot-specific
 * QEDRANK_API_KEY_<ID> wins, then the vendor key, then any fallback (e.g. OPENROUTER_API_KEY
 * for the Llama slot). The key itself must never be logged or returned to a client.
 */
export function resolveApiKey(id, env = process.env) {
  const p = getProvider(id);
  const candidates = [`QEDRANK_API_KEY_${envName(id)}`, p.envKey, ...(p.envKeyFallbacks || [])];
  for (const name of candidates) {
    const v = trimmed(env[name]);
    if (v) return { key: v, source: name };
  }
  return { key: null, source: null };
}

/** True when the provider has a key, a base URL and a model, and is not retired. */
export function isConfigured(id, env = process.env) {
  const p = getProvider(id);
  return Boolean(!p.retired && resolveApiKey(id, env).key && resolveBaseUrl(id, env) && resolveModelId(id, env));
}

/** Public description of a provider (safe to send to the browser; no secrets). */
export function describeProvider(id, env = process.env) {
  const p = getProvider(id);
  const modelId = resolveModelId(id, env);
  const baseUrl = resolveBaseUrl(id, env);
  let host = null;
  try { host = baseUrl ? new URL(baseUrl).host : null; } catch { host = null; }
  const key = resolveApiKey(id, env);
  return {
    id: p.id,
    label: p.label,
    vendor: p.vendor || p.label,
    kind: p.kind,
    reasoning: Boolean(p.reasoning),
    model_id: modelId,
    display_name: modelId ? `${p.label} · ${modelId}` : p.label,
    host,
    env_key: p.envKey,
    env_key_fallbacks: p.envKeyFallbacks || [],
    key_env_in_use: key.source,
    base_url_overridden: Boolean(baseUrl && baseUrl !== (p.baseUrl ? p.baseUrl.replace(/\/+$/, '') : null)),
    model_overridden: Boolean(modelId && modelId !== p.defaultModelId),
    effort: resolveEffort(id, env, null),
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
// Some vendors report an exhausted balance as 429 (OpenAI "insufficient_quota"); waiting cannot fix it.
const QUOTA_EXHAUSTED = /insufficient_quota|no credits remaining|exceeded your current quota|insufficient balance/i;
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
    const quotaExhausted = res.status === 429 && QUOTA_EXHAUSTED.test(text || '');
    if (RETRYABLE.has(res.status) && !quotaExhausted && attempt <= retries) {
      const wait = retryDelayMs(res, attempt, { baseDelayMs, maxDelayMs });
      retryWaitMs += wait;
      await sleep(wait);
      continue;
    }
    const kind = quotaExhausted ? 'insufficient_quota' : res.status === 429 ? 'rate_limited' : 'http_error';
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

async function callOpenAICompatible(p, { prompt, system, temperature, maxTokens, modelId, apiKey, baseUrl, authHeader, effort, transport }) {
  const headers = { 'Content-Type': 'application/json', ...(p.headers || {}) };
  if (authHeader.toLowerCase() === 'authorization') headers.Authorization = `Bearer ${apiKey}`;
  else headers[authHeader] = apiKey;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { model: modelId, messages };
  if (p.openaiReasoning) {
    // OpenAI reasoning models (GPT-5.x, GPT-6): max_tokens and temperature are rejected.
    body.max_completion_tokens = maxTokens;
    if (effort) body.reasoning_effort = effort;
  } else {
    body.temperature = temperature;
    body.max_tokens = maxTokens;
  }
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
    sampling: { temperature: p.openaiReasoning ? null : temperature, effort: p.openaiReasoning ? effort || null : null },
  };
}

const ANTHROPIC_STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'refusal' };

/**
 * Anthropic Messages API. Thinking stays at the API default (adaptive); only the effort is
 * set. No temperature is sent (Fable 5.1 / Opus 5.5 reject sampling parameters), and no
 * server-side fallback is enabled: a benchmark answer must come from the named model, so a
 * refusal is recorded as a failure rather than silently served by another model.
 */
async function callAnthropicMessages(p, { prompt, system, maxTokens, modelId, apiKey, baseUrl, effort, transport }) {
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (system) body.system = system;
  if (effort) body.output_config = { effort };
  const r = await postJson(p.id, `${baseUrl}/messages`, headers, body, { ...transport, secrets: [apiKey] });
  const blocks = Array.isArray(r.data?.content) ? r.data.content : [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => (typeof b.text === 'string' ? b.text : '')).join('').trim();
  const thinkingChars = blocks.filter((b) => b?.type === 'thinking').reduce((s, b) => s + (typeof b.thinking === 'string' ? b.thinking.length : 0), 0);
  const stop = r.data?.stop_reason ?? null;
  if (stop === 'refusal') {
    const d = r.data?.stop_details;
    throw new ProviderError(p.id, `${p.label} declined the request (${d?.category || 'refusal'}${d?.explanation ? `: ${String(d.explanation).slice(0, 200)}` : ''})`, { kind: 'refusal', httpStatus: r.httpStatus, attempts: r.attempts });
  }
  const u = r.data?.usage;
  return {
    text,
    reasoningChars: thinkingChars,
    usage: u ? { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), reasoningTokens: null } : null,
    latencyMs: r.latencyMs,
    httpStatus: r.httpStatus,
    attempts: r.attempts,
    retryWaitMs: r.retryWaitMs,
    finishReason: stop === null ? null : ANTHROPIC_STOP[stop] ?? stop,
    responseModel: r.data?.model ?? null,
    sampling: { temperature: null, effort: effort || null },
  };
}

async function callCohereLegacy(p, { prompt, system, temperature, maxTokens, modelId, apiKey, baseUrl, transport }) {
  const r = await postJson(p.id, `${baseUrl}/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    { model: modelId, prompt: system ? `${system}\n\n${prompt}` : prompt, max_tokens: maxTokens, temperature, k: 0, p: 0.75, frequency_penalty: 0, presence_penalty: 0, stop_sequences: [], return_likelihoods: 'NONE' },
    { ...transport, secrets: [apiKey] });
  const bu = r.data.meta?.billed_units;
  return { text: (r.data.generations?.[0]?.text || '').trim(), reasoningChars: 0, usage: bu ? { inputTokens: num(bu.input_tokens), outputTokens: num(bu.output_tokens), reasoningTokens: null } : null, latencyMs: r.latencyMs, httpStatus: r.httpStatus, attempts: r.attempts, retryWaitMs: r.retryWaitMs, finishReason: r.data.generations?.[0]?.finish_reason ?? null, responseModel: null, sampling: { temperature, effort: null } };
}

const CALLERS = { [OPENAI]: callOpenAICompatible, [ANTHROPIC]: callAnthropicMessages, cohere_legacy: callCohereLegacy };

/**
 * Call one provider.
 *
 * @param {string} id provider id
 * @param {object} opts
 * @param {string} opts.prompt         user message
 * @param {string|null} [opts.system]  system message (defaults to SYSTEM_PROMPT; pass null for none)
 * @param {number} [opts.temperature]  default 0.3; not sent to reasoning models (see `sampling` in the result)
 * @param {number} [opts.maxTokens]    default 2048
 * @param {string} [opts.effort]       reasoning effort for reasoning models (QEDRANK_EFFORT_<ID> wins)
 * @param {number} [opts.timeoutMs]    per-attempt timeout; 0 = none
 * @param {number} [opts.retries]      retries on 429/5xx/network errors (default 0)
 * @param {number} [opts.baseDelayMs]  backoff base (default 2000); Retry-After is honoured
 * @param {number} [opts.maxDelayMs]   backoff cap (default 60000)
 * @param {object} [opts.env]          environment to read keys/overrides from
 */
export async function callProvider(id, {
  prompt, system = SYSTEM_PROMPT, temperature = 0.3, maxTokens = 2048, effort = null, timeoutMs = 0,
  retries = 0, baseDelayMs = 2000, maxDelayMs = 60000, env = process.env,
  fetchImpl = globalThis.fetch, sleep = defaultSleep,
} = {}) {
  const p = getProvider(id);
  if (typeof prompt !== 'string' || !prompt) throw new Error('prompt is required');
  if (p.retired) throw new ProviderError(id, p.retired, { kind: 'retired' });
  const { key: apiKey } = resolveApiKey(id, env);
  if (!apiKey) throw new ProviderError(id, `${p.envKey} not configured`, { kind: 'not_configured' });
  const baseUrl = resolveBaseUrl(id, env);
  const modelId = resolveModelId(id, env);
  if (!baseUrl || !modelId) throw new ProviderError(id, `${p.label} needs ${p.baseUrlEnv || `QEDRANK_BASEURL_${envName(id)}`} and ${p.modelEnv || `QEDRANK_MODEL_${envName(id)}`}`, { kind: 'not_configured' });
  const transport = { timeoutMs, retries, baseDelayMs, maxDelayMs, sleep, fetchImpl };
  const result = await CALLERS[p.kind](p, {
    prompt, system, temperature, maxTokens, modelId, apiKey, baseUrl, transport,
    authHeader: resolveAuthHeader(id, env), effort: resolveEffort(id, env, effort),
  });
  if (!result.text && result.finishReason === 'length') {
    throw new ProviderError(id, `${p.label} hit the output token limit before producing an answer (reasoning used the budget; raise maxTokens)`, { kind: 'empty_response', attempts: result.attempts });
  }
  return {
    provider: id,
    label: p.label,
    vendor: p.vendor || p.label,
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
    sampling: result.sampling ?? { temperature, effort: null },
  };
}
