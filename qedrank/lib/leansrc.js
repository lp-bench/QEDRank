// Lean 4 source helpers: import parsing, declaration discovery, proof stripping,
// line counting and the static safety screen. These operate on text only and
// are deliberately conservative: anything they cannot classify is reported as
// ambiguous rather than guessed.

const DECL_KEYWORDS = [
  'theorem', 'lemma', 'def', 'abbrev', 'instance', 'structure', 'inductive', 'class',
  'axiom', 'opaque', 'example', 'macro', 'macro_rules', 'elab', 'elab_rules', 'syntax',
  'notation', 'infix', 'infixl', 'infixr', 'prefix', 'postfix', 'namespace', 'section',
  'end', 'open', 'variable', 'universe', 'set_option', 'noncomputable', 'private',
  'protected', 'partial', 'unsafe', 'nonrec', 'attribute', 'deriving', 'mutual',
  'initialize', 'builtin_initialize', 'run_cmd', 'run_elab', 'declare_syntax_cat', 'export',
  'scoped', 'local', 'alias', 'irreducible_def',
];
const MODIFIERS = new Set(['noncomputable', 'private', 'protected', 'partial', 'unsafe', 'nonrec', 'scoped', 'local']);
const NAMED_KINDS = new Set(['theorem', 'lemma', 'def', 'abbrev', 'instance', 'structure', 'inductive', 'class', 'axiom', 'opaque', 'irreducible_def']);

const COMMAND_START = new RegExp(`^(?:@\\[|#|/-|--|(?:${DECL_KEYWORDS.join('|')})(?![A-Za-z0-9_.'!?]))`);

/**
 * Remove `--` line comments and (nested) `/- ... -/` block comments, keeping newlines.
 * With `blank: true` every removed character becomes a space so that string
 * positions in the result line up exactly with the original source.
 */
export function stripComments(src, { blank = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  let depth = 0;
  const drop = (k) => { if (blank) for (let t = 0; t < k; t += 1) out += src[i + t] === '\n' ? '\n' : ' '; };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (depth > 0) {
      if (c === '/' && c2 === '-') { depth += 1; drop(2); i += 2; continue; }
      if (c === '-' && c2 === '/') { depth -= 1; drop(2); i += 2; continue; }
      if (c === '\n') out += '\n';
      else if (blank) out += ' ';
      i += 1;
      continue;
    }
    if (c === '"') {
      // string literal: copy verbatim
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === '\\') j += 1; j += 1; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && c2 === '-') { depth = 1; drop(2); i += 2; continue; }
    if (c === '-' && c2 === '-') {
      while (i < n && src[i] !== '\n') { if (blank) out += ' '; i += 1; }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Module names imported by the file (only `import` lines at the top). */
export function parseImports(src) {
  const mods = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    if (line.startsWith('/-')) continue; // doc comment before imports is invalid Lean anyway
    if (line === 'prelude') continue;
    const m = /^import\s+(.+)$/.exec(line);
    if (!m) break; // imports must be a prefix of the file
    for (const tok of m[1].split(/\s+/)) if (tok) mods.push(tok.replace(/--.*$/, ''));
  }
  return mods;
}

/** Replace the import block according to `mapFn(module) -> module | null` (null drops the import). */
export function rewriteImports(src, mapFn) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let inHeader = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (inHeader && /^import\s+/.test(line)) {
      const mods = line.replace(/^import\s+/, '').split(/\s+/);
      const mapped = mods.map(mapFn).filter(Boolean);
      if (mapped.length) out.push(`import ${mapped.join(' ')}`);
      continue;
    }
    if (inHeader && line && !line.startsWith('--') && line !== 'prelude') inHeader = false;
    out.push(raw);
  }
  return out.join('\n');
}

function isCommandStart(line) {
  return COMMAND_START.test(line);
}

/**
 * Find top-level declarations. Returns [{kind, name, line, start, end, assignIndex, header, body}].
 * `assignIndex` is the index (in `src`) of the top-level `:=` or null. Text positions refer to the
 * ORIGINAL source; scanning uses a comment-stripped copy of the same length per line.
 */
