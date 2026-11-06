# Concurrent runs and the Zenodo upload: harness v1.2 (2026-11-03)

A run archives itself when it ends (`scripts/run.sh` → `scripts/zenodo_publish.py`): a new
version of the official concept record with the run's zip and checksums, published at once.
Zenodo keeps one unpublished draft per concept, and the uploader of v1.0/v1.1 reused an
existing draft as a leftover of an earlier attempt of the same run, deleting its files. With
several runs in flight (up to six on 2026-11-03), two runs ending within the same minute would
therefore have shared one draft: the first could have published the second's files under its
own name, and a published version cannot be deleted. The window is the upload itself, under a
minute; no collision happened in runs 1–9.

v1.2 closes it in `scripts/zenodo_publish.py`, which is not evaluation code (the hash
9d6e862b64f7 of the agent loop, tools, checker and sandbox package is unchanged):

* a lock file next to the run folders (`logs/.zenodo.lock`, `flock`) serializes the uploads of
  runs on one machine;
* a draft that belongs to another run (files not of this run, or a version of another run) is
  left alone and waited for, up to `ZENODO_WAIT` seconds (default 3 hours), until it is
  published or deleted; a leftover draft of the same run is still reused.

Tests without network: `python3 tests/zenodo_publish_guard.py`. Runs 10–12 (Fable without
search) are the first from v1.2.

## Re-grade version (2026-11-06)

The offline re-grade records of the Fable/search parts 1 and 2 (36 records), the lake artifact
cache mounted in all later runs (`lakecache-matroid-v1.tar.zst`, sha256 ad7f6bde…) and the three
notes of this directory were published as one further version of concept 23857356:
version `20261104T174700Z_regrade-records_grading-environment`, record 24002743,
DOI 10.5281/zenodo.24002743 (receipt: `zenodo_regrade_receipt_2026-11-06.json`, package checksums:
`zenodo_regrade_package_SHA256SUMS`). The run versions are unchanged.
