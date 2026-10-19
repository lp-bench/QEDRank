// Proof metrics for the Head-to-head page: `qedrank/lean-tools/ProofMetrics.lean` elaborates each
// file inside its benchmark's own Lean project (that project's toolchain, Mathlib and lakefile
// options) and reports its commands, declarations and messages; this module runs it, caches one
// report per file, and turns the reports into one record per theorem and one summary per source.
//
// Sources (ProofBench):
//   library     the benchmark's own Lean library (default ProofBench/Mathlib_Problems)
//   statements  the problem files: automation probe of each target, linter warnings
//   solutions   reference solutions (*_sol.lean) of a separate, private ProofBench checkout
//   models      answers QEDRank graded as verified, from run directories
//
// `node qedrank/cli.js proof-metrics --project <benchmark Lean project> [--solutions <dir>]
//   [--runs id1,id2] [--only library,statements,solutions,models] [--jobs 3] [--refresh]`
// writes runs/_compare/proof-metrics.json, which the comparison attaches to ProofBench.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { detectToolchain, LeanRunner } from './lean.js';
import { stripComments } from './leansrc.js';
import { leanTokens, summarizeValues } from './compare/measure.js';
import { openSource } from './source.js';
import { discoverCorpus } from './corpus.js';
import { sha256, readJson, writeJson, ensureDir, isoNow, pLimit } from './util.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_FILE = path.resolve(HERE, '..', 'lean-tools', 'ProofMetrics.lean');
export const PROOF_METRICS_SCHEMA = 'qedrank-proof-metrics-v1';
export const SOURCE_IDS = ['library', 'statements', 'solutions', 'models'];

/** Tactics counted as automation: they search or decide, the user does not choose the steps. */
export const AUTOMATION_TACTICS = Object.freeze([
  'simp', 'simp?', 'simp_all', 'simp_all?', 'simpa', 'simpa?', 'dsimp', 'aesop', 'aesop?', 'omega', 'decide',
  'native_decide', 'norm_num', 'linarith', 'linarith!', 'nlinarith', 'nlinarith!', 'positivity', 'polyrith',
  'ring', 'ring_nf', 'field_simp', 'tauto', 'exact?', 'apply?', 'rw?', 'grind', 'bv_decide', 'continuity',
  'measurability', 'fun_prop', 'abel', 'group', 'noncomm_ring', 'order', 'bound', 'trivial', 'cancel_denoms',
]);
const AUTOMATION = new Set(AUTOMATION_TACTICS);
const PLACEHOLDER_TACTICS = new Set(['sorry', 'admit']);

export const RULES = {
  proof: 'a theorem or lemma written in the file (its command declares it by name; the theorems Lean generates, such as a structure\'s propositional fields, are left out) whose proof term contains no `sorry` and whose source lines carry no Lean error',
  proof_lines: 'non-blank lines of the proof (from `:=` to the end of the declaration), comments removed',
  proof_tokens: 'Lean tokens of the same text (the statement-length rule), the leading `:=` excluded',
  term_size: 'nodes of the elaborated proof term (no sharing), capped at 2,000,000',
  tactics: 'tactics written in the declaration: every node of Lean\'s `tactic` syntax category in its parsed source, the grouping forms `·`, `( … )` and `{ … }` excluded; a tactic is named by its first keyword (`simp only [h]` is `simp`); a term-mode proof has none',
  automation: `share of tactic calls that are ${AUTOMATION_TACTICS.join(', ')}`,
  unused_hypothesis: 'a binder of the theorem whose type is a proposition and that does not occur in the proof term (the proof may still use a lemma that takes it); a proof that does not abstract the binder leaves it undecided',
  linter_warning: 'a warning whose text names its linter (`set_option linter.… false`); Lean\'s and Mathlib\'s linters as the project enables them (its lakefile `[leanOptions]`)',
  statement_probe: 'each of omega, simp_all, decide, contradiction (the portfolio of QED_LEAF\'s vacuity probe) tried alone, 200,000 heartbeats each: does it prove the statement outright, or derive False from its hypotheses?',
};

/** The `QR_METRICS=` lines of the tool's output. */
export function parseReports(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('QR_METRICS=')) continue;
    try { out.push(JSON.parse(line.slice('QR_METRICS='.length))); } catch { /* truncated line */ }
  }
  return out;
}

