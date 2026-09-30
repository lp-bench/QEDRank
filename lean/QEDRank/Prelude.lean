import Mathlib.Data.Real.Basic

/-!
# QEDRank shared prelude (definitions only)

This file is shown verbatim to every model as the "allowed definitions-only
project prelude" and may be imported by model output as `QEDRank.Prelude`.

Rules for this file (enforced by `qedrank run` through `#qr_decls`):
* definitions, abbreviations, structures, inductives, instances and notation only;
* no `theorem`/`lemma`, no axioms, no `unsafe`, no meta code;
* keep it minimal (narrow imports keep evaluator start-up fast; models import Mathlib themselves) — per-paper definitions go in generated `QEDRank.Papers.*`
  modules built from the corpus' reviewed definition files.
-/

namespace QEDRank

/-- Marker used in benchmark statements to indicate an asymptotic constant that
the paper leaves unspecified. Models must not use it to hide assumptions. -/
abbrev UnspecifiedConstant := { c : ℝ // 0 < c }

end QEDRank
