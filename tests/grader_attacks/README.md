# Grader attack suite

Submissions that try to pass the grader without proving the theorem, plus two
valid solutions that it must accept. `run.sh` grades every case in a fresh
container from the evaluation image with each layer on its own (layer 2 runs
even when layer 1 rejects), so it shows which layer catches what. A case
counts as accepted only when both layers accept it, as in a real run.

```bash
tests/grader_attacks/run.sh                     # every case, Apptainer image proofbench-sandbox.sif
tests/grader_attacks/run.sh local_instance_P110 # one case
JOBS=8 PB=../proofbench-hidden tests/grader_attacks/run.sh
```

About 1 min per case; 4 cases run in parallel by default. Without
`proofbench-sandbox.sif` the Docker image `proofbench-sandbox:latest` is used.

Each case is a folder under `cases/` with the main file `Pxxx.lean`, or
`Pxxx_DISPROVE.lean` for a disproof of an open problem, and helper files under
`Pxxx/` when the attack needs them. The first line of the main file is
`-- expect: accept` or `-- expect: reject`, the second says what the case
tries. P110 (an elementary problem) is the base of most cases; P014 is used
where the problem file must contain definitions. Open problems cannot be
disproved, so the accepted disproof is of P999, a false test statement that is
not a benchmark problem: its challenge files are in the case's `_challenge/`
folder, which `one.sh` copies into the image's problem folder and builds
before grading.

**No solutions in this repository.** Cases that need a correct proof contain
the placeholder `REFERENCE_SOLUTION` (the whole file) or `REFERENCE_PROOF`
(the proof of the main theorem). `run.sh` fills them in from the reference
solutions of the private development repository (`PB`, default
`../proofbench-hidden`) and skips these cases when it is not there.

## Cases

| Case | Expect | What it tries |
|---|---|---|
| `solved_P110`, `solved_P014` | accept | the reference solution |
| `reformatted_P110` | accept | a solution with other comments, blank lines, spacing and line breaks |
| `untouched_P110` | reject | the problem file as given |
| `partial_P110` | reject | lemmas, one still `sorry` |
| `unused_sorry_P110` | reject | a solution plus an unused lemma with `sorry` |
| `compile_error_P110` | reject | a proof that does not compile |
| `changed_statement_P110` | reject | a weaker, trivial statement |
| `changed_definition_P014` | reject | a definition of the statement redefined as `False` |
| `moved_definition_P014` | reject | that definition removed and redefined in a helper file |
| `axiom_P110` | reject | `axiom : False` |
| `axiom_in_helper_P110` | reject | the same axiom in an imported helper file |
| `sorry_disguised_P110` | reject | `sorryAx` written out, invisible to a search for `sorry` |
| `native_decide_P110` | reject | `native_decide` on code that lies through `implemented_by` |
| `kernel_bypass_P110` | reject | a proof of `False` added with `debug.skipKernelTC`; `#print axioms` looks clean |
| `forbidden_command_P110` | reject | a solution plus `#eval` that writes a file at compile time |
| `hidden_import_P110` | reject | an import of the private proctor library |
| `local_instance_P110` | reject | statement text unchanged; a `local instance` makes `∣` always true |
| `global_instance_P110` | reject | the same with a high-priority global instance |
| `variable_hypothesis_P110` | reject | statement text unchanged; `variable [Fact False]` adds the hypothesis `False` |
| `macro_rules_P110` | reject | `macro_rules` rewrites `a ∣ b` to `True` |
| `notation_P110` | reject | new notation for `∣` (Lean reports an ambiguity) |
| `disprove_solved_P999` | accept | a disproof: the negation of a false test statement, through a DISPROVE file that imports its problem file |
| `disprove_uses_statement_P999` | reject | a disproof that uses the imported statement `P999`, whose proof is `sorry` |
| `disprove_untouched_P005` | reject | the DISPROVE file as given |
| `disprove_changed_negation_P026` | reject | the negation replaced by `¬ False` |

The design follows the attack list of QEDRank's grader tests; the cases were
rewritten against ProofBench problems.

## Last run

2026-10-24, image of 2026-10-24 (Lean 4.34.1, with the DISPROVE modules): all
26 cases as expected, and every rejection by Comparator gives the intended
reason.

- Layer 1 alone accepts `local_instance`, `global_instance` and
  `variable_hypothesis`: their statement text is unchanged. Comparator rejects
  all three ("Challenge and solution theorem statement do not match"). This is
  by design: layer 1 is a permissive pre-filter, since a valid proof it
  rejected could not be recovered, and Comparator makes the final judgment.
  A run with Comparator off would accept these three.
- Comparator alone accepts `unused_sorry`: it checks only the main theorem.
  Layer 1 rejects it (no `sorry` anywhere).
- Disprove cases: both layers accept the P999 disproof. Comparator rejects
  the changed negation (statements do not match) and the other two (`sorryAx`).
