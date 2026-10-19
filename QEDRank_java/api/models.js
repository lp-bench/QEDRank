// Vercel Serverless Function - the model roster.
//
// GET -> { roster: [...], optional: [...] } describing each provider: label, model id, API host,
// whether its key is configured, free-tier note and key portal. Never returns a key.

import { getRoster, describeProvider, PROVIDERS, SYSTEM_PROMPT } from '../lib/providers.js';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const roster = getRoster();
    res.status(200).json({
      roster: roster.map((id) => describeProvider(id)),
      optional: PROVIDERS.filter((p) => !roster.includes(p.id)).map((p) => describeProvider(p.id)),
      system_prompt: SYSTEM_PROMPT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
