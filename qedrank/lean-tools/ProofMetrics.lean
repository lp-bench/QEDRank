import Lean

/-!
# QEDRank proof metrics

Elaborates one Lean file inside its own project and reports, as one JSON line:

* every command, with the tactics written in it (counted on the parsed syntax: every node of the
  `tactic` syntax category, except the grouping forms `·`, `( … )` and `{ … }`; a tactic's name is
  its first keyword, e.g. `simp`, `rw`, `<;>`);
* every declaration the file adds (theorems, definitions, instances, …) with its source range, the
  range of its value (`:= …`), its proof-term size and, for theorems, which hypotheses (binders
  whose type is a proposition) the proof term never uses;
* every message Lean printed, with the linter that produced it when the message names one;
* for each `--targets` name: whether bounded automation derives `False` from the statement's
  hypotheses, or proves the statement outright (each of `omega`, `simp_all`, `decide`,
  `contradiction` tried on its own, the portfolio of QED_LEAF's vacuity probe).

Usage (from the file's Lean project, so that its imports resolve):

    lean --run ProofMetrics.lean FILE [--targets a,b] [--opt key=value]... [--heartbeats N]

`--opt` takes the project's `[leanOptions]` (`weak.` options are set only when declared).
The file is elaborated as the module `QRProofMetrics`; nothing is written to disk.
-/

open Lean Elab Meta

namespace QRProofMetrics

structure Config where
  file : String := ""
  targets : Array String := #[]
  opts : Array String := #[]
  heartbeats : Nat := 200000
  termCap : Nat := 2000000

partial def parseArgs : List String → Config → Except String Config
  | [], c => if c.file.isEmpty then .error "usage: ProofMetrics FILE [--targets a,b] [--opt k=v]... [--heartbeats N]" else .ok c
  | "--targets" :: v :: rest, c => parseArgs rest { c with targets := ((v.splitOn ",").filter (· ≠ "")).toArray }
  | "--opt" :: v :: rest, c => parseArgs rest { c with opts := c.opts.push v }
  | "--heartbeats" :: v :: rest, c => parseArgs rest { c with heartbeats := v.toNat! }
  | "--term-cap" :: v :: rest, c => parseArgs rest { c with termCap := v.toNat! }
  | f :: rest, c => parseArgs rest { c with file := f }

/-- Apply `key=value` options; a `weak.` option, or any unknown one, is skipped when not declared. -/
def applyOptions (decls : OptionDecls) (opts : Options) (kvs : Array String) : Options × Array String := Id.run do
  let mut o := opts
  let mut skipped := #[]
  for kv in kvs do
    match kv.splitOn "=" with
    | [k, v] =>
      let key := if "weak.".isPrefixOf k then String.join ((k.toList.drop 5).map toString) else k
      let name := key.toName
      match decls.find? name with
      | some d =>
        match d.defValue with
        | .ofBool _ => o := o.insert name (.ofBool (v == "true"))
        | .ofNat _ => o := o.insert name (.ofNat v.toNat!)
        | _ => o := o.insert name (.ofString v)
      | none => skipped := skipped.push kv
    | _ => skipped := skipped.push kv
  return (o, skipped)

/-- The first keyword written in a tactic node (its own atoms only, not those of sub-tactics). -/
def tacticName (stx : Syntax) : String :=
  match stx.getArgs.findSome? (fun a => match a with | .atom _ v => some v | _ => none) with
  | some v => v
  | none => stx.getKind.toString

def groupingKinds : List Name := [``Lean.Parser.Tactic.paren, ``Lean.Parser.Tactic.nestedTactic, `Lean.cdot]
def groupingAtoms : List String := ["·", ".", "(", "{"]

/-- Tactic names written in `stx`, with multiplicity. -/
partial def collectTactics (tacKinds : Parser.SyntaxNodeKindSet) (stx : Syntax) (acc : Std.HashMap String Nat) :
    Std.HashMap String Nat :=
  match stx with
  | .node _ k args =>
    if k == choiceKind then
      -- an ambiguous parse holds every alternative: count the first one only
      if h : 0 < args.size then collectTactics tacKinds args[0] acc else acc
    else
      let acc :=
        if tacKinds.contains k && !groupingKinds.contains k then
          let n := tacticName stx
          if groupingAtoms.contains n then acc else acc.insert n (acc.getD n 0 + 1)
        else acc
      args.foldl (fun a c => collectTactics tacKinds c a) acc
  | _ => acc

/-- The names in the `declId`s of a command (`theorem foo`, `lemma Bar.baz`, a `mutual` block's
several), without a leading `_root_`. -/
partial def declIds (stx : Syntax) : Array String :=
  go stx #[]
where
  go (stx : Syntax) (acc : Array String) : Array String :=
    match stx with
    | .node _ k args =>
      if k == ``Lean.Parser.Command.declId then
        let id := args[0]!.getId
        let id := if id.getRoot == `_root_ then id.replacePrefix `_root_ .anonymous else id
        acc.push id.toString
      else args.foldl (fun a c => go c a) acc
    | _ => acc

/-- The first node of one of `kinds` in `stx` (pre-order). -/
partial def findKind (kinds : List Name) (stx : Syntax) : Option Syntax :=
  match stx with
  | .node _ k args =>
    if kinds.contains k then some stx else args.findSome? (findKind kinds)
  | _ => none

/-- Tree size of an expression, stopping at `cap`. -/
partial def termSize (cap : Nat) (e : Expr) : StateM Nat Unit := do
  if (← get) ≥ cap then return
  modify (· + 1)
  match e with
  | .app f a => termSize cap f; termSize cap a
  | .lam _ d b _ => termSize cap d; termSize cap b
  | .forallE _ d b _ => termSize cap d; termSize cap b
  | .letE _ t v b _ => termSize cap t; termSize cap v; termSize cap b
  | .mdata _ b => termSize cap b
  | .proj _ _ b => termSize cap b
  | _ => pure ()

def kindOf : ConstantInfo → String
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "def"
  | .axiomInfo _ => "axiom"
  | .opaqueInfo _ => "opaque"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "constructor"
  | .recInfo _ => "recursor"
  | .quotInfo _ => "quot"

/-- For each leading binder of the type whose type is a proposition: its name and whether the
value uses it (`none` when the value is not a `fun` over that binder). -/
def hypothesisUse (ci : ConstantInfo) : MetaM (Array Json) := do
  -- a theorem's value counts as opaque for `value?`
  let some v := ci.value? (allowOpaque := true) | return #[]
  forallTelescope ci.type fun xs _ => do
    let mut body := v
    let mut doms : Array Expr := #[]
    for _ in [0:xs.size] do
      match body with
      | .lam _ d b _ => doms := doms.push d; body := b
      | _ => break
    let m := doms.size
    let mut out := #[]
    for i in [0:xs.size] do
      let x := xs[i]!
      unless ← isProp (← inferType x) do continue
      let name := (← x.fvarId!.getUserName).toString
      if i < m then
        let inBody := body.hasLooseBVar (m - 1 - i)
        let inTypes := (List.range m).any fun j => j > i && doms[j]!.hasLooseBVar (j - 1 - i)
        out := out.push (Json.mkObj [("name", name), ("used", toJson (inBody || inTypes))])
      else
        out := out.push (Json.mkObj [("name", name), ("used", Json.null)])
    return out

/-- Whether `tac` closes `goal` completely (no `sorry`, no metavariables left). -/
def closes (goal : Expr) (tac : Syntax) (heartbeats : Nat) : MetaM Bool :=
  withoutModifyingState do
    withCurrHeartbeats do
      withTheReader Core.Context (fun c => { c with maxHeartbeats := heartbeats * 1000 }) do
        try
          let g ← mkFreshExprMVar goal
          let (remaining, _) ← Elab.runTactic g.mvarId! tac
          unless remaining.isEmpty do return false
          let pf ← instantiateMVars g
          return !pf.hasSorry && !pf.hasExprMVar
        catch _ => return false

def portfolio : List String := ["omega", "simp_all", "decide", "contradiction"]

/-- `name` itself, else the one declaration of this file whose name ends with it (a target given
without its namespace, e.g. `P039` for `FullyAdaptiveHamiltonian.P039`). -/
def resolveTarget (env : Environment) (name : Name) : Option (Name × ConstantInfo) :=
  match env.find? name with
  | some ci => some (name, ci)
  | none =>
    let suffix := "." ++ name.toString
    match env.constants.map₂.toList.filter (fun (n, _) => n.toString.endsWith suffix) with
    | [(n, ci)] => some (n, ci)
    | _ => none

def probe (target : Name) (heartbeats : Nat) : MetaM Json := do
  let env ← getEnv
  let some (name, ci) := resolveTarget env target
    | return Json.mkObj [("name", target.toString), ("found", false)]
  let tacs := portfolio.filterMap fun t => match Parser.runParserCategory env `tactic t with
    | .ok s => some (t, s)
    | .error _ => none
  forallTelescope ci.type fun xs body => do
    let mut props : Nat := 0
    for x in xs do
      if ← isProp (← inferType x) then props := props + 1
    let mut contradiction : Option String := none
    let mut closedBy : Option String := none
    let bodyIsProp ← isProp body
    for (t, s) in tacs do
      if contradiction.isNone && props != 0 then
        if ← closes (mkConst ``False) s heartbeats then contradiction := some t
      if closedBy.isNone && bodyIsProp then
        if ← closes body s heartbeats then closedBy := some t
    return Json.mkObj [("name", name.toString), ("found", true), ("binders", xs.size), ("prop_hypotheses", props),
      ("contradictory_by", toJson contradiction), ("closed_by", toJson closedBy),
      ("portfolio", toJson (tacs.map (·.1)))]

def linterOf (text : String) : Option String :=
  -- "note: this linter can be disabled with `set_option linter.foo false`"
  match text.splitOn "set_option linter." with
  | _ :: rest :: _ =>
    let name := rest.takeWhile (fun c => c.isAlphanum || c == '.' || c == '_')
    some ("linter." ++ name.toString)
  | _ => none

def posJson (p : Position) : Json := Json.arr #[toJson p.line, toJson p.column]

end QRProofMetrics

namespace QRProofMetrics

/-- One file of a job list. -/
structure Job where
  file : String
  targets : Option (Array String) := none
  deriving FromJson

/-- Elaborate `file` and return its report (one JSON object). -/
unsafe def analyzeFile (cfg : Config) (file : String) (targetNames : Array String) : IO String := do
  let t0 ← IO.monoMsNow
  let input ← IO.FS.readFile file
  let inputCtx := Parser.mkInputContext input file
  let (header, parserState, messages) ← Parser.parseHeader inputCtx
  -- Importing resets the initializer flag, so it is set again before every file.
  enableInitializersExecution
  let (env, messages) ← processHeader header {} messages inputCtx (mainModule := `QRProofMetrics)
  let headerErrors := messages.hasErrors
  -- Import problems are reported here only: the command loop collects its own messages.
  let headerMessages ← messages.reportedPlusUnreported.toList.mapM fun m => return (← m.data.toString).take 600 |>.toString
  let (opts, skipped) := applyOptions (← getOptionDecls) {} cfg.opts
  let opts := Elab.async.set opts false
  let t1 ← IO.monoMsNow
  let s ← IO.processCommands inputCtx parserState (Command.mkState env messages opts)
  let t2 ← IO.monoMsNow
  let env := s.commandState.env
  let fileMap := inputCtx.fileMap
  let tacKinds := ((Parser.parserExtension.getState env).categories.find? `tactic).map (·.kinds) |>.getD {}
  -- commands with their tactics
  let mut commands : Array Json := #[]
  let mut cmdRanges : Array (Nat × Nat × Nat) := #[]  -- (index, first line, last line)
  let mut cmdIds : Std.HashMap Nat (Array String) := {}  -- names the command's header declares
  for i in [0:s.commands.size] do
    let cmd := s.commands[i]!
    let some p0 := cmd.getPos? | continue
    let p1 := cmd.getTailPos?.getD p0
    cmdIds := cmdIds.insert i (declIds cmd)
    let tac := collectTactics tacKinds cmd {}
    let total := tac.fold (fun a _ n => a + n) 0
    let value := findKind [``Lean.Parser.Command.declValSimple, ``Lean.Parser.Command.declValEqns,
      ``Lean.Parser.Command.whereStructInst] cmd
    let (vs, ve) : Option Nat × Option Nat := match value with
      | some v => match v.getPos?, v.getTailPos? with
        | some a, some b => (some a.byteIdx, some b.byteIdx)
        | _, _ => (none, none)
      | none => (none, none)
    let l0 := (fileMap.toPosition p0).line
    let l1 := (fileMap.toPosition p1).line
    cmdRanges := cmdRanges.push (i, l0, l1)
    commands := commands.push <| Json.mkObj [("index", i), ("kind", cmd.getKind.toString),
      ("start_byte", p0.byteIdx), ("end_byte", p1.byteIdx), ("start_line", l0), ("end_line", l1),
      ("value_start_byte", toJson vs), ("value_end_byte", toJson ve),
      ("tactics", total), ("tactics_by_name", Json.mkObj (tac.toList.map fun (k, n) => (k, toJson n)))]
  -- declarations the file added, with their command
  let coreCtx : Core.Context := { fileName := file, fileMap, options := opts, maxHeartbeats := cfg.heartbeats * 1000 }
  let decls ← (do
      let mut out := #[]
      for (n, ci) in env.constants.map₂.toList do
        -- a private name is internal as stored (`_private.…`), not as written
        if ((privateToUserName? n).getD n).isInternal then continue
        let some r ← findDeclarationRanges? n | continue
        let line := r.range.pos.line
        let cmd := cmdRanges.find? (fun (_, a, b) => a ≤ line && line ≤ b) |>.map (·.1)
        let value? := ci.value? (allowOpaque := true)
        let size : Nat := match value? with
          | some v => ((termSize cfg.termCap v).run 0 |>.run).2
          | none => 0
        let hyps ← if ci matches .thmInfo _ then hypothesisUse ci else pure #[]
        let hasSorry := value?.map Expr.hasSorry |>.getD false
        -- Written: the command's header names it. Not written: what Lean generates from a
        -- declaration (a structure's propositional fields, `@[ext]` lemmas, instances of fields).
        let user := ((privateToUserName? n).getD n).toString
        let written := match cmd with
          | some c => (cmdIds.getD c #[]).any fun id => user == id || user.endsWith ("." ++ id)
          | none => false
        out := out.push <| Json.mkObj [("name", n.toString), ("kind", kindOf ci), ("command", toJson cmd), ("written", written),
          ("start", posJson r.range.pos), ("end", posJson r.range.endPos),
          ("term_size", toJson (if value?.isSome then some size else none)),
          ("term_size_capped", decide (size ≥ cfg.termCap)), ("has_sorry", hasSorry), ("hypotheses", Json.arr hyps)]
      return out : MetaM (Array Json)).run' {} |>.toIO' coreCtx { env }
  let targets ← (targetNames.mapM fun t => probe t.toName cfg.heartbeats : MetaM (Array Json)).run' {} |>.toIO' coreCtx { env }
  let mut msgs : Array Json := #[]
  for m in s.commandState.messages.reportedPlusUnreported.toList do
    let text ← m.data.toString
    let sev := match m.severity with | .error => "error" | .warning => "warning" | .information => "info"
    msgs := msgs.push <| Json.mkObj [("severity", sev), ("line", m.pos.line), ("column", m.pos.column),
      ("linter", toJson (linterOf text)), ("text", (text.take 400).toString)]
  let t3 ← IO.monoMsNow
  let out := Json.mkObj [("tool", "qedrank-proof-metrics"), ("version", 1), ("lean", Lean.versionString),
    ("file", file), ("header_errors", headerErrors), ("header_messages", toJson headerMessages),
    ("options_skipped", toJson skipped),
    ("commands", Json.arr commands), ("decls", Json.arr decls), ("targets", Json.arr targets),
    ("messages", Json.arr msgs),
    ("timing_ms", Json.mkObj [("imports", t1 - t0), ("elaboration", t2 - t1), ("analysis", t3 - t2)])]
  -- The imported modules stay mapped (`Environment.freeRegions` is unsafe while elaboration
  -- tasks may still hold them); the environment's own tables are freed with `env`.
  return out.compress

end QRProofMetrics

open QRProofMetrics in
/-- `FILE` alone, or `--jobs list.json` with `[{"file": …, "targets": […]}, …]`: one
`QR_METRICS=` line per file, in order (a file that fails gives `{"file": …, "error": …}`). -/
unsafe def main (args : List String) : IO UInt32 := do
  let (jobsFile?, rest) := match args with
    | "--jobs" :: f :: rest => (some f, rest)
    | _ => (none, args)
  let cfg ← match parseArgs rest { file := if jobsFile?.isSome then "-" else "" } with
    | .ok c => pure c
    | .error e => IO.eprintln e; return 2
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let jobs : Array Job ← match jobsFile? with
    | none => pure #[{ file := cfg.file, targets := some cfg.targets }]
    | some f => do
      let j ← IO.ofExcept (Json.parse (← IO.FS.readFile f))
      IO.ofExcept (fromJson? j : Except String (Array Job))
  for job in jobs do
    let line ← try analyzeFile cfg job.file (job.targets.getD #[])
      catch e => pure (Json.mkObj [("tool", "qedrank-proof-metrics"), ("version", 1), ("file", job.file), ("error", toString e)]).compress
    IO.println ("QR_METRICS=" ++ line)
    (← IO.getStdout).flush
  return 0
