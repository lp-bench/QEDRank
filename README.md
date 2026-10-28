Web interface: https://qedrank.vercel.app, maintained by Vaibhav Bajpai (source: https://github.com/vaibhav-baj/QEDRank).


# QEDRank

The evaluation harness of ProofBench: model runs with the same agent, tools and budgets for every
model, and Lean-checked grading. Everything lives in this one repository, branch `main`.

```
QEDRank/
  QEDRank-eval/              the ProofBench agent harness (Inspect AI), a git subtree of
                             proof-bench/proofbench-eval-apptainer
  QEDRank-ProofBencheval/    an earlier copy of the harness with the QEDRank fork's fixes; removed
                             once the fixes are ported to QEDRank-eval/
  QEDRank_java/              a page that redirects to the web interface, published with GitHub
                             Pages at https://proof-bench.github.io/QEDRank/
```

## Quick start

See `QEDRank-eval/README.md`: setup, an example run and how grading works.

Run logs (`QEDRank-eval/logs/`) contain the private ProofBench statements: keep them off public
sites and shared drives.
