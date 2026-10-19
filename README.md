# QEDRank

Lean 4 benchmark evaluation for the private ProofBench corpus: model runs, Lean-checked grading,
statistics and the web app that shows them. Everything lives in this one repository, branch `main`.

```
QEDRank/
  QEDRank_java/              web app (Vite/React), the CLI `node qedrank/cli.js`, the Lean audit
                             project (lean/), tests, docs and the paper sources
  QEDRank-ProofBencheval/    ProofBench agent harness (Inspect AI), a git subtree of
                             proof-bench/proofbench-eval-apptainer with the QEDRank fork's fixes
  proofbench-statements/     built Lean project of the statements (not committed; private)
```

## Quick start

```bash
cd QEDRank_java
npm ci
npm run dev                  # the app on http://localhost:3000
npm run qedrank:serve        # local run server on 127.0.0.1:8787 (lists runs, starts jobs)
node qedrank/cli.js harnesses
```

The CLI finds the harness and the Lean project as the sibling folders above; a machine-specific
`QEDRank_java/qedrank.config.json` (not committed) overrides the paths. API keys stay in the
environment and are never written to files.

## Documentation

- `QEDRank_java/qedrank/README.md` — the CLI, grading rules, statistics
- `QEDRank_java/docs/agent-evaluation.md` — agent runs, statuses, pass@k, DGX commands
- `QEDRank-ProofBencheval/README.md` — the harness, and the changes made in this fork
- `QEDRank_java/paper/methodology.tex` — the evaluation methodology

Run folders (`QEDRank_java/runs/`) contain private ProofBench statements: keep them off public
sites and shared drives.
