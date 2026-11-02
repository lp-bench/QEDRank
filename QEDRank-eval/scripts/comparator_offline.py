#!/usr/bin/env python3
"""Re-run the Comparator for one archived attempt, outside the run (notes/grading_environment_2026-11-02.md).

usage: scripts/comparator_offline.py RUN_DIR PROBLEM [--sif IMAGE] [--target Pxxx|Pxxx_DISPROVE]

The submission files and the Comparator configuration are taken from the run's Inspect log
(the lean_check score metadata), so the offline run checks exactly the files that were graded.
The project build directory is seeded from the image as in a run.  The two things the sandbox
denied lake are provided: a writable copy of the Matroid build directory (which lake does not
change) and HOME under the project's .lake directory, so lake may write its artifact cache.
Writes RUN_DIR/regrade/PROBLEM[.target].json and the Comparator output next to it; exits 0 on
"Your solution is okay!", 1 on a rejection, 2 on an error of this script.
"""
import argparse, datetime, glob, hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

COMPARATOR, COMPARATOR_LIB = "/opt/verifier/bin/comparator", "/opt/verifier/lib"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir"); ap.add_argument("problem")
    ap.add_argument("--sif", default=None, help="image (default: proofbench-sandbox.sif next to the scripts)")
    ap.add_argument("--target", default=None, help="Pxxx or Pxxx_DISPROVE when both were graded (default: the one with a comparator record)")
    a = ap.parse_args()
    run = Path(a.run_dir); root = Path(__file__).resolve().parent.parent
    sif = Path(a.sif) if a.sif else root / "proofbench-sandbox.sif"
    apptainer = os.environ.get("APPTAINER") or shutil.which("apptainer") or shutil.which("singularity")
    if not apptainer: print("error: no apptainer/singularity on PATH", file=sys.stderr); return 2
    from inspect_ai.log import read_eval_log  # noqa: E402  (the harness venv)
    logs = glob.glob(str(run / "*.eval"))
    if len(logs) != 1: print(f"error: expected one .eval in {run}, found {logs}", file=sys.stderr); return 2
    log = read_eval_log(logs[0])
    sample = next((s for s in log.samples or [] if str(s.id) == a.problem), None)
    if sample is None: print(f"error: {a.problem} not in {logs[0]}", file=sys.stderr); return 2
    score = (sample.scores or {}).get("lean_check")
    md = (score.metadata or {}) if score else {}
    comp = md.get("comparator") or {}
    if not comp.get("config"): print("error: no comparator record for this attempt (layer 1 did not pass)", file=sys.stderr); return 2
    config = comp["config"]
    stem = config["solution_module"].split(".")[-1]  # Pxxx or Pxxx_DISPROVE
    files = {f"Submission/{stem}.lean": md.get("submission_text", "")}
    files.update(md.get("submission_files") or {})
    files = {p[len("/opt/proofbench/"):] if p.startswith("/opt/proofbench/") else p: t for p, t in files.items()}
    manifest = json.loads((run / "manifest.json").read_text()) if (run / "manifest.json").exists() else {}
    image_id = manifest.get("image", "?")
    work = Path(tempfile.mkdtemp(prefix="comparator_offline."))
    try:
        for d in ("build", "matroid", "home", "sub"): (work / d).mkdir()
        X = [apptainer, "exec", "--containall", "--cleanenv"]
        subprocess.run(X + ["--bind", f"{work}/build:/mnt/b", "--bind", f"{work}/matroid:/mnt/m", str(sif), "sh", "-c",
                        "cp -a /opt/proofbench/.lake/build/. /mnt/b/ && cp -a /opt/proofbench/.lake/packages/Matroid/.lake/build/. /mnt/m/"],
                       check=True)
        for rel, text in files.items():
            p = work / "sub" / Path(rel).relative_to("Submission"); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
        (work / "sub" / f"_comparator_{stem}.json").write_text(json.dumps(config))
        cmd = X + ["--bind", f"{work}/build:/opt/proofbench/.lake/build", "--bind", f"{work}/sub:/opt/proofbench/Submission",
                   "--bind", f"{work}/matroid:/opt/proofbench/.lake/packages/Matroid/.lake/build",
                   "--bind", f"{work}/home:/opt/proofbench/.lake/home", str(sif), "sh", "-c",
                   f"cd /opt/proofbench && HOME=/opt/proofbench/.lake/home LD_LIBRARY_PATH={COMPARATOR_LIB} "
                   f"lake env {COMPARATOR} Submission/_comparator_{stem}.json"]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
        out = r.stdout + r.stderr
        ok = r.returncode == 0 and "Your solution is okay!" in out
        rec = {
            "problem": a.problem, "target": stem, "run": run.name, "image": image_id,
            "in_run_verdict": score.value if score else None, "in_run_comparator_ok": comp.get("ok"),
            "in_run_explanation": (score.explanation or "")[:300] if score else "",
            "offline_comparator_ok": ok, "offline_returncode": r.returncode,
            "files_sha256": {p: hashlib.sha256(t.encode()).hexdigest() for p, t in files.items()},
            "config": config, "when_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "method": "same Comparator and image; writable copy of the Matroid build dir (unchanged by lake) and HOME under .lake "
                      "so that lake can write its artifact cache; see notes/grading_environment_2026-11-02.md",
        }
        out_dir = run / "regrade"; out_dir.mkdir(exist_ok=True)
        (out_dir / f"{stem}.json").write_text(json.dumps(rec, indent=1) + "\n")
        (out_dir / f"{stem}.comparator.log").write_text(out)
        print(f"{a.problem} ({stem}): in-run {rec['in_run_verdict']}, offline comparator {'ACCEPTS' if ok else 'REJECTS'} (exit {r.returncode}) -> {out_dir}/{stem}.json")
        return 0 if ok else 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
