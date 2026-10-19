theorem used_h (a b : Nat) (h : a = b) : b = a := h.symm
theorem unused_h (a : Nat) (h : a = 1) (h2 : True) : a + 0 = a := by simp
theorem tac_mix (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  constructor
  · exact hp
  · exact hq
theorem triv (n : Nat) : n + 0 = n := by omega
theorem contra (n : Nat) (h : n < 0) : n = 5 := by omega
theorem withSorry (n : Nat) (h : n = 1) : n = 1 := by sorry
def f (n : Nat) : Nat := n + 1
