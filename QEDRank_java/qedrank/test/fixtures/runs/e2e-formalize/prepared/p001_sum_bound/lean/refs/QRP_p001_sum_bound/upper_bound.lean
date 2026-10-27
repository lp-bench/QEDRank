import Mathlib.Algebra.BigOperators.Intervals
import Mathlib.Algebra.Order.BigOperators.Group.Finset
import Mathlib.Tactic.Ring
import QRP_p001_sum_bound.Defs

/-- Upper bound: the sum is at most n^2. -/
theorem upper_bound (n : ℕ) : sumBelow n ≤ n ^ 2 := by
  unfold sumBelow
  calc (Finset.range n).sum id ≤ (Finset.range n).sum (fun _ => n) :=
        Finset.sum_le_sum (fun i hi => le_of_lt (Finset.mem_range.mp hi))
    _ = n * n := by simp
    _ = n ^ 2 := by ring
