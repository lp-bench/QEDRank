import Mathlib.Algebra.Ring.Parity

theorem not_all_odd : ¬ ∀ n : ℕ, Odd (2 * n) := by
  intro h
  have h0 := h 0
  simp at h0