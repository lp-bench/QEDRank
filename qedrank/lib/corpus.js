// Corpus discovery: turn a repository file listing into a preview manifest of
// papers, PDFs and ground-truth Lean targets. Layouts vary between corpora, so
// every mapping decision is recorded and anything ambiguous is flagged for
// review instead of guessed.
//
// Paper directories are found from Lean target files first (…_UB.lean, Main.lean,
// <PaperId>/<PaperId>.lean, …), then PDFs are attached: PDFs inside the paper
// directory, or a PDF elsewhere in the repository whose file name is the paper
// id (e.g. DATABASE/content/pdf/P007.pdf). Only PDFs that belong to no Lean-based
// paper create PDF-only papers. A repository index JSON (Database.json, …) can
// supply titles, subject codes and difficulty; its Lean text fields are never
// copied into the manifest.

import path from 'node:path';
import { MANIFEST_SCHEMA, TARGET_KINDS } from './schema.js';
import { sha256, slug, isoNow, pLimit, nowMono } from './util.js';
import { parseImports, candidateDeclarations, staticScreen } from './leansrc.js';

export const PAPER_METADATA_FILES = ['metadata.json', 'paper.json', 'info.json', 'meta.json', 'qedrank.json'];
export const ANNOTATIONS_FILE = 'qedrank-annotations.json';
export const INDEX_FILE_NAMES = ['database.json', 'index.json', 'papers.json', 'problems.json', 'corpus.json'];

const KIND_TOKENS = {
  main_theorem: new Set(['main', 'maintheorem', 'mainthm', 'theorem', 'thm', 'mainresult', 'result']),
  upper_bound: new Set(['upper', 'upperbound', 'ub', 'upperbd', 'upperbounds']),
  lower_bound: new Set(['lower', 'lowerbound', 'lb', 'lowerbd', 'lowerbounds']),
  disproof: new Set(['disprove', 'disproof', 'disproved', 'disproven', 'counterexample', 'counter', 'refute', 'refutation', 'refuted', 'false', 'negation']),
};
const COMPACT_HINTS = {
  main_theorem: ['maintheorem', 'mainthm', 'mainresult'],
  upper_bound: ['upperbound', 'upperbd'],
  lower_bound: ['lowerbound', 'lowerbd'],
  disproof: ['counterexample', 'disproof', 'disprove'],
};
const GENERIC_DIR_NAMES = new Set(['lean', 'src', 'proofs', 'proof', 'formal', 'formalization', 'formalisation', 'lean4', 'code', 'ground_truth', 'groundtruth', 'gt', 'reference', 'references', 'targets', 'paper', 'pdf', 'pdfs']);
const SHARED_DEF_STEMS = new Set(['defs', 'definitions', 'common', 'prelude', 'shared', 'basic', 'basics', 'setup', 'preliminaries', 'notation']);
const STD_IMPORT = /^(Mathlib|Std|Lean|Init|Aesop|Batteries|Qq|ProofWidgets|Plausible)(\.|$)/;

