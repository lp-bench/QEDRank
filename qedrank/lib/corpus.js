// Corpus discovery: turn a repository file listing into a preview manifest of
// papers, PDFs and ground-truth Lean targets. Layouts vary between corpora, so
// every mapping decision is recorded and anything ambiguous is flagged for
// review instead of guessed.

import path from 'node:path';
import { MANIFEST_SCHEMA, TARGET_KINDS } from './schema.js';
import { sha256, slug, isoNow } from './util.js';
import { parseImports, candidateDeclarations, staticScreen } from './leansrc.js';

export const PAPER_METADATA_FILES = ['metadata.json', 'paper.json', 'info.json', 'meta.json', 'qedrank.json'];
export const ANNOTATIONS_FILE = 'qedrank-annotations.json';

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

/**
 * Build the preview manifest.
 * @param {import('./source.js').GitHubSource|import('./source.js').LocalSource} source
 * @param {object} opts
 * @param {boolean} [opts.readLeanFiles=true] read Lean/metadata contents (needed for declaration names)
 * @param {number} [opts.maxLeanBytes]
 * @param {object} [opts.annotations] pre-loaded annotations (overrides the repo file)
 * @param {number} [opts.expectedCount=108]
 * @param {(msg:string)=>void} [opts.log]
 */
export async function discoverCorpus(source, {
  readLeanFiles = true,
  maxLeanBytes = 2 * 1024 * 1024,
  maxMetaBytes = 256 * 1024,
  annotations = null,
  expectedCount = 108,
  maxLeanReads = Infinity,
  log = () => {},
} = {}) {
  let leanReads = 0;
  const descriptor = await source.resolve();
  const { files, truncated, totalBlobs } = await source.listTree();
  const globalFlags = [];
  if (truncated) globalFlags.push({ code: 'tree_truncated', message: 'GitHub returned a truncated tree; some files may be missing from discovery.' });

  const byPath = new Map(files.map((f) => [f.path, f]));
  const pdfs = files.filter((f) => f.path.toLowerCase().endsWith('.pdf'));
  const leans = files.filter((f) => f.path.toLowerCase().endsWith('.lean'));

  // Repository-level annotations.
  let repoAnnotations = null;
  if (byPath.has(ANNOTATIONS_FILE) && readLeanFiles) {
    try {
      repoAnnotations = safeJson((await source.readFile(ANNOTATIONS_FILE, { maxBytes: maxMetaBytes * 8 })).toString('utf8'));
      if (!repoAnnotations) globalFlags.push({ code: 'annotations_unparseable', message: `${ANNOTATIONS_FILE} is not valid JSON` });
    } catch (err) {
      globalFlags.push({ code: 'annotations_unreadable', message: err.message });
    }
  }
  const ann = annotations || repoAnnotations || {};
  const annPapers = ann.papers || {};

  // 1. Paper directories from PDFs.
  const pdfDirCounts = new Map();
  for (const f of pdfs) pdfDirCounts.set(dirname(f.path), (pdfDirCounts.get(dirname(f.path)) || 0) + 1);
  const papers = new Map(); // key: paper dir (or pdf path for flat layouts)
  const flatDirs = new Set([...pdfDirCounts.entries()].filter(([d, n]) => n > 1 || d === '').map(([d]) => d));

  for (const f of pdfs) {
    const d = dirname(f.path);
    if (flatDirs.has(d)) {
      const stem = path.posix.basename(f.path).replace(/\.pdf$/i, '');
      const key = `flat:${f.path}`;
      papers.set(key, { key, layout: 'flat_pdfs', dir: d, stem, pdf: f, leanFiles: [], flags: [] });
    } else {
      // A PDF alone in a directory: directory is the paper.
      let dir = d;
      // If the PDF sits in a generic sub-directory (e.g. paper/pdf/x.pdf) hoist to the parent.
      const base = path.posix.basename(dir);
      if (dir && !isPaperLikeDirName(base) && dirname(dir) !== '') dir = dirname(dir);
      if (!papers.has(dir)) papers.set(dir, { key: dir, layout: 'dir_per_paper', dir, stem: path.posix.basename(dir), pdf: f, leanFiles: [], flags: [] });
      else papers.get(dir).flags.push({ code: 'multiple_pdfs', message: `Additional PDF ${f.path} ignored`, paths: [f.path] });
    }
  }

  // 2a. Directories without a PDF still form a paper when they contain a target-classified Lean file.
  const nearestPaperDir = (f) => ancestors(f.path).find((a) => papers.has(a) && papers.get(a).layout === 'dir_per_paper');
  for (const f of leans) {
    if (nearestPaperDir(f)) continue;
    const cls = classifyLeanFile(path.posix.basename(f.path));
    let dir = dirname(f.path);
    while (dir && !isPaperLikeDirName(path.posix.basename(dir))) dir = dirname(dir);
    if (cls.kind && dir && !papers.has(dir)) {
      papers.set(dir, { key: dir, layout: 'dir_per_paper', dir, stem: path.posix.basename(dir), pdf: null, leanFiles: [], flags: [{ code: 'missing_pdf', message: 'No PDF found in the paper directory' }] });
    }
  }
  // 2b. Assign every Lean file to its paper.
  const orphans = [];
  for (const f of leans) {
    let assigned = null;
    const a = nearestPaperDir(f);
    if (a) assigned = papers.get(a);
    if (!assigned) {
      // flat layout: match by stem prefix (001.pdf <-> 001_main.lean)
      const stem = path.posix.basename(f.path).replace(/\.lean$/i, '').toLowerCase();
      const candidates = [...papers.values()].filter((p) => p.layout === 'flat_pdfs' && (stem === p.stem.toLowerCase() || stem.startsWith(`${p.stem.toLowerCase()}_`) || stem.startsWith(`${p.stem.toLowerCase()}-`) || dirname(f.path) === p.dir + '/' + p.stem || dirname(f.path).endsWith('/' + p.stem)));
      if (candidates.length === 1) assigned = candidates[0];
    }
    if (assigned) assigned.leanFiles.push(f);
    else orphans.push({ path: f.path, size: f.size, reason: 'no_paper_association' });
  }

  // 3. Build paper records.
  const usedIds = new Map();
  const records = [];
  for (const p of papers.values()) {
    let paperId = slug(p.stem);
    if (usedIds.has(paperId)) paperId = slug(p.dir ? p.dir.replace(/\//g, '__') : p.pdf.path);
    usedIds.set(paperId, true);
    const pAnn = annPapers[paperId] || annPapers[p.stem] || {};
    const rec = {
      paper_id: paperId,
      dir: p.dir,
      layout: p.layout,
      title: pAnn.title || null,
      citation: pAnn.citation || null,
      title_source: pAnn.title ? 'annotations' : null,
      pdf: p.pdf ? { path: p.pdf.path, size: p.pdf.size, sha256: null } : null,
      metadata_files: [],
      shared_definition_files: [],
      targets: Object.fromEntries(TARGET_KINDS.map((k) => [k, null])),
      unclassified_lean_files: [],
      subject_tags: Array.isArray(pAnn.subject_tags) ? pAnn.subject_tags : [],
      difficulty: pAnn.difficulty || null,
      requires_figures: pAnn.requires_figures ?? 'unknown',
      bridge_checks: Array.isArray(pAnn.bridge_checks) ? pAnn.bridge_checks : [],
      annotations_applied: Boolean(annPapers[paperId] || annPapers[p.stem]),
      flags: [...p.flags],
    };
    if (!rec.pdf) rec.flags.push({ code: 'missing_pdf', message: 'No PDF found for this paper' });

    // Metadata files in the paper directory.
    if (p.layout === 'dir_per_paper') {
      for (const f of files) {
        if (dirname(f.path) !== p.dir) continue;
        const base = path.posix.basename(f.path).toLowerCase();
        if (PAPER_METADATA_FILES.includes(base) || base.endsWith('.bib') || base === 'readme.md') rec.metadata_files.push(f.path);
      }
      if (readLeanFiles) {
        for (const mf of rec.metadata_files) {
          try {
            const text = (await source.readFile(mf, { maxBytes: maxMetaBytes })).toString('utf8');
            const base = path.posix.basename(mf).toLowerCase();
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

    // Classify Lean files.
    const perKind = Object.fromEntries(TARGET_KINDS.map((k) => [k, []]));
    for (const f of p.leanFiles) {
      const rel = p.layout === 'dir_per_paper' && p.dir ? f.path.slice(p.dir.length + 1) : path.posix.basename(f.path);
      const cls = classifyLeanFile(rel);
      if (cls.shared) { rec.shared_definition_files.push({ path: f.path, size: f.size }); continue; }
      if (cls.ambiguous) { rec.unclassified_lean_files.push({ path: f.path, size: f.size, matched: cls.matched }); rec.flags.push({ code: 'ambiguous_target_file', message: `${f.path} matches ${cls.matched.join(' and ')}`, paths: [f.path] }); continue; }
      if (!cls.kind) { rec.unclassified_lean_files.push({ path: f.path, size: f.size, matched: [] }); continue; }
      perKind[cls.kind].push({ file: f, weak: cls.weak });
    }
    const metaTargets = rec._metaTargets || {};
    const annTargets = pAnn.targets || {};
    for (const kind of TARGET_KINDS) {
      const list = perKind[kind];
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
      const target = {
        target_kind: kind,
        lean_path: chosen ? chosen.path : null,
        size: chosen ? chosen.size : null,
        sha256: null,
        candidates: list.map((x) => x.file.path),
        declaration_name: override.declaration_name || null,
        declaration_candidates: [],
        declaration_source: override.declaration_name ? 'annotations' : null,
        local_imports: [],
        required_shared_definitions: [],
        mathematical_status: override.mathematical_status || (rec._metaStatus && rec._metaStatus[kind]) || 'uncertain',
        mathematical_status_source: override.mathematical_status ? 'annotations' : (rec._metaStatus && rec._metaStatus[kind]) ? 'metadata' : 'default_uncertain',
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
      if (kind === 'disproof' && target.mathematical_status_source === 'default_uncertain') {
        target.mapping_flags.push('disproof_polarity_unconfirmed');
      }
      if (chosen && readLeanFiles) {
        if ((chosen.size ?? 0) > maxLeanBytes) {
          target.mapping_flags.push('lean_file_too_large_to_inspect');
        } else if (leanReads >= maxLeanReads) {
          target.mapping_flags.push('not_inspected_preview_budget');
        } else {
          leanReads += 1;
          try {
            const buf = await source.readFile(chosen.path, { maxBytes: maxLeanBytes });
            const text = buf.toString('utf8');
            target.sha256 = sha256(buf);
            target.local_imports = parseImports(text).filter((m) => !/^(Mathlib|Std|Lean|Init|Aesop|Batteries|Qq|ProofWidgets|Plausible)(\.|$)/.test(m));
            target.required_shared_definitions = target.local_imports;
            const cands = candidateDeclarations(text, kind);
            target.declaration_candidates = cands;
            if (!target.declaration_name) {
              const best = cands.filter((c) => c.score > 0);
              if (cands.length === 1) { target.declaration_name = cands[0].name; target.declaration_source = 'only_theorem'; }
              else if (best.length === 1) { target.declaration_name = best[0].name; target.declaration_source = 'name_matches_kind'; }
              else if (cands.length > 1) { target.declaration_name = cands[cands.length - 1].name; target.declaration_source = 'last_theorem_ambiguous'; target.mapping_flags.push('ambiguous_declaration'); }
              else { target.mapping_flags.push('no_theorem_declaration_found'); }
            } else if (!cands.some((c) => c.name === target.declaration_name)) {
              target.mapping_flags.push('annotated_declaration_not_found');
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
    // Shared definition files also referenced by imports from a parent directory.
    delete rec._metaStatus;
    delete rec._metaTargets;
    if (!rec.title) rec.title_source = 'none';
    if (!rec.citation) rec.citation = rec.title ? rec.title : paperId;
    records.push(rec);
  }
  records.sort((a, b) => a.paper_id.localeCompare(b.paper_id));

  const counts = {
    files_listed: files.length,
    blobs_total: totalBlobs,
    pdfs: pdfs.length,
    lean_files: leans.length,
    papers: records.length,
    papers_with_pdf: records.filter((r) => r.pdf).length,
    targets: Object.fromEntries(TARGET_KINDS.map((k) => [k, records.filter((r) => r.targets[k] && r.targets[k].lean_path).length])),
    papers_with_all_three_bounds: records.filter((r) => ['main_theorem', 'upper_bound', 'lower_bound'].every((k) => r.targets[k] && r.targets[k].lean_path)).length,
    papers_flagged: records.filter((r) => r.flags.length > 0).length,
    orphan_lean_files: orphans.length,
    flags_by_code: {},
    expected_count: expectedCount,
    expected_count_matches: records.length === expectedCount,
  };
  for (const r of records) for (const f of r.flags) counts.flags_by_code[f.code] = (counts.flags_by_code[f.code] || 0) + 1;

  log(`discovered ${records.length} papers (${counts.papers_with_pdf} with PDF); expected ${expectedCount}`);
  return {
    schema: MANIFEST_SCHEMA,
    generated_at: isoNow(),
    source: descriptor,
    download_policy: source.limits,
    counts,
    flags: globalFlags,
    papers: records,
    orphan_lean_files: orphans,
    notes: [
      'Target kinds are inferred from file and directory names; see each target.mapping_flags.',
      'reference_proof_status is a static scan until the Lean stage compiles the reference.',
      'mathematical_status defaults to uncertain unless metadata or annotations state otherwise; a DISPROOF file is never assumed to contain a proved counterexample.',
      `expected_count (${expectedCount}) is an expectation, not a result; expected_count_matches reports whether discovery agrees.`,
    ],
  };
}
