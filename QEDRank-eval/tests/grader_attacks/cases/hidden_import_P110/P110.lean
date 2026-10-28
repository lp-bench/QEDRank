-- expect: reject
-- Imports the private proctor library (ProofBench.Mathlib.*), absent from the sandbox.
import Mathlib.Data.Fintype.Pigeonhole
import Mathlib.Algebra.BigOperators.Intervals
import Mathlib.Data.ZMod.Basic
import ProofBench.Mathlib.Combinatorics.SimpleGraph.Basic

/-- **A Zero-Sum Block of Consecutive Integers.** Among any `n` integers some block of
consecutive terms has sum divisible by `n`. -/
theorem P110 (n : ℕ) (hn : 0 < n) (a : ℕ → ℤ) :
    ∃ i j, i < j ∧ j ≤ n ∧ (n : ℤ) ∣ ∑ k ∈ Finset.Ico i j, a k := by
  REFERENCE_PROOF
