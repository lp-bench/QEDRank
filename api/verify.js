// Vercel Serverless Function - Backend Bridge for LLMs
// This runs on the server, keeping your API keys hidden from the user.
//
// The five provider integrations live in ../lib/providers.js so that the
// QEDRank batch benchmark reuses exactly the same endpoints and model ids.

import { PROVIDERS, callProvider, singleProblemPrompt } from '../lib/providers.js';

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
    const { mathProblem } = req.body;

    if (!mathProblem || typeof mathProblem !== 'string') {
      res.status(400).json({ error: 'Invalid input: mathProblem is required' });
      return;
    }

    const prompt = singleProblemPrompt(mathProblem);

    // Call multiple LLMs in parallel (same order, temperature and token limit as before)
    const results = await Promise.allSettled(
      PROVIDERS.map((p) => callProvider(p.id, { prompt, temperature: 0.3, maxTokens: 2048 }))
    );

    // Process results
    const processedResults = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return {
          leanCode: result.value.text || 'Error generating code',
          model: result.value.displayName,
          success: true
        };
      } else {
        return {
          leanCode: `Error: ${result.reason.message || 'Failed to generate code'}`,
          model: ['Gemini', 'OpenAI', 'Anthropic', 'Cohere', 'Mistral'][index],
          success: false
        };
      }
    });

    res.status(200).json({
      results: processedResults,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
