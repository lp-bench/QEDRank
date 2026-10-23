// Run orchestration: discovery -> preparation -> generation/evaluation -> statistics.
// Every stage persists per-paper / per-item artifacts so an interrupted run
// resumes without repeating completed work.

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { RUN_SCHEMA, TARGET_KINDS, STAGES, itemKey } from './schema.js';
import { ensureDir, exists, readJson, writeJson, writeText, sha256, isoNow, nowMono, pLimit, slug, leanIdent } from './util.js';
import { openSource } from './source.js';
import { discoverCorpus } from './corpus.js';
import { extractPdfText, guessTitle, buildContext, findPages, figureMentions } from './pdf.js';
import { detectToolchain, LeanRunner } from './lean.js';
import { preparePrelude, prepareReference, evaluateAttempt } from './evaluate.js';
import { renderPrompt, PROMPT_TEMPLATE_VERSION, SYSTEM_PROMPT } from './prompt.js';
import { generateOnce, listModels, loadFixtureProvider, providerHalt } from './models.js';
import { assertPrivateCorpus, checkPrivateCorpus } from './privacy.js';
import { checkChallengeImports } from './preflight.js';
import { buildSummary } from './metrics.js';
import { writeExports } from './export.js';
import { findDeclarations } from './leansrc.js';
import { sanitizeConfig } from './config.js';
import { harnessRevision } from './provenance.js';
import { modelFacts } from '../../lib/model-facts.js';
import { applyManualAudit } from './agent.js';
import { renderProvePrompt, evaluateProveAttempt, PROVE_TEMPLATE_VERSION, PROVE_ENDPOINT } from './prove.js';
import { compileChallenge } from './grade.js';

export class RunContext {
  constructor({ runDir, config, log }) {
    this.runDir = runDir;
    this.config = config;
    this.log = log || ((m) => process.stderr.write(`${m}\n`));
    this.progress = null;
  }

  p(...parts) { return path.join(this.runDir, ...parts); }

  async loadRun() { this.run = await readJson(this.p('run.json')); return this.run; }
  async saveRun() { this.run.updated_at = isoNow(); await writeJson(this.p('run.json'), this.run); }

  async setStage(stage, status, extra = {}) {
    this.run.stages[stage] = { ...(this.run.stages[stage] || {}), status, ...extra, updated_at: isoNow() };
    await this.saveRun();
  }

  async updateProgress(patch) {
    this.progress = { ...(this.progress || {}), ...patch, updated_at: isoNow() };
    await writeJson(this.p('progress.json'), this.progress);
  }
}

