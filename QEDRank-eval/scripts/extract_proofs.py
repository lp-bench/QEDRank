#!/usr/bin/env python3
"""Write the final submission of every attempt in Inspect logs as plain Lean files.

usage: scripts/extract_proofs.py LOG_DIR [more LOG_DIRs]
       -> LOG_DIR/proofs/<problem>[_epoch<n>]/Submission/...   (main file and helper files)
          LOG_DIR/proofs/<problem>[_epoch<n>]/snapshot/...     (unsolved: every file the agent changed)
The grader keeps the final files in the score metadata (submission_text, submission_files),
whether or not they pass; the log viewer shows the main file but not the helper files.
A file VERDICT.txt next to them gives the verdict, polarity and errors.  For an unsolved
attempt, snapshot/ holds the snapshot of the sandbox kept for continuing it (sessions.py),
at its paths in the sandbox; it is unpacked with tarfile's "data" filter, which refuses
absolute paths, links out of the folder and special files.  run.sh calls this
at the end of every run.  proofs/ is neither listed in SHA256SUMS nor in the Zenodo zip:
it is derived from the .eval log, which is both.
"""

import base64
import io
import sys
import tarfile
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
            snap = (s.store or {}).get("snapshot") or {}
            if snap.get("tar_gz_base64"):
                with tarfile.open(fileobj=io.BytesIO(base64.b64decode(snap["tar_gz_base64"])), mode="r:gz") as tar:
                    tar.extractall(out / "snapshot", filter="data")
            (out / "VERDICT.txt").write_text(
                f"{s.id}: {sc.value} ({md.get('polarity', 'prove')})\n" + "".join(f"{e}\n" for e in md.get("errors", []))
                + (f"snapshot: {len(snap.get('files', []))} files kept, {len(snap.get('skipped', []))} skipped"
                   f"{', error: ' + snap['error'] if snap.get('error') else ''}\n" if snap else ""),
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
