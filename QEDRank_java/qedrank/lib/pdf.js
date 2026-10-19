// PDF text extraction (per page) and paper-context assembly.
// pdfjs-dist is loaded lazily; scripts embedded in PDFs are never executed
// (isEvalSupported=false, no rendering, text content only).

import { nowMono } from './util.js';

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** @returns {Promise<{numPages:number, pages:{page:number,text:string}[], text:string, metaTitle:string|null, extractMs:number}>} */
export async function extractPdfText(buffer, { maxPages = 400 } = {}) {
  const t0 = nowMono();
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const numPages = Math.min(doc.numPages, maxPages);
  const pages = [];
  for (let i = 1; i <= numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    pages.push({ page: i, text: text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim() });
    page.cleanup();
  }
  let metaTitle = null;
  try {
    const meta = await doc.getMetadata();
    const t = meta?.info?.Title;
    if (typeof t === 'string' && t.trim().length > 3) metaTitle = t.trim();
  } catch { /* ignore */ }
  await doc.destroy();
  return { numPages: doc.numPages, pages, text: pages.map((p) => p.text).join('\n\n'), metaTitle, extractMs: nowMono() - t0, truncated: doc.numPages > maxPages };
}

/** Heuristic title: PDF metadata title, else first plausible line of page 1. */
export function guessTitle(pages, metaTitle = null) {
  if (metaTitle && !/^(untitled|microsoft word|arxiv|\d+\.\d+)/i.test(metaTitle)) return { title: metaTitle, source: 'pdf_metadata' };
  const first = pages[0]?.text || '';
  for (const raw of first.split('\n')) {
    const line = raw.trim();
    if (line.length >= 12 && line.length <= 220 && !/^(arxiv|abstract|\d|©|preprint|submitted)/i.test(line) && /[A-Za-z]{3}/.test(line)) {
      return { title: line, source: 'pdf_first_line_heuristic' };
    }
  }
  return { title: null, source: 'none' };
}

const KIND_QUERIES = {
  main_theorem: [/\bmain (theorem|result)\b/i, /\btheorem\s+1(\.\d+)?\b/i, /\bour main\b/i],
  upper_bound: [/\bupper bound/i, /\bat most\b/i, /\bO\(/],
  lower_bound: [/\blower bound/i, /\bat least\b/i, /\bΩ\(/, /\bomega\(/i],
  disproof: [/\bcounter-?example/i, /\bdisprov/i, /\brefut/i, /\bconjecture\b/i, /\bfalse\b/i],
};

/** Pages whose text matches any of the given regexes (or the kind's default queries). */
export function findPages(pages, kindOrRegexes) {
  const res = Array.isArray(kindOrRegexes) ? kindOrRegexes : KIND_QUERIES[kindOrRegexes] || [];
  return pages.filter((p) => res.some((re) => re.test(p.text))).map((p) => p.page);
}

/** Pages mentioning figures/tables, for the "requires figure information" record. */
export function figureMentions(pages) {
  let figures = 0;
  let tables = 0;
  for (const p of pages) {
    figures += (p.text.match(/\bFig(ure|\.)\s*\d+/gi) || []).length;
    tables += (p.text.match(/\bTable\s+\d+/gi) || []).length;
  }
  return { figures, tables };
}

/**
 * Build the paper context given to every model for one target.
 * Reviewed context (a file supplied by a human reviewer) is used verbatim when
 * present; otherwise an automatic, unreviewed excerpt is assembled deterministically:
 * page 1 (title/abstract) plus the pages that match the target-kind queries, in
 * page order, until maxChars is reached.
 */
export function buildContext({ pages, targetKind, reviewedText = null, maxChars = 24000, declName = null }) {
  if (reviewedText && reviewedText.trim()) {
    return { text: reviewedText.trim().slice(0, maxChars), source: 'reviewed', pages_used: null, truncated: reviewedText.length > maxChars };
  }
  if (!pages || pages.length === 0) {
    return { text: '(no paper text available)', source: 'none', pages_used: [], truncated: false };
  }
  const hits = new Set(findPages(pages, targetKind));
  if (declName) {
    const words = declName.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 3);
    for (const w of words) findPages(pages, [new RegExp(`\\b${w}\\b`, 'i')]).forEach((p) => hits.add(p));
  }
  const order = [1, ...[...hits].filter((p) => p !== 1).sort((a, b) => a - b)];
  // If nothing matched, take the leading pages.
  const chosen = order.length > 1 ? order : pages.map((p) => p.page);
  let text = '';
  const used = [];
  let truncated = false;
  for (const pn of chosen) {
    const p = pages[pn - 1];
    if (!p) continue;
    const chunk = `[page ${pn}]\n${p.text}\n\n`;
    if (text.length + chunk.length > maxChars) {
      const room = maxChars - text.length;
      if (room > 200) { text += chunk.slice(0, room); used.push(pn); }
      truncated = true;
      break;
    }
    text += chunk;
    used.push(pn);
  }
  return { text: text.trim(), source: 'auto_unreviewed', pages_used: used, truncated };
}
