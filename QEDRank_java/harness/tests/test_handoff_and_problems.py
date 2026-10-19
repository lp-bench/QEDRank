from __future__ import annotations

import json
from pathlib import Path

from proofbench_harness.grader import QEDRankGrader
from proofbench_harness.handoff import HANDOFF_TEMPLATE, MAX_ITEM_CHARS, MAX_ITEMS_PER_SECTION, parse_handoff, render_handoff
from proofbench_harness.problems import load_problems, status_from_difficulty, target_of, theorem_names
from proofbench_harness.prompts import session_prompt, system_prompt


def test_template_parses_as_empty_and_well_formed() -> None:
    note = parse_handoff(HANDOFF_TEMPLATE)
    assert note.is_empty and note.well_formed and note.sections_found == ["proved", "open_goals", "failed"]


def test_note_is_reduced_to_the_three_sections() -> None:
    text = """Some preamble the model wrote.
# Handoff
## Proved lemmas
- weight_eq: weight n = 2 * n
  (by unfolding and omega)
* second_lemma: something
## Notes to self
- this section is not part of the format
## Open goals
1. the main theorem
## Failed approaches
- simp loops
"""
    note = parse_handoff(text)
    assert note.proved == ["weight_eq: weight n = 2 * n (by unfolding and omega)", "second_lemma: something"]
    assert note.open_goals == ["the main theorem"] and note.failed == ["simp loops"]
    assert note.dropped_chars > 0 and not note.well_formed
    rendered = render_handoff(note)
    assert "Notes to self" not in rendered and "preamble" not in rendered
    assert parse_handoff(rendered).proved == note.proved, "rendering is stable"
    assert parse_handoff(rendered).well_formed


def test_note_size_is_bounded() -> None:
    text = "## Proved lemmas\n" + "\n".join(f"- lemma {i}" for i in range(MAX_ITEMS_PER_SECTION + 5)) + f"\n## Open goals\n- {'x' * (MAX_ITEM_CHARS + 50)}\n## Failed approaches\n"
    note = parse_handoff(text)
    assert len(note.proved) == MAX_ITEMS_PER_SECTION and note.dropped_items == 5
    assert len(note.open_goals[0]) == MAX_ITEM_CHARS and note.truncated_items == 1


def test_missing_or_garbage_note_is_empty_not_an_error() -> None:
    assert parse_handoff(None).is_empty and parse_handoff("").is_empty
    assert parse_handoff("just some text").is_empty and parse_handoff("just some text").dropped_chars > 0


def test_theorem_names_ignore_comments() -> None:
    src = "/- theorem fake : True -/\n-- theorem alsoFake : True\ndef f := 1\nprivate theorem helper : True := trivial\n@[simp] lemma l2 : True := trivial\ntheorem P001 (G : Nat) : True := sorry\n"
    assert theorem_names(src) == ["helper", "l2", "P001"]
    assert target_of(src, "P001") == "P001" and target_of(src, "P777") == "P001"


def test_status_from_difficulty() -> None:
    assert status_from_difficulty("Open") == "open" and status_from_difficulty(" open ") == "open"
    assert status_from_difficulty("Research") == "established"
    assert status_from_difficulty("Calibration (elementary; full Lean reference proof)") == "established"
    assert status_from_difficulty(None) == "uncertain" and status_from_difficulty("") == "uncertain"


def _checkout(tmp_path: Path) -> Path:
    root = tmp_path / "ProofBench"
    for pid, body in {"P001": "theorem P001 : True := sorry\n", "P002": "theorem P002 : True := sorry\n", "P035": "theorem P037 : True := sorry\n"}.items():
        d = root / "ProofBench" / "PROBLEMS" / pid
        d.mkdir(parents=True)
        (d / f"{pid}.lean").write_text(body, encoding="utf-8")
        (d / f"{pid}_UB.lean").write_text("theorem SECRET_UPPER_BOUND : True := trivial\n", encoding="utf-8")
        (d / f"{pid}_sol.lean").write_text("theorem SECRET_SOLUTION : True := trivial\n", encoding="utf-8")
    db = root / "ProofBench" / "DATABASE"
    db.mkdir()
    (db / "Database.json").write_text(json.dumps([
        {"id": "001", "name": "First", "difficulty": "Open", "msc": "05C15", "formal_proof": ["SECRET_PROOF"], "informal_proof": "SECRET_INFORMAL", "formal_upper_bound": ["SECRET_UB"]},
        {"id": "002", "name": "Second", "difficulty": "Research", "msc": "05C38"},
        {"id": "035", "name": "Wrong entry for a renumbered folder", "difficulty": "Open"},
        {"id": "037", "name": "Renumbered", "difficulty": "Undergraduate"},
    ]), encoding="utf-8")
    return root


