import Mathlib.Algebra.Ring.Parity

theorem not_all_odd : ¬ ∀ n : ℕ, Odd (2 * n) := by
  intro h
  exact absurd (h 0) (by native_decide)