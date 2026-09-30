import { sha256 } from './util.js';

export const PROMPT_TEMPLATE_VERSION = 'qedrank-prompt-v1';

// The model-facing instruction template. The body is fixed by the benchmark
// protocol; only the five {placeholders} vary per item. A short formatting
// appendix asks for the four parts to be delimited so they can be parsed, and
// for the two confidence estimates that the calibration analysis needs.
export const PROMPT_TEMPLATE = `You are formalizing one mathematical research claim in Lean 4 with Mathlib.

Paper ID: {paper_id}
Target: {target_kind}
Title and citation: {citation}
Relevant paper passages, definitions, assumptions, and proof context:
{reviewed_paper_context}
Allowed definitions-only project prelude:
{allowed_prelude}

Translate the requested claim faithfully. Preserve the paper's definitions, quantifiers, hypotheses, constants, and conclusion. Do not strengthen or weaken the statement, add an invented assumption, replace a false claim with a true one, or claim a complete proof when one is unavailable.

Return separately:
A. A Lean theorem statement and any required definitions.
B. A complete Lean 4 source file proving that exact statement, if you can produce one.
C. A short paper-to-Lean mapping and any ambiguity or remaining proof gap.
D. Two confidence estimates, each an integer from 0 to 100: (1) that your part A statement faithfully matches the paper's claim; (2) that your part B file will pass a strict Lean and dependency audit (no sorry, admit, new axioms, unsafe or native_decide bypasses).

The proof file must contain no sorry, admit, new axioms, unsafe proof bypass, or native_decide proof bypass. If you cannot complete the proof, say so and return no purported complete proof file. Do not access or request benchmark ground-truth Lean files.

Formatting: begin each part with a line containing exactly "=== PART A ===", "=== PART B ===", "=== PART C ===" or "=== PART D ===". Put Lean code inside \`\`\`lean fences. In part D write "statement_confidence: <0-100>" and "proof_confidence: <0-100>" on separate lines. The Lean toolchain is {lean_toolchain} with Mathlib {mathlib_version}; the file may import Mathlib and {prelude_module}.`;

