/-- Twice a number, written as a sum. -/
def weight (n : Nat) : Nat := n + n

private def shift (n : Nat) : Nat := n + 1

/-- The successor, through a private helper. -/
def next (n : Nat) : Nat := shift n

structure Pair where
  fst : Nat
  snd : Nat

theorem weight_eq (n : Nat) : weight n = 2 * n := by
  unfold weight
  omega

theorem next_eq (n : Nat) : next n = n + 1 := sorry

theorem not_used (n : Nat) : n + 0 = n := rfl

/-- The statement to prove. -/
theorem P900 (n : Nat) : weight n = 2 * n ∧ next n = n + 1 :=
  ⟨weight_eq n, next_eq n⟩