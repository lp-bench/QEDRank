-- expect: reject
-- Changes a definition the statement uses (IsRainbow := False), which makes it trivial.
import Archive.Sensitivity
import ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Hypercube
import Mathlib.Combinatorics.SimpleGraph.LineGraph
import Mathlib.Combinatorics.SimpleGraph.Coloring.Vertex

open SimpleGraph Sensitivity Walk Finset

noncomputable section

variable {V : Type*} [Fintype V] (G : SimpleGraph V) {n : ℕ}

def EdgeColoring (α : Type*) := (lineGraph G).Coloring α

def IsRainbow {α : Type*} [DecidableEq α] (c : EdgeColoring G α)
    {u v : V} (p : G.Walk u v) : Prop :=
    False

-- The hypercube `H n` of sequences of length `n` is defined in
-- `ProofBench.Mathlib_Problems.Combinatorics.SimpleGraph.Hypercube`.

def phi' (hn : 0 < n) : Sym2 (Q n) -> Fin n := by
  let fn : (Q n) → (Q n) → Fin n := by
    intro p q
    if h : ∃! i, p i ≠ q i then
        exact Classical.choose h
      else
        exact ⟨0, hn ⟩
  exact Sym2.lift ⟨ fn, by grind ⟩

lemma hypercube_edge_destruct {n : ℕ} {e : Sym2 (Fin n → Bool)}
    (he : e ∈ (H n).edgeSet) {p : Fin n → Bool} (hp : p ∈ e) :
    ∃ y, y ≠ p ∧ e = s(p, y) ∧ ∃! i, p i ≠ y i := by
  let y := Sym2.Mem.other hp
  have h_ye : y ∈ e := Sym2.other_mem hp
  have h_diag := not_isDiag_of_mem_edgeSet (H n) he
  have h_xy : y ≠ p := Sym2.other_ne h_diag hp
  have h_exy : e = s(p,y) := (Sym2.mem_and_mem_iff h_xy.symm).mp ⟨hp, h_ye⟩
  have h_adj : ∃! i, p i ≠ y i := by
    apply (mem_edgeSet (H n)).mp
    rw [h_exy.symm]
    exact he
  exact ⟨y, h_xy, h_exy, h_adj⟩

def HEdgeColoring (hn : 0 < n) :
  EdgeColoring (H n) (Fin n) where
  toFun := fun p => phi' hn p.1
  map_rel' := by
    intro e₁ e₂ h_adj
    simp only [completeGraph_eq_top, top_adj, ne_eq] at *
    obtain ⟨hne, ⟨p, ⟨h1, h2⟩⟩⟩ := h_adj
    obtain ⟨y₁, h_xy₁, h_exy₁, h_adj₁⟩ := hypercube_edge_destruct e₁.2 h1
    obtain ⟨y₂, h_xy₂, h_exy₂, h_adj₂⟩ := hypercube_edge_destruct e₂.2 h2
    intro hc
    simp [phi'] at hc
    simp_all
    have : y₁ = y₂ := by
      obtain ⟨i₁, hi₁⟩ := h_adj₁
      obtain ⟨i₂, hi₂⟩ := h_adj₂
      have hi : i₁ = i₂ := by grind
      subst hi
      simp_all only [not_false_eq_true]
      apply Q.ext
      intro j
      by_cases hij : j = i₁
      · by_cases hip : p i₁ = true
        · grind
        · grind
      · grind
    grind

theorem P014 {hn : 0 < n} {u : Q n}
  {p : (H n).Walk u u} {hp : IsCycle p} :
  ¬ IsRainbow (H n) (HEdgeColoring hn) p := fun h => h
