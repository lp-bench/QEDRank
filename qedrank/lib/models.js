// Runner-side adapter over the project's provider registry (lib/providers.js).
// Live mode calls the same integrations the single-problem endpoint uses. Fixture
// mode replays canned responses for tests and dry runs; it is always labeled as
// such in every record it produces.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROVIDERS, callProvider, describeProvider, getRoster, ProviderError, SYSTEM_PROMPT } from '../../lib/providers.js';
import { nowMono, isoNow, exists, pLimit } from './util.js';

export { SYSTEM_PROMPT };

export function listModels(env = process.env, ids = null) {
  const list = ids || getRoster(env);
  return list.map((id) => {
    const d = describeProvider(id, env);
    return { id, label: d.label, vendor: d.vendor, display_name: d.display_name, model_id: d.model_id, host: d.host, configured: d.configured, retired: d.retired, tier: d.tier, env_key: d.env_key, key_env_in_use: d.key_env_in_use, reasoning: d.reasoning, portal: d.portal, facts: d.facts };
  });
}

/** A fixture provider reads <dir>/<provider>/<paper_id>__<target_kind>.md, then <dir>/<provider>/default.md, then <dir>/default.md. */
export async function loadFixtureProvider(dir) {
  const root = path.resolve(dir);
  if (!(await exists(root))) throw new Error(`Fixture directory not found: ${root}`);
  return {
    kind: 'fixture',
    dir: root,
    async respond(provider, { paper_id, target_kind, attempt = 1 }) {
      const candidates = [
        path.join(root, provider, `${paper_id}__${target_kind}__attempt${attempt}.md`),
        path.join(root, provider, `${paper_id}__${target_kind}.md`),
        path.join(root, provider, 'default.md'),
        path.join(root, 'default.md'),
      ];
      for (const c of candidates) {
        if (await exists(c)) return { text: await fs.readFile(c, 'utf8'), file: path.relative(root, c) };
      }
      return { text: '', file: null };
    },
  };
}

// One limiter per provider so free-tier rate limits are respected independently of item concurrency.
const providerLimiters = new Map();
function limiterFor(provider, concurrency) {
  const key = `${provider}:${concurrency}`;
  if (!providerLimiters.has(key)) providerLimiters.set(key, pLimit(Math.max(1, concurrency)));
  return providerLimiters.get(key);
}

/**
 * One generation call. Never throws for provider failures: they are returned as
 * `error` so the item is recorded as an infrastructure/provider failure.
 */
export async function generateOnce({
  provider, prompt, system = SYSTEM_PROMPT, temperature, maxTokens, effort = null, timeoutMs, retries = 4, baseDelayMs = 2000, maxDelayMs = 60000,
  providerConcurrency = 1, env = process.env, mode = 'live', fixture = null, meta = {},
}) {
  const d = describeProvider(provider, env);
  const base = {
    provider,
    display_name: mode === 'fixture' ? `fixture · ${d.label}` : d.display_name,
    label: d.label,
    vendor: d.vendor,
    model_id: mode === 'fixture' ? `fixture:${provider}` : d.model_id,
    api_host: mode === 'fixture' ? null : d.host,
    response_model: null,
    mode,
    text: '',
    usage: null,
    sampling: null, // what was actually sent: { temperature, effort }; null in fixture mode
    reasoning_chars: null,
    observed_latency_ms: null,
    working_ms: null, // the successful request only: no failed requests, no waits after them
    http_status: null,
    finish_reason: null,
    provider_attempts: null,
    retry_wait_ms: null,
    error: null,
    started_at: null,
    started_mono_ms: null,
    ended_at: null,
    ended_mono_ms: null,
  };
  const run = async () => {
    base.started_at = isoNow();
    base.started_mono_ms = nowMono();
    try {
      if (mode === 'fixture') {
        if (!fixture) throw new Error('fixture mode requires a fixture provider');
        const r = await fixture.respond(provider, meta);
        base.text = r.text;
        base.fixture_file = r.file;
        base.finish_reason = r.text ? 'fixture' : 'fixture_missing';
        base.provider_attempts = 1;
        if (!r.text) base.error = { kind: 'fixture_missing', message: 'no fixture response for this item', http_status: null };
      } else {
        const r = await callProvider(provider, { prompt, system, temperature, maxTokens, effort, timeoutMs, retries, baseDelayMs, maxDelayMs, env });
        base.text = r.text;
        base.usage = r.usage;
        base.sampling = r.sampling;
        base.reasoning_chars = r.reasoningChars;
        base.http_status = r.httpStatus;
        base.finish_reason = r.finishReason;
        base.response_model = r.responseModel;
        base.provider_attempts = r.attempts;
        base.retry_wait_ms = r.retryWaitMs;
        base.working_ms = r.workingMs ?? null;
        if (r.finishReason === 'length') base.truncated = true;
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        base.error = { kind: err.kind, message: err.message, http_status: err.httpStatus, body: err.body ?? null };
        base.http_status = err.httpStatus;
        base.provider_attempts = err.attempts ?? null;
      } else {
        base.error = { kind: 'runner_error', message: err.message, http_status: null };
      }
    }
    base.ended_mono_ms = nowMono();
    base.ended_at = isoNow();
    // Observed latency covers every attempt, including waits after rate-limit responses.
    base.observed_latency_ms = base.ended_mono_ms - base.started_mono_ms;
    if (mode === 'fixture' && !base.error) base.working_ms = base.observed_latency_ms;
    return base;
  };
  return mode === 'fixture' ? run() : limiterFor(provider, providerConcurrency)(run);
}

export const KNOWN_PROVIDER_IDS = PROVIDERS.map((p) => p.id);
