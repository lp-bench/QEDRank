import Mathlib.Algebra.Ring.Parity

theorem not_all_odd : ¬ ∀ n : ℕ, Odd (2 * n) := fun h => absurd (h 0) (by decide)