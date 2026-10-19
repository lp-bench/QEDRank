// Run configuration: defaults, optional qedrank.config.json, CLI overrides.
// Nothing here ever contains a credential; keys stay in the environment.

import path from 'node:path';
import { readJson } from './util.js';
import { PROVIDER_IDS, getRoster } from '../../lib/providers.js';

export const DEFAULT_CONFIG = Object.freeze({
  runsDir: 'runs',
  leanDir: 'lean',
  expectedPaperCount: 108,
  // What the model is asked to do with each challenge:
  //   formalize - write the Lean statement from the paper text and prove it; the statement is
  //               compared with the audited reference (needs the paper PDF)
  //   prove     - receive the challenge file as it is and fill in the one `sorry`; the completed
  //               file is judged by the independent check of grade.js (no PDF needed)
  task: 'formalize',
  // Policy of the independent check used by the prove task (see grade.js DEFAULT_GRADE_POLICY).
  grade: { libraryPrefixes: ['ProofBench.Mathlib_Problems'], allowExtraImports: false, allowUnusedSorry: false, kernelReplay: true },
  models: getRoster(), // the eleven default slots, or QEDRANK_MODELS
  generation: {
    temperature: 0,       // not sent to reasoning models (Claude, GPT-5.x/6); each record stores what was sent
    effort: 'high',       // reasoning effort for reasoning models; QEDRANK_EFFORT_<ID> overrides per slot
    maxTokens: 16384,     // reasoning models spend part of the budget thinking before answering
    timeoutMs: 300000,   // per attempt; reasoning models can think for minutes
    retries: 4,          // on 429 / 5xx / network errors, honouring Retry-After
    retryBaseDelayMs: 2000,
    retryMaxDelayMs: 60000,
    providerConcurrency: 1, // in-flight requests per provider (free tiers are rate-limited)
    attempts: 1,          // k for pass@k; pass@1 is always reported from attempt 1
    repairRounds: 0,      // >0 enables the separately-labelled repair setting with this fixed budget for every model
  },
  lean: {
    timeoutMs: 600000,
    memoryMb: 8192,
    maxHeartbeats: 400000,
    concurrency: 2,
  },
  concurrency: { items: 10 },
  context: { maxChars: 24000 },
  download: {},
  bootstrap: { B: 2000, seed: 20260930 },
  exploratoryThreshold: 10,
  primaryEndpoint: {
    id: 'verified_pass1_main_theorem',
    description: 'Strict verified success at pass@1 on the main_theorem target: original model file compiles under the pinned toolchain, its target declaration depends only on the allowed axioms, its statement is an accepted match to the audited reference, and the paper claim is established.',
  },
  // Per-model pricing in USD per million tokens, e.g. { "gpt-4": { "input": 30, "output": 60 } }.
  // Empty by default: cost is reported as unavailable unless you configure it.
  pricing: {},
  // Release date, training cutoff and parameter count per model id; extends lib/model-facts.js.
  // e.g. { "my-model": { "released": "2026-05-01", "training_cutoff": "2025-12", "parameters_b": 70 } }
  modelFacts: {},
  allowedAxioms: ['propext', 'Classical.choice', 'Quot.sound'],
  // Evaluation harnesses QEDRank can drive or import (docs/agent-evaluation.md). Paths are
  // machine-specific: set them in qedrank.config.json. Only `proofbench` has a driver and an
  // importer; the other entries are listed with their integration state and never block a run.
  harnesses: {
    proofbench: { dir: null, bash: null, python: null, statements: 'proofbench-statements', leanProject: null, image: 'proofbench-sandbox:latest', statementsUrl: 'https://github.com/proof-bench/proofbench-statements' },
    'matharena-arxivlean': { dir: null, datasetMode: 'adapted' },
    'qedrank-harness': { dir: 'harness' },
  },
  // Lean verification backend. 'lean-cli' (one lean process per file) is the only implemented
  // backend; a persistent server (Kimina Lean Server, LeanInteract) is added only after
  // `node qedrank/cli.js lean-bench` shows that compilation is the bottleneck on the target machine.
  verification: { backend: 'lean-cli' },
});

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export async function loadConfig({ configFile = null, cwd = process.cwd(), overrides = {} } = {}) {
  let fileCfg = {};
  const file = configFile || path.join(cwd, 'qedrank.config.json');
  const loaded = await readJson(file, null);
  if (loaded) fileCfg = loaded;
  else if (configFile) throw new Error(`Config file not found: ${configFile}`);
  const cfg = deepMerge(deepMerge(DEFAULT_CONFIG, fileCfg), overrides);
  cfg.runsDir = path.resolve(cwd, cfg.runsDir);
  cfg.leanDir = path.resolve(cwd, cfg.leanDir);
  cfg.configFile = loaded ? file : null;
  for (const m of cfg.models) if (!PROVIDER_IDS.includes(m)) throw new Error(`Unknown model id in config: ${m}`);
  if (!['formalize', 'prove'].includes(cfg.task)) throw new Error(`Unknown task: ${cfg.task} (formalize | prove)`);
  return cfg;
}

/** Snapshot safe to persist in run.json. */
export function sanitizeConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}
