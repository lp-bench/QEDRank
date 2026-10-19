import Mathlib.Algebra.BigOperators.Intervals

/-- The sum 0 + 1 + ... + (n-1). -/
def sumBelow (n : ℕ) : ℕ := (Finset.range n).sum id

theorem sumBelow_zero : sumBelow 0 = 0 := by simp [sumBelow]