def test_problems_from_a_checkout_never_carry_proctor_material(tmp_path: Path) -> None:
    root = _checkout(tmp_path)
    problems = load_problems(root)
    assert [p.id for p in problems] == ["P001", "P002", "P035"]
    p1, p2, p35 = problems
    assert (p1.title, p1.difficulty, p1.mathematical_status, p1.target) == ("First", "Open", "open", "P001")
    assert (p2.difficulty, p2.mathematical_status) == ("Research", "established")
    # A renumbered folder takes its labels from the theorem it declares, not from its folder number.
    assert p35.target == "P037" and p35.title == "Renumbered" and p35.difficulty == "Undergraduate"
    assert p35.notes == ["folder P035 declares theorem P037"]
    blob = json.dumps([p.metadata() for p in problems])
    assert "SECRET" not in blob
    assert [p.id for p in load_problems(root, include_open=False)] == ["P002", "P035"]
    assert [p.id for p in load_problems(root / "ProofBench" / "PROBLEMS", ids=["P002"])] == ["P002"]


def test_problems_from_a_file(tmp_path: Path) -> None:
    (tmp_path / "c.lean").write_text("theorem main : True := sorry\n", encoding="utf-8")
    f = tmp_path / "problems.jsonl"
    f.write_text("\n".join(json.dumps(r) for r in [
        {"id": "A", "challenge": "theorem a : True := sorry\n", "difficulty": "Open", "publication_date": 2019},
        {"id": "B", "challenge_path": "c.lean", "mathematical_status": "established"},
    ]), encoding="utf-8")
    a, b = load_problems(f)
    assert (a.target, a.mathematical_status, a.publication_date) == ("a", "open", "2019")
    assert (b.target, b.mathematical_status) == ("main", "established")


def test_prompts_are_the_same_for_every_model_and_state_the_rules() -> None:
    sp = system_prompt(max_sessions=4, output_tokens=64000, handoff_path="P/HANDOFF.md", allowed_imports="Mathlib", max_heartbeats=400000, web_search=False)
    assert "at most 4 sessions" in sp and "64,000 tokens" in sp and "## Failed approaches" in sp and "Web search is enabled" not in sp
    assert "Web search is enabled" in system_prompt(max_sessions=1, output_tokens=None, handoff_path="h", allowed_imports="x", max_heartbeats=1, web_search=True)
    first = session_prompt(problem_id="P1", target="P1", session=1, max_sessions=4, work_path="w.lean", handoff_path="h.md", file_text="theorem P1 : True := sorry", compiler_output=None, verdict_line=None, handoff_text=None)
    assert "Session 1 of 4" in first and "no handoff note yet" in first
    later = session_prompt(problem_id="P1", target="P1", session=2, max_sessions=4, work_path="w.lean", handoff_path="h.md", file_text="x", compiler_output="", verdict_line="not_solved", handoff_text=None)
    assert "(no diagnostics)" in later and "left no usable handoff note" in later


def test_grader_commands(tmp_path: Path) -> None:
    local = QEDRankGrader(mode="local", lean_project=str(tmp_path), allow_extra_imports=True)
    cmd = local.command(tmp_path, "P001")
    assert cmd[0] == "node" and cmd[2] == "grade" and "--allow-extra-imports" in cmd and "--target" in cmd
    assert cmd[cmd.index("--library-prefix") + 1] == "ProofBench.Mathlib_Problems"
    docker = QEDRankGrader(mode="docker", image="proofbench-sandbox:test")
    cmd = docker.command(tmp_path, "P001")
    # The clean container: fresh, removed afterwards, no network, only the two files mounted.
    assert cmd[:5] == ["docker", "run", "--rm", "--network", "none"] and "proofbench-sandbox:test" in cmd
    assert "--allow-extra-imports" not in cmd and docker.describe()["network"] == "none"