/** Lakefile `-Dkey=value` options as the tool's `--opt key=value` arguments. */
export function toolOptions(leanOptions = []) {
  return leanOptions.filter((a) => a.startsWith('-D')).flatMap((a) => ['--opt', a.slice(2)]);
}

async function git(dir, args) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], { timeout: 30000, windowsHide: true });
    return stdout.trim() || null;
  } catch { return null; }
}

/**
 * Run the tool on files of one Lean project, with a per-file report cache.
 * @param {object} p
 * @param {string} p.project          the project directory (its lean-toolchain, lakefile, .lake)
 * @param {{key:string, file:string, targets?:string[]}[]} p.files  absolute paths; `key` names the result
 * @returns {{ project: object, reports: Map<string, object>, failures: object[] }}
 */
export async function measureProjectFiles({ project, files, cacheDir, jobs = 3, chunkSize = 6, timeoutPerFileMs = 600000, heartbeats = 200000, refresh = false, log = () => {} }) {
  const tc = await detectToolchain(project);
  if (!tc.available || !tc.lean_exe) throw new Error(`${project}: Lean toolchain not usable (${tc.reason || 'unknown reason'})`);
  const commit = await git(project, ['rev-parse', 'HEAD']);
  const toolSha = sha256(await fs.readFile(TOOL_FILE, 'utf8'));
  const opts = toolOptions(tc.lean_options);
  const info = { dir: project, remote: await git(project, ['remote', 'get-url', 'origin']), commit, toolchain: tc.toolchain, lean_version: tc.lean_version, mathlib: tc.mathlib?.rev || null, options: tc.lean_options };
  const runner = new LeanRunner(tc, { timeoutMs: timeoutPerFileMs });
  const dir = path.join(cacheDir, 'proof-metrics');
  await ensureDir(dir);

  const reports = new Map();
  const todo = [];
  for (const f of files) {
    const text = await fs.readFile(f.file, 'utf8');
    const key = sha256([toolSha, tc.lean_version, commit, opts.join(' '), heartbeats, f.file, text, (f.targets || []).join(',')].join('\0'));
    const cacheFile = path.join(dir, `${key.slice(0, 32)}.json`);
    const hit = refresh ? null : await readJson(cacheFile, null);
    if (hit) reports.set(f.key, { ...hit, text });
    else todo.push({ ...f, text, cacheFile });
  }
  log(`${project}: ${files.length - todo.length} cached, ${todo.length} to measure (${tc.lean_version})`);

  const scratch = path.join(dir, 'jobs');
  await ensureDir(scratch);
  const runChunk = async (chunk) => {
    const jobsFile = path.join(scratch, `jobs-${process.pid}-${sha256(chunk.map((c) => c.file).join('|')).slice(0, 12)}.json`);
    await fs.writeFile(jobsFile, JSON.stringify(chunk.map((c) => ({ file: c.file, targets: c.targets || [] }))));
    const args = ['--run', TOOL_FILE, '--jobs', jobsFile, '--heartbeats', String(heartbeats), ...opts];
    const r = await runner.spawnTimed(tc.lean_exe, args, { cwd: project, timeoutMs: timeoutPerFileMs * chunk.length + 120000 });
    await fs.rm(jobsFile, { force: true });
    const got = parseReports(r.stdout);
    const missing = [];
    for (const c of chunk) {
      const rep = got.find((g) => g.file === c.file);
      if (rep) {
        await writeJson(c.cacheFile, rep);
        reports.set(c.key, { ...rep, text: c.text });
      } else missing.push({ ...c, reason: r.timedOut ? 'timed out' : `no report (exit ${r.code}${r.stderr ? `: ${r.stderr.trim().split(/\r?\n/).pop().slice(0, 200)}` : ''})` });
    }
    return missing;
  };
  const limit = pLimit(Math.max(1, jobs));
  const chunks = [];
  for (let i = 0; i < todo.length; i += chunkSize) chunks.push(todo.slice(i, i + chunkSize));
  let done = 0;
  const firstPass = await Promise.all(chunks.map((c) => limit(async () => {
    const m = await runChunk(c);
    done += c.length;
    log(`  ${done}/${todo.length} files${m.length ? ` (${m.length} without a report)` : ''}`);
    return m;
  })));
  // A file after one that crashed its process gets no report: give each such file its own process once.
  const retry = firstPass.flat();
  const failures = (await Promise.all(retry.map((c) => limit(() => runChunk([c]))))).flat()
    .map((c) => ({ key: c.key, file: c.file, reason: c.reason }));
  return { project: info, reports, failures };
}

