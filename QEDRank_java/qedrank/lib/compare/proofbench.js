// ProofBench side of the benchmark comparison: corpus composition (claim status, subject, difficulty,
// targets) from the same discovery the benchmark runner uses, and the statement measurements of
// `measure.js` on every main theorem, following imports into the benchmark's own Lean library.

import { openSource } from '../source.js';
import { discoverCorpus } from '../corpus.js';
import { pLimit } from '../util.js';
import { measureFileWithImports, summarizeMeasurements, summarizeStructure } from './measure.js';
import { TARGET_KINDS } from '../schema.js';

/** Collapse ProofBench's free-text difficulty labels into the levels used across benchmarks. */
export function difficultyLevel(label, status) {
  const s = String(label || '').toLowerCase();
  if (status === 'open' || /^open\b/.test(s)) return 'open';
  if (s.startsWith('research')) return 'research';
  if (s.startsWith('calibration')) return 'calibration';
  if (s.startsWith('undergraduate')) return 'undergraduate';
  if (s.startsWith('graduate')) return 'graduate';
  if (!s) return 'unlabeled';
  return 'other';
}

/** Two-digit MSC 2020 area of a code such as "05C15". */
export function mscArea(code) {
  const m = /^(\d{2})/.exec(String(code || '').trim());
  return m ? m[1] : null;
}

export function mscSection(code) {
  const m = /^(\d{2}[A-Z])/.exec(String(code || '').trim().toUpperCase());
  return m ? m[1] : null;
}

const count = (arr) => arr.reduce((acc, k) => { acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const DEF_LINE = /^\s*(?:@\[[^\]]*\]\s*)?(?:(?:noncomputable|private|protected)\s+)*(?:def|abbrev|structure|inductive|class|instance)\s/gm;

/**
 * @param {object} p
 * @param {string} [p.url]     corpus repository (GitHub URL or SSH)
 * @param {string} [p.path]    local corpus directory instead of a URL
 * @param {string} [p.ref]     branch, tag or commit
 * @param {string} [p.subdir]  folder holding the problem folders
 * @param {string} [p.token]   GitHub token for a private repository
 */
export async function proofbenchStats({ url, path: localPath, ref, subdir, token, log = () => {} } = {}) {
  const source = await openSource({ url, path: localPath, ref, subdir: subdir ?? null, token });
  const manifest = await discoverCorpus(source, { log, expectedCount: 0 });
  const papers = manifest.papers || [];
  log(`ProofBench: ${papers.length} problem folders at ${manifest.source?.commit?.slice(0, 10) || 'local'}`);

  // Module name -> repository path, for every Lean file in the repository.
  const { files } = await source.listTree();
  const moduleToPath = new Map();
  for (const f of files) if (f.path.endsWith('.lean')) moduleToPath.set(f.path.replace(/\.lean$/, '').split('/').join('.'), f.path);
  const textCache = new Map();
  const readPath = (p) => {
    if (!textCache.has(p)) textCache.set(p, source.readFile(p).then((b) => b.toString('utf8')));
    return textCache.get(p);
  };
  const readModule = async (mod) => (moduleToPath.has(mod) ? readPath(moduleToPath.get(mod)) : null);

  // Statement measurements of every main theorem (the task every model receives).
  const limit = pLimit(8);
  const imported = new Map(); // library modules the statements import, transitively
  const onModule = (module, text) => { if (!imported.has(module)) imported.set(module, { module, text }); };
  const rows = await Promise.all(papers.map((p) => limit(async () => {
    const t = p.targets?.main_theorem;
    const base = { id: p.paper_id, msc: (p.subject_tags || [])[0] || null, level: difficultyLevel(p.difficulty, t?.mathematical_status), status: t?.mathematical_status || null };
    if (!t?.lean_path) return { ...base, ok: false, reason: 'no main theorem file' };
    try {
      const text = await readPath(t.lean_path);
      const [m] = await measureFileWithImports(text, t.declaration_name ? [t.declaration_name] : null, readModule, { onModule });
      return { ...base, ...m, file: t.lean_path };
    } catch (err) {
      return { ...base, ok: false, reason: err.message };
    }
  })));

  // The benchmark's own Lean library: every repository module some problem imports, transitively.
  const libraryModules = [...new Set(rows.flatMap((r) => r.library_modules_used || []))];
  const importedModules = [...new Set(rows.flatMap((r) => r.project_imports || []))];
  const libraryFiles = [...moduleToPath.entries()].filter(([mod]) => /(^|\.)Mathlib_Problems(\.|$)/.test(mod));
  let libraryDefinitions = 0;
  for (const [, p] of libraryFiles) libraryDefinitions += ((await readPath(p).catch(() => '')).match(DEF_LINE) || []).length;

  const main = papers.map((p) => p.targets?.main_theorem).filter(Boolean);
  const targets = Object.fromEntries(TARGET_KINDS.map((k) => [k, papers.filter((p) => p.targets?.[k]).length]));
  const tags = papers.map((p) => (p.subject_tags || [])[0]).filter(Boolean);
  return {
    name: 'ProofBench',
    source: manifest.source,
    measured_at: new Date().toISOString(),
    problems: papers.length,
    targets,
    papers_with_sandwich: papers.filter((p) => p.targets?.main_theorem && p.targets?.upper_bound && p.targets?.lower_bound).length,
    claim_status: count(main.map((t) => t.mathematical_status || 'uncertain')),
    levels: count(rows.map((r) => r.level)),
    difficulty_labels: count(papers.map((p) => p.difficulty || 'unlabeled')),
    msc_area: count(tags.map(mscArea).filter(Boolean)),
    msc_section: count(tags.map(mscSection).filter(Boolean)),
    msc_unlabeled: papers.length - tags.length,
    with_pdf: papers.filter((p) => p.pdf).length,
    library: {
      files: libraryFiles.length,
      definitions: libraryDefinitions,
      modules_imported_directly: importedModules.length,
      modules_used_by_statements: libraryModules.length,
    },
    statements: summarizeMeasurements(rows),
    structure: summarizeStructure(rows, [...imported.values()]),
    per_problem: rows.map(({ id, ok, reason, msc, level, status, stmt_tokens, closure_tokens, closure_tokens_file_only, defs_used, file_defs_used, library_defs_used, uses_project_library, unresolved_imports }) => ({ id, ok, reason, msc, level, status, stmt_tokens, closure_tokens, closure_tokens_file_only, defs_used, file_defs_used, library_defs_used, uses_project_library, unresolved_imports })),
  };
}
