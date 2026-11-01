#!/usr/bin/env python3
"""The paper's tables from results.csv: LaTeX, generated instead of typed.

usage: scripts/paper_tables.py [--out DIR] LOG_DIR|results.csv [...]
  Each input is a run folder (results.csv and manifest.json) or a results.csv.  Runs of one
  configuration (model, web search on or off), e.g. the parts of a run, are pooled; when a
  problem was attempted more than once in a configuration, the latest attempt with a verdict
  counts (an earlier one is superseded).  Attempts without a verdict (status N) are listed as
  "no answer" and left out of the rates.  --out defaults to paper-tables/ next to the first input.

Writes to DIR:
  summary.tex          one row per configuration: solved/attempted by category, cost
  attempts-<slug>.tex  one table per configuration, one row per problem (problems down the
                       page, quantities across with headers rotated by 90 degrees, so a whole
                       run fits a few pages): the quantities of the paper's "Measured
                       Quantities" section, plus searches for runs with web search
  preview.tex          a standalone document that inputs them all (pdflatex preview.tex)
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
CATEGORY_NAME = {"calibration": "Calibration", "research": "Research", "open": "Open"}
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
        for r in csv.DictReader(open(csv_path)):
            r["_run"] = folder.name
            rows.append(r)
    return rows, manifests


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
    return {"C": r"\checkmark", "I": r"$\times$"}.get(r["status"], "--")


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
           r"Model & Web search & Calibration & Research & Open & Total & No answer & Cost (USD) \\", r"\hline"]
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
    out += [r"\hline", r"\end{tabular}",
            r"\caption{Problems solved (solved/graded), one attempt per problem with up to four sessions. "
            r"No answer: attempts ended by the provider or the node, which are run again. Cost at the providers' list prices.}",
            r"\label{tab:summary}", r"\end{table}"]
    return "\n".join(out) + "\n"


def main() -> None:
    args = sys.argv[1:]
    out_dir = None
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
    preview = [r"\documentclass[11pt]{article}", r"\usepackage[a4paper,margin=2cm]{geometry}", r"\usepackage{graphicx,longtable,float,amssymb}",
               r"\begin{document}", r"\input{summary}"] + [r"\input{" + f[:-4] + "}" for f in files] + [r"\end{document}"]
    (out_dir / "preview.tex").write_text("\n".join(preview) + "\n")
    print(f"summary.tex and preview.tex -> {out_dir}")


if __name__ == "__main__":
    main()
