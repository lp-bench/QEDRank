"""Problems: one challenge file each, with the labels the analyses need.

Two sources are understood:

* a ProofBench checkout (or its ``ProofBench/PROBLEMS`` folder): every ``Pnnn/Pnnn.lean`` is a
  challenge; ``DATABASE/Database.json`` supplies the name, subject and difficulty label. The
  proctor files next to a challenge (``_UB``, ``_LB``, ``_sol``, ``_DISPROVE``) and the formal
  fields of the database are never read.
* a ``.jsonl`` / ``.json`` file with one object per problem: ``id``, ``challenge`` (Lean text) or
  ``challenge_path``, and optionally ``target``, ``title``, ``difficulty``,
  ``mathematical_status``, ``publication_date``, ``public_formal_proof``, ``subject``.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

_DECL = re.compile(r"^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|nonrec)\s+)*(?:theorem|lemma)\s+([^\s:({\[]+)", re.MULTILINE)
_BLOCK_COMMENT = re.compile(r"/-.*?-/", re.DOTALL)
_LINE_COMMENT = re.compile(r"--.*$", re.MULTILINE)
# Database fields that hold reference statements, bounds or proofs: never loaded into a sample.
_PROCTOR_FIELDS = re.compile(r"^(formal_|informal_proof|informal_upper|informal_lower|blueprint)")


@dataclass
class Problem:
    id: str
    challenge: str
    target: str
    title: str | None = None
    difficulty: str | None = None
    mathematical_status: str = "uncertain"
    publication_date: str | None = None
    public_formal_proof: bool | None = None
    subject: str | None = None
    source_path: str | None = None
    notes: list[str] | None = None

    def metadata(self) -> dict:
        d = asdict(self)
        d["problem_id"] = d.pop("id")
        return d


def theorem_names(lean_source: str) -> list[str]:
    """Names of the theorems and lemmas declared in a Lean file, in order."""
    text = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", lean_source))
    return _DECL.findall(text)


def target_of(lean_source: str, problem_id: str) -> str | None:
    """The main theorem: the one named after the problem, else the last theorem of the file."""
    names = theorem_names(lean_source)
    if problem_id in names:
        return problem_id
    return names[-1] if names else None


def status_from_difficulty(difficulty: str | None) -> str:
    """ProofBench labels a problem "Open" exactly when it is an open conjecture; every other
    label is a result proved in the literature. No label means the status is not known."""
    if not difficulty or not difficulty.strip():
        return "uncertain"
    return "open" if difficulty.strip().lower() == "open" else "established"


def _digits(name: str) -> str | None:
    m = re.search(r"(\d+)", name)
    return m.group(1).lstrip("0") or "0" if m else None


def _load_database(problems_dir: Path) -> dict[str, dict]:
    for base in (problems_dir.parent, problems_dir.parent.parent, problems_dir):
        db = base / "DATABASE" / "Database.json"
        if db.is_file():
            try:
                entries = json.loads(db.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return {}
            out: dict[str, dict] = {}
            for e in entries if isinstance(entries, list) else []:
                key = _digits(str(e.get("id", "")))
                if key is not None:
                    out[key] = {k: v for k, v in e.items() if not _PROCTOR_FIELDS.match(k)}
            return out
    return {}


def _find_problems_dir(root: Path) -> Path:
    for cand in (root / "ProofBench" / "PROBLEMS", root / "PROBLEMS", root):
        if cand.is_dir() and any(p.is_dir() and (p / f"{p.name}.lean").is_file() for p in cand.iterdir()):
            return cand
    raise FileNotFoundError(f"No problem folders (Pnnn/Pnnn.lean) under {root}")


def _from_directory(root: Path) -> list[Problem]:
    problems_dir = _find_problems_dir(root)
    db = _load_database(problems_dir)
    out: list[Problem] = []
    for folder in sorted(p for p in problems_dir.iterdir() if p.is_dir()):
        challenge_file = folder / f"{folder.name}.lean"
        if not challenge_file.is_file():
            continue
        text = challenge_file.read_text(encoding="utf-8")
        target = target_of(text, folder.name)
        if not target:
            continue
        notes: list[str] = []
        # The database is joined on the theorem the file declares; a folder that was renumbered
        # after the database was written would otherwise pick up another problem's labels.
        key = _digits(target) if re.fullmatch(r"P\d+", target) else _digits(folder.name)
        if target != folder.name:
            notes.append(f"folder {folder.name} declares theorem {target}")
        entry = db.get(key or "", {})
        difficulty = entry.get("difficulty") if isinstance(entry.get("difficulty"), str) else None
        out.append(
            Problem(
                id=folder.name,
                challenge=text,
                target=target,
                title=entry.get("name") if isinstance(entry.get("name"), str) else None,
                difficulty=difficulty.strip() if difficulty else None,
                mathematical_status=status_from_difficulty(difficulty),
                publication_date=entry.get("publication_date") or None,
                public_formal_proof=entry.get("public_formal_proof") if isinstance(entry.get("public_formal_proof"), bool) else None,
                subject=entry.get("msc") if isinstance(entry.get("msc"), str) else None,
                source_path=str(challenge_file),
                notes=notes or None,
            )
        )
    return out


def _from_file(path: Path) -> list[Problem]:
    text = path.read_text(encoding="utf-8")
    rows = [json.loads(line) for line in text.splitlines() if line.strip()] if path.suffix == ".jsonl" else json.loads(text)
    if isinstance(rows, dict):
        rows = rows.get("problems", [])
    out: list[Problem] = []
    for row in rows:
        pid = str(row["id"])
        challenge = row.get("challenge")
        source = None
        if challenge is None:
            source_file = (path.parent / row["challenge_path"]).resolve()
            challenge = source_file.read_text(encoding="utf-8")
            source = str(source_file)
        target = row.get("target") or target_of(challenge, pid)
        if not target:
            raise ValueError(f"Problem {pid}: no theorem found in the challenge and no target given")
        difficulty = row.get("difficulty")
        out.append(
            Problem(
                id=pid,
                challenge=challenge,
                target=target,
                title=row.get("title"),
                difficulty=difficulty,
                mathematical_status=row.get("mathematical_status") or status_from_difficulty(difficulty),
                publication_date=str(row["publication_date"]) if row.get("publication_date") else None,
                public_formal_proof=row.get("public_formal_proof"),
                subject=row.get("subject"),
                source_path=source,
            )
        )
    return out


def load_problems(source: str | Path, ids: list[str] | None = None, limit: int | None = None, include_open: bool = True) -> list[Problem]:
    """Load problems from a ProofBench checkout or a problems file, in a stable order."""
    path = Path(source).expanduser().resolve()
    problems = _from_file(path) if path.is_file() else _from_directory(path)
    if ids:
        wanted = set(ids)
        problems = [p for p in problems if p.id in wanted]
        missing = wanted - {p.id for p in problems}
        if missing:
            raise ValueError(f"Problems not found in {path}: {', '.join(sorted(missing))}")
    if not include_open:
        problems = [p for p in problems if p.mathematical_status != "open"]
    return problems[:limit] if limit else problems
