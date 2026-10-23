#!/usr/bin/env python3
"""Archive a finished run as a new version of the project's Zenodo record.

usage: scripts/zenodo_publish.py LOG_DIR RUN_ID   (run.sh calls it when a run ends;
       run it by hand to retry)

Settings, from the environment or from .env:
  ZENODO_TOKEN    personal access token with the scopes deposit:write and deposit:actions
  ZENODO_CONCEPT  concept record ID (the number in the record's "Cite all versions" DOI)
  ZENODO_API      default https://zenodo.org/api; https://sandbox.zenodo.org/api for tests

The new version adds `<RUN_ID>.SHA256SUMS` and `<RUN_ID>.zip` (the run folder) to the
files of the previous version. The record's files must be restricted (they stay so until
publication), the record must have room for two more files (Zenodo allows 100), and the
run must not be archived yet; a step that fails leaves no draft behind. Without
ZENODO_TOKEN nothing is done. The run itself is never failed. On success the receipt
(DOI, link, files) is written to LOG_DIR/ZENODO.json.
"""
import hashlib
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_FILES = 100  # Zenodo's limit per record
KEEP = ("upload_type", "publication_type", "image_type", "title", "creators", "description",
        "access_right", "access_conditions", "license", "embargo_date", "keywords", "notes",
        "communities", "related_identifiers", "contributors")


def setting(name: str, default: str = "") -> str:
    if os.environ.get(name):
        return os.environ[name]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == name:
                return value.strip().strip("\"'")
    return default


def call(method: str, url: str, token: str, body=None, raw: bytes | None = None, timeout: int = 60):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    elif raw is not None:
        req.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url.split('?')[0]}: HTTP {e.code} {e.read()[:300]!r}") from None
    return json.loads(text) if text else {}


def zip_run(log_dir: Path, run_id: str, out: Path) -> None:
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for f in sorted(log_dir.iterdir()):
            if f.is_file() and f.name != "ZENODO.json":
                z.write(f, f"{run_id}/{f.name}")


def publish(log_dir: Path, run_id: str, token: str, concept: str, api: str) -> dict:
    names = [f"{run_id}.SHA256SUMS", f"{run_id}.zip"]
    query = urllib.parse.urlencode({"q": f"conceptrecid:{concept}", "all_versions": "true",
                                    "status": "published", "sort": "mostrecent", "size": 1})
    found = call("GET", f"{api}/deposit/depositions?{query}", token)
    if not found:
        raise RuntimeError(f"this token owns no published record with concept record ID {concept}")
    latest = call("GET", f"{api}/deposit/depositions/{found[0]['id']}", token)
    published = {f["filename"] for f in latest.get("files") or []}
    # Every check before anything is created on Zenodo.
    if latest["metadata"].get("access_right") != "restricted":
        raise RuntimeError("the record's files must be restricted; set the record to restricted access first")
    if published & set(names):
        raise RuntimeError(f"{run_id} is already archived in the record")
    if len(published) + len(names) > MAX_FILES:
        raise RuntimeError(f"the record would exceed Zenodo's {MAX_FILES} files; start a new record")
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / f"{run_id}.zip"
        zip_run(log_dir, run_id, archive)
        data = {names[0]: (log_dir / "SHA256SUMS").read_bytes(), names[1]: archive.read_bytes()}

    # One unpublished new-version draft at most: a leftover draft is returned and reused.
    draft_url = call("POST", f"{api}/deposit/depositions/{latest['id']}/actions/newversion", token)["links"]["latest_draft"]
    draft = call("GET", draft_url, token)
    try:
        for f in draft.get("files") or []:  # leftovers of an earlier attempt
            if f["filename"] not in published:
                call("DELETE", f"{api}/deposit/depositions/{draft['id']}/files/{f['id']}", token)
        for name, content in data.items():
            call("PUT", f"{draft['links']['bucket']}/{name}", token, raw=content, timeout=1800)
        now = datetime.now(timezone.utc)
        metadata = {k: v for k, v in draft["metadata"].items() if k in KEEP}
        metadata.update(version=run_id, publication_date=now.date().isoformat())
        call("PUT", f"{api}/deposit/depositions/{draft['id']}", token, body={"metadata": metadata})
        done = call("POST", f"{api}/deposit/depositions/{draft['id']}/actions/publish", token)
    except Exception as e:
        try:
            call("DELETE", f"{api}/deposit/depositions/{draft['id']}", token)
            cleanup = "the draft was removed"
        except Exception as e2:
            cleanup = f"removing the draft failed too ({e2}); a retry cleans it up"
        raise RuntimeError(f"{e}; {cleanup}") from None
    return {
        "run_id": run_id,
        "doi": done.get("doi", ""),
        "url": done.get("record_url") or done.get("links", {}).get("html", ""),
        "record_id": done.get("record_id") or done.get("id"),
        "concept_record": concept,
        "files": names,
        "logs_uploaded": True,
        "zip_sha256": hashlib.sha256(data[names[1]]).hexdigest(),
        "zip_bytes": len(data[names[1]]),
        "requested_utc": now.isoformat(timespec="seconds"),
    }


def main() -> None:
    log_dir, run_id = Path(sys.argv[1]), sys.argv[2]
    token, concept = setting("ZENODO_TOKEN"), setting("ZENODO_CONCEPT")
    api = setting("ZENODO_API", "https://zenodo.org/api").rstrip("/")
    if not token or not concept:
        print("== Zenodo: skipped (ZENODO_TOKEN or ZENODO_CONCEPT not set)")
        return
    if (log_dir / "ZENODO.json").exists():
        print(f"== Zenodo: {run_id} is already archived (see {log_dir}/ZENODO.json)")
        return
    try:
        receipt = publish(log_dir, run_id, token, concept, api)
    except Exception as e:
        print(f"== Zenodo: not archived: {e}", file=sys.stderr)
        print(f"   To retry: scripts/zenodo_publish.py {log_dir} {run_id}", file=sys.stderr)
        return
    (log_dir / "ZENODO.json").write_text(json.dumps(receipt, indent=1) + "\n")
    print(f"== Zenodo: archived {', '.join(receipt['files'])} as DOI {receipt['doi']}, {receipt['url']}")


if __name__ == "__main__":
    main()