export function findDeclarations(src) {
  const stripped = stripComments(src, { blank: true });
  const lines = src.split('\n');
  const sLines = stripped.split('\n');
  // Byte offsets of each line start in `src`.
  const offsets = [];
  let acc = 0;
  for (const l of lines) { offsets.push(acc); acc += l.length + 1; }

  // Command boundaries: line indices where a command starts (column 0).
  const starts = [];
  for (let i = 0; i < sLines.length; i += 1) {
    const l = sLines[i];
    if (!l || /^\s/.test(l)) continue;
    if (isCommandStart(l) || /^[A-Za-z_]/.test(l)) starts.push(i);
  }
  const decls = [];
  let pendingAttrStart = null; // a chunk made only of `@[...]` lines belongs to the next declaration
  for (let s = 0; s < starts.length; s += 1) {
    const chunkFrom = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const attrOnly = sLines.slice(chunkFrom, to).every((l) => l.trim() === '' || /^@\[/.test(l.trim()));
    if (attrOnly) { if (pendingAttrStart === null) pendingAttrStart = chunkFrom; continue; }
    const from = pendingAttrStart === null ? chunkFrom : pendingAttrStart;
    pendingAttrStart = null;
    const headText = sLines[chunkFrom];
    // Skip attributes on their own line: `@[simp]` followed by decl on next line.
    let kwLine = from;
    let kw = null;
    let name = null;
    for (let li = from; li < to; li += 1) {
      const t = sLines[li].replace(/^@\[[^\]]*\]\s*/, '');
      const toks = t.trim().split(/\s+/);
      let idx = 0;
      while (idx < toks.length && MODIFIERS.has(toks[idx])) idx += 1;
      if (idx < toks.length && NAMED_KINDS.has(toks[idx])) {
        kw = toks[idx];
        name = toks[idx + 1] ? toks[idx + 1].replace(/[:({[⟨].*$/, '') : null;
        if (kw === 'instance' && (!name || name.startsWith(':'))) name = null;
        kwLine = li;
        break;
      }
      if (idx < toks.length && toks[idx] === 'example') { kw = 'example'; kwLine = li; break; }
      if (!/^@\[/.test(sLines[li].trim())) break; // not an attribute line -> not a named decl
    }
    if (!kw) continue;
    const start = offsets[from];
    const end = to < lines.length ? offsets[to] : src.length;
    const chunk = stripped.slice(start, end);
    const assignRel = topLevelAssign(chunk, kwLine === from ? 0 : offsets[kwLine] - start);
    decls.push({
      kind: kw,
      name,
      line: kwLine + 1,
      start,
      end,
      assignIndex: assignRel === null ? null : start + assignRel,
      header: assignRel === null ? src.slice(start, end) : src.slice(start, start + assignRel),
      body: assignRel === null ? '' : src.slice(start + assignRel, end),
      firstLine: headText,
    });
  }
  // A trailing doc comment belongs to the NEXT declaration: leave it in the gap between the two.
  for (let i = 0; i + 1 < decls.length; i += 1) {
    const d = decls[i];
    const text = src.slice(d.start, d.end);
    const m = /\n(\s*\/--(?:(?!-\/)[\s\S])*-\/\s*)$/.exec(text);
    if (m) {
      d.end -= m[1].length;
      d.body = d.assignIndex === null ? '' : src.slice(d.assignIndex, d.end);
      d.header = d.assignIndex === null ? src.slice(d.start, d.end) : d.header;
    }
  }
  return decls;
}

/** Index of the first `:=` at bracket depth 0 in `text`, starting at `from`; null if none. */
function topLevelAssign(text, from = 0) {
  let depth = 0;
  for (let i = from; i < text.length - 1; i += 1) {
    const c = text[i];
    if (c === '"') { i += 1; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i += 1; i += 1; } continue; }
    if ('([{⟨'.includes(c)) depth += 1;
    else if (')]}⟩'.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ':' && text[i + 1] === '=') return i;
    else if (depth === 0 && c === '|' && /\s/.test(text[i - 1] || ' ') && text.slice(i).trimStart().startsWith('|')) {
      // pattern-matching definition: `| pat => ...` starts the body
      if (i > from) return i;
    }
  }
  return null;
}

/** Names of top-level theorems/lemmas in order. */
export function theoremNames(src) {
  return findDeclarations(src).filter((d) => (d.kind === 'theorem' || d.kind === 'lemma') && d.name).map((d) => d.name);
}

/**
 * Statement-only version: every theorem/lemma body is replaced by `:= sorry` (evaluator-attached,
 * never credited), `example`s are removed, and everything else (definitions, instances,
 * notation, options) is kept so the statements still elaborate.
 */
/**
 * If the text between `cursor` and `start` is only a doc comment (and whitespace),
 * return `cursor` so the caller drops it together with the declaration it documents.
 */
export function dropDanglingDoc(src, cursor, start) {
  const gap = src.slice(cursor, start);
  // Only a doc comment that ends the gap (i.e. immediately precedes the declaration) is dropped.
  const m = /(^|\n)(\s*\/--(?:(?!-\/)[\s\S])*-\/\s*)$/.exec(gap);
  return m ? cursor + m.index + m[1].length : start;
}

export function stripProofs(src) {
  const decls = findDeclarations(src);
  let out = '';
  let cursor = 0;
  for (const d of decls) {
    if (d.kind === 'example') {
      out += src.slice(cursor, dropDanglingDoc(src, cursor, d.start));
      cursor = d.end;
      continue;
    }
    if (d.kind === 'theorem' || d.kind === 'lemma') {
      if (d.assignIndex !== null) {
        out += src.slice(cursor, d.assignIndex);
        out += ':= sorry\n\n';
        cursor = d.end;
      } else {
        // No `:=`: statement with no proof at all; attach one.
        out += src.slice(cursor, d.end).replace(/\s*$/, '') + ' := sorry\n\n';
        cursor = d.end;
      }
    }
  }
  out += src.slice(cursor);
  return out;
}

/** Split into {imports, rest} text. */
export function splitHeader(src) {
  const lines = src.split(/\r?\n/);
  let i = 0;
  const header = [];
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^import\s+/.test(t) || t === '' || t === 'prelude' || t.startsWith('--')) {
      header.push(lines[i]);
      i += 1;
      continue;
    }
    break;
  }
  return { imports: header.join('\n'), rest: lines.slice(i).join('\n') };
}

/** Wrap all non-import content in `namespace ns ... end ns`. */
export function wrapNamespace(src, ns) {
  const { imports, rest } = splitHeader(src);
  return `${imports.trim()}\n\nnamespace ${ns}\n\n${rest}\n\nend ${ns}\n`;
}

/**
 * Line counts.
 * Rule: `total` = number of newline-separated lines; `code` = lines that are non-blank after
 * removing all comments; `proof` = for the named declaration, lines from the line containing its
 * top-level `:=` through the end of the declaration (blank trailing lines excluded).
 */
export function countLines(src, targetName = null) {
  const lines = src.split(/\r?\n/);
  const stripped = stripComments(src).split(/\r?\n/);
  const code = stripped.filter((l) => l.trim() !== '').length;
  let proof = null;
  if (targetName) {
    const d = findDeclarations(src).find((x) => x.name === targetName);
    if (d && d.assignIndex !== null) {
      const bodyText = src.slice(d.assignIndex, d.end).replace(/\s+$/, '');
      const bodyLines = bodyText.split(/\r?\n/);
      const bodyStripped = stripComments(bodyText).split(/\r?\n/);
      proof = { total: bodyLines.length, code: bodyStripped.filter((l) => l.trim() !== '').length };
    } else if (d) {
      proof = { total: 0, code: 0 };
    }
  }
  return { total: lines.length, code, proof, rule: 'total=newline-separated lines; code=non-blank lines after comment removal; proof=lines from the target declaration\'s top-level := to the end of the declaration, same code rule' };
}

export const DEFAULT_ALLOWED_IMPORT_PREFIXES = Object.freeze([
  'Mathlib', 'Std', 'Lean', 'Init', 'Aesop', 'Batteries', 'Qq', 'ProofWidgets', 'Plausible', 'LeanSearchClient', 'ImportGraph',
]);

const FORBIDDEN_COMMANDS = [
  '#eval', '#exit', 'run_cmd', 'run_elab', 'run_tac', 'initialize', 'builtin_initialize',
  'elab', 'elab_rules', 'macro', 'macro_rules', 'syntax', 'declare_syntax_cat',
  'implemented_by', 'extern', 'export_attr', 'unsafe',
];

/**
 * Static safety screen applied to every file before it is handed to the compiler.
 * Returns { ok, rejections: [{code, line, text}], flags: [{code, line, text}] }.
 * Rejections stop compilation (code execution risk or import policy); flags are recorded for
 * the trust audit (sorry/admit/axiom/native_decide) and never silently accepted.
 */
export function staticScreen(src, {
  allowedImportPrefixes = DEFAULT_ALLOWED_IMPORT_PREFIXES,
  allowedImports = [],
  maxHeartbeats = 400000,
  maxBytes = 512 * 1024,
} = {}) {
  const rejections = [];
  const flags = [];
  if (Buffer.byteLength(src, 'utf8') > maxBytes) {
    rejections.push({ code: 'file_too_large', line: 0, text: `${Buffer.byteLength(src, 'utf8')} bytes > ${maxBytes}` });
  }
  if (/^\s*prelude\b/m.test(src)) rejections.push({ code: 'prelude_module', line: 1, text: 'prelude' });
  for (const mod of parseImports(src)) {
    const ok = allowedImports.includes(mod) || allowedImportPrefixes.some((p) => mod === p || mod.startsWith(`${p}.`));
    if (!ok) rejections.push({ code: 'disallowed_import', line: 0, text: mod });
  }
  const stripped = stripComments(src).split(/\r?\n/);
  const forbidden = new RegExp(`(^|[^A-Za-z0-9_.'])(${FORBIDDEN_COMMANDS.map((c) => c.replace('#', '\\#')).join('|')})(?![A-Za-z0-9_'])`);
  const placeholder = /(^|[^A-Za-z0-9_.'])(sorry|admit)(?![A-Za-z0-9_'])/;
  const axiomRe = /(^|[^A-Za-z0-9_.'])axiom(?![A-Za-z0-9_'])/;
  const nativeRe = /(^|[^A-Za-z0-9_.'])native_decide(?![A-Za-z0-9_'])/;
  const heartbeatRe = /set_option\s+maxHeartbeats\s+(\d+)/;
  const partialRe = /(^|[^A-Za-z0-9_.'])partial(?![A-Za-z0-9_'])/;
  stripped.forEach((line, idx) => {
    const m = forbidden.exec(line);
    if (m) rejections.push({ code: 'forbidden_command', line: idx + 1, text: m[2] });
    const hb = heartbeatRe.exec(line);
    if (hb) {
      const v = Number(hb[1]);
      if (v === 0 || v > maxHeartbeats) rejections.push({ code: 'heartbeat_cap_exceeded', line: idx + 1, text: line.trim() });
    }
    if (placeholder.test(line)) flags.push({ code: 'placeholder', line: idx + 1, text: line.trim() });
    if (axiomRe.test(line)) flags.push({ code: 'user_axiom', line: idx + 1, text: line.trim() });
    if (nativeRe.test(line)) flags.push({ code: 'native_decide', line: idx + 1, text: line.trim() });
    if (partialRe.test(line)) flags.push({ code: 'partial_def', line: idx + 1, text: line.trim() });
  });
  return { ok: rejections.length === 0, rejections, flags };
}

/** Best-effort declaration-name candidates for a target kind. */
export function candidateDeclarations(src, targetKind) {
  const decls = findDeclarations(src).filter((d) => (d.kind === 'theorem' || d.kind === 'lemma') && d.name);
  const kindTokens = {
    main_theorem: ['main', 'theorem', 'thm', 'result'],
    upper_bound: ['upper', 'ub', 'upperbound'],
    lower_bound: ['lower', 'lb', 'lowerbound'],
    disproof: ['disproof', 'disprove', 'counter', 'counterexample', 'refute', 'false', 'not'],
  }[targetKind] || [];
  const scored = decls.map((d) => {
    const toks = d.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const score = toks.filter((t) => kindTokens.includes(t)).length;
    return { name: d.name, line: d.line, score };
  });
  return scored;
}