const ERROR = (m) => m.severity === 'error';

/** Records of the theorems one report describes (see `RULES`). */
export function theoremRecords(report, { source, file, problem = null }) {
  if (!report || report.error) return [];
  const text = report.text || '';
  const bytes = Buffer.from(text, 'utf8');
  const commands = new Map((report.commands || []).map((c) => [c.index, c]));
  const messages = report.messages || [];
  const out = [];
  for (const d of report.decls || []) {
    // `written: false`: generated by Lean (a structure's propositional field, an `@[ext]` lemma)
    if (d.kind !== 'theorem' || d.written === false) continue;
    const [line, endLine] = [d.start?.[0] ?? null, d.end?.[0] ?? null];
    const cmd = d.command != null ? commands.get(d.command) : null;
    let proofLines = null;
    let proofTokens = null;
    if (cmd && cmd.value_start_byte != null && cmd.value_end_byte != null) {
      const body = stripComments(bytes.subarray(cmd.value_start_byte, cmd.value_end_byte).toString('utf8'));
      const proof = body.replace(/^\s*:=/, '');
      proofLines = proof.split('\n').filter((l) => l.trim()).length;
      proofTokens = leanTokens(proof).length;
    }
    const byName = {};
    for (const [k, n] of Object.entries(cmd?.tactics_by_name || {})) if (!PLACEHOLDER_TACTICS.has(k)) byName[k] = n;
    const tactics = Object.values(byName).reduce((a, n) => a + n, 0);
    const inRange = (m) => line != null && m.line >= line && m.line <= (endLine ?? line);
    const linters = {};
    for (const m of messages) if (m.severity === 'warning' && m.linter && inRange(m)) linters[m.linter] = (linters[m.linter] || 0) + 1;
    const errors = messages.filter((m) => ERROR(m) && inRange(m)).length;
    const hyps = d.hypotheses || [];
    out.push({
      source,
      file,
      problem,
      name: d.name,
      line,
      end_line: endLine,
      has_sorry: Boolean(d.has_sorry),
      errors,
      complete: !d.has_sorry && errors === 0,
      proof_lines: proofLines,
      proof_tokens: proofTokens,
      term_size: d.term_size ?? null,
      term_size_capped: Boolean(d.term_size_capped),
      tactics,
      tactics_by_name: byName,
      automation: Object.entries(byName).reduce((a, [k, n]) => a + (AUTOMATION.has(k) ? n : 0), 0),
      hypotheses: hyps.length,
      unused_hypotheses: hyps.filter((h) => h.used === false).map((h) => h.name),
      undecided_hypotheses: hyps.filter((h) => h.used == null).length,
      linter_warnings: linters,
    });
  }
  return out;
}

const countBy = (xs) => xs.reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {});
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function linterSummary(reports) {
  const by = {};
  const perFile = [];
  for (const rep of reports) {
    let n = 0;
    for (const m of rep.messages || []) if (m.severity === 'warning' && m.linter) { by[m.linter] = (by[m.linter] || 0) + 1; n += 1; }
    perFile.push(n);
  }
  return { total: sum(Object.values(by)), by_linter: by, files_with_warnings: perFile.filter((n) => n > 0).length, per_file: summarizeValues(perFile) };
}

const fileBroken = (rep) => Boolean(rep.error) || Boolean(rep.header_errors);