export function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `run-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Create a run directory with run.json. */
export async function createRun({ config, runId = newRunId(), sourceOpts, models, mode, log }) {
  const runDir = path.join(config.runsDir, runId);
  if (await exists(path.join(runDir, 'run.json'))) throw new Error(`Run already exists: ${runDir} (use resume)`);
  await ensureDir(runDir);
  const run = {
    schema: RUN_SCHEMA,
    run_id: runId,
    created_at: isoNow(),
    updated_at: isoNow(),
    source_request: { url: sourceOpts.url ?? null, path: sourceOpts.path ?? null, ref: sourceOpts.ref ?? null, subdir: sourceOpts.subdir ?? null },
    source: null,
    mode,
    models,
    model_ids: null,
    protocol: 'single_call',
    task: config.task || 'formalize',
    harness: await harnessRevision(),
    prompt_template_version: config.task === 'prove' ? PROVE_TEMPLATE_VERSION : PROMPT_TEMPLATE_VERSION,
    primary_endpoint: config.task === 'prove' ? PROVE_ENDPOINT : config.primaryEndpoint,
    system_prompt: SYSTEM_PROMPT,
    settings: {
      temperature: config.generation.temperature,
      sampling_extras: samplingExtras(config.generation),
      max_tokens: config.generation.maxTokens,
      generation_timeout_ms: config.generation.timeoutMs,
      attempts_k: config.generation.attempts,
      repair_rounds: config.generation.repairRounds,
      lean: config.lean,
      context_max_chars: config.context.maxChars,
      primary_endpoint: config.primaryEndpoint,
    },
    toolchain: null,
    machine: { platform: os.platform(), release: os.release(), cpus: os.cpus().length, total_memory_mb: Math.round(os.totalmem() / 1048576), node: process.version },
    config: sanitizeConfig(config),
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: 'pending' }])),
    selection: null,
  };
  await writeJson(path.join(runDir, 'run.json'), run);
  const ctx = new RunContext({ runDir, config, log });
  ctx.run = run;
  return ctx;
}

export async function openRun({ config, runId, log }) {
  const runDir = path.join(config.runsDir, runId);
  const ctx = new RunContext({ runDir, config, log });
  await ctx.loadRun();
  ctx.progress = await readJson(ctx.p('progress.json'), {});
  return ctx;
}

// ---------------------------------------------------------------------------
// Stage 1: discovery
// ---------------------------------------------------------------------------

export async function stageDiscovery(ctx, { force = false, annotations = null } = {}) {
  const manifestPath = ctx.p('manifest.json');
  if (!force && (await exists(manifestPath))) {
    ctx.manifest = await readJson(manifestPath);
    ctx.log(`discovery: reusing manifest (${ctx.manifest.counts.papers} papers)`);
    return ctx.manifest;
  }
  await ctx.setStage('discovery', 'running');
  try {
    const source = await ctx.getSource();
    const manifest = await discoverCorpus(source, { annotations, expectedCount: ctx.config.expectedPaperCount, log: ctx.log });
    await writeJson(manifestPath, manifest);
    ctx.manifest = manifest;
    ctx.run.source = manifest.source;
    await ctx.setStage('discovery', 'done', { papers: manifest.counts.papers, flags: manifest.counts.flags_by_code });
    await ctx.updateProgress({ discovery: { papers: manifest.counts.papers, targets: manifest.counts.targets, flagged: manifest.counts.papers_flagged } });
    return manifest;
  } catch (err) {
    await ctx.setStage('discovery', 'failed', { error: err.message });
    throw err;
  }
}

RunContext.prototype.getSource = async function getSource() {
  if (this.source) return this.source;
  const req = this.run.source_request;
  // A token is never persisted in run.json; it comes from the CLI flag or GITHUB_TOKEN each time.
  this.source = await openSource({ url: req.url, path: req.path, ref: req.ref, subdir: req.subdir ?? null, token: this.sourceToken || null, limits: this.config.download });
  const desc = this.source.descriptor();
  if (this.run.source && this.run.source.commit && this.run.source.commit !== desc.commit) {
    throw new Error(`Source commit changed since the run was created (${this.run.source.commit} -> ${desc.commit}); start a new run.`);
  }
  this.run.source = desc;
  await this.saveRun();
  return this.source;
};

// ---------------------------------------------------------------------------
// Stage 2: preparation (PDF text, contexts, prelude, reference audit)
// ---------------------------------------------------------------------------

export async function initLean(ctx) {
  if (ctx.toolchain) return;
  ctx.toolchain = await detectToolchain(ctx.config.leanDir, { log: ctx.log });
  ctx.run.toolchain = {
    available: ctx.toolchain.available,
    reason: ctx.toolchain.reason,
    lean_project: ctx.toolchain.lean_dir,
    lean_options: ctx.toolchain.lean_options || [],
    toolchain: ctx.toolchain.toolchain,
    lean_version: ctx.toolchain.lean_version,
    mathlib: ctx.toolchain.mathlib,
    mathlib_built: ctx.toolchain.mathlib_built,
    audit_built: ctx.toolchain.audit_built,
  };
  await ctx.saveRun();
  const runner = new LeanRunner(ctx.toolchain, { ...ctx.config.lean, log: ctx.log });
  const limit = pLimit(ctx.config.lean.concurrency || 1);
  const raw = runner.runLean.bind(runner);
  runner.runLean = (opts) => limit(() => raw(opts));
  ctx.runner = runner;
}

function selectPapers(manifest, selection) {
  let papers = manifest.papers;
  if (selection?.papers?.length) papers = papers.filter((p) => selection.papers.includes(p.paper_id));
  if (selection?.limit) papers = papers.slice(0, selection.limit);
  return papers;
}

async function readReview(ctx) {
  const dir = ctx.p('review');
  const decisions = await readJson(path.join(dir, 'decisions.json'), {});
  const defects = await readJson(path.join(dir, 'reference-defects.json'), { reference_defects: [], reviewed_references: [] });
  return { decisions, ...defects, dir };
}

export async function stagePreparation(ctx, { selection = null, force = false } = {}) {
  if ((ctx.run.task || ctx.config.task) === 'prove') return stagePreparationProve(ctx, { selection, force });
  await initLean(ctx);
  const manifest = ctx.manifest || (await stageDiscovery(ctx));
  const source = await ctx.getSource();
  const papers = selectPapers(manifest, selection);
  await ctx.setStage('preparation', 'running', { papers: papers.length });
  const review = await readReview(ctx);
  ctx.review = review;
  ctx.prepared = ctx.prepared || {};
  let done = 0;
  const errors = [];
  const preludeText = await fs.readFile(path.join(ctx.config.leanDir, 'QEDRank', 'Prelude.lean'), 'utf8').catch(() => '-- QEDRank.Prelude unavailable');
  for (const paper of papers) {
    const pdir = ctx.p('prepared', slug(paper.paper_id));
    const doneFile = path.join(pdir, 'done.json');
    if (!force && (await exists(doneFile))) {
      ctx.prepared[paper.paper_id] = await readJson(doneFile);
      done += 1;
      continue;
    }
    const t0 = nowMono();
    const prep = { paper_id: paper.paper_id, prepared_at: isoNow(), pdf: null, title: paper.title, title_source: paper.title_source, contexts: {}, prelude: null, references: {}, flags: [], timing: {} };
    try {
      await ensureDir(pdir);
      // --- PDF ---
      let pages = [];
      if (paper.pdf) {
        try {
          const buf = await source.readFile(paper.pdf.path);
          prep.pdf = { path: paper.pdf.path, bytes: buf.length, sha256: sha256(buf) };
          await fs.writeFile(path.join(pdir, 'paper.pdf'), buf);
          const tx = await extractPdfText(buf);
          pages = tx.pages;
          prep.pdf.pages = tx.numPages;
          prep.pdf.truncated = tx.truncated;
          prep.timing.pdf_extract_ms = tx.extractMs;
          prep.pdf.figure_mentions = figureMentions(pages);
          await writeJson(path.join(pdir, 'pages.json'), { pages });
          if (!prep.title) { const g = guessTitle(pages, tx.metaTitle); prep.title = g.title; prep.title_source = g.source; }
        } catch (err) {
          prep.flags.push(`pdf_error:${err.message}`);
        }
      } else prep.flags.push('missing_pdf');
      // --- Lean files of the paper ---
      const leanPaths = new Set();
      for (const k of TARGET_KINDS) { const t = paper.targets[k]; if (t?.lean_path) leanPaths.add(t.lean_path); for (const c of t?.candidates || []) leanPaths.add(c); }
      for (const f of paper.shared_definition_files || []) leanPaths.add(f.path);
      for (const f of paper.unclassified_lean_files || []) leanPaths.add(f.path);
      // Also any .lean under the paper dir (imports may reference them).
      for (const f of (await source.listTree()).files) if (paper.dir && f.path.startsWith(`${paper.dir}/`) && f.path.endsWith('.lean')) leanPaths.add(f.path);
      const paperFiles = [];
      for (const p of leanPaths) {
        try { const buf = await source.readFile(p); paperFiles.push({ path: p, text: buf.toString('utf8'), sha256: sha256(buf) }); await writeText(path.join(pdir, 'corpus', ...p.split('/')), buf.toString('utf8')); }
        catch (err) { prep.flags.push(`lean_read_error:${p}:${err.message}`); }
      }
      // --- prelude ---
      const sharedFiles = (paper.shared_definition_files || []).map((f) => { const pf = paperFiles.find((x) => x.path === f.path); return pf ? { ...pf, module: path.posix.basename(f.path).replace(/\.lean$/, '') } : null; }).filter(Boolean);
      const reviewedPrelude = await fs.readFile(path.join(review.dir, 'prelude', `${paper.paper_id}.lean`), 'utf8').catch(() => null);
      const prelude = await preparePrelude({ runner: ctx.runner, toolchain: ctx.toolchain, paper, sharedFiles, reviewedPreludeSrc: reviewedPrelude, leanDir: ctx.config.leanDir, outDir: pdir, log: ctx.log });
      prep.prelude = { module: prelude.moduleName, source: prelude.source, compile_status: prelude.compile?.status ?? null, flags: prelude.flags, decls: prelude.decls.length };
      prep.prelude_text = prelude.src;
      // --- references and contexts (only the selected target kinds, all by default) ---
      const kindsToPrepare = selection?.targets?.length ? TARGET_KINDS.filter((k) => selection.targets.includes(k)) : TARGET_KINDS;
      for (const kind of kindsToPrepare) {
        const target = paper.targets[kind];
        if (!target) continue;
        const ref = await prepareReference({ runner: ctx.runner, toolchain: ctx.toolchain, paper, target, paperFiles, preludeModule: prelude.moduleName, outDir: pdir, maxHeartbeats: ctx.config.lean.maxHeartbeats, log: ctx.log });
        // Never put the reference text itself into the context; keep a hash for leak checks.
        const refFile = paperFiles.find((f) => f.path === target.lean_path);
        ref.leak_guard = refFile ? findDeclarations(refFile.text).filter((d) => d.body && d.body.length > 60).map((d) => d.body.trim().slice(0, 200)) : [];
        await writeJson(path.join(pdir, `reference__${kind}.json`), ref);
        prep.references[kind] = { lean_path: ref.lean_path, reference_proof_status: ref.reference_proof_status, statement_available: ref.statement_available, flags: ref.flags };
        const reviewedCtx = await fs.readFile(path.join(review.dir, 'context', paper.paper_id, `${kind}.md`), 'utf8').catch(() => null);
        const c = buildContext({ pages, targetKind: kind, reviewedText: reviewedCtx, maxChars: ctx.config.context.maxChars, declName: target.declaration_name });
        await writeText(path.join(pdir, `context__${kind}.txt`), c.text);
        prep.contexts[kind] = { source: c.source, pages_used: c.pages_used, truncated: c.truncated, chars: c.text.length, sha256: sha256(c.text), locator_pages: pages.length ? findPages(pages, kind) : [] };
      }
      prep.timing.total_ms = nowMono() - t0;
      await writeJson(doneFile, prep);
      ctx.prepared[paper.paper_id] = prep;
      done += 1;
      ctx.log(`prepared ${paper.paper_id} (${done}/${papers.length})`);
    } catch (err) {
      errors.push({ paper_id: paper.paper_id, error: err.message });
      ctx.log(`preparation failed for ${paper.paper_id}: ${err.message}`);
    }
    await ctx.updateProgress({ preparation: { done, total: papers.length, errors } });
  }
  await ctx.setStage('preparation', errors.length ? 'failed' : 'done', { done, errors });
  await writeText(ctx.p('prelude-base.lean'), preludeText);
  return { done, errors };
}

// ---------------------------------------------------------------------------
// Stage 3: generation + evaluation
// ---------------------------------------------------------------------------

function leakCheck(prompt, refRecord) {
  for (const frag of refRecord?.leak_guard || []) {
    if (frag.length >= 60 && prompt.includes(frag)) throw new Error(`leak guard: prompt contains reference proof text for ${refRecord.paper_id}/${refRecord.target_kind}`);
  }
}

/** A re-grade changes the evaluation, not the answers: record when, with which code and which Lean project. */
async function recordReevaluation(ctx, { noGenerate }) {
  await initLean(ctx);
  ctx.run.reevaluations = [...(ctx.run.reevaluations || []), {
    at: isoNow(),
    harness: await harnessRevision(),
    lean_project: ctx.toolchain.lean_dir,
    toolchain: ctx.toolchain.toolchain,
    lean_options: ctx.toolchain.lean_options || [],
    model_calls: noGenerate ? 'none' : 'only for items without a stored answer',
  }];
  await ctx.saveRun();
}

/**
 * Optional sampling settings beyond the temperature, as the chat-completions fields they become:
 * generation.topP -> top_p, topK -> top_k, presencePenalty -> presence_penalty. Null when none is set.
 * They are sent only to models whose temperature QEDRank sets (not to reasoning models).
 */
export function samplingExtras(gen = {}) {
  const out = {};
  if (typeof gen.topP === 'number') out.top_p = gen.topP;
  if (typeof gen.topK === 'number') out.top_k = gen.topK;
  if (typeof gen.presencePenalty === 'number') out.presence_penalty = gen.presencePenalty;
  return Object.keys(out).length ? out : null;
}

/** Providers halted during this stage (balance exhausted, persistent rate limit) are recorded on the run. */
function recordHalts(ctx, models, counters) {
  for (const m of models) {
    const h = providerHalt(m);
    if (!h) continue;
    ctx.run.provider_halts = { ...(ctx.run.provider_halts || {}), [m]: { ...h, requests_not_sent: counters.halted } };
    ctx.log(`${m} was halted (${h.kind}): ${counters.halted} request(s) were not sent. Fix the account, then resume with --retry-failed to ask the model for them.`);
  }
}

export async function stageGeneration(ctx, { selection = null, retryFailed = false, reevaluate = false, noGenerate = false, fixtureDir = null } = {}) {
  if (reevaluate) await recordReevaluation(ctx, { noGenerate });
  if ((ctx.run.task || ctx.config.task) === 'prove') return stageGenerationProve(ctx, { selection, retryFailed, reevaluate, noGenerate, fixtureDir });
  await initLean(ctx);
  const manifest = ctx.manifest || (await stageDiscovery(ctx));
  const papers = selectPapers(manifest, selection);
  const models = selection?.models?.length ? selection.models : ctx.run.models;
  const kinds = selection?.targets?.length ? selection.targets : TARGET_KINDS;
  const mode = ctx.run.mode;
  const fixture = mode === 'fixture' ? await loadFixtureProvider(fixtureDir || ctx.run.fixture_dir) : null;
  if (mode === 'fixture') { ctx.run.fixture_dir = fixture.dir; }
  ctx.run.model_ids = Object.fromEntries(listModels(process.env, models).map((m) => [m.id, mode === 'fixture' ? `fixture:${m.id}` : m.model_id]));
  ctx.run.model_hosts = Object.fromEntries(listModels(process.env, models).map((m) => [m.id, mode === 'fixture' ? null : m.host]));
  ctx.run.model_facts = Object.fromEntries(listModels(process.env, models).map((m) => [m.id, modelFacts(m.model_id, ctx.config.modelFacts || {})]));
  // The check is recorded on the run before the gate: a refused run shows why generation never started.
  ctx.run.privacy = checkPrivateCorpus({ config: ctx.config, slots: models, env: process.env, mode });
  if (ctx.run.privacy.refused.length) await ctx.setStage('generation', 'blocked', { reason: `private corpus: refused slot(s) ${ctx.run.privacy.refused.join(', ')}` });
  assertPrivateCorpus({ config: ctx.config, slots: models, env: process.env, mode });
  if (ctx.run.privacy.enforced) ctx.log(`private corpus: every slot resolves to an allowed host (${ctx.run.privacy.slots.map((s) => `${s.slot}@${s.host}`).join(', ')})`);
  const genOpts = { system: SYSTEM_PROMPT, temperature: ctx.config.generation.temperature, effort: ctx.config.generation.effort ?? null, maxTokens: ctx.config.generation.maxTokens, timeoutMs: ctx.config.generation.timeoutMs, retries: ctx.config.generation.retries ?? 4, baseDelayMs: ctx.config.generation.retryBaseDelayMs ?? 2000, maxDelayMs: ctx.config.generation.retryMaxDelayMs ?? 60000, providerConcurrency: ctx.config.generation.providerConcurrency ?? 1, extraSampling: samplingExtras(ctx.config.generation) };
  ctx.run.selection = { papers: papers.map((p) => p.paper_id), models, targets: kinds };
  await ctx.setStage('generation', 'running');
  await ctx.setStage('compilation', 'running');
  await ctx.setStage('audit', 'running');
  await ctx.setStage('comparison', 'running');
  const review = ctx.review || (await readReview(ctx));
  const preludeBase = await fs.readFile(path.join(ctx.config.leanDir, 'QEDRank', 'Prelude.lean'), 'utf8').catch(() => '');
  const k = ctx.config.generation.attempts;
  const repairRounds = ctx.config.generation.repairRounds;
  const limit = pLimit(ctx.config.concurrency.items || 1);
  const counters = { total: 0, done: 0, skipped: 0, halted: 0, generated: 0, gen_failed: 0, compiled: 0, verified: 0, infra: 0, errors: [] };
  const tasks = [];
  const t0 = nowMono();

  for (const paper of papers) {
    const prep = ctx.prepared?.[paper.paper_id] || (await readJson(ctx.p('prepared', slug(paper.paper_id), 'done.json'), null));
    if (!prep) { counters.errors.push({ paper_id: paper.paper_id, error: 'not prepared' }); continue; }
    const pdir = ctx.p('prepared', slug(paper.paper_id));
    for (const kind of kinds) {
      const target = paper.targets[kind];
      if (!target || !target.lean_path) continue;
      const reference = await readJson(path.join(pdir, `reference__${kind}.json`), null);
      if (!reference) continue;
      const context = await fs.readFile(path.join(pdir, `context__${kind}.txt`), 'utf8').catch(() => '(no context)');
      const preludeText = `${preludeBase}\n\n${prep.prelude_text || '-- (no per-paper definitions)'}`;
      const prelude = prep.prelude?.module && prep.prelude.compile_status === 'compiler_success' ? { moduleName: prep.prelude.module } : null;
      const citation = paper.citation || prep.title || paper.paper_id;
      const prompt = renderPrompt({
        paper_id: paper.paper_id,
        target_kind: kind,
        citation: `${prep.title || paper.title || ''}${citation && citation !== prep.title ? ` — ${citation}` : ''}`.trim() || paper.paper_id,
        reviewed_paper_context: context,
        allowed_prelude: preludeText,
        lean_toolchain: ctx.toolchain.toolchain || 'unknown',
        mathlib_version: ctx.toolchain.mathlib?.rev || 'unknown',
        prelude_module: prelude ? `QEDRank.Prelude and ${prelude.moduleName}` : 'QEDRank.Prelude',
      });
      leakCheck(prompt.text, reference);
      for (const provider of models) {
        const key = itemKey(paper.paper_id, kind, provider);
        const itemDir = ctx.p('items', key);
        for (let attempt = 1; attempt <= k; attempt += 1) {
          counters.total += 1;
          tasks.push(limit(async () => {
            try {
              const existing = await readJson(path.join(itemDir, `attempt-a${attempt}r0.json`), null);
              const infraFailed = existing?.outcomes?.infrastructure_failure;
              if (existing?.evaluation_complete && !reevaluate && !(retryFailed && infraFailed)) { counters.skipped += 1; return; }
              await ensureDir(itemDir);
              let gen;
              const genFile = path.join(itemDir, `generation-a${attempt}.json`);
              const prior = await readJson(genFile, null);
              if (noGenerate && (!prior || prior.error)) { counters.skipped += 1; return; }
              if (prior && !prior.error && (reevaluate || (!retryFailed))) gen = prior;
              else {
                await writeText(path.join(itemDir, `prompt-a${attempt}.txt`), prompt.text);
                gen = await generateOnce({ provider, prompt: prompt.text, ...genOpts, mode, fixture, meta: { paper_id: paper.paper_id, target_kind: kind, attempt } });
                // Not sent because the provider was halted: leave no record, so `resume` asks again.
                if (gen.error?.kind === 'halted') { counters.skipped += 1; counters.halted += 1; return; }
                gen.facts = ctx.run.model_facts?.[provider] ?? null;
                gen.prompt_hash = prompt.hash;
                gen.prompt_template_version = prompt.templateVersion;
                // Record what was actually sent: reasoning models accept no temperature (null), only an effort.
                gen.temperature = gen.sampling ? gen.sampling.temperature : ctx.config.generation.temperature;
                gen.effort = gen.sampling?.effort ?? null;
                gen.max_tokens = ctx.config.generation.maxTokens;
                gen.timeout_ms = ctx.config.generation.timeoutMs;
                await writeJson(genFile, gen);
                if (gen.error) counters.gen_failed += 1; else counters.generated += 1;
              }
              const decision = review.decisions?.[key] || null;
              const rec = await evaluateAttempt({ runner: ctx.runner, toolchain: ctx.toolchain, paper, target, reference, prelude, generation: gen, itemDir, config: ctx.config, expertDecision: decision, setting: 'pass@1', attempt, repairRound: 0, log: ctx.log });
              if (rec.compile?.status === 'compiler_success') counters.compiled += 1;
              if (rec.outcomes.verified === 1) counters.verified += 1;
              if (rec.outcomes.infrastructure_failure) counters.infra += 1;
              // Repair setting: same fixed budget for every model; only from attempt 1.
              if (repairRounds > 0 && attempt === 1 && !rec.outcomes.infrastructure_failure && rec.compile?.status !== 'not_attempted') {
                let last = rec;
                let lastGen = gen;
                for (let r = 1; r <= repairRounds; r += 1) {
                  if (last.compile?.status === 'compiler_success' && last.audit?.status === 'clean') break;
                  const diag = (last.compile?.messages || []).filter((m) => m.severity === 'error').slice(0, 20).map((m) => `${m.line}:${m.column}: ${m.text}`).join('\n') || `(status: ${last.compile?.status}; audit: ${last.audit?.status})`;
                  const repairPrompt = `${prompt.text}\n\n=== REPAIR ROUND ${r} of ${repairRounds} ===\nYour previous part B file was:\n\`\`\`lean\n${(await fs.readFile(path.join(itemDir, `proof-a1r${r - 1}.lean`), 'utf8').catch(() => '')).slice(0, 20000)}\n\`\`\`\nThe Lean compiler reported:\n${diag}\nReturn all four parts again with a corrected file. Do not weaken the statement.`;
                  await writeText(path.join(itemDir, `prompt-a1r${r}.txt`), repairPrompt);
                  const rg = await generateOnce({ provider, prompt: repairPrompt, ...genOpts, mode, fixture, meta: { paper_id: paper.paper_id, target_kind: kind, attempt: 1, repair: r } });
                  rg.prompt_hash = sha256(`${SYSTEM_PROMPT}

${repairPrompt}`);
                  rg.prompt_template_version = `${prompt.templateVersion}+repair`;
                  rg.temperature = rg.sampling ? rg.sampling.temperature : ctx.config.generation.temperature; rg.effort = rg.sampling?.effort ?? null; rg.max_tokens = ctx.config.generation.maxTokens; rg.timeout_ms = ctx.config.generation.timeoutMs;
                  await writeJson(path.join(itemDir, `generation-a1r${r}.json`), rg);
                  last = await evaluateAttempt({ runner: ctx.runner, toolchain: ctx.toolchain, paper, target, reference, prelude, generation: rg, itemDir, config: ctx.config, expertDecision: decision, setting: 'repair', attempt: 1, repairRound: r, log: ctx.log });
                  lastGen = rg;
                }
              }
            } catch (err) {
              counters.errors.push({ item: key, attempt, error: err.message });
              ctx.log(`item ${key} attempt ${attempt} failed: ${err.message}`);
            } finally {
              counters.done += 1;
              await ctx.updateProgress({ items: { ...counters, elapsed_ms: nowMono() - t0 } });
            }
          }));
        }
      }
    }
  }
  await Promise.all(tasks);
  recordHalts(ctx, models, counters);
  const status = counters.errors.length ? 'failed' : 'done';
  await ctx.setStage('generation', status, { generated: counters.generated, failed: counters.gen_failed, skipped: counters.skipped, halted: counters.halted });
  await ctx.setStage('compilation', status, { compiled: counters.compiled });
  await ctx.setStage('audit', status);
  await ctx.setStage('comparison', status);
  ctx.run.batch_wall_clock_ms = (ctx.run.batch_wall_clock_ms || 0) + (nowMono() - t0);
  await ctx.saveRun();
  return counters;
}

