// Accent colour per model slot, used as UI chrome on cards and chips (never as a data
// encoding in charts). Fixed per entity so a model keeps its colour whatever is selected.
const SLOT_COLOR = {
  fable: 'var(--s2)', opus: 'var(--s2)', anthropic: 'var(--s2)',
  gpt6_astra: 'var(--s1)', gpt6_sol: 'var(--s1)', gpt56_terra: 'var(--s1)', gpt54: 'var(--s1)', openai: 'var(--s1)',
  qwen: 'var(--s3)', mistral: 'var(--s4)', kimi: 'var(--s5)', llama: 'var(--s7)', deepseek: 'var(--s6)',
}

export function slotColor(id) {
  return SLOT_COLOR[id] || 'var(--muted)'
}

export function shortLabel(m) {
  return m.label || (m.display_name || m.id).split(' · ')[0]
}