/** Summary of one proof source: its files' reports and the theorem records made from them. */
export function summarizeProofs(records, reports) {
  const proofs = records.filter((r) => r.complete);
  const byName = {};
  for (const r of proofs) for (const [k, n] of Object.entries(r.tactics_by_name)) byName[k] = (byName[k] || 0) + n;
  const calls = sum(Object.values(byName));
  const auto = sum(proofs.map((r) => r.automation));
  const withHyps = proofs.filter((r) => r.hypotheses > 0);
  return {
    files: reports.length,
    files_not_elaborated: reports.filter(fileBroken).length,
    theorems: records.length,
    proofs: proofs.length,
    with_sorry: records.filter((r) => r.has_sorry).length,
    with_errors: records.filter((r) => !r.has_sorry && r.errors > 0).length,
    proof_lines: summarizeValues(proofs.map((r) => r.proof_lines)),
    proof_tokens: summarizeValues(proofs.map((r) => r.proof_tokens)),
    term_size: summarizeValues(proofs.filter((r) => !r.term_size_capped).map((r) => r.term_size)),
    term_size_capped: proofs.filter((r) => r.term_size_capped).length,
    tactics: summarizeValues(proofs.map((r) => r.tactics)),
    term_mode_proofs: proofs.filter((r) => r.tactics === 0).length,
    tactic_calls: calls,
    automation_calls: auto,
    automation_share: calls ? auto / calls : null,
    top_tactics: Object.entries(byName).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([name, count]) => ({ name, count, share: count / calls, automation: AUTOMATION.has(name) })),
    tactic_counts: byName,
    hypotheses: {
      proofs_with_hypotheses: withHyps.length,
      proofs_with_unused: withHyps.filter((r) => r.unused_hypotheses.length > 0).length,
      unused: sum(withHyps.map((r) => r.unused_hypotheses.length)),
      total: sum(withHyps.map((r) => r.hypotheses)),
      undecided: sum(withHyps.map((r) => r.undecided_hypotheses)),
    },
    linter_warnings: linterSummary(reports.filter((r) => !fileBroken(r))),
  };
}