// ---------------------------------------------------------------------------
// Task "prove": the challenge file is the prompt, the completed file is graded.
// No PDF, no prelude and no reference statement module are needed.
// ---------------------------------------------------------------------------

export async function stagePreparationProve(ctx, { selection = null, force = false } = {}) {
  const manifest = ctx.manifest || (await stageDiscovery(ctx));
  const source = await ctx.getSource();
  const papers = selectPapers(manifest, selection);
  await ctx.setStage('preparation', 'running', { papers: papers.length, task: 'prove' });
  ctx.review = ctx.review || (await readReview(ctx));
  ctx.prepared = ctx.prepared || {};
  let done = 0;
  const errors = [];
  const kinds = selection?.targets?.length ? TARGET_KINDS.filter((k) => selection.targets.includes(k)) : TARGET_KINDS;
  for (const paper of papers) {
    const pdir = ctx.p('prepared', slug(paper.paper_id));
    const doneFile = path.join(pdir, 'done.json');
    if (!force && (await exists(doneFile))) { ctx.prepared[paper.paper_id] = await readJson(doneFile); done += 1; continue; }
    const t0 = nowMono();
    const prep = { paper_id: paper.paper_id, prepared_at: isoNow(), task: 'prove', title: paper.title, challenges: {}, flags: [], timing: {} };
    try {
      await ensureDir(pdir);
      for (const kind of kinds) {
        const target = paper.targets[kind];
        if (!target?.lean_path) continue;
        const buf = await source.readFile(target.lean_path);
        const text = buf.toString('utf8');
        await writeText(path.join(pdir, `challenge__${kind}.lean`), text);
        const sorries = (text.match(/(^|[^A-Za-z0-9_.'])sorry(?![A-Za-z0-9_'])/g) || []).length;
        if (sorries !== 1) prep.flags.push(`challenge_${kind}_has_${sorries}_sorries`);
        prep.challenges[kind] = { lean_path: target.lean_path, sha256: sha256(buf), declaration_name: target.declaration_name, sorries, lines: text.split(/\r?\n/).length };
      }
      prep.timing.total_ms = nowMono() - t0;
      await writeJson(doneFile, prep);
      ctx.prepared[paper.paper_id] = prep;
      done += 1;
      ctx.log(`prepared ${paper.paper_id} (${done}/${papers.length}): ${Object.keys(prep.challenges).join(', ') || 'no challenge file'}`);
    } catch (err) {
      errors.push({ paper_id: paper.paper_id, error: err.message });
      ctx.log(`preparation failed for ${paper.paper_id}: ${err.message}`);
    }
    await ctx.updateProgress({ preparation: { done, total: papers.length, errors } });
  }
  await ctx.setStage('preparation', errors.length ? 'failed' : 'done', { done, errors });
  return { done, errors };
}

