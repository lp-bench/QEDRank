import Mathlib.Algebra.BigOperators.Intervals
import QEDRank.Prelude

-- ==== from papers/p001_sum_bound/Defs.lean (theorems removed automatically) ====
/-- The sum 0 + 1 + ... + (n-1). -/
def sumBelow (n : ℕ) : ℕ := (Finset.range n).sum id
