// Vercel Serverless Function - Backend Bridge for LLMs
// This runs on the server, keeping your API keys hidden from the user.
//
// POST { mathProblem, provider? }
//   provider given  -> one model (the page sends one request per selected model, so each model
//                      gets its own function invocation and time budget)
//   provider absent -> every configured model in the roster, in parallel (original behaviour)
//
// Provider integrations live in ../lib/providers.js and are shared with the QEDRank benchmark.

import { callProvider, getRoster, getProvider, describeProvider, singleProblemPrompt, SYSTEM_PROMPT, PROVIDER_IDS } from '../lib/providers.js';

const PER_MODEL_TIMEOUT_MS = 55000; // stays inside the 60 s function limit set in vercel.json
const MAX_TOKENS = 4096;            // reasoning models spend part of the budget thinking
const EFFORT = 'medium';            // reasoning effort for the interactive page (the benchmark uses its own config)

function errorResult(id, err) {
  const p = getProvider(id);
  const d = describeProvider(id);
  return {
    provider: id,
    model: d.display_name,
    label: p.label,
    vendor: d.vendor,
    modelId: d.model_id,
    leanCode: `Error: ${err.message || 'Failed to generate code'}`,
    success: false,
    errorKind: err.kind || 'error',
    attempts: err.attempts ?? null,
  };
}

async function runOne(id, prompt) {
  try {
    const r = await callProvider(id, { prompt, system: SYSTEM_PROMPT, temperature: 0.3, maxTokens: MAX_TOKENS, effort: EFFORT, timeoutMs: PER_MODEL_TIMEOUT_MS, retries: 0 });
    return {
      provider: id,
      model: r.displayName,
      label: r.label,
      vendor: r.vendor,
      modelId: r.modelId,
      responseModel: r.responseModel,
      leanCode: r.text || 'Error generating code',
      success: Boolean(r.text),
      latencyMs: r.latencyMs,
      usage: r.usage,
      reasoningChars: r.reasoningChars,
      finishReason: r.finishReason,
      sampling: r.sampling,
      attempts: r.attempts,
    };
  } catch (err) {
    return errorResult(id, err);
  }
}

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { mathProblem, provider } = req.body || {};

    if (!mathProblem || typeof mathProblem !== 'string') {
      res.status(400).json({ error: 'Invalid input: mathProblem is required' });
      return;
    }
    if (mathProblem.length > 20000) {
      res.status(400).json({ error: 'Invalid input: mathProblem is too long (max 20000 characters)' });
      return;
    }

    const prompt = singleProblemPrompt(mathProblem);

    if (provider !== undefined) {
      if (typeof provider !== 'string' || !PROVIDER_IDS.includes(provider)) {
        res.status(400).json({ error: `Unknown provider: ${String(provider).slice(0, 40)}` });
        return;
      }
      const result = await runOne(provider, prompt);
      res.status(200).json({ results: [result], timestamp: new Date().toISOString() });
      return;
    }

    const roster = getRoster();
    const results = await Promise.all(roster.map((id) => runOne(id, prompt)));
    res.status(200).json({ results, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
