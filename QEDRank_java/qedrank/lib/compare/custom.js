// A benchmark given only by a URL: a GitHub repository, branch or folder; a HuggingFace dataset; a
// raw JSON / JSONL / Lean file; or a local folder. Returns an adapter shaped like those in
// sources.js, so it is measured with exactly the same rules as the catalogued benchmarks.
//
//   Lean folder:  every theorem/lemma left as `sorry` is one problem; imports of modules found in
//                 the repository are followed (the benchmark's own library).
//   Rows:         the statement, header, name, subject, level and split fields are detected from
//                 the data (formal_statement, lean4_formalization, autoformalization, ...).
//
// A token is used for the download only: git receives it through its environment (never on the
// command line or in the clone's config) and HTTP requests through a header; it is never stored.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sha256 } from '../util.js';
import { gitCheckout, listFiles, hfRows, rawFile } from './fetch.js';
import { findDeclarations, stripComments } from '../leansrc.js';

const MAX_FILES = 20000;
const MAX_ROWS = 50000;
const SKIP_DIRS = /(^|\/)(\.lake|lake-packages|\.github|node_modules|build)\//;

/** What kind of source a URL names. */
export function parseBenchmarkUrl(input, { ref = null, folder = null } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('enter a URL');
  if (/^[a-zA-Z]:[\\/]|^\.{0,2}\//.test(raw) || raw.startsWith('file://')) {
    return { kind: 'local', dir: raw.replace(/^file:\/\//, ''), folder: folder || null };
  }
  let u;
  try { u = new URL(raw); } catch { throw new Error(`not a URL: ${raw}`); }
  if (u.protocol !== 'https:') throw new Error('only https:// URLs (or a local folder) are accepted');
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'github.com') {
    if (parts.length < 2) throw new Error('a GitHub link needs https://github.com/<owner>/<repo>');
    const [owner, repo] = [parts[0], parts[1].replace(/\.git$/, '')];
    // …/blob/<ref>/<file>: one data file.
    if (parts[2] === 'blob' && parts.length > 4) {
      return { kind: 'file', url: `https://raw.githubusercontent.com/${owner}/${repo}/${parts.slice(3).join('/')}`, name: parts[parts.length - 1], github: true };
    }
    // …/tree/<ref>/<folder>: the first segment is taken as the branch unless `ref` is given.
    let r = ref || null;
    let f = folder || null;
    if (parts[2] === 'tree' && parts.length > 3) {
      if (!r) { r = parts[3]; if (!f && parts.length > 4) f = parts.slice(4).join('/'); } else if (!f) {
        const rest = parts.slice(3).join('/');
        f = rest.startsWith(`${r}/`) ? rest.slice(r.length + 1) : null;
      }
    }
    return { kind: 'git', url: `https://github.com/${owner}/${repo}.git`, web: `https://github.com/${owner}/${repo}`, ref: r, folder: f, owner, repo };
  }
  if (u.hostname === 'raw.githubusercontent.com') return { kind: 'file', url: raw, name: parts[parts.length - 1], github: true };
  if (u.hostname === 'huggingface.co' && parts[0] === 'datasets' && parts.length >= 3) {
    if (parts[3] === 'resolve' || parts[3] === 'blob') return { kind: 'file', url: raw.replace('/blob/', '/resolve/'), name: parts[parts.length - 1] };
    return { kind: 'hf', dataset: `${parts[1]}/${parts[2]}` };
  }
  if (/\.(jsonl?|lean)(\?.*)?$/i.test(u.pathname)) return { kind: 'file', url: raw, name: parts[parts.length - 1] };
  throw new Error('use a GitHub repository/branch/folder link, a HuggingFace dataset link, a .json/.jsonl/.lean file URL, or a local folder');
}

// ------------------------------------------------------------------------------------------
// Row datasets: field detection
// ------------------------------------------------------------------------------------------

const STATEMENT_KEYS = ['formal_statement', 'lean4_formalization', 'autoformalization', 'lean_statement', 'lean4_statement', 'formal', 'lean4_code', 'lean_code', 'lean4_src', 'statement', 'theorem', 'code'];
const HEADER_KEYS = ['header', 'lean4_src_header', 'src_header', 'lean_header', 'imports'];
const ID_KEYS = ['name', 'id', 'theorem_name', 'problem_name', 'theorem_names', 'problem_id', 'uid'];
const SUBJECT_KEYS = ['domain', 'subject', 'category', 'msc', 'tags', 'topic', 'area'];
const LEVEL_KEYS = ['level', 'difficulty', 'difficult', 'grade'];

const asText = (v) => (Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : typeof v === 'string' ? v : null);
const looksLean = (s) => typeof s === 'string' && /\b(theorem|lemma)\s+[^\s:]/.test(s);

/** Field names for statement, header, id, subject, level and split, chosen from sample rows. */
export function detectFields(rows) {
  const sample = rows.slice(0, 50);
  const keys = [...new Set(sample.flatMap((r) => Object.keys(r || {})))];
  const share = (k, pred) => sample.filter((r) => pred(r?.[k])).length / Math.max(1, sample.length);
  const pick = (cands, pred, min = 0.5) => cands.find((k) => keys.includes(k) && share(k, pred) >= min) || null;
  const statement = pick(STATEMENT_KEYS, (v) => looksLean(asText(v)))
    || keys.find((k) => share(k, (v) => looksLean(asText(v))) >= 0.5) || null;
  return {
    statement,
    header: pick(HEADER_KEYS, (v) => typeof v === 'string', 0.5),
    id: pick(ID_KEYS, (v) => typeof v === 'string' || typeof v === 'number', 0.9),
    subject: pick(SUBJECT_KEYS, (v) => (typeof v === 'string' && v) || (Array.isArray(v) && v.length), 0.3),
    level: pick(LEVEL_KEYS, (v) => typeof v === 'string' && v, 0.3),
    split: keys.includes('split') ? 'split' : null,
  };
}

/** Map a free-text difficulty or source label onto the shared levels (null when it says nothing). */
export function normalizeLevel(label) {
  const s = String(label || '').replace(/​/g, '').toLowerCase();
  if (!s) return null;
  if (/\bopen\b|unsolved|conjecture/.test(s)) return 'open';
  if (/research/.test(s)) return 'research';
  if (/graduate|phd|qualifying/.test(s) && !/under/.test(s)) return 'graduate';
  if (/undergrad|university|college|textbook/.test(s)) return 'undergraduate';
  if (/olymp|competition|imo|amc|aime|putnam|contest/.test(s)) return 'competition';
  if (/high.?school|middle.?school|school|elementary|grade/.test(s)) return 'coursework';
  return null;
}

/** Subject label from a domain path ("Mathematics -> Algebra -> …"), a list, or a plain string. */
function subjectOf(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
  if (typeof v !== 'string' || !v) return null;
  const parts = v.replace(/;\s*$/, '').split(/->|>|\/|::/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && /^mathematics$/i.test(parts[0])) return parts[1];
  return parts[0];
}

export function rowsToProblems(rows, fields) {
  if (!fields.statement) throw new Error('no field with Lean theorem statements found in the data');
  const problems = [];
  rows.slice(0, MAX_ROWS).forEach((r, i) => {
    const stmt = asText(r[fields.statement]);
    if (!stmt) return;
    const header = fields.header && typeof r[fields.header] === 'string' ? r[fields.header] : '';
    let text = header && !stmt.includes(header.trim()) ? `${header.replace(/\s+$/, '')}\n${stmt}` : stmt;
    if (!/\bsorry\s*$/.test(text.trim())) text = `${text.replace(/\s+$/, '')}${/:=\s*(by)?\s*$/.test(text.trim()) ? ' sorry' : ''}\n`;
    const id = fields.id ? String(r[fields.id]) : String(i + 1);
    problems.push({
      id,
      text,
      target: null,
      subject: fields.subject ? subjectOf(r[fields.subject]) : null,
      level: fields.level ? normalizeLevel(r[fields.level]) : null,
      split: fields.split ? String(r[fields.split]) : null,
    });
  });
  return problems;
}

function parseRows(text, name) {
  const t = text.trim();
  if (/\.jsonl$/i.test(name) || (!t.startsWith('[') && !t.startsWith('{'))) return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const j = JSON.parse(t);
  if (Array.isArray(j)) return j;
  for (const k of ['data', 'rows', 'problems', 'items', 'train', 'test']) if (Array.isArray(j[k])) return j[k];
  throw new Error('the JSON file holds no array of problems');
}

// ------------------------------------------------------------------------------------------
// Lean folders
// ------------------------------------------------------------------------------------------

/** One problem per theorem/lemma left as `sorry` in each file. */
export function leanFileProblems(rel, text) {
  const out = [];
  for (const d of findDeclarations(text)) {
    if (d.kind !== 'theorem' && d.kind !== 'lemma') continue;
    if (!/\bsorry\b/.test(stripComments(d.body || ''))) continue;
    out.push({ id: `${rel.replace(/\.lean$/, '')}:${d.name}`, text, target: d.name });
  }
  return out;
}

/** Module name -> file, keyed by every path suffix so `CombiBench.X` finds lean/CombiBench/X.lean. */
function moduleIndex(files) {
  const idx = new Map();
  for (const f of files) {
    const segs = f.replace(/\.lean$/, '').split('/');
    for (let i = 0; i < segs.length; i += 1) {
      const key = segs.slice(i).join('.');
      if (!idx.has(key) || idx.get(key).length > f.length) idx.set(key, f);
    }
  }
  return idx;
}

async function leanFolderAdapter(root, folder, source) {
  const base = folder ? path.join(root, ...folder.split('/')) : root;
  if (!(await fs.stat(base).catch(() => null))?.isDirectory()) throw new Error(`folder not found: ${folder || root}`);
  const all = (await listFiles(root, /\.lean$/)).filter((f) => !SKIP_DIRS.test(`${f}`) && !/^lakefile\.lean$/.test(f));
  if (all.length > MAX_FILES) throw new Error(`${all.length} Lean files, above the limit of ${MAX_FILES}`);
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  const inFolder = all.filter((f) => f.startsWith(prefix));
  const idx = moduleIndex(all);
  const cache = new Map();
  const read = (f) => { if (!cache.has(f)) cache.set(f, fs.readFile(path.join(root, ...f.split('/')), 'utf8')); return cache.get(f); };
  let problems = [];
  for (const f of inFolder) problems.push(...leanFileProblems(f, await read(f)));
  let rule = 'every theorem or lemma left as sorry is one problem';
  if (!problems.length) {
    // Statements shipped with their proofs: one problem per file, its last theorem.
    rule = 'no sorry in the folder: one problem per file, its last theorem';
    problems = [];
    for (const f of inFolder) {
      const text = await read(f);
      const thms = findDeclarations(text).filter((d) => d.kind === 'theorem' || d.kind === 'lemma');
      if (thms.length) problems.push({ id: `${f.replace(/\.lean$/, '')}:${thms[thms.length - 1].name}`, text, target: thms[thms.length - 1].name });
    }
  }
  if (!problems.length) throw new Error(`no theorem found in ${inFolder.length} Lean file(s)${folder ? ` under ${folder}` : ''}`);
  return { source: { ...source, target_rule: rule }, problems, readModule: async (mod) => (idx.has(mod) ? read(idx.get(mod)) : null) };
}

// ------------------------------------------------------------------------------------------
// The adapter
// ------------------------------------------------------------------------------------------

/**
 * @param {object} p  { id, url, ref?, folder?, token? }
 * @returns an adapter { id, problems({ cacheDir, refresh, log }) } like those in sources.js
 */
export function customSource({ id, url, ref = null, folder = null, token = null }) {
  const spec = parseBenchmarkUrl(url, { ref, folder });
  const key = `custom-${sha256(`${spec.url || spec.dataset || spec.dir}|${spec.ref || ''}`).slice(0, 12)}`;
  return {
    id: id || key,
    cacheKey: key,
    spec,
    async problems({ cacheDir, refresh = false, log = () => {} }) {
      if (spec.kind === 'local') {
        const dir = path.resolve(spec.dir);
        return leanFolderAdapter(dir, spec.folder, { kind: 'local', url: `file://${dir}`, label: dir, commit: null, date: null });
      }
      if (spec.kind === 'git') {
        const co = await gitCheckout({ url: spec.url, ref: spec.ref, cacheDir: path.join(cacheDir, 'custom'), name: key, refresh, log, token });
        return leanFolderAdapter(co.dir, spec.folder, { kind: 'git', url: spec.web, label: `${spec.owner}/${spec.repo}${spec.folder ? `/${spec.folder}` : ''}${spec.ref ? ` @ ${spec.ref}` : ''}`, commit: co.commit, date: co.commit_date });
      }
      if (spec.kind === 'hf') {
        const splits = await fetch(`https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(spec.dataset)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const list = (splits?.splits || []).filter((s) => s.config === (splits.splits[0]?.config));
        if (!list.length) throw new Error(`no splits found for ${spec.dataset} (private or not indexed by the HuggingFace datasets server?)`);
        const rows = [];
        let commit = null;
        for (const s of list) {
          const got = await hfRows({ dataset: spec.dataset, config: s.config, split: s.split, cacheDir: path.join(cacheDir, 'custom'), refresh, log });
          commit = got.commit || commit;
          for (const r of got.rows) rows.push({ split: s.split, ...r });
        }
        const fields = detectFields(rows);
        return { source: { kind: 'hf', url: `https://huggingface.co/datasets/${spec.dataset}`, label: `${spec.dataset} (${list.map((s) => s.split).join(', ')})`, commit, date: null, fields }, problems: rowsToProblems(rows, fields) };
      }
      // A single file.
      const text = await rawFile({ url: spec.url, cacheDir: path.join(cacheDir, 'custom'), name: `${key}-${spec.name}`, refresh, headers: token ? { Authorization: `${spec.github ? 'token' : 'Bearer'} ${token}` } : {} });
      if (/\.lean$/i.test(spec.name)) {
        const problems = leanFileProblems(spec.name, text);
        if (!problems.length) throw new Error('no theorem left as sorry in the file');
        return { source: { kind: 'file', url: spec.url, label: spec.name, commit: sha256(text).slice(0, 12), date: null }, problems };
      }
      const rows = parseRows(text, spec.name);
      const fields = detectFields(rows);
      return { source: { kind: 'file', url: spec.url, label: spec.name, commit: sha256(text).slice(0, 12), date: null, fields }, problems: rowsToProblems(rows, fields) };
    },
  };
}
