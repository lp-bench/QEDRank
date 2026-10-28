-- expect: accept
-- A solution with layout changes only: comments (one mentions sorry), blank lines, spacing, line breaks.
import Mathlib.Data.Fintype.Pigeonhole
import Mathlib.Algebra.BigOperators.Intervals
import Mathlib.Data.ZMod.Basic

-- Proof by the reference solution; no sorry is left.


/-- A different docstring. -/
theorem   P110 (n : ℕ) (hn : 0 < n)
  (a : ℕ → ℤ) :   ∃ i j, i < j ∧ j ≤ n ∧ (n : ℤ) ∣ ∑ k ∈ Finset.Ico i j, a k := by

  REFERENCE_PROOF
