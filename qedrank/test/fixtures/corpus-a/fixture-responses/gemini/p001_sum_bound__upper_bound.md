=== PART A ===
```lean
import Mathlib
import QEDRank.Papers.p001_sum_bound

theorem upper_bound (n : ℕ) : sumBelow n ≤ n ^ 2
```
=== PART B ===
```lean
import Mathlib
import QEDRank.Papers.p001_sum_bound

theorem upper_bound (n : ℕ) : sumBelow n ≤ n ^ 2 := by
  unfold sumBelow
  have h : (Finset.range n).sum id ≤ (Finset.range n).sum (fun _ => n) :=
    Finset.sum_le_sum (fun i hi => le_of_lt (Finset.mem_range.mp hi))
  simp only [Finset.sum_const, Finset.card_range, smul_eq_mul] at h
  calc (Finset.range n).sum id ≤ n * n := h
    _ = n ^ 2 := by ring
```
=== PART C ===
Each summand is below n, so the sum of n of them is at most n·n = n².
=== PART D ===
statement_confidence: 90
proof_confidence: 75