/**
 * Before any model call in the prove task: every module the challenge files import must resolve
 * in the grader's Lean project (qedrank/lib/preflight.js). A whole prefix that is absent, e.g.
 * `ProofBench` when the run was left on the audit project lean/, means the wrong project: the run
 * stops here (or warns with --allow-missing-imports). Single missing modules, a project behind the
 * corpus commit, are listed; those items are recorded later as challenge_import_unavailable. The
 * result is stored on the run as `import_check`. Fixture runs and --no-generate skip the check.
 */
export async function stagePreflightProve(ctx, { selection = null, papers = null, kinds = null, mode = null } = {}) {
  if (ctx.config.preflight?.importCheck === false) return null;
  if ((mode || ctx.run.mode) === 'fixture') return null;
  await initLean(ctx);
  if (!ctx.toolchain.available) return null; // detectToolchain has already said why; items will say so too
  const manifest = ctx.manifest || (await stageDiscovery(ctx));
  const list = papers || selectPapers(manifest, selection);
  const ks = kinds || (selection?.targets?.length ? selection.targets : TARGET_KINDS);
  const challenges = [];
  for (const paper of list) {
    for (const kind of ks) {
      const file = ctx.p('prepared', slug(paper.paper_id), `challenge__${kind}.lean`);
      if (await exists(file)) challenges.push({ paper_id: paper.paper_id, kind, src: await fs.readFile(file, 'utf8') });
    }
  }
  const check = await checkChallengeImports({ challenges, toolchain: ctx.toolchain });
  ctx.run.import_check = {
    checked_at: isoNow(), lean_project: ctx.toolchain.lean_dir, challenge_files: challenges.length, challenge_papers: check.challenge_papers,
    modules: check.modules, available: check.available, missing: check.missing.slice(0, 50), missing_total: check.missing.length,
    missing_prefixes: check.missing_prefixes, fatal: check.fatal, enforced: !ctx.config.preflight?.allowMissingImports,
  };
  await ctx.saveRun();
  if (check.fatal) {
    const builtHint = ctx.config.harnesses?.proofbench?.leanProject ? ` This machine's built ProofBench project is ${ctx.config.harnesses.proofbench.leanProject}.` : '';
    const msg = `${check.message}${builtHint} Pass --lean-project <built checkout of the statement library>, or --allow-missing-imports to run the remaining items anyway.`;
    if (ctx.config.preflight?.allowMissingImports) { ctx.log(`WARNING: ${msg}`); return check; }
    await ctx.setStage('generation', 'blocked', { reason: `import check: module prefix ${check.missing_prefixes.map((p) => `'${p.prefix}'`).join(', ')} missing from ${ctx.toolchain.lean_dir}` });
    throw new Error(msg);
  }
  if (check.missing.length) {
    ctx.log(`import check: ${check.missing.length} of ${check.modules} imported modules are missing from ${ctx.toolchain.lean_dir} (${check.missing.slice(0, 5).map((m) => m.module).join(', ')}${check.missing.length > 5 ? ', …' : ''}); their items will be recorded as challenge_import_unavailable. Is the project behind the corpus commit?`);
  } else {
    ctx.log(`import check: all ${check.modules} modules imported by ${challenges.length} challenge files resolve in ${ctx.toolchain.lean_dir}`);
  }
  return check;
}

