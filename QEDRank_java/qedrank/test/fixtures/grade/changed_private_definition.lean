/-- Twice a number, written as a sum. -/
def weight (n : Nat) : Nat := n + n

private def shift (n : Nat) : Nat := 1 + n

/-- The successor, through a private helper. -/
def next (n : Nat) : Nat := shift n

structure Pair where
  fst : Nat
  snd : Nat

/-- The statement to prove. -/
theorem P900 (n : Nat) : weight n = 2 * n ∧ next n = n + 1 := by
  refine ⟨?_, ?_⟩
  · unfold weight; omega
  · unfold next shift; omega
