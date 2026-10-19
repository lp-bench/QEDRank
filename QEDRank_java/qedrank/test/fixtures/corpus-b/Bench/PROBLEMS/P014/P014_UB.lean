import Bench.PROBLEMS.P014.P014

namespace P014UB
theorem P014_UB_1 (n : ℕ) : n ≤ n + 1 := Nat.le_succ n
theorem P014_UB_2 (n : ℕ) : n ≤ n + 2 := by omega
end P014UB
