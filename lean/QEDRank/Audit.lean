import Lean

/-!
# QEDRank evaluator commands

These commands are used ONLY by the evaluator (qedrank/lib/lean.js) inside
isolated scratch files. They are never given to models, and model files that
import `QEDRank.Audit` are rejected by the static screen.

Every command prints one machine-readable info line prefixed with `QR_`.
-/

open Lean Meta Elab Command

namespace QEDRank.Audit

private def kindOf : ConstantInfo → String
  | .thmInfo _    => "theorem"
  | .defnInfo _   => "def"
  | .axiomInfo _  => "axiom"
  | .opaqueInfo _ => "opaque"
  | .ctorInfo _   => "ctor"
  | .inductInfo _ => "inductive"
  | .recInfo _    => "rec"
  | .quotInfo _   => "quot"

private def fmtNames (ns : Array Name) : String :=
  String.intercalate "," (ns.toList.map toString)

/-- Is the type of `ci` a proposition? -/
private def isPropType (ci : ConstantInfo) : MetaM Bool := do
  try
    let s ← inferType ci.type
    isDefEq s (mkSort Level.zero)
  catch _ => pure false

/-- `#qr_version` — toolchain string. -/
elab "#qr_version" : command => do
  logInfo m!"QR_VERSION lean={Lean.versionString}"

/-- `#qr_axioms c` — transitive axioms of `c` plus safety flags. -/
elab "#qr_axioms " c:ident : command => do
  let n ← liftCoreM (realizeGlobalConstNoOverload c)
  let env ← getEnv
  let some ci := env.find? n | throwError "QR_ERROR unknown constant {n}"
  let axioms ← collectAxioms n
  let isProp ← liftTermElabM (isPropType ci)
  logInfo m!"QR_AXIOMS name={n} kind={kindOf ci} prop={isProp} unsafe={ci.isUnsafe} partial={ci.isPartial} axioms=[{fmtNames axioms}]"

/-- `#qr_decls Mod` — list the non-internal constants declared in module `Mod`. -/
elab "#qr_decls " m:ident : command => do
  let env ← getEnv
  let some idx := env.getModuleIdx? m.getId
    | throwError "QR_ERROR module not imported: {m.getId}"
  let names := env.header.moduleData[idx.toNat]!.constNames
  let mut count : Nat := 0
  for n in names do
    if n.isInternal then continue
    if let some ci := env.find? n then
      let isProp ← liftTermElabM (isPropType ci)
      count := count + 1
      logInfo m!"QR_DECL module={m.getId} name={n} kind={kindOf ci} prop={isProp} unsafe={ci.isUnsafe}"
  logInfo m!"QR_DECLS_DONE module={m.getId} count={count}"

/-- `#qr_mk_prop P := c` — defines `P : Prop := <type of c>` so that ordinary
tactics can reason about the *statement* of `c` without touching its proof. -/
elab "#qr_mk_prop " p:ident " := " c:ident : command => do
  let n ← liftCoreM (realizeGlobalConstNoOverload c)
  liftTermElabM do
    let ci ← getConstInfo n
    unless (← isPropType ci) do
      throwError "QR_ERROR not a proposition: {n} : {ci.type}"
    addDecl <| .defnDecl {
      name := p.getId, levelParams := ci.levelParams, type := mkSort Level.zero,
      value := ci.type, hints := .abbrev, safety := .safe }
  logInfo m!"QR_MK_PROP name={p.getId} from={n}"

/-- `#qr_compare a b` — structural and definitional comparison of the
statements (types) of `a` and `b`. Nothing about their proofs is inspected. -/
elab "#qr_compare " a:ident b:ident : command => do
  let na ← liftCoreM (realizeGlobalConstNoOverload a)
  let nb ← liftCoreM (realizeGlobalConstNoOverload b)
  liftTermElabM do
    let ca ← getConstInfo na
    let cb ← getConstInfo nb
    let ta := ca.type
    let tb :=
      if ca.levelParams.length == cb.levelParams.length then
        cb.type.instantiateLevelParams cb.levelParams (ca.levelParams.map mkLevelParam)
      else cb.type
    let syn := ta == tb
    let red ← try withReducible (isDefEq ta tb) catch _ => pure false
    let dflt ← try withTransparency .default (isDefEq ta tb) catch _ => pure false
    logInfo m!"QR_COMPARE a={na} b={nb} syntactic={syn} reducible={red} default={dflt}"

/-- `#qr_uses_hyp t` — for `t := fun h => body`, report whether `body` uses `h`.
Used to reject implication "proofs" that never look at their hypothesis.
`t` should be a `def` (theorem values may be elaborated asynchronously). -/
elab "#qr_uses_hyp " t:ident : command => do
  let n ← liftCoreM (realizeGlobalConstNoOverload t)
  let env ← getEnv
  let some ci := env.find? n | throwError "QR_ERROR unknown constant {n}"
  let value? : Option Expr := ci.value? (allowOpaque := true)
  match value? with
  | none => logInfo m!"QR_USES_HYP name={n} uses=unknown reason=no_value"
  | some v =>
    match v with
    | .lam _ _ body _ => logInfo m!"QR_USES_HYP name={n} uses={body.hasLooseBVar 0}"
    | _ => logInfo m!"QR_USES_HYP name={n} uses=unknown reason=not_a_lambda"

end QEDRank.Audit
