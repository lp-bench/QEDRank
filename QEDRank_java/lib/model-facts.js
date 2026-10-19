// Facts about a model that the analyses across model generations need: when it was
// released, where its training data ends, and how large it is.
//
// Keyed by API model id, not by roster slot: a slot whose model is overridden with
// QEDRANK_MODEL_<ID> must not inherit another model's dates. Every value was read from the
// page listed under `sources` on 2026-10-06; a value that no vendor page or model card
// states is null. Closed models do not publish parameter counts.
//
// Override or extend without code changes: "modelFacts" in qedrank.config.json, same shape.

export const MODEL_FACTS = Object.freeze({
  'claude-fable-5-1': {
    released: '2026-09-01', training_cutoff: '2026-06', parameters_b: null, active_parameters_b: null,
    sources: { released: 'https://platform.claude.com/docs/en/models/fable-5-1/overview', training_cutoff: 'https://platform.claude.com/docs/en/models/fable-5-1/overview' },
    note: 'Cutoff is given to the month. Parameter count not disclosed.',
  },
  'claude-opus-5-5': {
    released: '2026-09-22', training_cutoff: '2026-06', parameters_b: null, active_parameters_b: null,
    sources: { released: 'https://platform.claude.com/docs/en/models/opus-5-5/overview', training_cutoff: 'https://platform.claude.com/docs/en/models/opus-5-5/overview' },
    note: 'Cutoff is given to the month. Parameter count not disclosed.',
  },
  'qwen3-30b-a3b-instruct-2507': {
    released: '2025-07-30', training_cutoff: null, parameters_b: 30.5, active_parameters_b: 3.3,
    sources: { released: 'https://github.com/QwenLM/Qwen3', parameters_b: 'https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507' },
    note: 'Mixture of experts. No vendor-stated training cutoff.',
  },
  'labs-leanstral-2603': {
    released: '2026-03-16', training_cutoff: null, parameters_b: 119, active_parameters_b: 6.5,
    sources: { released: 'https://docs.mistral.ai/models/model-cards/leanstral-26-03', parameters_b: 'https://huggingface.co/mistralai/Leanstral-2603' },
    note: 'Mixture of experts. No vendor-stated training cutoff. Mistral\'s model card lists this endpoint as retired on 2026-06-30; check with `node qedrank/cli.js ping` before a run.',
  },
  'gpt-6-astra': {
    released: '2026-09-03', training_cutoff: '2026-04-30', parameters_b: null, active_parameters_b: null,
    sources: { released: 'https://developers.openai.com/api/docs/changelog', training_cutoff: 'https://developers.openai.com/api/docs/models/gpt-6-astra' },
    note: 'Parameter count not disclosed.',
  },
  'gpt-6-sol': {
    released: '2026-09-22', training_cutoff: '2026-04-20', parameters_b: null, active_parameters_b: null,
    sources: { released: 'https://developers.openai.com/api/docs/changelog', training_cutoff: 'https://developers.openai.com/api/docs/models/gpt-6-sol' },
    note: 'Parameter count not disclosed.',
  },
  'gpt-5.6-terra': {
    released: '2026-07-09', training_cutoff: '2026-02-16', parameters_b: null, active_parameters_b: null,
    sources: { released: 'https://developers.openai.com/api/docs/changelog', training_cutoff: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra' },
    note: 'General-availability date; press reports a restricted preview from 2026-06-26. Parameter count not disclosed.',
  },
  'gpt-5.4': {
    released: '2026-03-05', training_cutoff: '2025-08-31', parameters_b: null, active_parameters_b: null,
    sources: { released: 'https://developers.openai.com/api/docs/changelog', training_cutoff: 'https://developers.openai.com/api/docs/models/gpt-5.4' },
    note: 'Parameter count not disclosed.',
  },
  'kimi-k3': {
    released: '2026-07-16', training_cutoff: null, parameters_b: 2800, active_parameters_b: 104,
    sources: { released: 'https://thenextweb.com/news/moonshot-kimi-k3-largest-open-model', parameters_b: 'https://huggingface.co/moonshotai/Kimi-K3' },
    note: 'Mixture of experts. Release date is from press coverage of the API launch; no Moonshot page prints it. No vendor-stated training cutoff.',
  },
  'meta-llama-3.1-8b-instruct': {
    released: '2024-07-23', training_cutoff: '2023-12', parameters_b: 8, active_parameters_b: null,
    sources: { released: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct', training_cutoff: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct', parameters_b: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct' },
    note: 'Cutoff is given to the month.',
  },
  'deepseek-v4-pro': {
    released: '2026-08-13', training_cutoff: null, parameters_b: 1600, active_parameters_b: 49,
    sources: { released: 'https://api-docs.deepseek.com/updates', parameters_b: 'https://api-docs.deepseek.com/news/news260424' },
    note: 'Mixture of experts. The API id served a preview from 2026-04-24 and the general-availability weights (0813) from 2026-08-13; the date here is the weights served now. The parameter count is the vendor\'s figure for the preview. No vendor-stated training cutoff.',
  },
});

const EMPTY = Object.freeze({ released: null, training_cutoff: null, parameters_b: null, active_parameters_b: null, sources: {}, note: null });

/** Facts for one model id, or all-null when the model is not in the table. */
export function modelFacts(modelId, extra = {}) {
  const f = (modelId && (extra[modelId] || MODEL_FACTS[modelId])) || null;
  return f ? { ...EMPTY, ...f } : { ...EMPTY, note: 'not in lib/model-facts.js; add it under "modelFacts" in qedrank.config.json' };
}
