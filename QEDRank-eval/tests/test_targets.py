"""Fake-sandbox test of the prove/disprove target logic in scorer.py and sessions.py: which
file is graded, which polarity is reported, when the session chain stops.  No container, no
model; layer 1 passes a file containing PROOF_OK, Comparator fails one containing CMP_FAIL.
usage: .venv/bin/python tests/test_targets.py"""
import asyncio, json, sys
from types import SimpleNamespace
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from inspect_ai.util import Store
from proofbench_eval import scorer, sessions

P = "/opt/proofbench"
class Result(SimpleNamespace):
    pass

class FakeSandbox:
    def __init__(self, files): self.files = dict(files); self.calls = []
    async def read_file(self, path):
        if path not in self.files: raise FileNotFoundError(path)
        return self.files[path]
    async def write_file(self, path, text): self.files[path] = text
    async def exec(self, cmd, input=None, timeout=None, user=None):
        if cmd[:2] == ["python3", "-"]:
            sub = cmd[3]; self.calls.append(("layer1", sub.split("/")[-1]))
            ok = "PROOF_OK" in self.files.get(sub, "")
            rep = {"ok": ok, "errors": [] if ok else ["contains sorry"], "files": [], "lines": 1,
                   "nonblank_lines": 1, "proof_lines": 1, "axioms": [], "compile_seconds": 0.1}
            return Result(stdout=json.dumps(rep) + "\n", stderr="", returncode=0, success=True)
        cfg = json.loads(self.files[cmd[-1]])
        stem = cfg["solution_module"].split(".")[-1]
        self.calls.append(("comparator", stem, cfg["challenge_module"], cfg["theorem_names"][0]))
        bad = "CMP_FAIL" in self.files.get(f"{P}/Submission/{stem}.lean", "")
        return Result(stdout="", stderr="mismatch" if bad else "", returncode=1 if bad else 0, success=not bad)

def md(open_problem):
    m = {"theorem": "P005", "submission": f"{P}/Submission/P005.lean", "project_dir": P,
         "reference": "theorem P005 : X := by\n  sorry\n", "sorries": 1, "comparator": True, "disprove": None}
    if open_problem:
        m["disprove"] = {"theorem": "P005_disprove", "submission": f"{P}/Submission/P005_DISPROVE.lean",
                         "reference": "theorem P005_disprove : ¬ X := by\n  sorry\n", "sorries": 1}
    return m

async def grade(m, files):
    sb = FakeSandbox(files)
    scorer.sandbox = lambda name=None: sb
    scorer._verifier = lambda: sb
    state = SimpleNamespace(metadata=m, store=Store(), output=None, sample_id="P005")
    score = await scorer.lean_check()(state, None)
    return score, sb

def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    global failures; failures += 0 if cond else 1
failures = 0

