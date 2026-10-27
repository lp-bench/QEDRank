// Smoke test for the provider roster: send one small Lean 4 task to every configured model,
// report status/latency/tokens, and optionally compile each answer with the pinned toolchain.

import path from 'node:path';
import { callProvider, describeProvider, SYSTEM_PROMPT } from '../../lib/providers.js';
import { extractCodeBlocks } from './prompt.js';
import { staticScreen, parseImports } from './leansrc.js';
import { detectToolchain, LeanRunner } from './lean.js';
import { selectToolchain } from './leanenv.js';
import { pLimit, nowMono } from './util.js';

export const PING_PROMPT = `Write a Lean 4 proof for the commutativity of addition on natural numbers:
theorem add_comm_example (a b : ℕ) : a + b = b + a := by
`;

/** The Lean file to compile from a model answer: the largest lean code block, or the whole answer. */
export function leanFromAnswer(text) {
  const blocks = extractCodeBlocks(text || '').filter((b) => b.lang === 'lean' || b.lang === 'lean4' || b.lang === '');
  let code = blocks.length ? [...blocks].sort((a, b) => b.code.length - a.code.length)[0].code : (text || '').trim();
  if (!parseImports(code).length) code = `import Mathlib.Tactic\n\n${code}`;
  return code;
}

export async function pingModels(ids, { env = process.env, timeoutMs = 120000, maxTokens = 4096, retries = 1, compile = false, leanDir = 'lean', config = null, scratchDir, log = () => {} } = {}) {
  const limit = pLimit(10);
  let runner = null;
  if (compile) {
    // With the run configuration the configured backend applies (host, docker or apptainer).
    const tc = config ? await selectToolchain(config, { leanDir, log }) : await detectToolchain(leanDir, { log });
    runner = new LeanRunner(tc, { timeoutMs: 600000, memoryMb: 8192, maxHeartbeats: 400000 });
  }
  const results = await Promise.all(ids.map((id) => limit(async () => {
    const d = describeProvider(id, env);
    const row = { id, label: d.label, model_id: d.model_id, host: d.host, configured: d.configured, status: null, latency_ms: null, output_tokens: null, reasoning_tokens: null, attempts: null, answer: null, error: null, compile: null };
    if (d.retired) { row.status = 'retired'; row.error = d.retired; return row; }
    if (!d.configured) { row.status = 'not_configured'; row.error = `set ${d.env_key}${id === 'custom' ? ', QEDRANK_CUSTOM_BASE_URL and QEDRANK_CUSTOM_MODEL' : d.host ? '' : ` plus QEDRANK_BASEURL_${id.toUpperCase()} and QEDRANK_MODEL_${id.toUpperCase()}`}`; return row; }
    const t0 = nowMono();
    try {
      const r = await callProvider(id, { prompt: PING_PROMPT, system: SYSTEM_PROMPT, temperature: 0.1, effort: 'low', maxTokens, timeoutMs, retries, env });
      row.status = r.text ? 'ok' : 'empty';
      row.latency_ms = Math.round(nowMono() - t0);
      row.output_tokens = r.usage?.outputTokens ?? null;
      row.reasoning_tokens = r.usage?.reasoningTokens ?? null;
      row.attempts = r.attempts;
      row.response_model = r.responseModel;
      row.answer = r.text;
    } catch (err) {
      row.status = err.kind || 'error';
      row.latency_ms = Math.round(nowMono() - t0);
      row.error = err.message;
      row.attempts = err.attempts ?? null;
    }
    if (runner && row.status === 'ok') {
      const code = leanFromAnswer(row.answer);
      const screen = staticScreen(code);
      if (!screen.ok) row.compile = { status: 'rejected_by_static_screen', detail: screen.rejections.map((x) => `${x.code}:${x.text}`).join(', ') };
      else {
        const res = await runner.compileModule({ src: code, moduleName: `QRPing_${id.replace(/[^A-Za-z0-9]/g, '_')}`, scratchDir: path.join(scratchDir || path.join(leanDir, '.ping'), id) });
        const firstErr = (res.messages || []).find((m) => m.severity === 'error');
        row.compile = { status: res.status, placeholder: screen.flags.some((f) => f.code === 'placeholder'), duration_ms: Math.round(res.duration_ms || 0), first_error: firstErr ? `${firstErr.line}:${firstErr.column} ${firstErr.text.slice(0, 200)}` : null };
      }
    }
    log(`${id}: ${row.status}${row.latency_ms != null ? ` in ${row.latency_ms} ms` : ''}${row.compile ? `, compile ${row.compile.status}` : ''}`);
    return row;
  })));
  return results;
}
