#!/usr/bin/env python3
"""The paper's tables from results.csv: LaTeX, generated instead of typed.

usage: scripts/paper_tables.py [--out DIR] LOG_DIR|results.csv [...]
  Each input is a run folder (results.csv and manifest.json) or a results.csv.  Runs of one
  configuration (model, web search on or off), e.g. the parts of a run, are pooled; when a
  problem was attempted more than once in a configuration, the latest attempt with a verdict
  counts (an earlier one is superseded).  Attempts without a verdict (status N) are listed as
  "no answer" and left out of the rates.  --out defaults to paper-tables/ next to the first input.

Writes to DIR:
  configuration.tex    a paragraph with the run configuration from the manifests (harness
                       commit, sandbox image, Lean and Mathlib, problem-set commit, budgets,
                       reasoning effort per model), and the differences between runs if any
  summary.tex          one row per configuration: solved/attempted by category, cost
  attempts-<slug>.tex  one table per configuration, one row per problem (problems down the
                       page, quantities across with headers rotated by 90 degrees, so a whole
                       run fits a few pages): the quantities of the paper's "Measured
                       Quantities" section, plus searches for runs with web search
  preview.tex          with --preview: a standalone document that inputs them all
The tables need \\usepackage{graphicx,longtable} in the paper.  Categories come from the
statements database (proofbench/ProofBench/DATABASE/Database.json)."""
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATEGORY_ORDER = ["calibration", "research", "open"]
CATEGORY_NAME = {"calibration": "Calibration", "research": "Literature", "open": "Open"}
MODEL_NAME = {
    "claude-opus-5-5": "Claude Opus 5.5", "claude-fable-5-1": "Claude Fable 5.1",
    "claude-sonnet-5-5": "Claude Sonnet 5.5", "glm-5.3-flash": "GLM-5.3-Flash",
}


def category(difficulty: str) -> str:
    return "open" if difficulty == "Open" else "research" if difficulty.startswith("Research") else "calibration"


def categories() -> dict[str, str]:
    db = json.load(open(ROOT / "proofbench/ProofBench/DATABASE/Database.json"))
    return {"P" + e["id"]: category(e["difficulty"]) for e in db}


def model_name(model: str) -> str:
    short = model.split("/")[-1]
    return MODEL_NAME.get(short, short)


def slug(model: str, search: bool) -> str:
    return re.sub(r"[^a-z0-9]+", "-", model.split("/")[-1].lower()).strip("-") + ("-search" if search else "-nosearch")


def load(inputs: list[Path]) -> tuple[list[dict], dict[str, dict]]:
    """Rows of every results.csv with the run's manifest attached; manifests by run."""
    rows, manifests = [], {}
    for p in inputs:
        folder = p if p.is_dir() else p.parent
        csv_path = folder / "results.csv" if p.is_dir() else p
        manifest = json.load(open(folder / "manifest.json")) if (folder / "manifest.json").exists() else {}
        manifests[folder.name] = manifest
        new = []
        for r in csv.DictReader(open(csv_path)):
            r["_run"] = folder.name
            new.append(r)
        apply_regrades(folder, new)
        rows += new
    return rows, manifests


def apply_regrades(folder: Path, rows: list[dict]) -> None:
    """Offline Comparator re-runs (scripts/comparator_offline.py, folder/regrade/*.json): an attempt
    whose in-run Comparator failed for an infrastructure reason counts as solved when the offline
    run of the same Comparator accepts it.  The in-run verdict is kept in status_in_run and the
    row marked (regraded), so tables can flag it.  See notes/grading_environment_2026-11-02.md."""
    reg_dir = folder / "regrade"
    if not reg_dir.is_dir():
        return
    records = {}
    for f in sorted(reg_dir.glob("*.json")):
        rec = json.load(open(f))
        records[(rec["problem"], rec["target"].endswith("_DISPROVE"))] = rec
    for r in rows:
        rec = records.get((r["problem"], r.get("polarity") == "disprove"))
        if rec and r["status"] == "I" and rec.get("offline_comparator_ok"):
            r["status_in_run"], r["status"], r["correct"] = r["status"], "C", "1"
            r["regraded"] = "offline comparator accepts"


