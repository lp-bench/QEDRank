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
//   node qedrank/cli.js run --repo <url> [--ref R] [--run-id ID] [--models a,b] [--papers p1,p2] [--targets main_theorem,...] [--limit N]
//                          [--task formalize|prove] [--lean-project DIR] [--fixtures DIR] [--attempts K] [--repair-rounds R] [--config file] [--dry-run]
//       --task formalize (default): the model writes statement and proof from the paper text; the statement is compared with the reference
//       --task prove: the model gets the challenge file and fills in its sorry; the file is judged by the independent check (no PDF needed)
//       --lean-project: the Lean project whose toolchain, Mathlib and libraries compile the files (default lean/; a built ProofBench checkout for its statement library)
//   node qedrank/cli.js resume --run-id ID [--retry-failed] [--reevaluate]
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
//
// A local directory can replace --repo with --path DIR (fixtures, offline review).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from './lib/config.js';
import { openSource } from './lib/source.js';
import { discoverCorpus } from './lib/corpus.js';
import { detectToolchain } from './lib/lean.js';
import { listModels } from './lib/models.js';
import { pingModels } from './lib/ping.js';
import { getRoster, PROVIDER_IDS } from '../lib/providers.js';
import { createRun, openRun, runAll, stageDiscovery, stagePreparation, stageGeneration, stageStatistics } from './lib/run.js';
import { createServer } from './lib/serve.js';
import { readJson, writeJson } from './lib/util.js';
import { TARGET_KINDS } from './lib/schema.js';
import { matrixRows, fmtRate } from './lib/metrics.js';
import os from 'node:os';
import { LeanRunner } from './lib/lean.js';
import { gradeSubmission, DEFAULT_GRADE_POLICY } from './lib/grade.js';
import { importAgentBundles } from './lib/agent.js';
import { JobManager } from './lib/jobs.js';
import { fileURLToPath } from 'node:url';

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
  const config = await loadConfig({ configFile: args.config || null, overrides });

  switch (cmd) {
    case 'toolchain': {
      const tc = await detectToolchain(config.leanDir, { log });
      const { path_env, ...rest } = tc;
      console.log(JSON.stringify(rest, null, 2));
      return;
    }
    case 'models': {
      const ids = args.all ? PROVIDER_IDS : list(args.models).length ? list(args.models) : getRoster();
      const rows = listModels(process.env, ids);
      if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      console.log('slot | id | provider | model | key | status');
      rows.forEach((m, i) => console.log(`${String(i + 1).padStart(2)} | ${m.id} | ${m.label} | ${m.model_id || '(set QEDRANK_CUSTOM_MODEL)'} | ${m.env_key} | ${m.retired ? 'retired' : m.configured ? 'configured' : 'no key'}`));
      return;
    }
    case 'ping': {
      const ids = list(args.models).length ? list(args.models) : getRoster();
      const rows = await pingModels(ids, { compile: Boolean(args.compile), leanDir: config.leanDir, timeoutMs: Number(args.timeout || 120000), maxTokens: Number(args['max-tokens'] || config.generation.maxTokens), log });
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
      const ctx = await createRun({ config, runId: args['run-id'] || undefined, sourceOpts: { url: args.repo, path: args.path, ref: args.ref, subdir: args.subdir || null }, models, mode, log });
      ctx.sourceToken = args.token || null;
      if (mode === 'fixture') { ctx.run.fixture_dir = path.resolve(args.fixtures); await ctx.saveRun(); }
      log(`run ${ctx.run.run_id} at ${ctx.runDir}`);
      const selection = { papers: list(args.papers), models, targets: list(args.targets).filter((t) => TARGET_KINDS.includes(t)), limit: args.limit ? Number(args.limit) : null };
      const annotations = args.annotations ? await readJson(args.annotations) : null;
      if (args['dry-run']) {
        await stageDiscovery(ctx, { annotations });
        await stagePreparation(ctx, { selection });
        log('dry run: discovery and preparation complete; no model calls made');
        return;
      }
      const { summary } = await runAll(ctx, { selection, annotations, fixtureDir: args.fixtures ? path.resolve(args.fixtures) : null });
      printMatrix(summary);
      return;
    }
    case 'resume': {
      if (!args['run-id']) throw new Error('resume requires --run-id');
      const ctx = await openRun({ config, runId: args['run-id'], log });
      ctx.sourceToken = args.token || null;
      const sel = ctx.run.selection || {};
      const selection = { papers: list(args.papers).length ? list(args.papers) : sel.papers || [], models: sel.models || ctx.run.models, targets: sel.targets || [], limit: null };
      await stageDiscovery(ctx);
      await stagePreparation(ctx, { selection: { ...selection, papers: selection.papers } });
      await stageGeneration(ctx, { selection, retryFailed: Boolean(args['retry-failed']), reevaluate: Boolean(args.reevaluate), fixtureDir: ctx.run.fixture_dir || null });
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
      const toolchain = await detectToolchain(leanDir, { log });
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
    case 'serve': {
      const port = Number(args.port || 8787);
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const jobs = args['no-jobs'] ? null : new JobManager({ cwd: repoRoot, cliPath: fileURLToPath(import.meta.url), logDir: path.join(config.runsDir, '.jobs') });
      const server = createServer({ runsDir: config.runsDir, jobs, allowOrigins: list(args['allow-origin']) });
      server.listen(port, '127.0.0.1', () => log(`serving ${config.runsDir} at http://127.0.0.1:${port}/runs${jobs ? ' (the page can start runs here; --no-jobs disables that)' : ''}`));
      return;
    }
    default:
      console.error('usage: node qedrank/cli.js <toolchain|models|ping|discover|run|resume|stats|export|prompt|grade|import-agent|serve> [options]');
      process.exitCode = 1;
  }
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
