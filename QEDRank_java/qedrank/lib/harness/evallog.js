// Reader for Inspect AI evaluation logs: `.eval` (a zip of header.json, samples/*.json and a
// journal) or `.json`. Returns the parts QEDRank needs in one plain shape, with each sample
// normalised to what the importers read (metadata, store, scores, usage, timing, events counts).
// A log that is still being written, or was cancelled, has no header.json: its spec comes from
// _journal/start.json and its samples are the ones already written, which are complete attempts.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function sumUsage(modelUsage) {
  const out = { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0, input_tokens_cache_read: 0, input_tokens_cache_write: 0, models: [] };
  let any = false;
  for (const [model, u] of Object.entries(modelUsage || {})) {
    any = true;
    out.models.push(model);
    for (const k of ['input_tokens', 'output_tokens', 'total_tokens', 'reasoning_tokens', 'input_tokens_cache_read', 'input_tokens_cache_write']) out[k] += num(u?.[k]) ?? 0;
  }
  return any ? out : null;
}

function eventCounts(events) {
  const c = { tool_calls: 0, tool_errors: 0, model_calls: 0, tool_calls_by_tool: {} };
  for (const e of events || []) {
    if (e?.event === 'tool') {
      c.tool_calls += 1;
      if (e.error) c.tool_errors += 1;
      const fn = e.function || 'tool';
      c.tool_calls_by_tool[fn] = (c.tool_calls_by_tool[fn] || 0) + 1;
    } else if (e?.event === 'model') c.model_calls += 1;
  }
  return c;
}

/** One EvalSample -> the fields the importers read. */
export function normalizeSample(s) {
  const scores = {};
  for (const [name, sc] of Object.entries(s.scores || {})) scores[name] = { value: sc?.value ?? null, explanation: sc?.explanation ?? null, metadata: sc?.metadata ?? {} };
  return {
    id: String(s.id),
    epoch: num(s.epoch) ?? 1,
    uuid: s.uuid ?? null,
    metadata: s.metadata || {},
    store: s.store || {},
    scores,
    usage: sumUsage(s.model_usage),
    total_time_s: num(s.total_time),
    working_time_s: num(s.working_time),
    started_at: s.started_at ?? null,
    completed_at: s.completed_at ?? null,
    limit: s.limit ? { type: s.limit.type, limit: s.limit.limit } : null,
    error: s.error ? { message: String(s.error.message || s.error.traceback || 'sample error').slice(0, 1000) } : null,
    error_retries: Array.isArray(s.error_retries) ? s.error_retries.length : 0,
    events: eventCounts(s.events),
    messages: Array.isArray(s.messages) ? s.messages.length : null,
    completion: s.output?.completion ?? null,
  };
}

function normalizeLog({ header, samples, file, format, started }) {
  const spec = header?.eval || started?.eval || {};
  return {
    file,
    format,
    status: header?.status || (started ? 'started' : 'unknown'),
    eval: {
      run_id: spec.run_id ?? null,
      task: spec.task ?? null,
      task_id: spec.task_id ?? null,
      created: spec.created ?? null,
      model: spec.model ?? null,
      model_generate_config: spec.model_generate_config ?? null,
      task_args: spec.task_args ?? {},
      metadata: spec.metadata ?? {},
      config: spec.config ?? {},
      revision: spec.revision ?? null,
      packages: spec.packages ?? {},
      sandbox: spec.sandbox ?? null,
      dataset: spec.dataset ? { name: spec.dataset.name ?? null, samples: spec.dataset.samples ?? null, sample_ids: spec.dataset.sample_ids ?? null } : null,
    },
    plan: header?.plan ?? started?.plan ?? null,
    results: header?.results ?? null,
    stats: header?.stats ?? null,
    error: header?.error ? { message: String(header.error.message || 'eval error').slice(0, 1000) } : null,
    samples: samples.map(normalizeSample).sort((a, b) => a.id.localeCompare(b.id) || a.epoch - b.epoch),
  };
}

/** Read one log file. */
export async function readEvalLog(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    return normalizeLog({ header: j, samples: j.samples || [], file, format: 'json' });
  }
  if (ext !== '.eval') throw new Error(`${file}: not an Inspect log (.eval or .json)`);
  const zip = openZip(await fs.readFile(file));
  const parse = (name) => JSON.parse(zip.read(name).toString('utf8'));
  const header = zip.has('header.json') ? parse('header.json') : null;
  const started = !header && zip.has('_journal/start.json') ? parse('_journal/start.json') : null;
  const samples = zip.names.filter((n) => /^samples\/.+\.json$/.test(n)).map(parse);
  return normalizeLog({ header, samples, file, format: 'eval', started });
}

/** Every log in a directory (not recursive), newest last. */
export async function readEvalLogs(dir) {
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const logs = [];
  for (const n of names.filter((x) => /\.(eval|json)$/i.test(x) && !/^(manifest|results)\.json$/i.test(x)).sort()) {
    const file = path.join(dir, n);
    try { logs.push(await readEvalLog(file)); } catch (err) { logs.push({ file, format: 'unreadable', status: 'unreadable', error: { message: err.message }, eval: {}, samples: [] }); }
  }
  return logs;
}