def pool(rows: list[dict]) -> dict[tuple[str, bool], dict[str, dict]]:
    """Per configuration, the attempt that counts for each problem: the latest with a verdict,
    else the latest without one (status N, listed as no answer)."""
    by: dict[tuple[str, bool], dict[str, dict]] = defaultdict(dict)
    for r in sorted(rows, key=lambda r: r["_run"]):  # run ids start with the UTC timestamp
        key = (r["model"], r["search"] == "true")
        current = by[key].get(r["problem"])
        if current is None or r["status"] in ("C", "I") or current["status"] not in ("C", "I"):
            by[key][r["problem"]] = r
    return by


def num(x: str, scale: float = 1.0, digits: int = 0) -> str:
    if x in ("", None):
        return "--"
    v = float(x) / scale
    s = f"{v:,.{digits}f}"
    return s.replace(",", "{,}")


def pct(part: str, whole: str) -> str:
    try:
        return f"{100 * float(part) / float(whole):.0f}" if float(whole) else "--"
    except ValueError:
        return "--"


def verdict(r: dict) -> str:
    s = {"C": r"\checkmark", "I": r"$\times$"}.get(r["status"], "--")
    return s + r"$^{\dagger}$" if r.get("regraded") else s


REGRADE_NOTE = (r" $\dagger$: the in-run Comparator failed for an infrastructure reason (lake's artifact cache in the "
                r"read-only sandbox, see the grading note in Methods); the verdict is from the offline re-run of the same "
                r"Comparator and image on the archived files, the in-run verdict was $\times$. ")


def rot(text: str) -> str:
    return r"\rotatebox[origin=l]{90}{" + text + "}"


def configuration_note(manifest: dict) -> str:
    if not manifest:
        return ""
    parts = []
    if manifest.get("harness_commit"):
        parts.append(r"harness commit \texttt{" + manifest["harness_commit"][:7] + "}")
    if manifest.get("image") or manifest.get("image_id"):
        parts.append(r"sandbox image \texttt{" + (manifest.get("image") or manifest.get("image_id")) + "}")
    if manifest.get("lean_toolchain"):
        parts.append("Lean~" + manifest["lean_toolchain"].split(":v")[-1])
    if manifest.get("mathlib_commit"):
        parts.append(r"Mathlib commit \texttt{" + manifest["mathlib_commit"][:7] + "}")
    if manifest.get("statements_commit"):
        parts.append(r"ProofBench commit \texttt{" + manifest["statements_commit"][:7] + "}")
    if manifest.get("effort"):
        parts.append("reasoning effort: " + manifest["effort"])
    parts.append("web search: " + ("on" if str(manifest.get("search")).lower() == "true" else "off"))
    budgets = ""
    if manifest.get("session_output_tokens"):
        budgets = (f" The run used a budget of {int(manifest['session_output_tokens']):,} output tokens per session, "
                   f"at most {int(manifest.get('max_tokens', 0)):,} output tokens per reply and up to "
                   f"{manifest.get('sessions', '?')} sessions per problem.").replace(",", "{,}")
    return "Run configuration, as recorded in the run's manifest: " + ", ".join(parts) + "." + budgets


