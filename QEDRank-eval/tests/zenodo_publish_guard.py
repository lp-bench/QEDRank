#!/usr/bin/env python3
"""The Zenodo uploader with concurrent runs (harness v1.2): a draft of another run is waited
for, a leftover draft of the same run is reused, and uploads on one machine take a lock.
Runs against a fake Zenodo API, no network.   python3 tests/zenodo_publish_guard.py"""
import json
import multiprocessing
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import zenodo_publish as zp  # noqa: E402

API = "https://zenodo.test/api"


class FakeZenodo:
    """Just enough of the deposition API: one published version, one draft slot."""

    def __init__(self, draft_files=(), draft_version=None, foreign_polls=0):
        self.published = {"id": 1, "metadata": {"access_right": "restricted", "version": "run-A", "title": "t"},
                          "files": [{"filename": "run-A.zip", "id": "f1"}, {"filename": "run-A.SHA256SUMS", "id": "f2"}]}
        self.draft = {"id": 2, "metadata": dict(self.published["metadata"]),
                      "files": [{"filename": n, "id": f"d{i}"} for i, n in enumerate(draft_files)],
                      "links": {"bucket": f"{API}/bucket/2"}}
        if draft_version:
            self.draft["metadata"]["version"] = draft_version
        self.foreign_polls = foreign_polls  # polls until the other run's draft is gone
        self.log = []

    def __call__(self, method, url, token, body=None, raw=None, timeout=60):
        self.log.append((method, url.replace(API, "")))
        if method == "GET" and "depositions?" in url:
            return [self.published]
        if method == "GET" and url.endswith("/depositions/1"):
            return self.published
        if method == "POST" and url.endswith("/actions/newversion"):
            return {"links": {"latest_draft": f"{API}/deposit/depositions/2"}}
        if method == "GET" and url.endswith("/depositions/2"):
            if self.foreign_polls > 0:
                self.foreign_polls -= 1
                return self.draft
            # the other run has published: a fresh draft for us
            return {"id": 3, "metadata": dict(self.published["metadata"]), "files": [], "links": {"bucket": f"{API}/bucket/3"}}
        if method == "DELETE":
            return {}
        if method == "PUT" and "/bucket/" in url:
            return {}
        if method == "PUT" and "/depositions/" in url:
            return {}
        if method == "POST" and url.endswith("/actions/publish"):
            return {"doi": "10.5281/zenodo.99", "record_id": 99, "links": {"html": "https://zenodo.test/records/99"}}
        raise AssertionError(f"unexpected call {method} {url}")


def run_dir(tmp: Path, run_id: str) -> Path:
    d = tmp / "logs" / run_id
    d.mkdir(parents=True)
    (d / "SHA256SUMS").write_text("abc  results.csv\n")
    (d / "results.csv").write_text("run,problem\n")
    return d


def test_foreign_draft_is_waited_for():
    with tempfile.TemporaryDirectory() as t:
        d = run_dir(Path(t), "run-C")
        fake = FakeZenodo(draft_files=["run-B.zip"], draft_version="run-A", foreign_polls=2)
        zp.call = fake
        zp.time.sleep = lambda s: None
        receipt = zp.publish(d, "run-C", "tok", "1", API)
        deletes = [u for m, u in fake.log if m == "DELETE"]
        assert not deletes, f"touched the other run's draft: {deletes}"
        assert fake.log.count(("POST", "/deposit/depositions/1/actions/newversion")) == 3
        assert receipt["record_id"] == 99 and receipt["files"] == ["run-C.SHA256SUMS", "run-C.zip"]
    print("ok: a draft of another run is left alone and waited for")


def test_own_leftover_draft_is_reused():
    with tempfile.TemporaryDirectory() as t:
        d = run_dir(Path(t), "run-C")
        fake = FakeZenodo(draft_files=["run-C.zip"], draft_version="run-C", foreign_polls=10**6)
        zp.call = fake
        receipt = zp.publish(d, "run-C", "tok", "1", API)
        deletes = [u for m, u in fake.log if m == "DELETE"]
        assert deletes == ["/deposit/depositions/2/files/d0"], deletes
        assert fake.log.count(("POST", "/deposit/depositions/1/actions/newversion")) == 1
        assert receipt["record_id"] == 99
    print("ok: a leftover draft of the same run is reused")


def test_wait_gives_up():
    with tempfile.TemporaryDirectory() as t:
        d = run_dir(Path(t), "run-C")
        fake = FakeZenodo(draft_files=["run-B.zip"], foreign_polls=10**6)
        zp.call = fake
        zp.time.sleep = lambda s: None
        os.environ["ZENODO_WAIT"] = "0"
        try:
            zp.publish(d, "run-C", "tok", "1", API)
            raise AssertionError("should have given up")
        except RuntimeError as e:
            assert "another run" in str(e), e
        finally:
            del os.environ["ZENODO_WAIT"]
    print("ok: gives up after ZENODO_WAIT")


def _hold_lock(log_dir: str, seconds: float, q):
    with zp._upload_lock(Path(log_dir)):
        q.put(("acquired", time.monotonic()))
        time.sleep(seconds)
        q.put(("released", time.monotonic()))


def test_lock_serializes_uploads():
    with tempfile.TemporaryDirectory() as t:
        d1, d2 = run_dir(Path(t), "run-1"), run_dir(Path(t), "run-2")
        q = multiprocessing.Queue()
        p1 = multiprocessing.Process(target=_hold_lock, args=(str(d1), 1.0, q)); p1.start()
        time.sleep(0.3)
        p2 = multiprocessing.Process(target=_hold_lock, args=(str(d2), 0.1, q)); p2.start()
        p1.join(); p2.join()
        events = sorted([q.get() for _ in range(4)], key=lambda e: e[1])
        assert [e[0] for e in events] == ["acquired", "released", "acquired", "released"], events
        assert (d1.parent / ".zenodo.lock").exists()
    print("ok: uploads on one machine are serialized by the lock")


if __name__ == "__main__":
    zp.time.sleep = lambda s: None
    test_foreign_draft_is_waited_for()
    test_own_leftover_draft_is_reused()
    test_wait_gives_up()
    zp.time.sleep = time.sleep
    test_lock_serializes_uploads()
    print("all passed")