async def main():
    ref, dref = md(True)["reference"], md(True)["disprove"]["reference"]
    S, D = f"{P}/Submission/P005.lean", f"{P}/Submission/P005_DISPROVE.lean"
    # 1. prove-only problem, proof passes
    s, sb = await grade(md(False), {S: "PROOF_OK"})
    check("prove-only: correct, polarity prove, no 'other'", s.value == "C" and s.metadata["polarity"] == "prove" and "other" not in s.metadata)
    check("prove-only: comparator config unchanged", sb.calls[-1] == ("comparator", "P005", "ProofBench.PROBLEMS.P005.P005", "P005"))
    check("prove-only: explanation has no polarity prefix", s.explanation == "fast check and comparator passed")
    # 2. open problem, disproof passes
    s, sb = await grade(md(True), {S: ref, D: "PROOF_OK"})
    check("open, disproof: correct, polarity disprove", s.value == "C" and s.metadata["polarity"] == "disprove")
    check("open, disproof: comparator on the DISPROVE modules", ("comparator", "P005_DISPROVE", "ProofBench.PROBLEMS.P005.P005_DISPROVE", "P005_disprove") in sb.calls)
    check("open, disproof: other = untouched prove report", s.metadata["other"]["polarity"] == "prove" and s.metadata["other"]["ok"] is False)
    check("open, disproof: references written per target", f"{P}/Submission/_reference_P005.lean" in sb.files and f"{P}/Submission/_reference_P005_DISPROVE.lean" in sb.files)
    print("     explanation:", s.explanation)
    # 3. open problem, nothing passes, agent edited the disproof
    s, _ = await grade(md(True), {S: ref, D: dref + "-- attempt\n"})
    check("open, failed disproof attempt: incorrect, reported polarity disprove", s.value == "I" and s.metadata["polarity"] == "disprove")
    # 4. open problem, proof passes: the disproof is not graded
    s, sb = await grade(md(True), {S: "PROOF_OK", D: dref})
    check("open, proof: correct, polarity prove, other None", s.value == "C" and s.metadata["polarity"] == "prove" and s.metadata["other"] is None)
    check("open, proof: disprove target never graded", all(c[1] != "P005_DISPROVE.lean" for c in sb.calls))
    # 5. proof passes layer 1 but Comparator rejects; disproof passes
    s, _ = await grade(md(True), {S: "PROOF_OK CMP_FAIL", D: "PROOF_OK"})
    check("open, proof rejected by comparator, disproof passes: correct disprove", s.value == "C" and s.metadata["polarity"] == "disprove" and s.metadata["other"]["comparator"]["ok"] is False)
    # 6. prove file deleted, disproof passes
    s, _ = await grade(md(True), {D: "PROOF_OK"})
    check("open, prove file missing, disproof passes: correct", s.value == "C" and s.metadata["polarity"] == "disprove")
    # 7. untouched open problem: incorrect, polarity prove
    s, _ = await grade(md(True), {S: ref, D: dref})
    check("open, untouched: incorrect, polarity prove", s.value == "I" and s.metadata["polarity"] == "prove")

    # session loop: both files in the prompt, stop when the disproof passes layer 1
    prompts = []
    async def fake_run(agent, prompt, limits=None, name=None):
        prompts.append(prompt)
        sb.files[D] = "PROOF_OK"  # the agent proves the negation in its first session
        return SimpleNamespace(messages=[]), None
    async def fake_lean(md_, files): return "(lean output)"
    sb = FakeSandbox({S: ref, D: dref})
    sessions.sandbox = lambda name=None: sb
    sessions.run = fake_run
    sessions._lean_output = fake_lean
    state = SimpleNamespace(metadata=md(True), store=Store(), input_text="INSTRUCTIONS", messages=[], sample_id="P005")
    await sessions.handoff_sessions([], sessions=3)(state, None)
    recs = state.store.get("sessions")
    check("sessions: prompt shows both files", S in prompts[0] and D in prompts[0] and "When either file compiles" in prompts[0] and "the current files, their Lean output" in prompts[0])
    check("sessions: stops after the passing disproof", len(recs) == 1 and recs[0]["passed"] and recs[0]["polarity"] == "disprove")
    prompts.clear()
    sb = FakeSandbox({S: "theorem P005 : X := by\n  sorry\n"})
    sessions.sandbox = lambda name=None: sb
    async def fake_run2(agent, prompt, limits=None, name=None):
        prompts.append(prompt); return SimpleNamespace(messages=[]), None
    sessions.run = fake_run2
    state = SimpleNamespace(metadata=md(False), store=Store(), input_text="INSTRUCTIONS", messages=[], sample_id="P005")
    await sessions.handoff_sessions([], sessions=2)(state, None)
    recs = state.store.get("sessions")
    check("sessions, prove-only: one file, old wording, two failed sessions", len(prompts) == 2 and D not in prompts[0] and "When the file compiles" in prompts[0] and len(recs) == 2 and not recs[-1]["passed"])

asyncio.run(main())
print(f"{failures} failures")
sys.exit(1 if failures else 0)
