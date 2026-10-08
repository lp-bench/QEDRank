def weight (n : Nat) : Nat :=
  n + n

private def shift (n : Nat) : Nat := n + 1

def next (n : Nat) : Nat := shift n

structure Pair where
  fst : Nat
  snd : Nat

theorem P900 (k : Nat) :
    weight k = 2 * k ∧ next k = k + 1 := by
  refine ⟨?_, rfl⟩
  unfold weight
  omega
