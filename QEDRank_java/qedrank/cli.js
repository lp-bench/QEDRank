#!/usr/bin/env node
// QEDRank command line.
//
//   node qedrank/cli.js toolchain
//   node qedrank/cli.js models [--all] [--json]          the model roster and which keys are set
//   node qedrank/cli.js ping [--models a,b] [--compile] [--show]   one small Lean task per configured model
//   node qedrank/cli.js discover --repo <github url> [--ref <branch|tag|sha>] [--out manifest.json] [--annotations file.json]
//       --repo accepts https://github.com/<owner>/<repo>[/tree/<branch>] (private: --token <PAT> or GITHUB_TOKEN)
//       or git@github.com:<owner>/<repo>.git (private over SSH, uses your SSH agent / deploy key)
//       --subdir <folder> restricts discovery to one folder (a /tree/<branch>/<folder> link sets it too)
//   node qedrank/cli.js run --repo <url> [--ref R] [--run-id ID] [--models a,b] [--papers p1,p2] [--targets main_theorem,...] [--limit N] [--private] [--allow-host h1,h2]
//                          [--task formalize|prove] [--lean-project DIR] [--fixtures DIR] [--attempts K] [--repair-rounds R] [--config file] [--dry-run] [--allow-missing-imports]
//                          [--temperature T] [--top-p P] [--effort low|medium|high|xhigh|max] [--max-tokens N] [--timeout-ms MS] [--provider-concurrency N]
//       generation settings on the command line override the --config file; attempts above 1 need a temperature above 0 (pass@k is
//       reported for every k from 1 to the attempts, 16 at most on the page)
//       --task formalize (default): the model writes statement and proof from the paper text; the statement is compared with the reference
//       --task prove: the model gets the challenge file and fills in its sorry; the file is judged by the independent check (no PDF needed)
//       --lean-project: the Lean project whose toolchain, Mathlib and libraries compile the files (default lean/; for --task prove the built
//                       ProofBench checkout from qedrank.config.json harnesses.proofbench.leanProject when it exists)
//       before the first model call of a prove run, every module the challenges import must resolve in that project; a whole
//       prefix missing (e.g. ProofBench in lean/) stops the run, --allow-missing-imports makes it a warning; --dry-run runs the same check
//   node qedrank/cli.js resume --run-id ID [--retry-failed] [--reevaluate [--no-generate]] [--lean-project DIR] [--private] [--allow-host h1,h2]
//       --reevaluate grades the stored answers again (e.g. in another --lean-project); --no-generate never calls a
//       model, so items whose answer is missing or a provider error keep their record
//   node qedrank/cli.js stats --run-id ID
//   node qedrank/cli.js serve [--port 8787] [--no-jobs] [--allow-origin https://host]
//       serves runs/ to the page and, unless --no-jobs, lets the page start and watch runs (POST /jobs; localhost only)
//   node qedrank/cli.js prompt --run-id ID --paper P --target main_theorem
//   node qedrank/cli.js import-agent --bundle bundle.json[,more.json] --run-id ID [--force]
//       results of the Inspect AI harness (harness/, `proofbench-export`) as a run: same statistics, same UI
//   node qedrank/cli.js grade --challenge P001.lean --solution solution.lean [--target P001] [--lean-project DIR]
//                          [--library-prefix A,B] [--allow-extra-imports] [--extra-lean-path DIR] [--allow-unused-sorry]
//                          [--no-kernel-replay] [--out grade.json] [--scratch DIR]
//       independent Lean check of an agent's solution file; exit code 0 = graded, 2 = the grader itself failed
//   node qedrank/cli.js proof-metrics --project DIR [--solutions DIR] [--runs id1,id2] [--only library,statements,solutions,models]
//                          [--library ProofBench/Mathlib_Problems] [--jobs 3] [--timeout-per-file 600] [--refresh] [--out FILE]
//       tactics, proof length, unused hypotheses and linter warnings of the benchmark's own proofs, and an automation
//       probe of its statements, measured with Lean in each project (runs/_compare/proof-metrics.json, shown on Head-to-head)
//   node qedrank/cli.js harnesses [--json]
//       the evaluation harnesses this machine can run, with their integration state
//   node qedrank/cli.js agent-run --run-id ID --models slot[,slot] --problems P001,P002 [--attempts 1..16] [--harness proofbench] [--private] [--allow-host h1,h2]
//                          [--sessions N] [--session-output-tokens N] [--session-tokens N] [--session-working-time S] [--note-tokens N]
//                          [--max-tokens N] [--request-timeout S] [--attempt-timeout S] [--time-limit S] [--message-limit N] [--max-samples N]
//                          [--max-cost-usd X] [--effort low|high|max] [--comparator on|off] [--search] [--ref COMMIT] [--retry-infra] [--regrade [--lean-project DIR]]
//       independent attempts with the ProofBench agent harness (docs/agent-evaluation.md); resumable, every log imported
//   node qedrank/cli.js import-harness --run-id ID --proofbench DIR [--attempts N] [--regrade [--lean-project DIR]] [--merge-run ID[,ID]] [--force]
//       logs of the ProofBench harness (a log directory, or a directory of attempt-N/ directories) as a run; --merge-run adds
//       another QEDRank run's main-theorem records for a cross-harness comparison
//   node qedrank/cli.js lean-bench [--project DIR] [--files N]
//       time Lean on N challenge files of a project: the measurement to take before adding a persistent verification backend
//   node qedrank/cli.js lean-env status [--json] [--lean-project DIR]
//       the Lean environments this machine has (host project, Docker image, Apptainer .sif) and which one a run would use
//   node qedrank/cli.js lean-env build --project DIR [--tag qedrank-lean:latest] [--modules ProofBench,Matroid] [--apptainer [--sif FILE]] [--no-cache] [--platform linux/amd64]
//       the image of one Lean project (lean-env/Dockerfile): its toolchain, Mathlib from the cache, everything else from source;
//       --modules limits the module sweep to these prefixes (default: every module of every library); a prefix naming a
//       dependency package (e.g. Matroid) builds that package; `run … --dry-run --backend docker` checks the corpus's imports inside
//
// Every command that compiles Lean takes --backend auto|host|docker|apptainer [--image NAME] [--sif FILE]; the default is
// verification.backend in qedrank.config.json (auto = the host project when it is built, else the Docker image, else the .sif).
// A local directory can replace --repo with --path DIR (fixtures, offline review).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from './lib/config.js';
import { checkPrivateCorpus } from './lib/privacy.js';
import { openSource } from './lib/source.js';
import { discoverCorpus } from './lib/corpus.js';
import { selectToolchain, describeEnvironments, buildImage, verificationSettings } from './lib/leanenv.js';
import { listModels } from './lib/models.js';
import { pingModels } from './lib/ping.js';
import { getRoster, PROVIDER_IDS } from '../lib/providers.js';
import { stagePreflightProve, createRun, openRun, runAll, stageDiscovery, stagePreparation, stageGeneration, stageStatistics } from './lib/run.js';
import { createServer } from './lib/serve.js';
import { readJson, writeJson } from './lib/util.js';
import { TARGET_KINDS } from './lib/schema.js';
import { matrixRows, fmtRate } from './lib/metrics.js';
import os from 'node:os';
import { LeanRunner } from './lib/lean.js';
import { gradeSubmission, DEFAULT_GRADE_POLICY } from './lib/grade.js';
import { importAgentBundles } from './lib/agent.js';
import { JobManager, listRunConfigs } from './lib/jobs.js';
import { fileURLToPath } from 'node:url';
import { compareCommand } from './lib/compare/command.js';
import { proofMetricsCommand } from './lib/proofmetrics.js';
import { describeHarnesses, proofbenchSettings } from './lib/harness/registry.js';
import { importProofbenchLogs, discoverSources } from './lib/harness/proofbench.js';
import { runAttempts } from './lib/harness/attempts.js';
import { ATTEMPT_STATUS } from './lib/harness/status.js';

