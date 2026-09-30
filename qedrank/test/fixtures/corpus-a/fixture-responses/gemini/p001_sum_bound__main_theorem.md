=== PART A ===
```lean
import Mathlib
import QEDRank.Papers.p001_sum_bound

theorem main_theorem (n : ℕ) : 2 * sumBelow n = n * (n - 1)
```
=== PART B ===
```lean
import Mathlib
import QEDRank.Papers.p001_sum_bound

theorem main_theorem (n : ℕ) : 2 * sumBelow n = n * (n - 1) := by
  unfold sumBelow
  rw [mul_comm]
  exact Finset.sum_range_id_mul_two n
```
=== PART C ===
The paper's S(n) is the prelude's `sumBelow n`; the closed form 2 S(n) = n(n-1) is stated verbatim over ℕ with truncated subtraction, which agrees with the paper for n ≥ 1 and trivially for n = 0.
=== PART D ===
statement_confidence: 95
proof_confidence: 80
