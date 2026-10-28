-- expect: reject
-- The DISPROVE file as given, proof still `sorry`.
import ProofBench.PROBLEMS.P005.P005

open SimpleGraph

/-- **Disprove version of P005**: for some `r`, no constant `c > 0` guarantees that every
finite `P_r`-free graph has a clique or independent set of size at least `|V|^c`. -/
theorem P005_disprove :
    ¬ ∀ r : ℕ, ErdosHajnalConjectureFor (pathGraph r) := by
  sorry
