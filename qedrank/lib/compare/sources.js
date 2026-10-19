// Where each public benchmark's Lean 4 statements come from, pinned to the commit (or Hub revision)
// checked on 2026-10-14. Each adapter returns the problems as Lean text plus the target theorem,
// a subject label (MSC code or domain name, possibly several) and a level, both only when the
// benchmark itself provides them per problem.
//
// Not measured: AMBER (no public release found) and FormalProofBench (private; 2 samples only).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { gitCheckout, listFiles, hfRows, rawFile } from './fetch.js';

const SORRY = (s) => (/\bsorry\s*$/.test(s.trim()) ? s : `${s.replace(/\s+$/, '')} sorry\n`);

/** Minimal RFC 4180 CSV reader (quoted fields, embedded commas, quotes and newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

const parseJsonl = (text) => text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------------------------

const MINIF2F_SHA = '2c4ba9119eef74d0d611f494261b2c5bae98c69a';
const PUTNAM_SHA = 'a635813f5edf297d928f9bd5ef8324a26bdde09c';
const FORMALMATH_REV = '8eea2550f174ce8b95444334da18a7473c2d169c';
const MSC180_SHA = '298f08a0a0e4fa715a7e478c0d67358d6ef362a2';
const COMBIBENCH_SHA = 'c67e4213597b1477351d9ef5ca37fb622084cc78';
const LEANEVAL_SHA = '38361be884302c7edce1908c4aef8296eb2cb27e';

function minif2fLabels(name) {
  const level = /^(imo|aime|amc)/.test(name) ? 'competition' : /^mathd_/.test(name) ? 'competition' : 'coursework';
  const subject = /algebra/.test(name) ? 'Algebra' : /numbertheory/.test(name) ? 'Number Theory' : null;
  return { level, subject };
}

const PROOFNET_SUBJECT = {
  Rudin: 'Real Analysis', Pugh: 'Real Analysis', Shakarchi: 'Complex Analysis', Axler: 'Linear Algebra',
  Artin: 'Algebra', 'Dummit-Foote': 'Algebra', Herstein: 'Algebra', Munkres: 'Topology', 'Ireland-Rosen': 'Number Theory',
};

export const SOURCES = [
  {
    id: 'minif2f',
    async problems({ cacheDir }) {
      const url = `https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Prover-V1.5/${MINIF2F_SHA}/datasets/minif2f.jsonl`;
      const rows = parseJsonl(await rawFile({ url, cacheDir, name: `minif2f-deepseek-${MINIF2F_SHA.slice(0, 7)}.jsonl` }));
      return {
        source: { kind: 'git', url: 'https://github.com/deepseek-ai/DeepSeek-Prover-V1.5', label: 'DeepSeek-Prover-V1.5 datasets/minif2f.jsonl (Lean 4 port used by most prover papers)', commit: MINIF2F_SHA, date: '2024-08-16' },
        problems: rows.map((r) => ({ id: r.name, text: SORRY(`${r.header}${r.formal_statement}`), target: r.name, split: r.split, ...minif2fLabels(r.name) })),
      };
    },
  },
  {
    id: 'putnambench',
    async problems({ cacheDir, refresh, log }) {
      const co = await gitCheckout({ url: 'https://github.com/trishullab/PutnamBench.git', ref: PUTNAM_SHA, cacheDir, name: 'putnambench', refresh, log });
      const tags = new Map(JSON.parse(await fs.readFile(path.join(co.dir, 'informal', 'putnam.json'), 'utf8')).map((e) => [e.problem_name, e.tags || []]));
      const files = await listFiles(co.dir, /^lean4\/src\/putnam_[^/]+\.lean$/);
      const problems = [];
      for (const f of files) {
        const id = path.basename(f, '.lean');
        problems.push({ id, text: await fs.readFile(path.join(co.dir, f), 'utf8'), target: id, subject: tags.get(id) || null, level: 'competition' });
      }
      return { source: { kind: 'git', url: 'https://github.com/trishullab/PutnamBench', label: 'trishullab/PutnamBench lean4/src (Lean 4)', commit: co.commit, date: co.commit_date }, problems };
    },
  },
  {
    id: 'formalmath',
    async problems({ cacheDir }) {
      const url = `https://huggingface.co/datasets/SphereLab/FormalMATH-All/resolve/${FORMALMATH_REV}/FormalMATH_all.json`;
      const rows = JSON.parse(await rawFile({ url, cacheDir, name: `formalmath-all-${FORMALMATH_REV.slice(0, 7)}.json` }));
      const level = (s) => (['u-math', 'hardmath', 'DEMIMATH'].includes(s) ? 'undergraduate' : 'competition');
      const subject = (d) => {
        const parts = String(d || '').replace(/;\s*$/, '').split('->').map((x) => x.trim()).filter(Boolean);
        return parts.length > 1 ? parts[1] : parts[0] || null;
      };
      return {
        source: { kind: 'hf', url: 'https://huggingface.co/datasets/SphereLab/FormalMATH-All', label: 'SphereLab/FormalMATH-All (HuggingFace)', commit: FORMALMATH_REV, date: '2025-05-04' },
        problems: rows.map((r) => ({ id: r.theorem_names, text: SORRY(r.autoformalization), target: String(r.theorem_names || '').split(/[,\s]+/)[0] || null, subject: subject(r.domain), level: level(r.source) })),
      };
    },
  },
  {
    id: 'msc180',
    async problems({ cacheDir }) {
      const url = `https://raw.githubusercontent.com/Siri6504/MSC-180/${MSC180_SHA}/data/MSC-180.json`;
      const rows = JSON.parse(await rawFile({ url, cacheDir, name: `msc180-${MSC180_SHA.slice(0, 7)}.json` }));
      return {
        source: { kind: 'git', url: 'https://github.com/Siri6504/MSC-180', label: 'Siri6504/MSC-180 data/MSC-180.json', commit: MSC180_SHA, date: '2025-09-26' },
        problems: rows.map((r) => {
          const names = Array.isArray(r.problem_names) ? r.problem_names : [r.problem_names];
          const text = Array.isArray(r.lean_statement) ? r.lean_statement[0] : r.lean_statement;
          return {
            id: r.problem_id,
            text,
            target: names.find((n) => n && new RegExp(`\\b(theorem|lemma)\\s+${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) || null,
            subject: String(r.domain || '').slice(0, 2) || null,
            level: /^undergraduate/i.test(String(r.difficult || '').replace(/​/g, '')) ? 'undergraduate' : /^graduate/i.test(String(r.difficult || '')) ? 'graduate' : null,
          };
        }),
      };
    },
  },
  {
    id: 'proofnet',
    async problems({ cacheDir, refresh, log }) {
      const problems = [];
      let commit = null;
      for (const split of ['valid', 'test']) {
        const got = await hfRows({ dataset: 'PAug/ProofNetSharp', config: 'default', split, cacheDir, refresh, log });
        commit = got.commit || commit;
        for (const r of got.rows) {
          const [book, name] = String(r.id).split('|');
          problems.push({
            id: r.id,
            // Some ProofNet# headers lack their final newline ("...falsetheorem exercise_23_4").
            text: SORRY(`${r.lean4_src_header || ''}\n${r.lean4_formalization || ''}`),
            target: name || null,
            split,
            subject: PROOFNET_SUBJECT[book] || null,
            level: book === 'Putnam' ? 'competition' : 'undergraduate',
          });
        }
      }
      return { source: { kind: 'hf', url: 'https://huggingface.co/datasets/PAug/ProofNetSharp', label: 'PAug/ProofNetSharp (ProofNet#, corrected Lean 4 port)', commit, date: null }, problems };
    },
  },
  {
    id: 'combibench',
    async problems({ cacheDir, refresh, log }) {
      const co = await gitCheckout({ url: 'https://github.com/MoonshotAI/CombiBench.git', ref: COMBIBENCH_SHA, cacheDir, name: 'combibench', refresh, log });
      const meta = new Map(parseCsv(await fs.readFile(path.join(co.dir, 'lean', 'CombiBench', 'metadata.csv'), 'utf8')).map((r) => [r.theorem_name, r]));
      const level = (tag) => ({ hackmath: 'coursework', brualdi: 'undergraduate', imo: 'competition', math_competitions: 'competition' }[tag] || null);
      const files = await listFiles(co.dir, /^lean\/CombiBench\/[^/]+\.lean$/);
      const problems = [];
      for (const f of files) {
        const id = path.basename(f, '.lean');
        problems.push({ id, text: await fs.readFile(path.join(co.dir, f), 'utf8'), target: id, subject: 'Combinatorics', level: level(meta.get(id)?.tag) });
      }
      return { source: { kind: 'git', url: 'https://github.com/MoonshotAI/CombiBench', label: 'MoonshotAI/CombiBench lean/CombiBench', commit: co.commit, date: co.commit_date }, problems };
    },
  },
  {
    id: 'leaneval',
    async problems({ cacheDir, refresh, log }) {
      const co = await gitCheckout({ url: 'https://github.com/leanprover/lean-eval.git', ref: LEANEVAL_SHA, cacheDir, name: 'lean-eval', refresh, log });
      const index = JSON.parse(await fs.readFile(path.join(co.dir, 'generated', 'index.json'), 'utf8'));
      const entries = Array.isArray(index) ? index : index.problems || Object.values(index);
      const v1 = await fs.readFile(path.join(co.dir, 'manifests', 'sets', 'v1.toml'), 'utf8');
      const members = new Set([...v1.matchAll(/problem_id\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
      const problems = [];
      for (const e of entries) {
        if (!members.has(e.id)) continue;
        const dir = path.join(co.dir, 'generated', e.id);
        const text = await fs.readFile(path.join(dir, 'Challenge.lean'), 'utf8').catch(() => null);
        if (text == null) { problems.push({ id: e.id, text: '', target: null }); continue; }
        const holes = JSON.parse(await fs.readFile(path.join(dir, 'holes.json'), 'utf8').catch(() => '{}'));
        const thm = (holes.holes || []).find((h) => h.kind === 'theorem');
        const deps = await fs.readFile(path.join(dir, 'ChallengeDeps.lean'), 'utf8').catch(() => null);
        const topic = String(e.module || '').split('.')[1] || null;
        problems.push({ id: e.id, text, target: thm?.name || null, subject: topic, deps }); // no per-problem level: the stated one applies
      }
      return {
        source: { kind: 'git', url: 'https://github.com/leanprover/lean-eval', label: `leanprover/lean-eval generated/ (frozen v1 set, ${members.size} problems)`, commit: co.commit, date: co.commit_date },
        problems,
        // Each problem's ChallengeDeps.lean holds the shared-module definitions its statement uses.
        readModuleFor: (p) => async (mod) => (mod === 'ChallengeDeps' ? p.deps : null),
      };
    },
  },
];