/** agent-run flags -> budget keys of the attempts driver. */
const LIMIT_FLAGS = { sessions: 'sessions', 'session-output-tokens': 'sessionOutputTokens', 'session-tokens': 'sessionTokens', 'session-working-time': 'sessionWorkingTime', 'note-tokens': 'noteTokens', 'max-tokens': 'maxTokens', 'request-timeout': 'requestTimeout', 'attempt-timeout': 'attemptTimeout', 'time-limit': 'timeLimit', 'message-limit': 'messageLimit', 'max-samples': 'maxSamples' };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    } else args._.push(a);
  }
  return args;
}

function list(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const log = (m) => process.stderr.write(`[qedrank] ${m}\n`);

function printLeanEnv(d) {
  const line = (name, e, extra) => console.log(`${name.padEnd(10)} ${(e.usable ? 'usable' : 'not usable').padEnd(11)} ${e.usable ? `${e.lean_version || e.toolchain || '?'}; mathlib ${e.mathlib || 'none'}; built=${e.mathlib_built}; audit=${e.audit_built}` : e.reason || ''}${extra ? `\n${' '.repeat(22)}${extra}` : ''}`);
  line('host', d.host, d.host.lean_project);
  const warn = (e) => (e.build_warnings?.length ? `\n${' '.repeat(22)}${e.build_warnings.length} module(s) did not build: ${e.build_warnings.slice(0, 5).join(', ')}${e.build_warnings.length > 5 ? ', …' : ''}` : '');
  line('docker', d.docker, `${d.docker.image}${d.docker.image_id ? ` ${d.docker.image_id.slice(0, 19)}` : ''}${d.docker.image_info?.project?.commit ? `; project ${d.docker.image_info.project.commit.slice(0, 10)}${d.docker.image_info.project.dirty ? ' (dirty)' : ''}, built ${d.docker.image_info.built_at}` : ''}${warn(d.docker)}`);
  line('apptainer', d.apptainer, `${d.apptainer.sif || 'no .sif configured'}${d.apptainer.image_info?.project?.commit ? `; project ${d.apptainer.image_info.project.commit.slice(0, 10)}` : ''}${warn(d.apptainer)}`);
  console.log(`requested ${d.backend_requested}; a run would use: ${d.selected || 'none (every compile would be an infrastructure failure)'}`);
  console.log(`container mounts: ${d.mounts.map((m) => `${m.host} -> ${m.container}`).join(', ')}`);
}

/**
 * A resumed run keeps the settings it was started with (attempts, token budget, timeout, effort,
 * Lean project, grade policy), so the attempts it still has to ask are asked the same way. Flags
 * and a --config file given to `resume` override them.
 */
async function resumeConfig(config, overrides, args) {
  const stored = (await readJson(path.join(config.runsDir, args['run-id'], 'run.json'), null))?.config;
  if (!stored) return config;
  const file = args.config ? (await readJson(args.config, null)) || {} : {};
  const pick = (k) => ({ ...(config[k] || {}), ...(stored[k] || {}), ...(file[k] || {}), ...(overrides[k] || {}) });
  const leanDir = overrides.leanDir || (file.leanDir ? path.resolve(file.leanDir) : null) || stored.leanDir || config.leanDir;
  if (leanDir !== config.leanDir) log(`resume: Lean project ${leanDir} (as the run was started; --lean-project overrides)`);
  return { ...config, generation: pick('generation'), lean: pick('lean'), grade: pick('grade'), concurrency: pick('concurrency'), verification: pick('verification'), leanDir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const overrides = {};
  if (args.attempts) overrides.generation = { ...(overrides.generation || {}), attempts: Number(args.attempts) };
  if (args['repair-rounds']) overrides.generation = { ...(overrides.generation || {}), repairRounds: Number(args['repair-rounds']) };
  if (args['lean-timeout']) overrides.lean = { ...(overrides.lean || {}), timeoutMs: Number(args['lean-timeout']) };
  if (args.concurrency) overrides.concurrency = { items: Number(args.concurrency) };
  if (args['runs-dir']) overrides.runsDir = args['runs-dir'];
  if (typeof args.task === 'string') overrides.task = args.task;
  if (typeof args['lean-project'] === 'string') overrides.leanDir = path.resolve(args['lean-project']);
  if (args.private) overrides.privacy = { ...(overrides.privacy || {}), privateCorpus: true };
  if (args['allow-missing-imports']) overrides.preflight = { ...(overrides.preflight || {}), allowMissingImports: true };
  for (const [flag, key] of [['temperature', 'temperature'], ['top-p', 'topP'], ['max-tokens', 'maxTokens'], ['timeout-ms', 'timeoutMs'], ['provider-concurrency', 'providerConcurrency']]) {
    if (args[flag] !== undefined && args[flag] !== true) overrides.generation = { ...(overrides.generation || {}), [key]: Number(args[flag]) };
  }
  if (typeof args.effort === 'string') overrides.generation = { ...(overrides.generation || {}), effort: args.effort };
  if (typeof args.backend === 'string') overrides.verification = { ...(overrides.verification || {}), backend: args.backend };
  if (typeof args.image === 'string') overrides.verification = { ...(overrides.verification || {}), image: args.image };
  if (typeof args.sif === 'string') overrides.verification = { ...(overrides.verification || {}), sif: path.resolve(args.sif) };
  const config = await loadConfig({ configFile: args.config || null, overrides });
  if (typeof args['allow-host'] === 'string') config.privacy.allowedHosts = [...(config.privacy.allowedHosts || []), ...list(args['allow-host'])];

  switch (cmd) {
    case 'toolchain': {
      const tc = await selectToolchain(config, { leanDir: config.leanDir, log });
      const { path_env, environment, ...rest } = tc;
      console.log(JSON.stringify({ ...rest, environment: environment ? { ...environment, mounts: (environment.mounts || []).map((m) => `${m.host}:${m.container}`) } : null }, null, 2));
      return;
    }
    case 'lean-env': {
      const sub = args._[1] || 'status';
      if (sub === 'status') {
        const leanDir = typeof args['lean-project'] === 'string' ? path.resolve(args['lean-project']) : config.leanDir;
        const d = await describeEnvironments(config, { leanDir, log });
        if (args.json) console.log(JSON.stringify(d, null, 2));
        else printLeanEnv(d);
        return;
      }
      if (sub === 'build') {
        const project = path.resolve(typeof args.project === 'string' ? args.project : config.leanDir);
        const r = await buildImage({
          project, tag: typeof args.tag === 'string' ? args.tag : verificationSettings(config).image, modules: list(args.modules), apptainer: Boolean(args.apptainer),
          sif: typeof args.sif === 'string' ? path.resolve(args.sif) : null, noCache: Boolean(args['no-cache']), platform: typeof args.platform === 'string' ? args.platform : null, log,
        });
        console.log(JSON.stringify({ tag: r.tag, image_id: r.image_id, size_bytes: r.size_bytes, sif: r.sif, sif_archive: r.sif_archive, project: r.manifest.project, built_at: r.manifest.built_at }, null, 2));
        return;
      }
      throw new Error('lean-env takes: status [--json] [--lean-project DIR]  |  build --project DIR [--tag NAME] [--modules Prefix.A,Prefix.B] [--apptainer [--sif FILE]] [--no-cache] [--platform linux/amd64]');
    }
    case 'models': {
      const ids = args.all ? PROVIDER_IDS : list(args.models).length ? list(args.models) : getRoster();
      const rows = listModels(process.env, ids);
      if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      const pol = checkPrivateCorpus({ config, slots: ids, env: process.env });
      if (pol.enforced) console.log(`private corpus: allowed hosts ${pol.allowed_hosts.join(', ')}; refused slots: ${pol.refused.length ? pol.slots.filter((r) => !r.allowed).map((r) => `${r.slot} (${r.host || 'unknown host'})`).join(', ') : 'none'}`);
      console.log('slot | id | provider | model | key | status');
      rows.forEach((m, i) => console.log(`${String(i + 1).padStart(2)} | ${m.id} | ${m.label} | ${m.model_id || '(set QEDRANK_CUSTOM_MODEL)'} | ${m.env_key} | ${m.retired ? 'retired' : m.configured ? 'configured' : 'no key'}`));
      return;
    }
    case 'ping': {
      const ids = list(args.models).length ? list(args.models) : getRoster();
      const rows = await pingModels(ids, { compile: Boolean(args.compile), leanDir: config.leanDir, config, timeoutMs: Number(args.timeout || 120000), maxTokens: Number(args['max-tokens'] || config.generation.maxTokens), log });
      if (args.out) { await writeJson(args.out, rows); log(`wrote ${args.out}`); }
      console.log('\nmodel | status | latency | output tokens | attempts' + (args.compile ? ' | compile' : ''));
      for (const r of rows) {
        console.log(`${r.label} · ${r.model_id || '-'} | ${r.status} | ${r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)} s` : '-'} | ${r.output_tokens ?? '-'} | ${r.attempts ?? '-'}${args.compile ? ` | ${r.compile ? r.compile.status + (r.compile.placeholder ? ' (uses sorry)' : '') : '-'}` : ''}`);
        if (r.error) console.log(`    ${r.error.slice(0, 300)}`);
        if (args.show && r.answer) console.log(r.answer.split('\n').map((l) => `    | ${l}`).join('\n'));
      }
      const ok = rows.filter((r) => r.status === 'ok').length;
      console.log(`\n${ok} of ${rows.length} models answered; ${rows.filter((r) => r.status === 'not_configured').length} have no key.`);
      return;
    }
    case 'discover': {
      const source = await openSource({ url: args.repo, path: args.path, ref: args.ref, subdir: args.subdir || null, token: args.token || null, limits: config.download });
      const annotations = args.annotations ? await readJson(args.annotations) : null;
      const manifest = await discoverCorpus(source, { annotations, expectedCount: config.expectedPaperCount, log });
      if (args.out) { await writeJson(args.out, manifest); log(`wrote ${args.out}`); }
      else console.log(JSON.stringify(manifest, null, 2));
      const c = manifest.counts;
      log(`papers=${c.papers} (expected ${c.expected_count}, matches=${c.expected_count_matches}) targets=${JSON.stringify(c.targets)} flagged=${c.papers_flagged}`);
      return;
    }
    case 'run': {
      if (!args.repo && !args.path) throw new Error('run requires --repo <github url> or --path <dir>');
      const models = list(args.models).length ? list(args.models) : config.models;
      const mode = args.fixtures ? 'fixture' : 'live';
      if (mode === 'live') {
        const missing = listModels().filter((m) => models.includes(m.id) && !m.configured).map((m) => m.id);
        if (missing.length) log(`WARNING: no API key for ${missing.join(', ')}; their items will be recorded as infrastructure failures`);
      }
      if (config.generation.attempts > 1 && !(config.generation.temperature > 0)) log(`WARNING: ${config.generation.attempts} attempts at temperature ${config.generation.temperature}: the attempts will be near-identical and pass@k says nothing; pass --temperature (e.g. 1.0) or a --config file such as configs/glm-prove-pass4.json`);
      const ctx = await createRun({ config, runId: args['run-id'] || undefined, sourceOpts: { url: args.repo, path: args.path, ref: args.ref, subdir: args.subdir || null }, models, mode, log });
      ctx.sourceToken = args.token || null;
      if (mode === 'fixture') { ctx.run.fixture_dir = path.resolve(args.fixtures); await ctx.saveRun(); }
      log(`run ${ctx.run.run_id} at ${ctx.runDir}`);
      if (config.leanDirDefault) log(`lean project: ${config.leanDir} (default for the prove task from ${config.leanDirDefault}; --lean-project overrides)`);
      const selection = { papers: list(args.papers), models, targets: list(args.targets).filter((t) => TARGET_KINDS.includes(t)), limit: args.limit ? Number(args.limit) : null };
      const annotations = args.annotations ? await readJson(args.annotations) : null;
      if (args['dry-run']) {
        await stageDiscovery(ctx, { annotations });
        await stagePreparation(ctx, { selection });
        if (config.task === 'prove') await stagePreflightProve(ctx, { selection, mode });
        log(`dry run: discovery${config.task === 'prove' ? ', preparation and the import check' : ' and preparation'} complete; no model calls made`);
        return;
      }
      const { summary } = await runAll(ctx, { selection, annotations, fixtureDir: args.fixtures ? path.resolve(args.fixtures) : null });
      printMatrix(summary);
      return;
    }
    case 'resume': {
      if (!args['run-id']) throw new Error('resume requires --run-id');
      const ctx = await openRun({ config: await resumeConfig(config, overrides, args), runId: args['run-id'], log });
      ctx.sourceToken = args.token || null;
      const sel = ctx.run.selection || {};
      const selection = { papers: list(args.papers).length ? list(args.papers) : sel.papers || [], models: sel.models || ctx.run.models, targets: sel.targets || [], limit: null };
      await stageDiscovery(ctx);
      await stagePreparation(ctx, { selection: { ...selection, papers: selection.papers } });
      await stageGeneration(ctx, { selection, retryFailed: Boolean(args['retry-failed']), reevaluate: Boolean(args.reevaluate), noGenerate: Boolean(args['no-generate']), fixtureDir: ctx.run.fixture_dir || null });
      const { summary } = await stageStatistics(ctx);
      printMatrix(summary);
      return;
    }
    case 'stats':
    case 'export': {
      if (!args['run-id']) throw new Error(`${cmd} requires --run-id`);
      const ctx = await openRun({ config, runId: args['run-id'], log });
      const { summary, exports: ex } = await stageStatistics(ctx);
      if (summary.agent) printAgent(summary); else printMatrix(summary);
      log(`exports: ${Object.values(ex).join(', ')}`);
      return;
    }
    case 'prompt': {
      if (!args['run-id'] || !args.paper || !args.target) throw new Error('prompt requires --run-id, --paper and --target');
      const ctx = await openRun({ config, runId: args['run-id'], log });
      const items = await fs.readdir(ctx.p('items')).catch(() => []);
      const key = items.find((k) => k.startsWith(`${args.paper}__${args.target}__`));
      if (!key) throw new Error('no generated item found for that paper/target; run first');
      console.log(await fs.readFile(ctx.p('items', key, 'prompt-a1.txt'), 'utf8'));
      return;
    }
    case 'import-agent': {
      if (!args.bundle || !args['run-id']) throw new Error('import-agent requires --bundle <file[,file]> and --run-id');
      await importAgentBundles({ config, runId: args['run-id'], files: list(args.bundle).map((f) => path.resolve(f)), force: Boolean(args.force), log });
      const ctx = await openRun({ config, runId: args['run-id'], log });
      const { summary, exports: ex } = await stageStatistics(ctx);
      printAgent(summary);
      log(`exports: ${Object.values(ex).join(', ')}`);
      return;
    }
    case 'grade': {
      if (!args.challenge || !args.solution) throw new Error('grade requires --challenge <file> and --solution <file>');
      const leanDir = args['lean-project'] ? path.resolve(args['lean-project']) : config.leanDir;
      const toolchain = await selectToolchain(config, { leanDir, log });
      const runner = new LeanRunner(toolchain, { ...config.lean, log });
      const challengeSrc = await fs.readFile(args.challenge, 'utf8');
      const solutionSrc = await fs.readFile(args.solution, 'utf8').catch(() => null);
      const scratchDir = args.scratch ? path.resolve(args.scratch) : await fs.mkdtemp(path.join(os.tmpdir(), 'qedrank-grade-'));
      const policy = {
        libraryPrefixes: list(args['library-prefix']).length ? list(args['library-prefix']) : DEFAULT_GRADE_POLICY.libraryPrefixes,
        allowExtraImports: Boolean(args['allow-extra-imports']),
        allowUnusedSorry: Boolean(args['allow-unused-sorry']),
        kernelReplay: !args['no-kernel-replay'],
      };
      const extraLeanPath = typeof args['extra-lean-path'] === 'string' ? args['extra-lean-path'].split(path.delimiter).filter(Boolean).map((d) => path.resolve(d)) : [];
      let grade;
      try {
        grade = await gradeSubmission({ runner, toolchain, challengeSrc, solutionSrc, target: typeof args.target === 'string' ? args.target : null, scratchDir, cacheDir: path.join(config.runsDir, '.grade-cache'), policy, extraLeanPath, allowedAxioms: config.allowedAxioms, log });
      } finally {
        if (!args.scratch) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      }
      if (args.out) { await writeJson(path.resolve(args.out), grade); log(`wrote ${args.out}`); }
      else console.log(JSON.stringify(grade, null, 2));
      log(`verdict: ${grade.verdict}${grade.reasons.length ? ` (${grade.reasons.join(', ')})` : ''}`);
      if (grade.verdict === 'grader_error') process.exitCode = 2;
      return;
    }
    case 'compare': {
      await compareCommand(args, { config, log, list });
      return;
    }
    case 'proof-metrics': {
      await proofMetricsCommand(args, { config, log, list });
      return;
    }
    case 'harnesses': {
      const rows = await describeHarnesses(config);
      if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      for (const h of rows) console.log(`${h.id.padEnd(22)} ${h.integration.padEnd(18)} ${h.ready ? 'ready' : 'not ready'}${h.reason ? ` - ${h.reason}` : ''}`);
      return;
    }
    case 'agent-run': {
      if (!args['run-id'] || typeof args.models !== 'string' || typeof args.problems !== 'string') throw new Error('agent-run requires --run-id ID, --models slot[,slot] and --problems P001[,P002]');
      const harness = typeof args.harness === 'string' ? args.harness : 'proofbench';
      if (harness !== 'proofbench') throw new Error(`no driver for harness ${harness}; see node qedrank/cli.js harnesses`);
      const limits = {};
      for (const [flag, key] of Object.entries(LIMIT_FLAGS)) if (args[flag] !== undefined && args[flag] !== true) limits[key] = Number(args[flag]);
      const regrade = args.regrade ? { leanProject: typeof args['lean-project'] === 'string' ? path.resolve(args['lean-project']) : (await proofbenchSettings(config)).leanProject } : null;
      if (regrade && !regrade.leanProject) throw new Error('--regrade needs the pinned Lean project: --lean-project DIR or harnesses.proofbench.leanProject in qedrank.config.json');
      const result = await runAttempts({
        config, runId: args['run-id'], slots: list(args.models), problems: list(args.problems), attempts: Number(args.attempts || 1), limits,
        effort: typeof args.effort === 'string' ? args.effort : null, search: Boolean(args.search), network: args.network === undefined ? null : args.network !== 'false',
        comparator: args.comparator !== 'off', retryInfra: Boolean(args['retry-infra']), maxCostUsd: args['max-cost-usd'] !== undefined && args['max-cost-usd'] !== true ? Number(args['max-cost-usd']) : null,
        datasetRef: typeof args.ref === 'string' ? args.ref : null, regrade, log,
      });
      log(`attempts: ${result.attempts.map((a) => `a${a.attempt}=${a.status}`).join(' ')}; stop reason: ${result.stop_reason}`);
      const summary = await readJson(path.join(config.runsDir, args['run-id'], 'summary.json'), null);
      if (summary) printAttempts(summary);
      if (result.stop_reason !== 'completed') process.exitCode = 3;
      return;
    }
    case 'import-harness': {
      if (!args['run-id'] || typeof args.proofbench !== 'string') throw new Error('import-harness requires --run-id ID and --proofbench DIR (a log directory, or a directory of attempt-N/ directories)');
      const sources = await discoverSources(path.resolve(args.proofbench));
      const regrade = args.regrade ? { leanProject: typeof args['lean-project'] === 'string' ? path.resolve(args['lean-project']) : (await proofbenchSettings(config)).leanProject } : null;
      if (regrade && !regrade.leanProject) throw new Error('--regrade needs the pinned Lean project: --lean-project DIR or harnesses.proofbench.leanProject in qedrank.config.json');
      await importProofbenchLogs({ config, runId: args['run-id'], sources, attemptsPlanned: args.attempts && args.attempts !== true ? Number(args.attempts) : null, force: Boolean(args.force), regrade, mergeRuns: list(args['merge-run']), log });
      const ctx = await openRun({ config, runId: args['run-id'], log });
      const { summary, exports: ex } = await stageStatistics(ctx);
      printAttempts(summary);
      log(`exports: ${Object.values(ex).join(', ')}`);
      return;
    }
    case 'lean-bench': {
      const project = path.resolve(typeof args.project === 'string' ? args.project : config.leanDir);
      const n = Number(args.files || 3);
      const toolchain = await selectToolchain(config, { leanDir: project, log });
      const runner = new LeanRunner(toolchain, { ...config.lean, log });
      const probDir = path.join(project, 'ProofBench', 'PROBLEMS');
      const ids = (await fs.readdir(probDir).catch(() => [])).filter((d) => /^P\d{3}$/.test(d)).sort().slice(0, n);
      if (!ids.length) throw new Error(`no ProofBench/PROBLEMS/Pxxx folders under ${project}; give a built statements project with --project`);
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qedrank-lean-bench-cache-'));
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qedrank-lean-bench-'));
      const rows = [];
      try {
        for (const id of ids) {
          const src = await fs.readFile(path.join(probDir, id, `${id}.lean`), 'utf8');
          const t0 = Date.now();
          const g = await gradeSubmission({ runner, toolchain, challengeSrc: src, solutionSrc: src, target: id, scratchDir: path.join(scratch, id), cacheDir, policy: { ...DEFAULT_GRADE_POLICY, libraryPrefixes: ['ProofBench.Mathlib_Problems', 'Matroid', 'Archive.Sensitivity'], allowUnusedSorry: true, kernelReplay: false }, allowedAxioms: config.allowedAxioms, log: () => {} });
          rows.push({ id, challenge_compile_s: g.timing?.challenge_compile_ms != null ? g.timing.challenge_compile_ms / 1000 : null, solution_compile_s: g.timing?.compile_ms != null ? g.timing.compile_ms / 1000 : null, wall_s: (Date.now() - t0) / 1000, verdict: g.verdict, reasons: g.reasons });
          log(`${id}: challenge ${rows.at(-1).challenge_compile_s ?? '?'} s, file ${rows.at(-1).solution_compile_s ?? '?'} s, wall ${rows.at(-1).wall_s.toFixed(1)} s`);
        }
      } finally {
        await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
        await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
      }
      const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
      const report = { project, toolchain: toolchain.toolchain, lean_version: toolchain.lean_version, cpus: os.cpus().length, memory_mb: Math.round(os.totalmem() / 1048576), files: rows, median_file_compile_s: med(rows.map((r) => r.solution_compile_s)), median_wall_s: med(rows.map((r) => r.wall_s)), measured_at: new Date().toISOString() };
      const perFile = report.median_wall_s;
      report.assessment = perFile === null ? 'no timing' : perFile > 60 ? `about ${Math.round(perFile)} s per file: with hundreds of attempts, Lean checking is a bottleneck on this machine; a persistent verification backend (Kimina Lean Server or LeanInteract) is worth evaluating, provided it runs this exact toolchain (${toolchain.toolchain})` : `about ${Math.round(perFile)} s per file: Lean checking is not the bottleneck here; keep the lean-cli backend`;
      if (args.out) { await writeJson(path.resolve(args.out), report); log(`wrote ${args.out}`); } else console.log(JSON.stringify(report, null, 2));
      return;
    }
    case 'serve': {
      const port = Number(args.port || 8787);
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const jobs = args['no-jobs'] ? null : new JobManager({ cwd: repoRoot, cliPath: fileURLToPath(import.meta.url), logDir: path.join(config.runsDir, '.jobs') });
      const server = createServer({ runsDir: config.runsDir, jobs, allowOrigins: list(args['allow-origin']), harnesses: () => describeHarnesses(config), configs: () => listRunConfigs(path.join(repoRoot, 'configs')) });
      server.listen(port, '127.0.0.1', () => log(`serving ${config.runsDir} at http://127.0.0.1:${port}/runs${jobs ? ' (the page can start runs here; --no-jobs disables that)' : ''}`));
      return;
    }
    default:
      console.error('usage: node qedrank/cli.js <toolchain|models|ping|discover|run|resume|stats|export|prompt|grade|import-agent|import-harness|agent-run|harnesses|lean-bench|compare|proof-metrics|serve> [options]');
      process.exitCode = 1;
  }
}

/** Attempt statuses, pass@k and coverage per model of an imported or driven agent run. */
function printAttempts(summary) {
  const name = (id) => summary.models.find((m) => m.id === id)?.display_name ?? id;
  const hp = summary.run?.harness_protocol;
  console.log(`\nRun ${summary.run?.run_id}: ${summary.attempts?.planned ?? summary.settings?.attempts ?? 1} attempt(s) planned${hp ? `; harness ${hp.id} @ ${(hp.commit || '').slice(0, 10)}, image ${(hp.image_id || '').replace(/^sha256:/, '').slice(0, 12) || 'n/a'}, Lean ${hp.lean_toolchain || 'n/a'}, Comparator ${hp.comparator === false ? 'off' : 'on'}` : ''}`);
  console.log(`model | ${ATTEMPT_STATUS.slice(0, 4).join(' | ')} | pass@k (unbiased, prominent) | problems covered`);
  for (const m of summary.models) {
    const mm = summary.by_target.all?.[m.id];
    if (!mm) continue;
    const sc = mm.status_counts || {};
    const curve = (mm.pass_at_k?.curve || []).filter((c) => c.prominent).map((c) => `pass@${c.k}=${c.value === null ? 'unavailable' : `${(100 * c.value).toFixed(1)}%`} (n=${c.items})`).join(', ');
    console.log(`${name(m.id)} | ${sc.fully_solved ?? 0} | ${sc.partially_solved ?? 0} | ${sc.failed ?? 0} | ${sc.infrastructure_error ?? 0} | ${curve || 'n/a'} | ${summary.coverage?.problems_by_model?.[m.id]?.length ?? '?'}`);
  }
  for (const d of summary.coverage?.coverage_differences || []) console.log(`coverage: ${name(d.model)} lacks ${d.missing.length} problem(s) others have: ${d.missing.slice(0, 10).join(' ')}${d.missing.length > 10 ? ' …' : ''}`);
  for (const mm of summary.run?.protocol_mismatches || []) console.log(`WARNING: ${mm.model} (attempt ${mm.attempt}) differs from ${mm.reference_model} in ${mm.field}`);
  if (summary.attempts?.stop_reason && summary.attempts.stop_reason !== 'completed') console.log(`stop reason: ${summary.attempts.stop_reason}`);
}

function printAgent(summary) {
  const a = summary.agent;
  const name = (id) => summary.models.find((m) => m.id === id)?.display_name ?? id;
  console.log(`\nAgent run: at most ${a.sessions_max} session(s) per problem; web search ${a.web_search ? 'on' : 'off'}; harness ${summary.run.harness?.commit?.slice(0, 10) ?? 'unknown'}`);
  console.log(`model | ${a.tiers.map((k) => `solved within ${k}`).join(' | ')} | median sessions to success | output tokens (total) | working time (total) | tool calls | awaiting audit`);
  for (const [m, r] of Object.entries(a.by_model)) {
    const tiers = a.tiers.map((k) => `${fmtRate(r.solved_within[k])}`).join(' | ');
    const hours = r.totals.working_ms != null ? `${(r.totals.working_ms / 3.6e6).toFixed(2)} h` : 'n/a';
    console.log(`${name(m)} | ${tiers} | ${r.sessions_to_success.median ?? 'n/a'} | ${r.totals.output_tokens ?? 'n/a'} | ${hours} | ${r.totals.tool_calls ?? 'n/a'} | ${r.awaiting_manual_audit.length}`);
    if (r.open_claim_escalations.length) console.log(`    ESCALATE for review (apparent proofs of open claims): ${r.open_claim_escalations.join(', ')}`);
    if (r.infrastructure_failures) console.log(`    ${r.infrastructure_failures} problem(s) could not be graded or errored; excluded from the rates`);
  }
  for (const mm of summary.run.protocol_mismatches || []) console.log(`WARNING: ${mm.model} differs from ${mm.reference_model} in ${mm.field}`);
}

function printMatrix(summary) {
  const rows = matrixRows(summary).filter((r) => r.scope === 'all');
  console.log('\nQEDRank matrix (all targets, pass@1):');
  console.log('model | eligible(stmt/proof) | GT-faithful statement | compile | verified pass@1 | sandwich | RMS cal (stmt/proof) | median total ms');
  for (const r of rows) {
    console.log(`${r.model} | ${r.eligible_statement_n}/${r.eligible_proof_n} | ${r.statement_faithful} | ${r.compile} | ${r.verified_pass1} ${r.verified_pass1_ci} | ${r.sandwich_coverage} | ${r.rms_calibration_statement ?? 'n/a'}/${r.rms_calibration_proof ?? 'n/a'} | ${r.median_total_ms ?? 'n/a'}`);
  }
  const c = summary.coverage;
  console.log(`\ncorpus: ${c.papers_discovered} papers discovered (expected ${c.expected_count}, matches=${c.expected_count_matches}); items=${c.items_total}, infrastructure failures=${c.items_infrastructure_failed}`);
  if (c.open_claim_escalations?.length) console.log(`ESCALATE for review (apparent proofs of open claims): ${c.open_claim_escalations.join(', ')}`);
}

main().catch((err) => {
  console.error(`[qedrank] error: ${err.message}`);
  if (process.env.QEDRANK_DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
