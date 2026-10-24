import Mathlib.Algebra.Group.Nat.Even

/-- Every natural number is even: a false test statement, not a benchmark problem. -/
def AllEven : Prop := ∀ n : ℕ, Even n

/-- The test statement; its negation `P999_disprove` is provable. -/
theorem P999 : AllEven := by
  sorry
