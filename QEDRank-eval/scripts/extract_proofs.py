#!/usr/bin/env python3
"""Write the final submission of every attempt in Inspect logs as plain Lean files.

usage: scripts/extract_proofs.py LOG_DIR [more LOG_DIRs]
       -> LOG_DIR/proofs/<problem>[_epoch<n>]/Submission/...   (main file and helper files)
The grader keeps the final files in the score metadata (submission_text, submission_files),
whether or not they pass; the log viewer shows the main file but not the helper files.
A file VERDICT.txt next to them gives the verdict, polarity and errors.  proofs/ is not
listed in SHA256SUMS: it is derived from the .eval log, which is.
"""

import sys
from pathlib import Path

from inspect_ai.log import list_eval_logs, read_eval_log


def extract(log_dir: Path) -> int:
    n = 0
    for info in list_eval_logs(str(log_dir)):
        log = read_eval_log(info)
        epochs = (log.eval.config.epochs or 1) > 1
        for s in log.samples or []:
            sc = (s.scores or {}).get("lean_check")
            md = sc.metadata if sc and sc.metadata else {}
            if not md.get("submission_text"):
                continue
            out = log_dir / "proofs" / (f"{s.id}_epoch{s.epoch}" if epochs else str(s.id))
            project = s.metadata["project_dir"]
            files = {s.metadata["submission"]: md["submission_text"], **md.get("submission_files", {})}
            for path, text in files.items():
                dest = out / path[len(project) + 1 :]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(text, encoding="utf-8")
            (out / "VERDICT.txt").write_text(
                f"{s.id}: {sc.value} ({md.get('polarity', 'prove')})\n" + "".join(f"{e}\n" for e in md.get("errors", [])),
                encoding="utf-8",
            )
            print(f"{s.id} {sc.value}: {len(files)} file(s) -> {out}")
            n += 1
    return n


def main() -> None:
    dirs = [Path(d) for d in sys.argv[1:]]
    if not dirs:
        sys.exit(__doc__)
    if not sum(extract(d) for d in dirs):
        print("no submissions found in", ", ".join(map(str, dirs)))


if __name__ == "__main__":
    main()