export async function stageGenerationProve(ctx, { selection = null, retryFailed = false, reevaluate = false, noGenerate = false, fixtureDir = null } = {}) {
  await initLean(ctx);
  const manifest = ctx.manifest || (await stageDiscovery(ctx));
  const papers = selectPapers(manifest, selection);
  const models = selection?.models?.length ? selection.models : ctx.run.models;
  const kinds = selection?.targets?.length ? selection.targets : TARGET_KINDS;
  const mode = ctx.run.mode;
  if (!noGenerate) await stagePreflightProve(ctx, { papers, kinds, mode });
  const fixture = mode === 'fixture' ? await loadFixtureProvider(fixtureDir || ctx.run.fixture_dir) : null;
  if (mode === 'fixture') ctx.run.fixture_dir = fixture.dir;
  const described = listModels(process.env, models);
  ctx.run.model_ids = Object.fromEntries(described.map((m) => [m.id, mode === 'fixture' ? `fixture:${m.id}` : m.model_id]));
  ctx.run.model_hosts = Object.fromEntries(described.map((m) => [m.id, mode === 'fixture' ? null : m.host]));
  ctx.run.model_facts = Object.fromEntries(described.map((m) => [m.id, modelFacts(m.model_id, ctx.config.modelFacts || {})]));
  // The check is recorded on the run before the gate: a refused run shows why generation never started.
  ctx.run.privacy = checkPrivateCorpus({ config: ctx.config, slots: models, env: process.env, mode });
  if (ctx.run.privacy.refused.length) await ctx.setStage('generation', 'blocked', { reason: `private corpus: refused slot(s) ${ctx.run.privacy.refused.join(', ')}` });
  assertPrivateCorpus({ config: ctx.config, slots: models, env: process.env, mode });
  if (ctx.run.privacy.enforced) ctx.log(`private corpus: every slot resolves to an allowed host (${ctx.run.privacy.slots.map((s) => `${s.slot}@${s.host}`).join(', ')})`);
  const genOpts = { system: SYSTEM_PROMPT, temperature: ctx.config.generation.temperature, effort: ctx.config.generation.effort ?? null, maxTokens: ctx.config.generation.maxTokens, timeoutMs: ctx.config.generation.timeoutMs, retries: ctx.config.generation.retries ?? 4, baseDelayMs: ctx.config.generation.retryBaseDelayMs ?? 2000, maxDelayMs: ctx.config.generation.retryMaxDelayMs ?? 60000, providerConcurrency: ctx.config.generation.providerConcurrency ?? 1, extraSampling: samplingExtras(ctx.config.generation) };
  ctx.run.selection = { papers: papers.map((p) => p.paper_id), models, targets: kinds };
  for (const s of ['generation', 'compilation', 'audit', 'comparison']) await ctx.setStage(s, 'running');
  const allowedImports = `Mathlib or the statement library (${(ctx.config.grade?.libraryPrefixes || ['ProofBench.Mathlib_Problems']).join(', ')})`;
  const k = ctx.config.generation.attempts;
  const repairRounds = ctx.config.generation.repairRounds;
  const limit = pLimit(ctx.config.concurrency.items || 1);
  const counters = { total: 0, done: 0, skipped: 0, halted: 0, generated: 0, gen_failed: 0, compiled: 0, verified: 0, infra: 0, errors: [] };
  const tasks = [];
  const t0 = nowMono();
  // A live model call is only worth paying for when the grader can compile the challenge it answers.
  const challengeChecks = new Map();
  const challengeUnusable = (paperId, kind, src) => {
    if (mode !== 'live' || !ctx.toolchain.available) return Promise.resolve(null);
    const id = `${paperId}__${kind}`;
    if (!challengeChecks.has(id)) {
      challengeChecks.set(id, compileChallenge({ runner: ctx.runner, toolchain: ctx.toolchain, challengeSrc: src, cacheDir: path.join(ctx.config.runsDir, '.grade-cache'), leanArgs: ctx.toolchain.lean_options || [] })
        .then((r) => (r.status === 'compiler_success' ? null
          : `${r.missing_module ? 'a module the challenge imports is missing from the grader\'s Lean project' : 'the challenge does not compile in the grader\'s Lean project'} (${ctx.toolchain.lean_dir}): ${r.errors.split('\n')[0] || r.status}`)));
    }
    return challengeChecks.get(id);
  };
  const stamp = (gen, prompt) => {
    gen.facts = ctx.run.model_facts?.[gen.provider] ?? null;
    gen.prompt_hash = prompt.hash;
    gen.prompt_template_version = prompt.templateVersion;
    gen.temperature = gen.sampling ? gen.sampling.temperature : ctx.config.generation.temperature;
    gen.effort = gen.sampling?.effort ?? null;
    gen.max_tokens = ctx.config.generation.maxTokens;
    gen.timeout_ms = ctx.config.generation.timeoutMs;
    return gen;
  };

  const units = [];
  for (const paper of papers) {
    const prep = ctx.prepared?.[paper.paper_id] || (await readJson(ctx.p('prepared', slug(paper.paper_id), 'done.json'), null));
    if (!prep) { counters.errors.push({ paper_id: paper.paper_id, error: 'not prepared' }); continue; }
    for (const kind of kinds) {
      const target = paper.targets[kind];
      if (!target?.lean_path || !prep.challenges?.[kind]) continue;
      const challengeSrc = await fs.readFile(ctx.p('prepared', slug(paper.paper_id), `challenge__${kind}.lean`), 'utf8');
      const prompt = renderProvePrompt({ paper_id: paper.paper_id, target: target.declaration_name || paper.paper_id, challenge: challengeSrc, lean_toolchain: ctx.toolchain.toolchain || 'unknown', mathlib_version: ctx.toolchain.mathlib?.rev || 'unknown', allowed_imports: allowedImports });
      units.push({ paper, kind, target, challengeSrc, prompt });
    }
  }
  // Attempt-major order: every problem gets attempt 1 before any gets attempt 2, so a run that
  // stops early (budget, rate limit) still has complete results for every attempt it reached.
  for (let attempt = 1; attempt <= k; attempt += 1) {
    for (const { paper, kind, target, challengeSrc, prompt } of units) {
      for (const provider of models) {
        const key = itemKey(paper.paper_id, kind, provider);
        const itemDir = ctx.p('items', key);
        {
          counters.total += 1;
          tasks.push(limit(async () => {
            try {
              const existing = await readJson(path.join(itemDir, `attempt-a${attempt}r0.json`), null);
              const infraFailed = existing?.outcomes?.infrastructure_failure;
              if (existing?.evaluation_complete && !reevaluate && !(retryFailed && infraFailed)) { counters.skipped += 1; return; }
              await ensureDir(itemDir);
              const genFile = path.join(itemDir, `generation-a${attempt}.json`);
              const prior = await readJson(genFile, null);
              if (noGenerate && (!prior || prior.error)) { counters.skipped += 1; return; }
              const evalOpts = { runner: ctx.runner, toolchain: ctx.toolchain, paper, target, challengeSrc, itemDir, config: ctx.config, log: ctx.log };
              let gen;
              if (prior && !prior.error && (reevaluate || !retryFailed)) gen = prior;
              else {
                const unusable = await challengeUnusable(paper.paper_id, kind, challengeSrc);
                if (unusable) {
                  // Recorded as an infrastructure failure and not saved as a generation, so a later
                  // run with a working Lean project asks the model.
                  const d = described.find((m) => m.id === provider);
                  const skipped = { provider, display_name: d?.display_name ?? d?.label ?? provider, model_id: ctx.run.model_ids[provider], label: d?.label ?? null, api_host: d?.host ?? null, mode, error: { kind: 'challenge_does_not_compile', message: unusable } };
                  await evaluateProveAttempt({ ...evalOpts, generation: skipped, setting: 'pass@1', attempt, repairRound: 0 });
                  counters.infra += 1;
                  return;
                }
                await writeText(path.join(itemDir, `prompt-a${attempt}.txt`), prompt.text);
                gen = stamp(await generateOnce({ provider, prompt: prompt.text, ...genOpts, mode, fixture, meta: { paper_id: paper.paper_id, target_kind: kind, attempt } }), prompt);
                // Not sent because the provider was halted: leave no record, so `resume` asks again.
                if (gen.error?.kind === 'halted') { counters.skipped += 1; counters.halted += 1; return; }
                await writeJson(genFile, gen);
                if (gen.error) counters.gen_failed += 1; else counters.generated += 1;
              }
              const rec = await evaluateProveAttempt({ ...evalOpts, generation: gen, setting: 'pass@1', attempt, repairRound: 0 });
              if (rec.compile?.status === 'compiler_success') counters.compiled += 1;
              if (rec.outcomes.verified === 1) counters.verified += 1;
              if (rec.outcomes.infrastructure_failure) counters.infra += 1;
              // Repair setting: the compiler output of the independent check goes back to the model.
              if (repairRounds > 0 && attempt === 1 && !rec.outcomes.infrastructure_failure && !rec.abstained) {
                let last = rec;
                for (let r = 1; r <= repairRounds; r += 1) {
                  if (last.grade?.verdict === 'solved') break;
                  const previous = await fs.readFile(path.join(itemDir, `proof-a1r${r - 1}.lean`), 'utf8').catch(() => '');
                  const repairPrompt = `${prompt.text}\n\n=== REPAIR ROUND ${r} of ${repairRounds} ===\nYour previous file was:\n\`\`\`lean\n${previous.slice(0, 20000)}\n\`\`\`\nThe independent check reported: ${(last.grade?.reasons || []).join(', ') || 'not solved'}\n${(last.compiler_output || '').slice(0, 6000)}\nReturn the whole corrected file in one \`\`\`lean block. Do not change the statement or the definitions.`;
                  await writeText(path.join(itemDir, `prompt-a1r${r}.txt`), repairPrompt);
                  const rg = stamp(await generateOnce({ provider, prompt: repairPrompt, ...genOpts, mode, fixture, meta: { paper_id: paper.paper_id, target_kind: kind, attempt: 1, repair: r } }), { hash: sha256(`${SYSTEM_PROMPT}\n\n${repairPrompt}`), templateVersion: `${prompt.templateVersion}+repair` });
                  await writeJson(path.join(itemDir, `generation-a1r${r}.json`), rg);
                  last = await evaluateProveAttempt({ ...evalOpts, generation: rg, setting: 'repair', attempt: 1, repairRound: r });
                }
              }
            } catch (err) {
              counters.errors.push({ item: key, attempt, error: err.message });
              ctx.log(`item ${key} attempt ${attempt} failed: ${err.message}`);
            } finally {
              counters.done += 1;
              await ctx.updateProgress({ items: { ...counters, elapsed_ms: nowMono() - t0 } });
            }
          }));
        }
      }
    }
  }
  await Promise.all(tasks);
  recordHalts(ctx, models, counters);
  const status = counters.errors.length ? 'failed' : 'done';
  await ctx.setStage('generation', status, { generated: counters.generated, failed: counters.gen_failed, skipped: counters.skipped, halted: counters.halted });
  await ctx.setStage('compilation', status, { compiled: counters.compiled });
  await ctx.setStage('audit', status);
  await ctx.setStage('comparison', status);
  ctx.run.batch_wall_clock_ms = (ctx.run.batch_wall_clock_ms || 0) + (nowMono() - t0);
  await ctx.saveRun();
  return counters;
}

