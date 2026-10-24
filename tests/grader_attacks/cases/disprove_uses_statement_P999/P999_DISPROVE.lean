-- expect: reject
-- A disproof that uses the imported statement `P999`, whose proof is `sorry`.
import ProofBench.PROBLEMS.P999.P999

/-- The negation of `P999`. -/
theorem P999_disprove : ¬ AllEven := by
  intro _
  exact Nat.not_even_one (P999 1)