/** Statement checks over the problem files: the automation probe of each target and linter warnings. */
export function summarizeStatements(problems) {
  const measured = problems.filter((p) => p.report && !fileBroken(p.report));
  const probes = measured.map((p) => ({ id: p.id, probe: (p.report.targets || [])[0] || null }));
  const found = probes.filter((p) => p.probe?.found);
  return {
    files: problems.length,
    measured: measured.length,
    not_elaborated: problems.filter((p) => p.report && fileBroken(p.report)).map((p) => p.id),
    targets_found: found.length,
    targets_not_found: probes.filter((p) => !p.probe?.found).map((p) => p.id),
    portfolio: found[0]?.probe.portfolio || [],
    closed_by_automation: found.filter((p) => p.probe.closed_by).length,
    contradictory: found.filter((p) => p.probe.contradictory_by).length,
    with_hypotheses: found.filter((p) => p.probe.prop_hypotheses > 0).length,
    closed_by: countBy(found.map((p) => p.probe.closed_by).filter(Boolean)),
    contradictory_by: countBy(found.map((p) => p.probe.contradictory_by).filter(Boolean)),
    flagged: found.filter((p) => p.probe.closed_by || p.probe.contradictory_by).map((p) => ({ id: p.id, target: p.probe.name, closed_by: p.probe.closed_by, contradictory_by: p.probe.contradictory_by })),
    linter_warnings: linterSummary(measured.map((p) => p.report)),
  };
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

async function walk(dir, keep, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const problemOf = (p) => (/\b(P\d{3})(?:_sol)?\.lean$/i.exec(p) || [])[1] || null;

/** Verified prove-task answers in run directories, grouped by the Lean project they were graded in. */
export async function verifiedAnswers(runDirs) {
  const out = [];
  for (const dir of runDirs) {
    const run = await readJson(path.join(dir, 'run.json'), null);
    if (!run) continue;
    const project = run.toolchain?.lean_project || null;
    const itemsDir = path.join(dir, 'items');
    for (const e of await fs.readdir(itemsDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      for (const f of await fs.readdir(path.join(itemsDir, e.name)).catch(() => [])) {
        const m = /^attempt-(a\d+r\d+)\.json$/.exec(f);
        if (!m) continue;
        const item = await readJson(path.join(itemsDir, e.name, f), null);
        if (item?.outcomes?.verified !== 1) continue;
        const proof = path.join(itemsDir, e.name, `proof-${m[1]}.lean`);
        out.push({ run_id: run.run_id || path.basename(dir), project, file: proof, problem: item.paper_id, model: item.model_label || item.model_display_name || item.provider, item_key: item.item_key, attempt: m[1] });
      }
    }
  }
  return out;
}

/**
 * Measure the selected sources and write the proof-metrics file.
 * @param {object} p
 * @param {string} p.project      the benchmark's Lean project (library and statement files)
 * @param {string} [p.solutions]  a separate checkout with *_sol.lean files (its own Lean project)
 * @param {string[]} [p.runDirs]  QEDRank runs whose verified answers are measured
 */
export async function buildProofMetrics({ project, library = 'ProofBench/Mathlib_Problems', solutions = null, runDirs = [], only = SOURCE_IDS, cacheDir, jobs = 3, chunkSize = 6, timeoutPerFileMs = 600000, heartbeats = 200000, refresh = false, log = () => {} }) {
  const out = { schema: PROOF_METRICS_SCHEMA, generated_at: isoNow(), tool: { file: 'qedrank/lean-tools/ProofMetrics.lean', sha256: sha256(await fs.readFile(TOOL_FILE, 'utf8')) }, rules: RULES, automation_tactics: AUTOMATION_TACTICS, projects: [], sources: {}, failures: [] };
  const run = async (proj, files) => {
    const r = await measureProjectFiles({ project: proj, files, cacheDir, jobs, chunkSize, timeoutPerFileMs, heartbeats, refresh, log });
    if (!out.projects.some((p) => p.dir === r.project.dir)) out.projects.push(r.project);
    out.failures.push(...r.failures);
    return r;
  };

  if (project && only.includes('library')) {
    const root = path.join(project, library);
    const files = (await walk(root, (p) => p.endsWith('.lean'))).sort().map((f) => ({ key: rel(project, f), file: f }));
    log(`library: ${files.length} files in ${rel(project, root) || root}`);
    const r = await run(project, files);
    const reports = files.map((f) => r.reports.get(f.key)).filter(Boolean);
    const records = files.flatMap((f) => theoremRecords(r.reports.get(f.key), { source: 'library', file: f.key }));
    out.sources.library = { label: `${path.basename(project)} library (${library})`, project: r.project.dir, summary: summarizeProofs(records, reports), records };
  }

  if (project && only.includes('statements')) {
    const manifest = await discoverCorpus(await openSource({ path: project }), { log: () => {}, expectedCount: 0 });
    const problems = (manifest.papers || []).map((p) => ({ id: p.paper_id, t: p.targets?.main_theorem })).filter((p) => p.t?.lean_path);
    const files = problems.map((p) => ({ key: p.id, file: path.join(project, ...p.t.lean_path.split('/')), targets: p.t.declaration_name ? [p.t.declaration_name] : [] }));
    log(`statements: ${files.length} problem files`);
    const r = await run(project, files);
    const rows = problems.map((p) => ({ id: p.id, file: p.t.lean_path, report: r.reports.get(p.id) || null }));
    out.sources.statements = {
      label: `${path.basename(project)} problem files`,
      project: r.project.dir,
      summary: summarizeStatements(rows),
      problems: rows.map((p) => {
        const probe = (p.report?.targets || [])[0] || null;
        const linters = {};
        for (const m of p.report?.messages || []) if (m.severity === 'warning' && m.linter) linters[m.linter] = (linters[m.linter] || 0) + 1;
        return { id: p.id, file: p.file, elaborated: Boolean(p.report && !fileBroken(p.report)), target: probe?.name || null, found: Boolean(probe?.found), prop_hypotheses: probe?.prop_hypotheses ?? null, closed_by: probe?.closed_by ?? null, contradictory_by: probe?.contradictory_by ?? null, linter_warnings: linters };
      }),
    };
  }

  if (solutions && only.includes('solutions')) {
    const files = (await walk(solutions, (p) => /_sol\.lean$/i.test(p))).sort().map((f) => ({ key: rel(solutions, f), file: f }));
    log(`solutions: ${files.length} files in ${solutions}`);
    const r = await run(solutions, files);
    const reports = files.map((f) => r.reports.get(f.key)).filter(Boolean);
    const records = files.flatMap((f) => theoremRecords(r.reports.get(f.key), { source: 'solutions', file: f.key, problem: problemOf(f.file) }));
    out.sources.solutions = { label: `reference solutions (${path.basename(solutions)}, private)`, private: true, project: r.project.dir, summary: summarizeProofs(records, reports), records };
  }

  if (runDirs.length && only.includes('models')) {
    const answers = await verifiedAnswers(runDirs);
    log(`models: ${answers.length} verified answers in ${runDirs.length} run(s)`);
    const records = [];
    const reports = [];
    const byProject = new Map();
    for (const a of answers) if (a.project) byProject.set(a.project, [...(byProject.get(a.project) || []), a]);
    for (const [proj, list] of byProject) {
      const files = list.map((a) => ({ key: `${a.run_id}/${a.item_key}/${a.attempt}`, file: a.file }));
      const r = await run(proj, files);
      for (const a of list) {
        const rep = r.reports.get(`${a.run_id}/${a.item_key}/${a.attempt}`);
        if (!rep) continue;
        reports.push({ ...rep, model: a.model });
        records.push(...theoremRecords(rep, { source: 'models', file: `${a.run_id}/${a.item_key}`, problem: a.problem }).map((x) => ({ ...x, model: a.model, run_id: a.run_id })));
      }
    }
    const models = [...new Set(answers.map((a) => a.model))];
    out.sources.models = {
      label: 'verified answers in QEDRank runs',
      runs: runDirs.map((d) => path.basename(d)),
      answers: answers.length,
      summary: summarizeProofs(records, reports),
      by_model: Object.fromEntries(models.map((m) => [m, summarizeProofs(records.filter((r) => r.model === m), reports.filter((r) => r.model === m))])),
      records,
    };
  }
  return out;
}

/** What the Head-to-head page receives: summaries, per-lemma rows, no private lemma names. */
export function slimProofMetrics(pm) {
  if (!pm || pm.schema !== PROOF_METRICS_SCHEMA) return null;
  const strip = ({ text, ...r }) => r;
  const sources = {};
  for (const [id, s] of Object.entries(pm.sources || {})) {
    const { records, ...rest } = s;
    if (!records) { sources[id] = rest; continue; }
    sources[id] = { ...rest, records: s.private ? records.map((r, i) => ({ ...strip(r), name: `${r.problem || 'solution'} lemma ${i + 1}`, file: r.problem || null })) : records.map(strip) };
  }
  return { schema: pm.schema, generated_at: pm.generated_at, tool: pm.tool, rules: pm.rules, automation_tactics: pm.automation_tactics, projects: pm.projects, sources, failures: (pm.failures || []).length };
}

export async function proofMetricsCommand(args, { config, log, list }) {
  const only = list(args.only).length ? list(args.only) : SOURCE_IDS;
  for (const s of only) if (!SOURCE_IDS.includes(s)) throw new Error(`unknown source ${s}; use ${SOURCE_IDS.join(', ')}`);
  const runIds = list(args.runs);
  const runDirs = runIds.length ? runIds.map((id) => path.join(config.runsDir, id)) : [];
  if (!args.project && !args.solutions && !runDirs.length) throw new Error('proof-metrics needs --project <benchmark Lean project> (and optionally --solutions <dir>, --runs id1,id2)');
  const data = await buildProofMetrics({
    project: args.project ? path.resolve(args.project) : null,
    library: args.library || 'ProofBench/Mathlib_Problems',
    solutions: args.solutions ? path.resolve(args.solutions) : null,
    runDirs,
    only,
    cacheDir: path.join(config.runsDir, '_cache'),
    jobs: Number(args.jobs || 3),
    chunkSize: Number(args.chunk || 6),
    timeoutPerFileMs: Number(args['timeout-per-file'] || 600) * 1000,
    heartbeats: Number(args.heartbeats || 200000),
    refresh: Boolean(args.refresh),
    log,
  });
  const file = path.resolve(args.out || path.join(config.runsDir, '_compare', 'proof-metrics.json'));
  await ensureDir(path.dirname(file));
  await writeJson(file, data);
  log(`wrote ${file}`);
  const n = (x) => (x == null ? '—' : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : String(x));
  console.log('\nsource | files | theorems | proofs | median lines | median tactics | automation | proofs with unused hypotheses | linter warnings');
  for (const [id, s] of Object.entries(data.sources)) {
    const m = s.summary;
    if (id === 'statements') { console.log(`statements | ${m.files} | targets found ${m.targets_found} | closed by automation ${m.closed_by_automation} | contradictory ${m.contradictory} | linter warnings ${m.linter_warnings.total}`); continue; }
    console.log(`${id} | ${m.files} | ${m.theorems} | ${m.proofs} | ${n(m.proof_lines.median)} | ${n(m.tactics.median)} | ${m.automation_share == null ? '—' : `${(100 * m.automation_share).toFixed(0)}%`} | ${m.hypotheses.proofs_with_unused}/${m.hypotheses.proofs_with_hypotheses} | ${m.linter_warnings.total}`);
  }
  if (data.failures.length) console.log(`\n${data.failures.length} file(s) without a report: ${data.failures.slice(0, 5).map((f) => `${f.key} (${f.reason})`).join('; ')}`);
}
