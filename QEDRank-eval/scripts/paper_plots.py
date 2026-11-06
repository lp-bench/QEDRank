#!/usr/bin/env python3
"""The paper's figures from results.csv (PDF, matplotlib): the attempts of a configuration as
points, marked by verdict (filled: solved, hollow: unsolved) and category (colour and shape).

usage: scripts/paper_plots.py [--out DIR] [--x METRIC --y METRIC] [--labels] LOG_DIR|results.csv [...]
  Inputs and pooling as in paper_tables.py (parts of a run pooled, the latest graded attempt of a
  problem counts).  Without --x/--y, the default set is drawn for every configuration:
    cost-vs-reference-length   cost against the length of the known (reference) proof, for the
                               problems that have one (data/reference_lengths.csv)
    cost-vs-proof-length       cost against the length of the submitted proof (solved problems)
    output-vs-working-time     output tokens against working time, all attempts
    cost-by-category           cost per attempt by category, with the median
  --x/--y draw one ad-hoc figure instead; metrics: cost, output, input, working_time, total_time,
  sessions, tool_calls, model_calls, largest_prompt, proof_length, ref_length, searches.
  --labels writes the problem id next to every point (for our own reading; not for the paper).
  --merge-search also draws cost-by-category per model with the attempts of both search settings
  pooled (two per problem), as cost-by-category-<model>.pdf.
  --out defaults to paper-figures/ next to the first input.  Axes switch to a log scale when
  the values span more than two orders of magnitude."""
import csv
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paper_tables import CATEGORY_NAME, CATEGORY_ORDER, categories, load, model_name, pool, slug  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# Colours: the first three categorical slots of the reference palette (validated for all pairs on a
# light surface); identity is also carried by the marker shape, so colour is never the only cue.
STYLE = {"calibration": ("#2a78d6", "o"), "research": ("#eb6834", "s"), "open": ("#1baf7a", "^")}
TEXT, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"
METRICS = {  # name: (column, axis label, divisor)
    "cost": ("cost_usd", "Cost (USD)", 1),
    "output": ("tokens_out", "Output tokens (thousands)", 1e3),
    "input": ("tokens_in", "Input tokens (millions)", 1e6),
    "working_time": ("working_time_s", "Working time (minutes)", 60),
    "total_time": ("total_time_s", "Total time (minutes)", 60),
    "sessions": ("sessions_used", "Sessions used", 1),
    "tool_calls": ("tool_calls", "Tool calls", 1),
    "model_calls": ("model_calls", "Model calls", 1),
    "largest_prompt": ("max_context", "Largest prompt (thousand tokens)", 1e3),
    "proof_length": ("lines", "Length of the submitted proof (lines)", 1),
    "ref_length": ("ref_lines", "Length of the reference proof (lines)", 1),
    "searches": ("searches", "Web searches", 1),
}


def reference_lengths() -> dict[str, int]:
    path = ROOT / "data" / "reference_lengths.csv"
    return {r["problem"]: int(r["ref_lines"]) for r in csv.DictReader(open(path))} if path.exists() else {}


def value(r: dict, metric: str) -> float | None:
    col, _, div = METRICS[metric]
    if metric == "proof_length" and r["status"] != "C":
        return None  # an unsolved attempt has no proof
    x = r.get(col)
    if x in ("", None):
        return None
    try:
        return float(x) / div
    except ValueError:
        return None


def style_axes(ax) -> None:
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.xaxis.label.set_color(TEXT)
    ax.yaxis.label.set_color(TEXT)


def maybe_log(ax, which: str, values: list[float]) -> None:
    positive = [v for v in values if v and v > 0]
    if len(positive) >= 3 and max(positive) / min(positive) > 100:
        getattr(ax, f"set_{which}scale")("log")


def legend(ax, cats_present: list[str]) -> None:
    handles = [Line2D([], [], marker=STYLE[c][1], color=STYLE[c][0], linestyle="", markersize=7, label=CATEGORY_NAME[c])
               for c in CATEGORY_ORDER if c in cats_present]
    handles += [Line2D([], [], marker="o", color=MUTED, linestyle="", markersize=7, label="solved"),
                Line2D([], [], marker="o", markerfacecolor="white", color=MUTED, linestyle="", markersize=7, label="unsolved")]
    ax.legend(handles=handles, fontsize=8, frameon=False, labelcolor=TEXT, loc="best")


def scatter(rows: list[dict], cats: dict[str, str], x: str, y: str, title: str, path: Path, labels: bool) -> int:
    pts = [(r, value(r, x), value(r, y)) for r in rows]
    pts = [(r, a, b) for r, a, b in pts if a is not None and b is not None]
    if not pts:
        return 0
    fig, ax = plt.subplots(figsize=(5.2, 3.6), dpi=150)
    present = []
    for cat in CATEGORY_ORDER:
        sel = [(r, a, b) for r, a, b in pts if cats.get(r["problem"], "research") == cat]
        if not sel:
            continue
        present.append(cat)
        colour, marker = STYLE[cat]
        for solved in (True, False):
            part = [(a, b) for r, a, b in sel if (r["status"] == "C") == solved]
            if part:
                ax.scatter([a for a, _ in part], [b for _, b in part], marker=marker, s=36, linewidths=1.4,
                           facecolors=colour if solved else "white", edgecolors=colour, zorder=3)
    if labels:
        for r, a, b in pts:
            ax.annotate(r["problem"], (a, b), textcoords="offset points", xytext=(4, 3), fontsize=6, color=MUTED)
    maybe_log(ax, "x", [a for _, a, _ in pts])
    maybe_log(ax, "y", [b for _, _, b in pts])
    ax.set_xlabel(METRICS[x][1], fontsize=9)
    ax.set_ylabel(METRICS[y][1], fontsize=9)
    ax.set_title(title, fontsize=9, color=TEXT, loc="left")
    style_axes(ax)
    legend(ax, present)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return len(pts)


