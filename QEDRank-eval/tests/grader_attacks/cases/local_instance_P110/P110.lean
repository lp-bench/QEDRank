-- expect: reject
-- Statement text unchanged, but a local instance before it makes ∣ on ℤ always true.
import Mathlib.Data.Fintype.Pigeonhole
import Mathlib.Algebra.BigOperators.Intervals
import Mathlib.Data.ZMod.Basic

local instance : Dvd ℤ := ⟨fun _ _ => True⟩

/-- **A Zero-Sum Block of Consecutive Integers.** Among any `n` integers some block of
consecutive terms has sum divisible by `n`. -/
theorem P110 (n : ℕ) (hn : 0 < n) (a : ℕ → ℤ) :
    ∃ i j, i < j ∧ j ≤ n ∧ (n : ℤ) ∣ ∑ k ∈ Finset.Ico i j, a k := by
  exact ⟨0, 1, Nat.zero_lt_one, hn, trivial⟩