export function renderPrompt(vars) {
  const required = ['paper_id', 'target_kind', 'citation', 'reviewed_paper_context', 'allowed_prelude'];
  for (const k of required) if (typeof vars[k] !== 'string') throw new Error(`renderPrompt: missing ${k}`);
  const all = {
    lean_toolchain: 'the pinned toolchain',
    mathlib_version: 'the pinned version',
    prelude_module: 'QEDRank.Prelude',
    ...vars,
  };
  const text = PROMPT_TEMPLATE.replace(/\{([a-z_]+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
  return { text, hash: sha256(text), templateVersion: PROMPT_TEMPLATE_VERSION };
}

const PART_RE = /^\s*(?:=+\s*)?(?:\*\*)?(?:PART|Part|part)?\s*([ABCD])\s*(?:\*\*)?(?:[.):=\-]|\s*=+)\s*.*$/;

function splitParts(text) {
  const lines = text.split(/\r?\n/);
  const parts = { A: [], B: [], C: [], D: [] };
  let current = null;
  let found = 0;
  for (const line of lines) {
    const explicit = /^\s*=+\s*PART\s+([ABCD])\s*=+\s*$/i.exec(line);
    const m = explicit || (/^\s*(?:#+\s*)?(?:\*\*)?(?:Part\s+)?([ABCD])(?:\*\*)?\s*[.):]/.exec(line));
    if (m && (explicit || /^\s*(?:#+\s*)?(?:\*\*)?(?:Part\s+)?[ABCD](?:\*\*)?\s*[.):]/.test(line)) && !line.trim().startsWith('```')) {
      const id = m[1].toUpperCase();
      // Only accept in order-ish to avoid matching "A." in prose: require id not already used.
      if (parts[id].length === 0 && (current === null || id > current)) {
        current = id;
        found += 1;
        continue;
      }
    }
    if (current) parts[current].push(line);
  }
  return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.join('\n')])), found };
}

export function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push({ lang: (m[1] || '').toLowerCase(), code: m[2].replace(/\s+$/, '') });
  return blocks;
}

function looksLikeLean(text) {
  return /^(import|theorem|lemma|def|open|namespace|variable|noncomputable|universe|set_option)\b/m.test(text);
}

function parseConfidence(text, key) {
  const direct = new RegExp(`${key}_confidence\\s*[:=]\\s*(\\d{1,3})`, 'i').exec(text);
  if (direct) return clamp(Number(direct[1]));
  return null;
}

function clamp(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

const ABSTAIN_RE = /(cannot|can't|unable to|could not|no complete proof|not able to|do not have a complete|don't have a complete|not provide(?:d)? a (?:complete )?proof|omit(?:ted)? the proof)/i;

/**
 * Parse a model response into its parts. Never throws; records parse notes so
 * an unparseable response is an explicit outcome instead of a silent failure.
 */
export function parseModelOutput(text) {
  const notes = [];
  const out = {
    statement: null,
    proofFile: null,
    mapping: null,
    statementConfidence: null,
    proofConfidence: null,
    abstained: false,
    parseNotes: notes,
    partsFound: 0,
  };
  if (typeof text !== 'string' || !text.trim()) {
    notes.push('empty_response');
    out.abstained = true;
    return out;
  }
  const { parts, found } = splitParts(text);
  out.partsFound = found;
  const blocksA = extractCodeBlocks(parts.A);
  const blocksB = extractCodeBlocks(parts.B);
  if (found >= 2) {
    if (blocksA.length) out.statement = blocksA.map((b) => b.code).join('\n\n');
    else if (looksLikeLean(parts.A)) { out.statement = parts.A.trim(); notes.push('part_a_unfenced'); }
    if (blocksB.length) {
      // Largest block is the proof file; smaller ones are usually snippets.
      const sorted = [...blocksB].sort((a, b) => b.code.length - a.code.length);
      out.proofFile = sorted[0].code;
      if (blocksB.length > 1) notes.push('part_b_multiple_blocks_largest_used');
    } else if (looksLikeLean(parts.B)) { out.proofFile = parts.B.trim(); notes.push('part_b_unfenced'); }
    out.mapping = parts.C.trim() || null;
    out.statementConfidence = parseConfidence(parts.D || text, 'statement');
    out.proofConfidence = parseConfidence(parts.D || text, 'proof');
    if (!out.proofFile && ABSTAIN_RE.test(parts.B + '\n' + parts.C)) out.abstained = true;
    if (!out.proofFile && !out.abstained) { out.abstained = true; notes.push('no_proof_file_returned'); }
  } else {
    notes.push('part_markers_missing');
    const blocks = extractCodeBlocks(text);
    if (blocks.length >= 2) {
      out.statement = blocks[0].code;
      out.proofFile = [...blocks.slice(1)].sort((a, b) => b.code.length - a.code.length)[0].code;
      notes.push('fallback_first_block_statement_largest_rest_proof');
    } else if (blocks.length === 1) {
      out.proofFile = blocks[0].code;
      notes.push('fallback_single_block_as_proof_file_statement_derived');
    } else if (looksLikeLean(text)) {
      out.proofFile = text.trim();
      notes.push('fallback_raw_text_as_proof_file');
    } else {
      out.abstained = true;
      notes.push('no_lean_code_found');
    }
    out.statementConfidence = parseConfidence(text, 'statement');
    out.proofConfidence = parseConfidence(text, 'proof');
    if (ABSTAIN_RE.test(text) && !out.proofFile) out.abstained = true;
  }
  if (out.statementConfidence === null) notes.push('statement_confidence_missing');
  if (out.proofConfidence === null) notes.push('proof_confidence_missing');
  return out;
}
