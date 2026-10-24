-- expect: accept
-- A disproof: the negation of a false test statement, proved (DISPROVE file importing its problem file).
import ProofBench.PROBLEMS.P999.P999

/-- The negation of `P999`. -/
theorem P999_disprove : ¬ AllEven := by
  intro h
  exact Nat.not_even_one (h 1)
