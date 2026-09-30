import Mathlib
import Defs

/-- Main theorem: the Gauss closed form. -/
theorem main_theorem (n : ℕ) : 2 * sumBelow n = n * (n - 1) := by
  unfold sumBelow
  rw [mul_comm]
  exact Finset.sum_range_id_mul_two n
