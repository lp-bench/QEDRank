// Browser-side helpers for the QEDRank page. No Node imports here.

export const MODEL_ORDER = ['gemini', 'openai', 'anthropic', 'cohere', 'mistral'];
export const TARGET_KINDS = ['main_theorem', 'upper_bound', 'lower_bound', 'disproof'];
export const TARGET_LABELS = { main_theorem: 'Main theorem', upper_bound: 'Upper bound', lower_bound: 'Lower bound', disproof: 'Disproof', all: 'All targets' };

// Categorical slots in fixed order (validated palette; identity follows the model, never rank).
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];

export function seriesColor(modelId, dark) {
  const i = MODEL_ORDER.indexOf(modelId);
  const pal = dark ? SERIES_DARK : SERIES_LIGHT;
  return pal[i >= 0 ? i : pal.length - 1];
}

export function fmtRate(r) {
  if (!r || r.den === undefined || r.den === null) return 'unavailable';
  if (r.den === 0) return '0/0 (unavailable)';
  return `${r.num}/${r.den} (${(100 * r.value).toFixed(1)}%)`;
}

export function fmtCI(r) {
  if (!r || r.ci_lo === null || r.ci_lo === undefined) return '';
  return `95% CI [${(100 * r.ci_lo).toFixed(1)}%, ${(100 * r.ci_hi).toFixed(1)}%]`;
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unavailable';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

export function fmtNum(x, digits = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'unavailable';
  return Number(x).toFixed(digits);
}

export function fmtInt(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'unavailable';
  return String(Math.round(x));
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

/** Simple num/den rate over flat item rows for client-side filtered views (no CI). */
export function rateOf(rows, numFn, denFn) {
  let num = 0;
  let den = 0;
  for (const r of rows) if (denFn(r)) { den += 1; if (numFn(r)) num += 1; }
  return { num, den, value: den ? num / den : null };
}

export function useDarkMode() {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