def by_category(rows: list[dict], cats: dict[str, str], title: str, path: Path) -> int:
    import random

    rng = random.Random(0)
    fig, ax = plt.subplots(figsize=(5.2, 3.6), dpi=150)
    n = 0
    for i, cat in enumerate(CATEGORY_ORDER):
        sel = [r for r in rows if cats.get(r["problem"], "research") == cat and value(r, "cost") is not None]
        if not sel:
            continue
        colour, marker = STYLE[cat]
        for solved in (True, False):
            part = [value(r, "cost") for r in sel if (r["status"] == "C") == solved]
            xs = [i + rng.uniform(-0.18, 0.18) for _ in part]
            ax.scatter(xs, part, marker=marker, s=36, linewidths=1.4, facecolors=colour if solved else "white", edgecolors=colour, zorder=3)
        costs = sorted(value(r, "cost") for r in sel)
        median = costs[len(costs) // 2] if len(costs) % 2 else (costs[len(costs) // 2 - 1] + costs[len(costs) // 2]) / 2
        ax.hlines(median, i - 0.3, i + 0.3, colors=TEXT, linewidths=1.2, zorder=4)
        ax.annotate(f"median {median:.2f}", (i + 0.32, median), fontsize=7, color=MUTED, va="center")
        n += len(sel)
    ax.set_xticks(range(len(CATEGORY_ORDER)), [CATEGORY_NAME[c] for c in CATEGORY_ORDER])
    ax.set_ylabel(METRICS["cost"][1], fontsize=9)
    maybe_log(ax, "y", [value(r, "cost") or 0 for r in rows])
    ax.set_title(title, fontsize=9, color=TEXT, loc="left")
    style_axes(ax)
    ax.grid(True, axis="y", color=GRID, linewidth=0.6)
    ax.grid(False, axis="x")
    legend(ax, [c for c in CATEGORY_ORDER if any(cats.get(r["problem"], "research") == c for r in rows)])
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return n


def main() -> None:
    args = sys.argv[1:]
    out_dir, x, y, labels, merge = None, None, None, False, False
    if "--labels" in args:
        labels = True
        args.remove("--labels")
    if "--merge-search" in args:
        merge = True
        args.remove("--merge-search")
    for flag in ("--out", "--x", "--y"):
        if flag in args:
            i = args.index(flag)
            val = args[i + 1]
            del args[i:i + 2]
            if flag == "--out":
                out_dir = Path(val)
            elif flag == "--x":
                x = val
            else:
                y = val
    inputs = [Path(a) for a in args]
    if not inputs or bool(x) != bool(y):
        sys.exit(__doc__)
    out_dir = out_dir or (inputs[0] if inputs[0].is_dir() else inputs[0].parent).parent / "paper-figures"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows, _ = load(inputs)
    cats = categories()
    refs = reference_lengths()
    for (model, search), attempts in pool(rows).items():
        data = list(attempts.values())
        for r in data:
            r["ref_lines"] = refs.get(r["problem"], "")
        name = model_name(model) + (" with web search" if search else " without web search")
        s = slug(model, search)
        if x:
            n = scatter(data, cats, x, y, name, out_dir / f"{x}-vs-{y}-{s}.pdf", labels)
            print(f"{x}-vs-{y}-{s}.pdf: {n} points")
            continue
        for fx, fy, stem in (("ref_length", "cost", "cost-vs-reference-length"), ("proof_length", "cost", "cost-vs-proof-length"),
                             ("working_time", "output", "output-vs-working-time")):
            n = scatter(data, cats, fx, fy, name, out_dir / f"{stem}-{s}.pdf", labels)
            print(f"{stem}-{s}.pdf: {n} points")
        n = by_category(data, cats, name, out_dir / f"cost-by-category-{s}.pdf")
        print(f"cost-by-category-{s}.pdf: {n} attempts")
    if merge and not x:
        by_model: dict[str, list[dict]] = {}
        for (model, _search), attempts in pool(rows).items():
            by_model.setdefault(model, []).extend(attempts.values())
        for model, data in by_model.items():
            s = slug(model, False).removesuffix("-nosearch")
            n = by_category(data, cats, model_name(model) + ", with and without web search", out_dir / f"cost-by-category-{s}.pdf")
            print(f"cost-by-category-{s}.pdf: {n} attempts")
    print(f"figures -> {out_dir}")


if __name__ == "__main__":
    main()
