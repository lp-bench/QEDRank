=== PART A ===
```lean
import Mathlib.Algebra.Ring.Parity

theorem not_all_odd : ¬ ∀ n : ℕ, Odd (2 * n)
```
=== PART B ===
```lean
import Mathlib.Algebra.Ring.Parity

theorem not_all_odd : ¬ ∀ n : ℕ, Odd (2 * n) := by
  intro h
  exact absurd (h 0) (by native_decide)
```
=== PART C ===
Witness n = 0; decided by evaluation.
=== PART D ===
statement_confidence: 90
proof_confidence: 85
