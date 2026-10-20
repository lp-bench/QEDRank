import Mathlib.Combinatorics.SimpleGraph.Walk

def IsRainbow {V : Type*} (G : SimpleGraph V) {β : Sort*} (_c : β) {u v : V} (_p : G.Walk u v) : Prop :=
  False
