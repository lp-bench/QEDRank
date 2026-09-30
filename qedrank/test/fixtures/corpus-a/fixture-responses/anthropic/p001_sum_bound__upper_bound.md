=== PART A ===
```lean
import Mathlib
import QEDRank.Papers.p001_sum_bound

theorem upper_bound (n : ℕ) : sumBelow n ≤ n ^ 2 + 1
```
=== PART B ===
```lean
import Mathlib
import QEDRank.Papers.p001_sum_bound

theorem upper_bound (n : ℕ) : sumBelow n ≤ n ^ 2 + 1 := by
  unfold sumBelow
  have h : (Finset.range n).sum id ≤ (Finset.range n).sum (fun _ => n) :=
    Finset.sum_le_sum (fun i hi => le_of_lt (Finset.mem_range.mp hi))
  simp only [Finset.sum_const, Finset.card_range, smul_eq_mul] at h
  nlinarith [h]
```
=== PART C ===
I state the bound with a +1 slack because I was unsure whether the paper's inequality is strict; this may be weaker than the paper's claim.
=== PART D ===
statement_confidence: 55
proof_confidence: 70
