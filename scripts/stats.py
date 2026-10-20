#!/usr/bin/env python3
"""Statistics over one or more runs: what the paper's results section needs.

usage: scripts/stats.py [--release YYYY-MM] [--out FILE] LOG_DIR|results.csv [...]
  LOG_DIR      Inspect logs (read as scripts/analyze.py does); results.csv: its output
  --release    when ProofBench became public: models whose training cutoff is
               later may have seen the problems themselves
  --out        JSON with every table (default: stats.json next to the first input)

Tables, one row per model unless stated:
  solve rates   solved / attempted with a 95% interval: percentile bootstrap
                over problems (all epochs of a problem stay together), also
                per category (open / research / calibration)
  pairs         every pair of models on their common problems: exact McNemar
                test (only problems one model solved and the other did not
                count) with Holm correction for the number of pairs, and the
                difference in solve rate with a paired bootstrap interval
  contamination solve rate on problems whose proof was public before the
                model's training cutoff vs. after (dates compared at the
                precision both have; equal = undecided), from data/problem_dates.csv
  generations   solve rate by release date, from data/model_facts.csv
  problems      per problem: who solved it, the earliest-released and the
                smallest open-weight model that did, and the fewest sessions
                and output tokens a solve took (an empirical difficulty)
Attempts without a score (infrastructure failures) are left out and counted.
A problem's outcome for McNemar is solved in at least half its epochs.
"""

import csv
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
B, SEED, ALPHA = 10_000, 1, 0.05


def read_rows(path: Path) -> list[dict]:
    if path.is_dir():
        from analyze import rows_for  # needs inspect_ai; not needed for a CSV
        return list(rows_for(path))
    with path.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def short(model: str) -> str:
    return model.split("/")[-1].lower()


def date(s: str) -> tuple[int, ...] | None:
    return tuple(int(x) for x in s.split("-")) if s and s.strip() else None


def compare(a: tuple, b: tuple) -> int:
    """-1, 0, 1 at the precision both dates have (2024 vs 2024-05 is 0: undecided)."""
    k = min(len(a), len(b))
    return (a[:k] > b[:k]) - (a[:k] < b[:k])


def ci(values: list[float], rng: random.Random) -> tuple[float, float] | None:
    """95% percentile bootstrap interval of the mean of per-problem values."""
    if not values:
        return None
    n = len(values)
    means = sorted(sum(rng.choices(values, k=n)) / n for _ in range(B))
    return means[int(B * ALPHA / 2)], means[int(B * (1 - ALPHA / 2)) - 1]


def mcnemar(b: int, c: int) -> float:
    """Exact two-sided McNemar p-value: binomial test of b against b + c at 1/2."""
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, k) for k in range(min(b, c) + 1)) / 2**n)


def holm(ps: list[float]) -> list[float]:
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    adj, running = [0.0] * len(ps), 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (len(ps) - rank) * ps[i]))
        adj[i] = running
    return adj


def pct(x: float | None) -> str:
    return "" if x is None else f"{100 * x:.1f}"