def attempts_table(model: str, search: bool, attempts: dict[str, dict], cats: dict[str, str], manifest: dict) -> str:
    cols = [  # header, cell
        ("Verdict", verdict),
        ("Sessions used", lambda r: num(r["sessions_used"])),
        ("Input tokens (M)", lambda r: num(r["tokens_in"], 1e6, 2)),
        (r"of which cached (\%)", lambda r: pct(r["tokens_cached"], r["tokens_in"])),
        ("Output tokens (k)", lambda r: num(r["tokens_out"], 1e3)),
        ("Cost (USD)", lambda r: num(r["cost_usd"], 1, 2)),
        ("Total time (min)", lambda r: num(r["total_time_s"], 60, 1)),
        ("Working time (min)", lambda r: num(r["working_time_s"], 60, 1)),
        ("Tool calls", lambda r: num(r["tool_calls"])),
        ("Model calls", lambda r: num(r["model_calls"])),
        ("Largest prompt (k tokens)", lambda r: num(r["max_context"], 1e3)),
        ("Proof length (lines)", lambda r: num(r["lines"]) if r["status"] == "C" else "--"),
        ("Compile time (s)", lambda r: num(r["compile_s"]) if r["status"] == "C" else "--"),
    ]
    if search:
        cols += [("Web searches", lambda r: num(r.get("searches", ""))),
                 ("Pages fetched", lambda r: num(r.get("urls", ""))),
                 ("Code addresses fetched", lambda r: num(r.get("code_urls", "")))]
    rows = sorted(attempts.values(), key=lambda r: (CATEGORY_ORDER.index(cats.get(r["problem"], "research")), r["problem"]))
    solved = sum(r["status"] == "C" for r in rows)
    graded = sum(r["status"] in ("C", "I") for r in rows)
    noanswer = len(rows) - graded
    out = [r"% generated by scripts/paper_tables.py; needs \usepackage{graphicx,longtable}",
           r"\begin{small}", r"\setlength{\tabcolsep}{3pt}",
           r"\begin{longtable}{l" + "r" * len(cols) + "}",
           r"\caption{Measured quantities of " + model_name(model) + (" with" if search else " without") +
           f" web search, one attempt per problem: {solved} of {graded} graded problems solved" +
           (f", {noanswer} without a verdict (ended by the provider or the node; to be run again)" if noanswer else "") +
           r". -- marks a quantity that does not apply. Cost at the provider's list prices. Proof length counts every line of the submitted files, the statement file included. " +
           (REGRADE_NOTE if any(r.get("regraded") for r in rows) else "") +
           configuration_note(manifest) + r"}\label{tab:attempts-" + slug(model, search) + r"} \\",
           r"\hline", "Problem & " + " & ".join(rot(h) for h, _ in cols) + r" \\", r"\hline", r"\endfirsthead",
           r"\multicolumn{" + str(len(cols) + 1) + r"}{l}{\small\textit{continued}} \\", r"\hline",
           "Problem & " + " & ".join(rot(h) for h, _ in cols) + r" \\", r"\hline", r"\endhead",
           r"\hline", r"\endfoot"]
    last = None
    for r in rows:
        cat = cats.get(r["problem"], "research")
        if cat != last:
            n = [x for x in rows if cats.get(x["problem"], "research") == cat]
            out.append(r"\multicolumn{" + str(len(cols) + 1) + r"}{l}{\textit{" + CATEGORY_NAME[cat] +
                       f" ({sum(x['status'] == 'C' for x in n)}/{sum(x['status'] in ('C', 'I') for x in n)} solved)" + r"}} \\")
            last = cat
        out.append(r["problem"] + " & " + " & ".join(cell(r) for _, cell in cols) + r" \\")
    # totals: sums where they mean something
    sums = {
        "Input tokens (M)": num(sum(float(r["tokens_in"] or 0) for r in rows), 1e6, 2),
        "Output tokens (k)": num(sum(float(r["tokens_out"] or 0) for r in rows), 1e3),
        "Cost (USD)": num(sum(float(r["cost_usd"] or 0) for r in rows), 1, 2) if all(r["cost_usd"] for r in rows) else "--",
        "Total time (min)": num(sum(float(r["total_time_s"] or 0) for r in rows), 60),
        "Working time (min)": num(sum(float(r["working_time_s"] or 0) for r in rows), 60),
        "Tool calls": num(sum(float(r["tool_calls"] or 0) for r in rows)),
        "Model calls": num(sum(float(r["model_calls"] or 0) for r in rows)),
        "Web searches": num(sum(float(r.get("searches") or 0) for r in rows)),
        "Verdict": f"{solved}/{graded}",
        "Sessions used": num(sum(float(r["sessions_used"] or 0) for r in rows)),
    }
    out.append(r"\hline")
    out.append("Total & " + " & ".join(sums.get(h, "") for h, _ in cols) + r" \\")
    out += [r"\end{longtable}", r"\end{small}"]
    return "\n".join(out) + "\n"