function tokens(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Classify a Lean file by its path relative to the paper directory. */
export function classifyLeanFile(relPath) {
  const stem = path.posix.basename(relPath).replace(/\.lean$/i, '');
  const segs = relPath.split('/');
  const toks = new Set();
  const compact = [];
  for (const seg of segs) {
    const s = seg.replace(/\.lean$/i, '');
    tokens(s).forEach((t) => toks.add(t));
    compact.push(s.toLowerCase().replace(/[^a-z0-9]/g, ''));
  }
  const matched = [];
  for (const kind of TARGET_KINDS) {
    const hit = [...toks].some((t) => KIND_TOKENS[kind].has(t)) || compact.some((c) => COMPACT_HINTS[kind].some((h) => c.includes(h)));
    if (hit) matched.push(kind);
  }
  // "theorem"/"result" alone are weak signals for main_theorem; drop them if a stronger kind also matched.
  const weakMain = matched.includes('main_theorem') && ![...toks].some((t) => ['main', 'maintheorem', 'mainthm', 'mainresult'].includes(t)) && !compact.some((c) => COMPACT_HINTS.main_theorem.some((h) => c.includes(h)));
  let kinds = matched;
  if (weakMain && matched.length > 1) kinds = matched.filter((k) => k !== 'main_theorem');
  const isShared = SHARED_DEF_STEMS.has(stem.toLowerCase()) && kinds.length === 0;
  return {
    kind: kinds.length === 1 ? kinds[0] : null,
    matched: kinds,
    ambiguous: kinds.length > 1,
    weak: kinds.length === 1 && weakMain,
    shared: isShared,
  };
}

function dirname(p) {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
}

function basename(p) {
  return path.posix.basename(p);
}

function stemOf(p) {
  return basename(p).replace(/\.[^.]+$/, '');
}

function isPaperLikeDirName(name) {
  return !GENERIC_DIR_NAMES.has(name.toLowerCase());
}

function ancestors(p) {
  const out = [];
  let d = dirname(p);
  while (true) {
    out.push(d);
    if (d === '') break;
    d = dirname(d);
  }
  return out; // nearest first, ends with ''
}

function parseBibTitle(text) {
  const m = /title\s*=\s*[{"]\s*([^}"]+?)\s*[}"]/i.exec(text);
  return m ? m[1].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : null;
}

function firstHeading(md) {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? m[1].trim() : null;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** "P014", "p-014", "014", "14" all normalise to "14"; non-numeric ids compare case-insensitively. */
export function normalizeId(id) {
  const s = String(id ?? '').trim();
  const m = /^[A-Za-z_-]*0*(\d+)$/.exec(s);
  if (m) return `#${m[1]}`;
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function wordSet(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function overlap(a, b) {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}

/** Mathematical status of the main claim from an index entry; null when the entry does not say. */
function statusFromIndex(entry) {
  for (const key of ['mathematical_status', 'status']) {
    const v = typeof entry[key] === 'string' ? entry[key].trim().toLowerCase() : '';
    if (['established', 'open', 'refuted', 'uncertain'].includes(v)) return { status: v, field: key };
  }
  const d = typeof entry.difficulty === 'string' ? entry.difficulty.trim() : '';
  if (/^open$/i.test(d)) return { status: 'open', field: 'difficulty' };
  if (/proved in (the )?literature|full lean reference proof/i.test(d)) return { status: 'established', field: 'difficulty' };
  return null;
}

function subjectTagsFromIndex(entry) {
  const raw = entry.subject_tags ?? entry.msc ?? entry.subjects ?? null;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [];
  return list.map((t) => {
    const m = /\b(\d{2}[A-Z]\d{2}|\d{2}[A-Z]xx|\d{2}[A-Z]|\d{2}-XX)\b/.exec(String(t));
    return m ? m[1] : String(t).trim();
  }).filter(Boolean);
}

/** Load repository index files (array of {id, name|title, ...}). Only whitelisted fields are kept. */
async function loadIndexes(allFiles, read, globalFlags) {
  const candidates = allFiles.filter((f) => INDEX_FILE_NAMES.includes(basename(f.path).toLowerCase()) && (f.size ?? 0) <= 16 * 1024 * 1024);
  const entries = new Map(); // normalized id -> {entry, file}
  const used = [];
  for (const f of candidates) {
    let json;
    try {
      json = safeJson((await read(f.path, 16 * 1024 * 1024)).toString('utf8'));
    } catch (err) {
      globalFlags.push({ code: 'index_unreadable', message: `${f.path}: ${err.message}` });
      continue;
    }
    const arr = Array.isArray(json) ? json : json && typeof json === 'object' ? (json.papers || json.problems || json.entries || Object.values(json).find(Array.isArray)) : null;
    if (!Array.isArray(arr) || !arr.length || !arr.every((e) => e && typeof e === 'object' && 'id' in e)) continue;
    let n = 0;
    for (const e of arr) {
      const key = normalizeId(e.id);
      if (!key || entries.has(key)) continue;
      entries.set(key, {
        file: f.path,
        entry: {
          id: String(e.id),
          title: typeof (e.title ?? e.name) === 'string' ? (e.title ?? e.name).trim() : null,
          citation: typeof e.citation === 'string' ? e.citation : null,
          references: Array.isArray(e.references) ? e.references.filter((r) => typeof r === 'string').slice(0, 20) : [],
          subject_tags: subjectTagsFromIndex(e),
          msc_raw: typeof e.msc === 'string' ? e.msc : null,
          difficulty: typeof e.difficulty === 'string' ? e.difficulty.trim() : null,
          status: statusFromIndex(e),
        },
      });
      n += 1;
    }
    if (n) used.push({ path: f.path, entries: n });
  }
  return { entries, files: used };
}

/**
 * Build the preview manifest.
 * @param {import('./source.js').GitHubSource|import('./source.js').LocalSource} source
 * @param {object} opts
 * @param {boolean} [opts.readLeanFiles=true] read Lean/metadata contents (needed for declaration names)
 * @param {string|null} [opts.subdir] restrict paper discovery to this folder (defaults to source.subdir)
 * @param {object} [opts.annotations] pre-loaded annotations (overrides the repo file)
 * @param {number} [opts.expectedCount=108]
 * @param {number} [opts.maxLeanReads] cap on Lean files read (preview budget)
 * @param {number} [opts.timeBudgetMs] stop reading Lean files after this long (preview budget)
 * @param {number} [opts.concurrency=8] parallel file reads
 * @param {(msg:string)=>void} [opts.log]
 */
export async function discoverCorpus(source, {
  readLeanFiles = true,
  maxLeanBytes = 2 * 1024 * 1024,
  maxMetaBytes = 256 * 1024,
  annotations = null,
  expectedCount = 108,
  maxLeanReads = Infinity,
  timeBudgetMs = Infinity,
  concurrency = 8,
  subdir = undefined,
  log = () => {},
} = {}) {
  const t0 = nowMono();
  let leanReads = 0;
  let budgetExhausted = false;
  const descriptor = await source.resolve();
  const { files: allFiles, truncated, totalBlobs } = await source.listTree();
  const root = (subdir === undefined ? source.subdir : subdir) || '';
  const globalFlags = [];
  if (truncated) globalFlags.push({ code: 'tree_truncated', message: 'GitHub returned a truncated tree; some files may be missing from discovery.' });
  const inRoot = (p) => (root ? p === root || p.startsWith(`${root}/`) : true);
  const files = allFiles.filter((f) => inRoot(f.path));
  if (root && files.length === 0) globalFlags.push({ code: 'subdir_empty', message: `No eligible files under ${root}` });
  const insideRootDir = (d) => (root ? d.startsWith(`${root}/`) : d !== '');

  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  const leans = files.filter((f) => f.path.toLowerCase().endsWith('.lean'));
  const pdfsAll = allFiles.filter((f) => f.path.toLowerCase().endsWith('.pdf'));
  const cache = new Map();
  const read = (p, maxBytes) => {
    if (!cache.has(p)) cache.set(p, source.readFile(p, { maxBytes }));
    return cache.get(p);
  };

  // Repository-level annotations.
  let repoAnnotations = null;
  if (byPath.has(ANNOTATIONS_FILE) && readLeanFiles) {
    try {
      repoAnnotations = safeJson((await read(ANNOTATIONS_FILE, maxMetaBytes * 8)).toString('utf8'));
      if (!repoAnnotations) globalFlags.push({ code: 'annotations_unparseable', message: `${ANNOTATIONS_FILE} is not valid JSON` });
    } catch (err) {
      globalFlags.push({ code: 'annotations_unreadable', message: err.message });
    }
  }
  const ann = annotations || repoAnnotations || {};
  const annPapers = ann.papers || {};
  const index = readLeanFiles ? await loadIndexes(allFiles, read, globalFlags) : { entries: new Map(), files: [] };

  // 1. Paper directories from Lean target files (and <Id>/<Id>.lean main files).
  const papers = new Map(); // key: paper dir (or "flat:<pdf path>")
  const mkDirPaper = (dir) => ({ key: dir, layout: 'dir_per_paper', dir, stem: basename(dir), pdfCandidates: [], leanFiles: [], flags: [] });
  for (const f of leans) {
    const parent = dirname(f.path);
    const stem = stemOf(f.path).toLowerCase();
    const cls = classifyLeanFile(basename(f.path));
    const stemIsDir = parent && stem === basename(parent).toLowerCase();
    if (!cls.kind && !stemIsDir) continue;
    let dir = parent;
    while (dir && insideRootDir(dir) && !isPaperLikeDirName(basename(dir))) dir = dirname(dir);
    if (!dir || !insideRootDir(dir)) continue;
    if (!papers.has(dir)) papers.set(dir, mkDirPaper(dir));
  }
  const nearestPaperDir = (p) => ancestors(p).find((a) => papers.has(a) && papers.get(a).layout === 'dir_per_paper' && insideRootDir(a));

  // 2. PDFs: inside a paper directory, or named after a paper id anywhere in the repository.
  const paperByNormId = new Map();
  for (const p of papers.values()) {
    const k = normalizeId(p.stem);
    paperByNormId.set(k, paperByNormId.has(k) ? null : p); // null marks an ambiguous id
  }
  const unplaced = [];
  for (const f of pdfsAll) {
    const owner = nearestPaperDir(f.path);
    if (owner) { papers.get(owner).pdfCandidates.push({ ...f, origin: 'paper_folder' }); continue; }
    const byId = paperByNormId.get(normalizeId(stemOf(f.path)));
    if (byId) { byId.pdfCandidates.push({ ...f, origin: 'matched_by_file_name' }); continue; }
    if (inRoot(f.path)) unplaced.push(f);
  }
  // Remaining PDFs inside the discovery root: one PDF in a folder -> that folder is a paper;
  // several in one folder (or at the root) -> one paper per PDF (flat layout).
  const unplacedByDir = new Map();
  for (const f of unplaced) {
    const d = dirname(f.path);
    if (!unplacedByDir.has(d)) unplacedByDir.set(d, []);
    unplacedByDir.get(d).push(f);
  }
  for (const [d, list] of unplacedByDir) {
    if (list.length === 1 && insideRootDir(d)) {
      let dir = d;
      if (dir && !isPaperLikeDirName(basename(dir)) && insideRootDir(dirname(dir))) dir = dirname(dir);
      if (!papers.has(dir)) papers.set(dir, mkDirPaper(dir));
      papers.get(dir).pdfCandidates.push({ ...list[0], origin: 'paper_folder' });
    } else {
      for (const f of list) {
        const key = `flat:${f.path}`;
        papers.set(key, { key, layout: 'flat_pdfs', dir: d, stem: stemOf(f.path), pdfCandidates: [{ ...f, origin: 'flat_folder' }], leanFiles: [], flags: [] });
      }
    }
  }

  // 3. Assign every Lean file under the root to its paper.
  const orphans = [];
  for (const f of leans) {
    let assigned = null;
    const a = nearestPaperDir(f.path);
    if (a) assigned = papers.get(a);
    if (!assigned) {
      // flat layout: match by stem prefix (001.pdf <-> 001_main.lean)
      const stem = stemOf(f.path).toLowerCase();
      const candidates = [...papers.values()].filter((p) => p.layout === 'flat_pdfs' && (stem === p.stem.toLowerCase() || stem.startsWith(`${p.stem.toLowerCase()}_`) || stem.startsWith(`${p.stem.toLowerCase()}-`) || dirname(f.path) === `${p.dir}/${p.stem}` || dirname(f.path).endsWith(`/${p.stem}`)));
      if (candidates.length === 1) assigned = candidates[0];
    }
    if (assigned) assigned.leanFiles.push(f);
    else orphans.push({ path: f.path, size: f.size, reason: 'no_paper_association' });
  }

  // 4. Stable paper ids (assigned before the concurrent per-paper pass).
  const usedIds = new Set();
  const plan = [...papers.values()].sort((a, b) => a.key.localeCompare(b.key)).map((p) => {
    let paperId = slug(p.stem);
    if (usedIds.has(paperId)) paperId = slug(p.dir ? `${p.dir}/${p.stem}`.replace(/\//g, '__') : p.key);
    usedIds.add(paperId);
    return { p, paperId };
  });

  // Synchronous check-and-reserve, so concurrent papers cannot overrun the budget.
  const reserveLeanRead = (target, file) => {
    if ((file.size ?? 0) > maxLeanBytes) { target.mapping_flags.push('lean_file_too_large_to_inspect'); return false; }
    if (leanReads >= maxLeanReads || nowMono() - t0 > timeBudgetMs) { budgetExhausted = true; target.mapping_flags.push('not_inspected_preview_budget'); return false; }
    leanReads += 1;
    return true;
  };

  const processPaper = async ({ p, paperId }) => {
    const pAnn = annPapers[paperId] || annPapers[p.stem] || {};
    const idx = index.entries.get(normalizeId(paperId)) || index.entries.get(normalizeId(p.stem)) || null;
    const rec = {
      paper_id: paperId,
      dir: p.dir,
      layout: p.layout,
      title: pAnn.title || null,
      citation: pAnn.citation || null,
      title_source: pAnn.title ? 'annotations' : null,
      pdf: null,
      pdf_candidates: [],
      index_entry: idx ? { file: idx.file, id: idx.entry.id, difficulty: idx.entry.difficulty, msc: idx.entry.msc_raw, references: idx.entry.references } : null,
      metadata_files: [],
      shared_definition_files: [],
      targets: Object.fromEntries(TARGET_KINDS.map((k) => [k, null])),
      unclassified_lean_files: [],
      subject_tags: Array.isArray(pAnn.subject_tags) ? pAnn.subject_tags : idx?.entry.subject_tags?.length ? idx.entry.subject_tags : [],
      subject_tags_source: Array.isArray(pAnn.subject_tags) ? 'annotations' : idx?.entry.subject_tags?.length ? `index:${idx.file}` : null,
      difficulty: pAnn.difficulty || idx?.entry.difficulty || null,
      requires_figures: pAnn.requires_figures ?? 'unknown',
      bridge_checks: Array.isArray(pAnn.bridge_checks) ? pAnn.bridge_checks : [],
      annotations_applied: Boolean(annPapers[paperId] || annPapers[p.stem]),
      flags: [...p.flags],
    };
    if (!rec.title && idx?.entry.title) { rec.title = idx.entry.title; rec.title_source = `index:${idx.file}`; }
    if (!rec.citation && idx?.entry.citation) rec.citation = idx.entry.citation;

    // Metadata files in the paper directory.
    if (p.layout === 'dir_per_paper') {
      for (const f of files) {
        if (dirname(f.path) !== p.dir) continue;
        const base = basename(f.path).toLowerCase();
        if (PAPER_METADATA_FILES.includes(base) || base.endsWith('.bib') || base === 'readme.md') rec.metadata_files.push(f.path);
      }
      if (readLeanFiles) {
        for (const mf of rec.metadata_files) {
          try {
            const text = (await read(mf, maxMetaBytes)).toString('utf8');
            const base = basename(mf).toLowerCase();
            if (base.endsWith('.json')) {
              const j = safeJson(text);
              if (j) {
                if (!rec.title && typeof j.title === 'string') { rec.title = j.title; rec.title_source = mf; }
                if (!rec.citation && typeof j.citation === 'string') rec.citation = j.citation;
                if (!rec.citation && Array.isArray(j.authors) && j.title) rec.citation = `${j.authors.join(', ')}. ${j.title}${j.year ? ` (${j.year})` : ''}`;
                if (j.mathematical_status && typeof j.mathematical_status === 'object') rec._metaStatus = j.mathematical_status;
                if (j.targets && typeof j.targets === 'object') rec._metaTargets = j.targets;
              } else rec.flags.push({ code: 'metadata_unparseable', message: `${mf} is not valid JSON`, paths: [mf] });
            } else if (base.endsWith('.bib')) {
              const t = parseBibTitle(text);
              if (!rec.title && t) { rec.title = t; rec.title_source = mf; }
              if (!rec.citation) rec.citation = text.trim().slice(0, 500);
            } else if (base === 'readme.md') {
              const h = firstHeading(text);
              if (!rec.title && h) { rec.title = h; rec.title_source = mf; }
            }
          } catch (err) {
            rec.flags.push({ code: 'metadata_unreadable', message: `${mf}: ${err.message}`, paths: [mf] });
          }
        }
      }
    }

    // PDF choice: annotation override, else the only candidate, else the best title match.
    const cands = p.pdfCandidates;
    rec.pdf_candidates = cands.map((c) => ({ path: c.path, size: c.size ?? null, origin: c.origin }));
    let chosenPdf = null;
    if (pAnn.pdf_path && cands.some((c) => c.path === pAnn.pdf_path)) chosenPdf = cands.find((c) => c.path === pAnn.pdf_path);
    else if (cands.length === 1) chosenPdf = cands[0];
    else if (cands.length > 1) {
      const local = cands.filter((c) => c.origin !== 'matched_by_file_name');
      const pool = local.length ? local : cands;
      const scored = pool.map((c) => ({ c, s: rec.title ? overlap(rec.title, stemOf(c.path)) : 0 })).sort((a, b) => b.s - a.s || a.c.path.localeCompare(b.c.path));
      chosenPdf = scored[0].c;
      const reason = scored[0].s > (scored[1]?.s ?? 0) ? 'best title match' : 'first in folder order (no title match)';
      rec.flags.push({ code: 'multiple_pdfs', message: `${cands.length} PDFs; chose ${basename(chosenPdf.path)} (${reason}); set pdf_path in annotations to override`, paths: cands.map((c) => c.path) });
    }
    if (chosenPdf) {
      rec.pdf = { path: chosenPdf.path, size: chosenPdf.size ?? null, sha256: null, origin: chosenPdf.origin };
      if (chosenPdf.origin === 'matched_by_file_name') rec.flags.push({ code: 'pdf_from_other_folder', message: `PDF matched by file name: ${chosenPdf.path}`, paths: [chosenPdf.path] });
      if (!rec.title) {
        const s = stemOf(chosenPdf.path).replace(/[_]+/g, ' ').trim();
        if (s.split(/\s+/).length >= 3) { rec.title = s; rec.title_source = 'pdf_file_name'; }
      }
    } else {
      rec.flags.push({ code: 'missing_pdf', message: 'No PDF found for this paper' });
    }

    // Classify Lean files.
    const perKind = Object.fromEntries(TARGET_KINDS.map((k) => [k, []]));
    for (const f of p.leanFiles) {
      const rel = p.layout === 'dir_per_paper' && p.dir ? f.path.slice(p.dir.length + 1) : basename(f.path);
      const stem = stemOf(f.path).toLowerCase();
      if (stem === p.stem.toLowerCase() || stem === paperId.toLowerCase()) {
        perKind.main_theorem.push({ file: f, weak: false, rule: 'file_name_equals_paper_id' });
        continue;
      }
      const cls = classifyLeanFile(rel);
      if (cls.shared) { rec.shared_definition_files.push({ path: f.path, size: f.size }); continue; }
      if (cls.ambiguous) { rec.unclassified_lean_files.push({ path: f.path, size: f.size, matched: cls.matched }); rec.flags.push({ code: 'ambiguous_target_file', message: `${f.path} matches ${cls.matched.join(' and ')}`, paths: [f.path] }); continue; }
      if (!cls.kind) { rec.unclassified_lean_files.push({ path: f.path, size: f.size, matched: [] }); continue; }
      perKind[cls.kind].push({ file: f, weak: cls.weak, rule: 'file_name_tokens' });
    }
    const metaTargets = rec._metaTargets || {};
    const annTargets = pAnn.targets || {};
    for (const kind of TARGET_KINDS) {
      let list = perKind[kind];
      // A file named after the paper beats token matches for the main theorem.
      if (kind === 'main_theorem' && list.length > 1 && list.filter((x) => x.rule === 'file_name_equals_paper_id').length === 1) {
        list = list.filter((x) => x.rule === 'file_name_equals_paper_id');
      }
      const override = annTargets[kind] || metaTargets[kind] || {};
      let chosen = null;
      if (override.lean_path && byPath.has(override.lean_path)) chosen = byPath.get(override.lean_path);
      else if (list.length === 1) chosen = list[0].file;
      else if (list.length > 1) {
        rec.flags.push({ code: 'duplicate_target_files', message: `${list.length} files classify as ${kind}`, paths: list.map((x) => x.file.path) });
      }
      if (!chosen && list.length === 0) {
        if (kind !== 'disproof') rec.flags.push({ code: 'missing_target_file', message: `No Lean file classified as ${kind}`, paths: [] });
        rec.targets[kind] = null;
        continue;
      }
      let status = 'uncertain';
      let statusSource = 'default_uncertain';
      if (override.mathematical_status) { status = override.mathematical_status; statusSource = 'annotations'; }
      else if (rec._metaStatus && rec._metaStatus[kind]) { status = rec._metaStatus[kind]; statusSource = 'metadata'; }
      else if (kind === 'main_theorem' && idx?.entry.status) { status = idx.entry.status.status; statusSource = `index:${idx.file}:${idx.entry.status.field}`; }
      const target = {
        target_kind: kind,
        lean_path: chosen ? chosen.path : null,
        size: chosen ? chosen.size : null,
        sha256: null,
        candidates: list.map((x) => x.file.path),
        mapping_rule: chosen ? (override.lean_path ? 'annotations' : list[0]?.rule || null) : null,
        declaration_name: override.declaration_name || null,
        declaration_candidates: [],
        declaration_source: override.declaration_name ? 'annotations' : null,
        local_imports: [],
        required_shared_definitions: [],
        mathematical_status: status,
        mathematical_status_source: statusSource,
        reference_proof_status: chosen ? 'unknown' : 'missing',
        reference_proof_status_source: 'not_compiled',
        static_flags: [],
        source_locator: override.source_locator || null,
        context_file: override.context_file || null,
        mapping_flags: [],
        weak_match: list.length === 1 ? Boolean(list[0].weak) : false,
      };
      if (list.length > 1 && !chosen) target.mapping_flags.push('duplicate_target_files');
      if (target.weak_match) target.mapping_flags.push('weak_filename_match');
      if (statusSource.startsWith('index:')) target.mapping_flags.push('mathematical_status_from_index_needs_review');
      if (kind === 'disproof' && statusSource === 'default_uncertain') target.mapping_flags.push('disproof_polarity_unconfirmed');
      if (chosen && readLeanFiles) {
        if (reserveLeanRead(target, chosen)) {
          try {
            const buf = await read(chosen.path, maxLeanBytes);
            const text = buf.toString('utf8');
            target.sha256 = sha256(buf);
            target.local_imports = parseImports(text).filter((m) => !STD_IMPORT.test(m));
            target.required_shared_definitions = target.local_imports;
            const decls = candidateDeclarations(text, kind);
            target.declaration_candidates = decls;
            if (!target.declaration_name) {
              const fileStem = stemOf(chosen.path).toLowerCase();
              const named = decls.filter((c) => { const n = c.name.split('.').pop().toLowerCase(); return n === fileStem || n === paperId.toLowerCase(); });
              const best = decls.filter((c) => c.score > 0);
              if (decls.length === 1) { target.declaration_name = decls[0].name; target.declaration_source = 'only_theorem'; }
              else if (named.length === 1) { target.declaration_name = named[0].name; target.declaration_source = 'name_equals_file_name'; }
              else if (best.length === 1) { target.declaration_name = best[0].name; target.declaration_source = 'name_matches_kind'; }
              else if (decls.length > 1) { target.declaration_name = decls[decls.length - 1].name; target.declaration_source = 'last_theorem_ambiguous'; target.mapping_flags.push('ambiguous_declaration'); }
              else { target.mapping_flags.push('no_theorem_declaration_found'); }
            } else if (!decls.some((c) => c.name === target.declaration_name)) {
              target.mapping_flags.push('annotated_declaration_not_found');
            }
            // A declaration named after a different paper id (e.g. P037 inside P035.lean) is a likely copy-paste defect.
            const declId = target.declaration_name ? /^([A-Za-z]+\d+)(?![a-z])/.exec(target.declaration_name.split('.').pop()) : null;
            if (declId && /^[A-Za-z_-]*\d+$/.test(paperId) && normalizeId(declId[1]) !== normalizeId(paperId)) {
              target.mapping_flags.push(`declaration_names_other_paper:${declId[1]}`);
            }
            const screen = staticScreen(text, { allowedImports: target.local_imports });
            target.static_flags = screen.flags.map((f) => f.code).filter((v, i, a) => a.indexOf(v) === i);
            if (screen.flags.some((f) => f.code === 'placeholder')) { target.reference_proof_status = 'contains_placeholder'; target.reference_proof_status_source = 'static_scan'; }
            if (!screen.ok) target.mapping_flags.push('reference_fails_static_screen');
          } catch (err) {
            target.mapping_flags.push(`read_error:${err.code || err.message}`);
          }
        }
      }
      if (target.mapping_flags.length) rec.flags.push({ code: 'target_needs_review', message: `${kind}: ${target.mapping_flags.join(', ')}`, paths: chosen ? [chosen.path] : [] });
      rec.targets[kind] = target;
    }
    delete rec._metaStatus;
    delete rec._metaTargets;
    if (!rec.title) rec.title_source = 'none';
    if (!rec.citation) rec.citation = rec.title ? rec.title : paperId;
    return rec;
  };

  const limit = pLimit(Math.max(1, concurrency));
  const records = await Promise.all(plan.map((x) => limit(() => processPaper(x))));
  records.sort((a, b) => a.paper_id.localeCompare(b.paper_id, undefined, { numeric: true }));
  if (budgetExhausted) globalFlags.push({ code: 'preview_budget_reached', message: `Read ${leanReads} Lean files within the preview budget; remaining targets are marked not_inspected_preview_budget. The local runner reads everything.` });

  const papersByParent = {};
  for (const r of records) { const k = r.layout === 'flat_pdfs' ? `${r.dir || '.'} (flat)` : (dirname(r.dir) || '.'); papersByParent[k] = (papersByParent[k] || 0) + 1; }
  const indexMatched = records.filter((r) => r.index_entry).length;
  const counts = {
    subdir: root || null,
    files_listed: files.length,
    files_listed_repository: allFiles.length,
    blobs_total: totalBlobs,
    pdfs: files.filter((f) => f.path.toLowerCase().endsWith('.pdf')).length,
    lean_files: leans.length,
    papers: records.length,
    papers_by_parent_dir: papersByParent,
    papers_with_pdf: records.filter((r) => r.pdf).length,
    papers_with_index_entry: indexMatched,
    index_files: index.files,
    index_entries_without_paper: index.files.length ? [...index.entries.entries()].filter(([k]) => !records.some((r) => normalizeId(r.paper_id) === k)).map(([, v]) => v.entry.id) : [],
    targets: Object.fromEntries(TARGET_KINDS.map((k) => [k, records.filter((r) => r.targets[k] && r.targets[k].lean_path).length])),
    papers_with_all_three_bounds: records.filter((r) => ['main_theorem', 'upper_bound', 'lower_bound'].every((k) => r.targets[k] && r.targets[k].lean_path)).length,
    papers_flagged: records.filter((r) => r.flags.length > 0).length,
    orphan_lean_files: orphans.length,
    lean_files_inspected: leanReads,
    flags_by_code: {},
    expected_count: expectedCount,
    expected_count_matches: records.length === expectedCount,
    discovery_ms: Math.round(nowMono() - t0),
  };
  for (const r of records) for (const f of r.flags) counts.flags_by_code[f.code] = (counts.flags_by_code[f.code] || 0) + 1;

  log(`discovered ${records.length} papers (${counts.papers_with_pdf} with PDF) under ${root || 'repository root'}; expected ${expectedCount}`);
  return {
    schema: MANIFEST_SCHEMA,
    generated_at: isoNow(),
    source: { ...descriptor, subdir: root || null },
    download_policy: source.limits,
    counts,
    flags: globalFlags,
    papers: records,
    orphan_lean_files: orphans,
    notes: [
      'Paper folders are found from Lean target files; PDFs are attached from the paper folder or, by file name, from elsewhere in the repository.',
      'Target kinds are inferred from file names (<Id>.lean = main theorem, _UB/_LB/_DISPROVE, …); see targets[].mapping_rule and mapping_flags.',
      'reference_proof_status is a static scan until the Lean stage compiles the reference.',
      'mathematical_status defaults to uncertain unless annotations, metadata or a repository index state otherwise; index-derived statuses apply to the main theorem only and are flagged for review. A DISPROOF file is never assumed to contain a proved counterexample.',
      'Index files contribute titles, subject codes, difficulty and reference keys only; their formal statements and proofs are never copied into the manifest or given to models.',
      `expected_count (${expectedCount}) is an expectation, not a result; expected_count_matches reports whether discovery agrees.`,
    ],
  };
}