def main() -> None:
    args, release, out = sys.argv[1:], None, None
    while args and args[0].startswith("--"):
        flag, value, args = args[0], args[1], args[2:]
        release, out = (value, out) if flag == "--release" else (release, value)
    inputs = [Path(a) for a in args] or [ROOT / "logs"]
    rows = [r for p in inputs for r in read_rows(p)]
    facts_rows = read_csv(ROOT / "data" / "model_facts.csv")
    dates = {r["problem"]: r for r in read_csv(ROOT / "data" / "problem_dates.csv")}
    rng = random.Random(SEED)

    def facts(model: str) -> dict:
        m = short(model)
        hits = [f for f in facts_rows if m == f["model"] or m.startswith(f["model"] + "-")]
        return max(hits, key=lambda f: len(f["model"])) if hits else {}

    # per model and problem: outcomes of all epochs
    scored = [r for r in rows if str(r.get("correct", "")) != ""]
    by_mp: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for r in scored:
        by_mp[r["model"]][str(r["problem"])].append(r)
    models = sorted(by_mp)
    solved = lambda rs: sum(int(r["correct"]) for r in rs) / len(rs)
    cat = lambda p: dates.get(p, {}).get("category", "?")
    report: dict = {"inputs": [str(p) for p in inputs], "attempts": len(rows),
                    "unscored_attempts": len(rows) - len(scored), "bootstrap": {"B": B, "seed": SEED}}

    # 1. solve rates, overall and per category
    rates = []
    for m in models:
        ps = by_mp[m]
        vals = [solved(rs) for rs in ps.values()]
        row = {"model": m, "problems": len(ps), "attempts": sum(map(len, ps.values())),
               "solved": sum(int(r["correct"]) for rs in ps.values() for r in rs),
               "rate": sum(vals) / len(vals), "ci": ci(vals, rng),
               "by_category": {}}
        for c in sorted({cat(p) for p in ps}):
            v = [solved(rs) for p, rs in ps.items() if cat(p) == c]
            row["by_category"][c] = {"problems": len(v), "rate": sum(v) / len(v), "ci": ci(v, rng)}
        rates.append(row)
    report["solve_rates"] = rates
    print(f"{len(scored)} scored attempts ({len(rows) - len(scored)} without a score) over {len(models)} models\n")
    print(f"{'model':40} {'problems':>8} {'solved':>6} {'rate %':>7} {'95% CI':>13}")
    for r in rates:
        lo, hi = r["ci"]
        print(f"{r['model']:40} {r['problems']:>8} {r['solved']:>6} {pct(r['rate']):>7} "
              f"{pct(lo):>6}-{pct(hi):<6}")
        for c, v in r["by_category"].items():
            print(f"  {c:38} {v['problems']:>8} {'':>6} {pct(v['rate']):>7} {pct(v['ci'][0]):>6}-{pct(v['ci'][1]):<6}")

    # 2. pairs: exact McNemar with Holm correction, paired bootstrap of the difference
    pairs = []
    for i, a in enumerate(models):
        for b_ in models[i + 1:]:
            common = sorted(set(by_mp[a]) & set(by_mp[b_]))
            if not common:
                continue
            sa = {p: solved(by_mp[a][p]) for p in common}
            sb = {p: solved(by_mp[b_][p]) for p in common}
            only_a = sum(sa[p] >= 0.5 > sb[p] for p in common)
            only_b = sum(sb[p] >= 0.5 > sa[p] for p in common)
            d = [sa[p] - sb[p] for p in common]
            pairs.append({"a": a, "b": b_, "common": len(common), "only_a": only_a, "only_b": only_b,
                          "diff": sum(d) / len(d), "ci": ci(d, rng), "p": mcnemar(only_a, only_b)})
    for p, adj in zip(pairs, holm([p["p"] for p in pairs])):
        p["p_holm"], p["differ"] = adj, adj < ALPHA
    report["pairs"] = pairs
    if pairs:
        print(f"\n{'model A':32} {'model B':32} {'common':>6} {'A only':>6} {'B only':>6} {'A-B pp':>7} "
              f"{'95% CI':>13} {'p':>7} {'p Holm':>7}")
        for p in pairs:
            print(f"{p['a'][:32]:32} {p['b'][:32]:32} {p['common']:>6} {p['only_a']:>6} {p['only_b']:>6} "
                  f"{pct(p['diff']):>7} {pct(p['ci'][0]):>6}-{pct(p['ci'][1]):<6} {p['p']:>7.3f} {p['p_holm']:>7.3f}"
                  + ("  differ" if p["differ"] else ""))
        n = sum(p["differ"] for p in pairs)
        print(f"{n} of {len(pairs)} pairs differ after Holm correction; the others are ties at this sample size")

    # 3. contamination split and 4. generations
    contamination, gens = [], []
    for m in models:
        f = facts(m)
        cut = date(f.get("training_cutoff", ""))
        r = next(x for x in rates if x["model"] == m)
        gens.append({"model": m, "name": f.get("name", ""), "release_date": f.get("release_date", ""),
                     "open_weights": f.get("open_weights", ""), "rate": r["rate"], "ci": r["ci"],
                     "cutoff_after_release": None if not (cut and release) else compare(cut, date(release)) > 0})
        if not cut:
            contamination.append({"model": m, "note": "no training cutoff in data/model_facts.csv"})
            continue
        groups: dict[str, list[float]] = {"before": [], "after": [], "undecided": []}
        unchecked = 0
        for p, rs in by_mp[m].items():
            d = dates.get(p, {})
            pub = date(d.get("proof_public", ""))
            if d.get("status") not in ("checked", "unchecked") or not pub:
                continue
            unchecked += d["status"] == "unchecked"
            side = {-1: "before", 1: "after", 0: "undecided"}[compare(pub, cut)]
            groups[side].append(solved(rs))
        contamination.append({"model": m, "training_cutoff": f["training_cutoff"], "unchecked_dates": unchecked,
                              **{k: {"problems": len(v), "rate": sum(v) / len(v) if v else None, "ci": ci(v, rng)}
                                 for k, v in groups.items()}})
    report["contamination"], report["generations"] = contamination, sorted(gens, key=lambda g: g["release_date"] or "9")
    print(f"\ncontamination (proof public before vs. after the model's training cutoff)")
    print(f"{'model':40} {'cutoff':>8} {'before: n':>9} {'rate %':>7} {'after: n':>9} {'rate %':>7} {'undecided':>9}")
    for c in contamination:
        if "note" in c:
            print(f"{c['model']:40} {c['note']}"); continue
        print(f"{c['model']:40} {c['training_cutoff']:>8} {c['before']['problems']:>9} {pct(c['before']['rate']):>7} "
              f"{c['after']['problems']:>9} {pct(c['after']['rate']):>7} {c['undecided']['problems']:>9}"
              + (f"  ({c['unchecked_dates']} dates unchecked)" if c["unchecked_dates"] else ""))
    print(f"\ngenerations (by release date){' and training cutoff vs. ProofBench release ' + release if release else ''}")
    for g in report["generations"]:
        flag = {True: "  cutoff after release", False: "", None: ""}[g["cutoff_after_release"]]
        print(f"{g['release_date'] or '?':>10} {g['model']:40} open={g['open_weights'] or '?':3} "
              f"{pct(g['rate']):>6}% ({pct(g['ci'][0])}-{pct(g['ci'][1])}){flag}")

    # 5. per problem: empirical difficulty
    problems = []
    for p in sorted({p for m in models for p in by_mp[m]}):
        tried = [m for m in models if p in by_mp[m]]
        wins = [(m, r) for m in tried for r in by_mp[m][p] if int(r["correct"])]
        winners = sorted({m for m, _ in wins})
        rel = [(facts(m).get("release_date") or "9", m) for m in winners]
        size = [(float(facts(m)["total_params_b"]), m) for m in winners
                if facts(m).get("open_weights") == "yes" and facts(m).get("total_params_b")]
        num = lambda r, k: int(float(r[k])) if str(r.get(k, "")) not in ("", "None") else None
        sess = [x for _, r in wins if (x := num(r, "sessions_used")) is not None]
        toks = [x for _, r in wins if (x := num(r, "tokens_out")) is not None]
        problems.append({"problem": p, "category": cat(p), "models_tried": len(tried), "models_solved": len(winners),
                         "solved_by": winners, "earliest_solver": min(rel)[1] if rel else None,
                         "smallest_open_solver": min(size)[1] if size else None,
                         "min_sessions": min(sess) if sess else None, "min_output_tokens": min(toks) if toks else None})
    report["problems"] = problems
    print(f"\n{'problem':8} {'category':12} {'solved/tried':>12} {'earliest solver':32} {'smallest open solver':28} "
          f"{'min sess':>8} {'min out tok':>11}")
    for q in problems:
        if q["models_solved"]:
            print(f"{q['problem']:8} {q['category']:12} {q['models_solved']:>5}/{q['models_tried']:<6} "
                  f"{(q['earliest_solver'] or '')[:32]:32} {(q['smallest_open_solver'] or '')[:28]:28} "
                  f"{q['min_sessions'] or '':>8} {q['min_output_tokens'] or '':>11}")
    print(f"({sum(not q['models_solved'] for q in problems)} problems solved by no model not listed)")

    dest = Path(out) if out else (inputs[0] if inputs[0].is_dir() else inputs[0].parent) / "stats.json"
    dest.write_text(json.dumps(report, indent=1, default=str))
    print(f"\nall tables -> {dest}")


if __name__ == "__main__":
    main()
