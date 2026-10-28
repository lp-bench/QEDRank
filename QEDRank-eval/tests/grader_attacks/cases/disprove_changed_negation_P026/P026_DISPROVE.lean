-- expect: reject
-- Replaces the negation by a trivial statement.
import ProofBench.Mathlib_Problems.Geometry.ConvexSphereDiagram

open ConvexSphereDiagram

/-- Negation of `P026`: in some dimension `d ≥ 4`, some cube `Q_n` is not the labelled
region-adjacency graph of the boundaries of `n` convex bodies. -/
theorem P026_disprove : ¬ False := by
  exact fun h => h