def summary_table(by: dict[tuple[str, bool], dict[str, dict]], cats: dict[str, str]) -> str:
    out = [r"% generated by scripts/paper_tables.py", r"\begin{table}[H]", r"\centering", r"\small",
           r"\begin{tabular}{llrrrrrr}", r"\hline",
           r"Model & Web search & Calibration & Literature & Open & Total & No answer & Cost (USD) \\", r"\hline"]
    for (model, search), attempts in sorted(by.items(), key=lambda kv: (model_name(kv[0][0]), kv[0][1])):
        rows = list(attempts.values())
        cells = []
        for cat in CATEGORY_ORDER:
            n = [r for r in rows if cats.get(r["problem"], "research") == cat]
            graded = [r for r in n if r["status"] in ("C", "I")]
            cells.append(f"{sum(r['status'] == 'C' for r in graded)}/{len(graded)}" if graded else "--")
        graded = [r for r in rows if r["status"] in ("C", "I")]
        total = f"{sum(r['status'] == 'C' for r in graded)}/{len(graded)}"
        noanswer = len(rows) - len(graded)
        cost = num(sum(float(r["cost_usd"] or 0) for r in rows), 1, 2) if all(r["cost_usd"] for r in rows) else "--"
        out.append(f"{model_name(model)} & {'yes' if search else 'no'} & " + " & ".join(cells) +
                   f" & {total} & {noanswer or '--'} & {cost} " + r"\\")
    regraded = sum(1 for a in by.values() for r in a.values() if r.get("regraded"))
    out += [r"\hline", r"\end{tabular}",
            r"\caption{Problems solved (solved/graded), one attempt per problem with up to four sessions. "
            r"No answer: attempts ended by the provider or the node, which are run again. Cost at the providers' list prices."
            + (f" {regraded} verdict{'s' if regraded != 1 else ''} from the offline Comparator re-run ($\\dagger$ in the attempts tables)." if regraded else "")
            + "}",
            r"\label{tab:summary}", r"\end{table}"]
    return "\n".join(out) + "\n"


