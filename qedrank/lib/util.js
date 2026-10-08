import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Monotonic clock in milliseconds (fractional). */
export function nowMono() {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function isoNow() {
  return new Date().toISOString();
}

/** A raw timestamp pair: wall-clock ISO plus monotonic ms. */
export function stamp() {
  return { iso: isoNow(), mono_ms: nowMono() };
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Atomic JSON write (tmp file + rename) so interrupted runs never leave half-written artifacts. */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text, 'utf8');
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows, columns) {
  const cols = columns || Array.from(rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set()));
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Sanitize an arbitrary string into a safe file/directory name. */
export function slug(s, max = 80) {
  const out = String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (out || 'x').slice(0, max);
}

/** Sanitize into a valid Lean identifier component. */
export function leanIdent(s) {
  let out = String(s).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '');
  if (!out) out = 'X';
  if (/^[0-9]/.test(out)) out = `P${out}`;
  return out;
}

/** Minimal concurrency limiter. */
export function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

export function quantile(values, q) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function summarize(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return { n: 0, median: null, q1: null, q3: null, p90: null, min: null, max: null };
  return {
    n: xs.length,
    median: quantile(xs, 0.5),
    q1: quantile(xs, 0.25),
    q3: quantile(xs, 0.75),
    p90: quantile(xs, 0.9),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

export function round(x, digits = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x ?? null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible for a given seed. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
