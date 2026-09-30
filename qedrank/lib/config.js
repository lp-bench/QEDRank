// Run configuration: defaults, optional qedrank.config.json, CLI overrides.
// Nothing here ever contains a credential; keys stay in the environment.

import path from 'node:path';
import { readJson } from './util.js';
import { PROVIDER_IDS } from '../../lib/providers.js';

export const DEFAULT_CONFIG = Object.freeze({
  runsDir: 'runs',
  leanDir: 'lean',
  expectedPaperCount: 108,
  models: PROVIDER_IDS,
  generation: {
    temperature: 0,
    maxTokens: 4096,
    timeoutMs: 180000,
    attempts: 1,          // k for pass@k; pass@1 is always reported from attempt 1
    repairRounds: 0,      // >0 enables the separately-labelled repair setting with this fixed budget for every model
  },
  lean: {
    timeoutMs: 600000,
    memoryMb: 8192,
    maxHeartbeats: 400000,
    concurrency: 2,
  },
  concurrency: { items: 2, generation: 5 },
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
  allowedAxioms: ['propext', 'Classical.choice', 'Quot.sound'],
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
  return cfg;
}

/** Snapshot safe to persist in run.json. */
export function sanitizeConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}
