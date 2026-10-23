// Pre-flight check for the prove task: every module a challenge file imports must resolve in the
// grader's Lean project before any model is called. Lean resolves an import `A.B.C` to
// `A/B/C.olean` on LEAN_PATH, so the check is a file lookup on the directories `lake env`
// reports, no compile. Two outcomes are told apart:
//   - a whole prefix is absent (no `ProofBench/` directory on any LEAN_PATH entry): the run was
//     pointed at the wrong project (the audit project lean/ has Mathlib only) and every such item
//     would be an infrastructure failure, so the run must stop before it spends a request;
//   - single modules are missing while their prefix exists: the project is behind the corpus
//     commit; those items are recorded as challenge_import_unavailable and the rest can run.
// Pure apart from the file-existence lookups; no network, no Lean process.

import path from 'node:path';
import { parseImports } from './leansrc.js';
import { exists } from './util.js';

/** Directories of the project's LEAN_PATH (from detectToolchain), in order. */
export function leanPathDirs(toolchain) {
  return String(toolchain?.lean_path || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

/** `A.B.C` -> `A/B/C` with the platform separator. */
export function modulePath(module) {
  return String(module).split('.').join(path.sep);
}

/** The LEAN_PATH directory that holds the module's .olean, or null. */
export async function moduleAvailable(module, dirs) {
  const rel = `${modulePath(module)}.olean`;
  for (const d of dirs) if (await exists(path.join(d, rel))) return d;
  return null;
}

/** True when some LEAN_PATH directory has a folder (or olean) for the top-level prefix. */
export async function prefixPresent(prefix, dirs) {
  for (const d of dirs) {
    if (await exists(path.join(d, prefix))) return true;
    if (await exists(path.join(d, `${prefix}.olean`))) return true;
  }
  return false;
}

/**
 * Check the imports of the prepared challenge files against the project.
 * @param {object} p
 * @param {{paper_id:string, kind?:string, src:string}[]} p.challenges  challenge sources
 * @param {object} p.toolchain  result of detectToolchain (lean_dir, lean_path)
 * @param {string[]} [p.extraLeanPath]  directories searched before LEAN_PATH
 * @returns {{modules:number, available:number, missing:{module:string,papers:string[]}[], missing_prefixes:{prefix:string,modules:number,papers:string[],example:string}[], fatal:boolean, lean_project:string, lean_path_dirs:number, challenge_papers:number, message:string|null}}
 */
export async function checkChallengeImports({ challenges, toolchain, extraLeanPath = [] }) {
  const dirs = [...(extraLeanPath || []), ...leanPathDirs(toolchain)];
  const byModule = new Map();
  const papersSeen = new Set();
  for (const c of challenges || []) {
    papersSeen.add(c.paper_id);
    for (const m of parseImports(c.src || '')) {
      if (!byModule.has(m)) byModule.set(m, new Set());
      byModule.get(m).add(c.paper_id);
    }
  }
  const missing = [];
  for (const [module, papers] of byModule) {
    if (!(await moduleAvailable(module, dirs))) missing.push({ module, papers: [...papers].sort() });
  }
  const groups = new Map();
  for (const mm of missing) {
    const prefix = mm.module.split('.')[0];
    if (!groups.has(prefix)) groups.set(prefix, { prefix, modules: 0, papers: new Set(), example: mm.module });
    const g = groups.get(prefix);
    g.modules += 1;
    for (const p of mm.papers) g.papers.add(p);
  }
  const missingPrefixes = [];
  for (const g of groups.values()) {
    if (!(await prefixPresent(g.prefix, dirs))) missingPrefixes.push({ prefix: g.prefix, modules: g.modules, papers: [...g.papers].sort(), example: g.example });
  }
  const fatal = missingPrefixes.length > 0;
  const leanProject = toolchain?.lean_dir || null;
  let message = null;
  if (fatal) {
    const parts = missingPrefixes.map((p) => `no module prefix '${p.prefix}' at all, but ${p.papers.length} of ${papersSeen.size} challenge files import it (${p.modules} module${p.modules === 1 ? '' : 's'}, e.g. ${p.example})`);
    message = `import check: the grader's Lean project ${leanProject} has ${parts.join('; ')}. None of the ${dirs.length} LEAN_PATH directories contains it, so every such item would be recorded as challenge_import_unavailable; the run stops before any model call.`;
  }
  return {
    modules: byModule.size,
    available: byModule.size - missing.length,
    missing: missing.sort((a, b) => (a.module < b.module ? -1 : 1)),
    missing_prefixes: missingPrefixes,
    fatal,
    lean_project: leanProject,
    lean_path_dirs: dirs.length,
    challenge_papers: papersSeen.size,
    message,
  };
}
