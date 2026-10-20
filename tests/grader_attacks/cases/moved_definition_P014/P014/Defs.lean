import Mathlib.Combinatorics.SimpleGraph.LineGraph
import Mathlib.Combinatorics.SimpleGraph.Coloring.Vertex

def IsRainbow {V : Type*} (G : SimpleGraph V) {β : Sort*} (_c : β) {u v : V} (_p : G.Walk u v) : Prop :=
  False
