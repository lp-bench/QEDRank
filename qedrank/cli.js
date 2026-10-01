#!/usr/bin/env node
// QEDRank command line.
//
//   node qedrank/cli.js toolchain
//   node qedrank/cli.js discover --repo <github url> [--ref <branch|tag|sha>] [--out manifest.json] [--annotations file.json]
//       --repo accepts https://github.com/<owner>/<repo>[/tree/<branch>] (private: --token <PAT> or GITHUB_TOKEN)
//       or git@github.com:<owner>/<repo>.git (private over SSH, uses your SSH agent / deploy key)
//       --subdir <folder> restricts discovery to one folder (a /tree/<branch>/<folder> link sets it too)
//   node qedrank/cli.js run --repo <url> [--ref R] [--run-id ID] [--models a,b] [--papers p1,p2] [--targets main_theorem,...] [--limit N]
//                          [--fixtures DIR] [--attempts K] [--repair-rounds R] [--config file] [--dry-run]
//   node qedrank/cli.js resume --run-id ID [--retry-failed] [--reevaluate]
//   node qedrank/cli.js stats --run-id ID
//   node qedrank/cli.js serve [--port 8787]
//   node qedrank/cli.js prompt --run-id ID --paper P --target main_theorem
//
// A local directory can replace --repo with --path DIR (fixtures, offline review).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from './lib/config.js';
import { openSource } from './lib/source.js';
import { discoverCorpus } from './lib/corpus.js';
import { detectToolchain } from './lib/lean.js';
import { listModels } from './lib/models.js';
import { createRun, openRun, runAll, stageDiscovery, stagePreparation, stageGeneration, stageStatistics } from './lib/run.js';
import { createServer } from './lib/serve.js';
import { readJson, writeJson } from './lib/util.js';
import { TARGET_KINDS } from './lib/schema.js';
import { matrixRows, fmtRate } from './lib/metrics.js';

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
  const config = await loadConfig({ configFile: args.config || null, overrides });

  switch (cmd) {
    case 'toolchain': {
      const tc = await detectToolchain(config.leanDir, { log });
      const { path_env, ...rest } = tc;
      console.log(JSON.stringify(rest, null, 2));
      return;
    }
    case 'models': {
      console.log(JSON.stringify(listModels(), null, 2));
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
      printMatrix(summary);
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
    case 'serve': {
      const port = Number(args.port || 8787);
      const server = createServer({ runsDir: config.runsDir });
      server.listen(port, '127.0.0.1', () => log(`serving ${config.runsDir} at http://127.0.0.1:${port}/runs`));
      return;
    }
    default:
      console.error('usage: node qedrank/cli.js <toolchain|models|discover|run|resume|stats|export|prompt|serve> [options]');
      process.exitCode = 1;
  }
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
