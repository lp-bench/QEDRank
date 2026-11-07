Web interface: https://qedrank.vercel.app, maintained by Vaibhav Bajpai (source: https://github.com/vaibhav-baj/QEDRank).


# QEDRank

The evaluation harness of ProofBench: model runs with the same agent, tools and budgets for every
model, and Lean-checked grading. Everything lives in this one repository, branch `main`.

```
QEDRank/
  QEDRank-eval/              the ProofBench agent harness (Inspect AI), with the full history of
                             its former repository proofbench-eval-apptainer
  inspectAI-apptainer/       the Apptainer sandbox for Inspect that the harness uses on HPC, with
                             the full history of its former repository inspect-apptainer
  QEDRank-java/              a page that redirects to the web interface, published with GitHub
                             Pages at https://lp-bench.github.io/QEDRank/
```

## Quick start

See `QEDRank-eval/README.md`: setup (`QEDRank-eval/scripts/setup.sh`), an example run and how
grading works.

Run logs (`QEDRank-eval/logs/`) contain the private ProofBench statements: keep them off public
sites and shared drives.
