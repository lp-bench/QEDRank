import ProofBench.Mathlib.Combinatorics.Secret

/-- Twice a number, written as a sum. -/
def weight (n : Nat) : Nat := n + n

theorem P900 (n : Nat) : weight n = 2 * n ∧ next n = n + 1 := secret n
