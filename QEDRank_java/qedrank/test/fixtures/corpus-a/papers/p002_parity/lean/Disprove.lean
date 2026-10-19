import Mathlib.Algebra.Ring.Parity

/-- The paper conjectures the converse fails; the polarity is NOT confirmed by this file alone. -/
theorem not_all_odd : ¬ ∀ n : ℕ, Odd (2 * n) := by
  intro h
  exact absurd (h 0) (by decide)
