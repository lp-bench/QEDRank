import Mathlib

lemma helper (n : ℕ) : n ≤ n := le_refl n

theorem P014 (n : ℕ) : n + 0 = n := by simp
