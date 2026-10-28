-- expect: reject
-- native_decide on a Bool whose compiled code lies (implemented_by) proves False.
import Mathlib.Data.Fintype.Pigeonhole
import Mathlib.Algebra.BigOperators.Intervals
import Mathlib.Data.ZMod.Basic

def truth : Bool := true
@[implemented_by truth] def lie : Bool := false
theorem lie_eq : lie = true := by native_decide

/-- **A Zero-Sum Block of Consecutive Integers.** Among any `n` integers some block of
consecutive terms has sum divisible by `n`. -/
theorem P110 (n : ℕ) (hn : 0 < n) (a : ℕ → ℤ) :
    ∃ i j, i < j ∧ j ≤ n ∧ (n : ℤ) ∣ ∑ k ∈ Finset.Ico i j, a k := by
  exact absurd lie_eq (by decide)
