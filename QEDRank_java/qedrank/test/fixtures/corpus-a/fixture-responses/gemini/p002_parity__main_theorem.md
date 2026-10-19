=== PART A ===
```lean
import Mathlib.Algebra.Ring.Parity

theorem two_mul_even (n : ℕ) : Even (2 * n)
```
=== PART B ===
```lean
import Mathlib.Algebra.Ring.Parity

theorem two_mul_even (n : ℕ) : Even (2 * n) := even_two_mul n
```
=== PART C ===
Theorem 1 of the paper, verbatim.
=== PART D ===
statement_confidence: 99
proof_confidence: 95