def configuration_paragraph(manifests: dict[str, dict], by: dict[tuple[str, bool], dict[str, dict]]) -> str:
    """The configuration the runs share, and what differs between runs, from their manifests."""
    runs = {name: m for name, m in manifests.items() if m}
    if not runs:
        return "% no manifests found\n"
    shared = [("harness commit", lambda m: r"\texttt{" + m.get("harness_commit", "")[:7] + "}"),
              ("evaluation code hash", lambda m: r"\texttt{" + m.get("evaluation_code_sha256", "")[:12] + "}" if m.get("evaluation_code_sha256") else ""),
              ("sandbox image", lambda m: r"\texttt{" + (m.get("image") or m.get("image_id") or "") + "}"),
              ("Lean", lambda m: m.get("lean_toolchain", "").split(":v")[-1]),
              ("Mathlib commit", lambda m: r"\texttt{" + m.get("mathlib_commit", "")[:7] + "}"),
              ("ProofBench commit", lambda m: r"\texttt{" + m.get("statements_commit", "")[:7] + "}"),
              ("sessions per problem", lambda m: str(m.get("sessions", ""))),
              ("output tokens per session", lambda m: f"{int(m['session_output_tokens']):,}".replace(",", "{,}") if m.get("session_output_tokens") else ""),
              ("output tokens per reply", lambda m: f"{int(m['max_tokens']):,}".replace(",", "{,}") if m.get("max_tokens") else ""),
              ("time per attempt", lambda m: f"{int(m['time_limit']) // 3600} hours" if m.get("time_limit") else ""),
              ("time per tool call", lambda m: f"{int(m['tool_timeout']) // 60} minutes" if m.get("tool_timeout") else ""),
              # The per-session working-time cap was configured but never fired: Inspect 0.3.276 checks a
              # scoped working limit only when restoring a checkpoint (notes/session_limits_2026-11-03.md).
              ("working-time cap per session", lambda m: f"{int(m['session_working_time']) // 60} minutes, configured but not enforced by Inspect {m.get('inspect_version', '')} (see the grading note)" if m.get("session_working_time") else "")]
    common, differing = [], []
    for label, get in shared:
        values = {get(m) for m in runs.values()}
        values.discard("")
        if len(values) == 1:
            common.append(f"{label} {values.pop()}")
        elif values:
            differing.append(label + ": " + "; ".join(f"{get(m)} ({name.split('_')[0]})" for name, m in sorted(runs.items())))
    efforts = sorted({(model_name(m.get("model", "")), m.get("effort") or "provider default") for m in runs.values()})
    text = ("The runs share one configuration, recorded in each run's manifest: " + ", ".join(common) + ". "
            + "Reasoning effort: " + ", ".join(f"{model} {effort}" for model, effort in efforts) + ". "
            + "Each configuration (a model, with or without web search) attempted every problem once"
            + (", in parts run as separate jobs" if len(runs) > len(by) else "") + ".")
    if differing:
        text += " Settings that differ between runs: " + "; ".join(differing) + "."
    return "% generated by scripts/paper_tables.py from the manifests of " + ", ".join(sorted(runs)) + "\n" + text + "\n"


def main() -> None:
    args = sys.argv[1:]
    out_dir, preview = None, False
    if "--preview" in args:
        preview = True
        args.remove("--preview")
    if "--out" in args:
        i = args.index("--out")
        out_dir = Path(args[i + 1])
        del args[i:i + 2]
    inputs = [Path(a) for a in args]
    if not inputs:
        sys.exit(__doc__)
    out_dir = out_dir or (inputs[0] if inputs[0].is_dir() else inputs[0].parent).parent / "paper-tables"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows, manifests = load(inputs)
    cats = categories()
    by = pool(rows)
    files = []
    for (model, search), attempts in by.items():
        runs = sorted({r["_run"] for r in attempts.values()})
        manifest = manifests.get(runs[-1], {})
        name = f"attempts-{slug(model, search)}.tex"
        (out_dir / name).write_text(attempts_table(model, search, attempts, cats, manifest))
        files.append(name)
        superseded = len([r for r in rows if r["model"] == model and (r["search"] == "true") == search]) - len(attempts)
        print(f"{name}: {len(attempts)} problems from {len(runs)} run(s)" + (f", {superseded} superseded attempt(s) left out" if superseded else ""))
    (out_dir / "summary.tex").write_text(summary_table(by, cats))
    (out_dir / "configuration.tex").write_text(configuration_paragraph(manifests, by))
    written = "configuration.tex, summary.tex"
    if preview:
        doc = [r"\documentclass[11pt]{article}", r"\usepackage[a4paper,margin=2cm]{geometry}", r"\usepackage{graphicx,longtable,float,amssymb}",
               r"\begin{document}", r"\input{configuration}", r"\input{summary}"] + [r"\input{" + f[:-4] + "}" for f in files] + [r"\end{document}"]
        (out_dir / "preview.tex").write_text("\n".join(doc) + "\n")
        written += ", preview.tex"
    print(f"{written} -> {out_dir}")


if __name__ == "__main__":
    main()
