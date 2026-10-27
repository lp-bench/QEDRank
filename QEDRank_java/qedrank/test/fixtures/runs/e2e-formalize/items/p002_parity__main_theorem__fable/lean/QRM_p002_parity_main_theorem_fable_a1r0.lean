import Mathlib.Algebra.Ring.Parity

theorem two_mul_even (m : ℕ) : Even (m * 2) := even_mul_succ_self m |>.elim (fun _ => ⟨m, by ring⟩) (fun _ => ⟨m, by ring⟩)