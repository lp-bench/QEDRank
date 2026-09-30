// Runner-side adapter over the project's five provider integrations.
// Live mode calls lib/providers.js (the same code the single-problem endpoint
// uses). Fixture mode replays canned responses for tests and dry runs; it is
// always labeled as such in every record it produces.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROVIDERS, callProvider, resolveModelId, isConfigured, ProviderError } from '../../lib/providers.js';
import { nowMono, isoNow, exists } from './util.js';

export function listModels(env = process.env) {
  return PROVIDERS.map((p) => ({ id: p.id, display_name: p.displayName, model_id: resolveModelId(p.id, env), configured: isConfigured(p.id, env) }));
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

/**
 * One generation call. Never throws for provider failures: they are returned as
 * `error` so the item is recorded as an infrastructure/provider failure.
 */
export async function generateOnce({ provider, prompt, temperature, maxTokens, timeoutMs, env = process.env, mode = 'live', fixture = null, meta = {} }) {
  const started = { iso: isoNow(), mono_ms: nowMono() };
  const base = {
    provider,
    display_name: PROVIDERS.find((p) => p.id === provider)?.displayName ?? provider,
    model_id: mode === 'fixture' ? `fixture:${provider}` : resolveModelId(provider, env),
    response_model: null,
    mode,
    text: '',
    usage: null,
    observed_latency_ms: null,
    http_status: null,
    finish_reason: null,
    error: null,
    started_at: started.iso,
    started_mono_ms: started.mono_ms,
    ended_at: null,
    ended_mono_ms: null,
  };
  try {
    if (mode === 'fixture') {
      if (!fixture) throw new Error('fixture mode requires a fixture provider');
      const r = await fixture.respond(provider, meta);
      base.text = r.text;
      base.fixture_file = r.file;
      base.finish_reason = r.text ? 'fixture' : 'fixture_missing';
      if (!r.text) base.error = { kind: 'fixture_missing', message: 'no fixture response for this item', http_status: null };
    } else {
      const r = await callProvider(provider, { prompt, temperature, maxTokens, timeoutMs, env });
      base.text = r.text;
      base.usage = r.usage;
      base.http_status = r.httpStatus;
      base.finish_reason = r.finishReason;
      base.response_model = r.responseModel;
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      base.error = { kind: err.kind, message: err.message, http_status: err.httpStatus, body: err.body ?? null };
      base.http_status = err.httpStatus;
    } else {
      base.error = { kind: 'runner_error', message: err.message, http_status: null };
    }
  }
  base.ended_mono_ms = nowMono();
  base.ended_at = isoNow();
  base.observed_latency_ms = base.ended_mono_ms - base.started_mono_ms;
  return base;
}