// ---------------------------------------------------------------------------
// Stage 4: statistics + exports
// ---------------------------------------------------------------------------

export async function collectItems(ctx) {
  const itemsDir = ctx.p('items');
  const out = [];
  if (!(await exists(itemsDir))) return out;
  for (const key of await fs.readdir(itemsDir)) {
    const dir = path.join(itemsDir, key);
    let files;
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) if (/^attempt-a\d+r\d+\.json$/.test(f)) out.push(await readJson(path.join(dir, f)));
  }
  out.sort((a, b) => a.item_key.localeCompare(b.item_key) || a.attempt - b.attempt || a.repair_round - b.repair_round);
  return out;
}

export async function loadReferences(ctx) {
  const manifest = ctx.manifest || (await readJson(ctx.p('manifest.json')));
  const refs = {};
  for (const paper of manifest.papers) {
    for (const kind of TARGET_KINDS) {
      const r = await readJson(ctx.p('prepared', slug(paper.paper_id), `reference__${kind}.json`), null);
      if (r) refs[`${paper.paper_id}__${kind}`] = r;
    }
  }
  return refs;
}

export async function stageStatistics(ctx) {
  await ctx.setStage('statistics', 'running');
  const manifest = ctx.manifest || (await readJson(ctx.p('manifest.json')));
  ctx.manifest = manifest;
  const items = await collectItems(ctx);
  const references = await loadReferences(ctx);
  const review = ctx.review || (await readReview(ctx));
  // Hand audit of solved agent problems: a rejected solve no longer counts.
  applyManualAudit(items, await readJson(path.join(review.dir, 'audit.json'), {}));
  await writeJson(ctx.p('results.json'), { schema: 'qedrank-results-v1', run_id: ctx.run.run_id, source: ctx.run.source, count: items.length, items });
  const summary = buildSummary({ items, manifest, references, config: ctx.config, models: ctx.run.models, review, run: ctx.run });
  summary.run.batch_wall_clock_ms = ctx.run.batch_wall_clock_ms ?? null;
  summary.run.stages = ctx.run.stages;
  await writeJson(ctx.p('summary.json'), summary);
  const exportsInfo = await writeExports(ctx.runDir, { items, summary, run: ctx.run, config: ctx.config, manifest });
  await ctx.setStage('statistics', 'done', { items: items.length });
  await ctx.updateProgress({ statistics: { items: items.length, done: true } });
  return { summary, items, exports: exportsInfo };
}

/** Full pipeline. */
export async function runAll(ctx, opts = {}) {
  await stageDiscovery(ctx, { force: opts.forceDiscovery, annotations: opts.annotations });
  await stagePreparation(ctx, { selection: opts.selection, force: opts.forcePreparation });
  await stageGeneration(ctx, { selection: opts.selection, retryFailed: opts.retryFailed, reevaluate: opts.reevaluate, fixtureDir: opts.fixtureDir });
  return stageStatistics(ctx);
}
