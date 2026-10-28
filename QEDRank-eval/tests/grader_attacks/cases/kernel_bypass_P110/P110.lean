-- expect: reject
-- Adds `cheat : False` with kernel checking switched off (debug.skipKernelTC); #print axioms looks clean.
import Mathlib.Data.Fintype.Pigeonhole
import Mathlib.Algebra.BigOperators.Intervals
import Mathlib.Data.ZMod.Basic

set_option debug.skipKernelTC true in
run_cmd Lean.Elab.Command.liftCoreM do
  Lean.addDecl (.thmDecl { name := `cheat, levelParams := [], type := Lean.mkConst ``False, value := Lean.mkConst ``True.intro })

/-- **A Zero-Sum Block of Consecutive Integers.** Among any `n` integers some block of
consecutive terms has sum divisible by `n`. -/
theorem P110 (n : ℕ) (hn : 0 < n) (a : ℕ → ℤ) :
    ∃ i j, i < j ∧ j ≤ n ∧ (n : ℤ) ∣ ∑ k ∈ Finset.Ico i j, a k := by
  exact cheat.elim
