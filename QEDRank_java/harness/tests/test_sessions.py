"""The session chain, end to end, with a scripted model, a local sandbox and a stub grader."""

from __future__ import annotations

from inspect_ai import eval as inspect_eval
from inspect_ai.tool import Tool, tool

from conftest import CHALLENGE, HANDOFF, NOTE, PARTIAL, SOLVED, WORK, Script, StubGrader, call, make_task, say
from proofbench_harness.export import bundle_from_log
from proofbench_harness.sessions import CHAIN_KEY, SessionLimits


def run(task, script, tmp_path):
    logs = inspect_eval(task, model=script.model(), log_dir=str(tmp_path), display="none")
    assert logs[0].status == "success", logs[0].error
    sample = logs[0].samples[0]
    assert sample.error is None, sample.error
    return logs[0], sample, sample.store[CHAIN_KEY]


def test_first_passing_session_ends_the_chain(grader: StubGrader, tmp_path) -> None:
    script = Script([call("write_file", path=WORK, content=SOLVED), call("end_session", reason="proof complete")])
    log, sample, chain = run(make_task(grader, max_sessions=4), script, tmp_path)
    assert chain["sessions_used"] == 1 and chain["solved_at_session"] == 1 and chain["final_verdict"] == "solved"
    assert len(grader.calls) == 1, "no session is spent after the first one that passes"
    s = chain["sessions"][0]
    assert s["stop_reason"] == "agent_ended" and s["end_reason"] == "proof complete"
    assert s["model_calls"] == 2 and s["tool_calls"] == 2 and s["tool_calls_by_tool"] == {"write_file": 1, "end_session": 1}
    assert s["output_tokens"] == 200 and s["input_tokens"] == 2000
    assert sample.scores["lean_check"].value == 1.0
    assert sample.scores["lean_check"].metadata["needs_manual_audit"] is True
    assert log.results.scores[0].metrics["solve_rate"].value == 1.0


def test_second_session_starts_fresh_from_file_compiler_output_and_handoff(grader: StubGrader, tmp_path) -> None:
    script = Script([
        call("write_file", path=WORK, content=PARTIAL),
        call("write_file", path=NOTE, content=HANDOFF),
        call("end_session", reason="out of ideas"),
        call("write_file", path=WORK, content=SOLVED),
        call("end_session", reason="done"),
    ])
    _, sample, chain = run(make_task(grader, max_sessions=3), script, tmp_path)
    assert chain["sessions_used"] == 2 and chain["solved_at_session"] == 2
    assert [s["verdict"] for s in chain["sessions"]] == ["not_solved", "solved"]
    assert chain["sessions"][0]["completeness"] == 0.5
    first, second = script.first_user_prompts()
    # Session 1 sees the pristine challenge and no note.
    assert "Session 1 of 3" in first and CHALLENGE.strip() in first and "no handoff note yet" in first
    # Session 2 is a fresh context: system + one user message, nothing of session 1's conversation.
    session2_first_call = next(m for m in script.inputs if len(m) == 2 and "Session 2 of 3" in m[1].text)
    assert [m.role for m in session2_first_call] == ["system", "user"]
    assert PARTIAL.strip() in second, "the file as session 1 left it"
    assert "declaration uses `sorry`" in second, "the compiler output of the previous check"
    assert "not_solved (contains_sorry)" in second
    assert "- step: n + n = 2 * n" in second and "- rfl does not close step" in second
    assert "free text that is not part of the format" not in second, "text outside the fixed format is not passed on"
    h = chain["sessions"][0]["handoff"]
    assert h["items"] == {"proved": 0, "open_goals": 1, "failed": 1} and h["dropped_chars"] > 0 and not h["well_formed"]
    totals = chain["totals"]
    assert totals["model_calls"] == 5 and totals["tool_calls"] == 5 and totals["output_tokens"] == 500
    assert totals["tool_calls_by_tool"] == {"write_file": 3, "end_session": 2}
    assert sample.scores["lean_check"].metadata["solved_at_session"] == 2


def test_unsolved_after_all_sessions(grader: StubGrader, tmp_path) -> None:
    script = Script(lambda i: call("end_session", reason="stuck"))
    log, sample, chain = run(make_task(grader, max_sessions=3), script, tmp_path)
    assert chain["sessions_used"] == 3 and chain["solved_at_session"] is None and chain["final_verdict"] == "not_solved"
    assert len(grader.calls) == 3, "the check runs after every session"
    assert sample.scores["lean_check"].value == 0.0
    m = log.results.scores[0].metrics
    assert m["solve_rate"].value == 0.0 and m["mean_sessions"].value == 3 and m["mean_completeness_unsolved"].value == 0.5


def test_output_token_budget_ends_the_session_after_a_warning(grader: StubGrader, tmp_path) -> None:
    # 450 output tokens per call against a budget of 1000: warning after the second call (900 >= 850),
    # budget exceeded on the third.
    script = Script(lambda i: call("write_file", tokens=450, path="scratch.txt", content=str(i)))
    limits = SessionLimits(output_tokens=1000, warn_fraction=0.85)
    _, _, chain = run(make_task(grader, max_sessions=1, limits=limits), script, tmp_path)
    s = chain["sessions"][0]
    assert s["stop_reason"] == "output_token_budget"
    assert s["budget_warning_sent"] is True
    assert s["model_calls"] == 2, "the call that crossed the budget is cut off by the limit"
    warned = [m for m in script.inputs[-1] if m.role == "user" and "output tokens of this session" in m.text]
    assert len(warned) == 1 and "900 of the 1,000" in warned[0].text
    assert chain["final_verdict"] == "not_solved", "the file is still checked after a budget stop"


def test_a_model_that_stops_calling_tools_is_nudged_then_closed_as_idle(grader: StubGrader, tmp_path) -> None:
    script = Script(lambda i: say("I think I am done."))
    _, _, chain = run(make_task(grader, max_sessions=1), script, tmp_path)
    s = chain["sessions"][0]
    assert s["stop_reason"] == "idle" and s["model_calls"] == 3 and s["tool_calls"] == 0


def test_full_context_window_ends_the_session_without_compaction(grader: StubGrader, tmp_path) -> None:
    script = Script([say("…", stop_reason="model_length"), call("write_file", path=WORK, content=SOLVED), call("end_session")])
    _, _, chain = run(make_task(grader, max_sessions=2), script, tmp_path)
    assert chain["sessions"][0]["stop_reason"] == "context_window"
    assert chain["solved_at_session"] == 2


def test_grader_error_is_neither_solved_nor_failed(tmp_path) -> None:
    grader = StubGrader(error_on=1)
    script = Script([call("write_file", path=WORK, content=SOLVED), call("end_session")])
    log, sample, chain = run(make_task(grader, max_sessions=1), script, tmp_path)
    assert chain["final_verdict"] == "grader_error"
    assert sample.scores["lean_check"].metadata["grader_error"] is True
    m = log.results.scores[0].metrics
    assert m["grader_errors"].value == 1
    assert m["solve_rate"].value != m["solve_rate"].value, "no gradable sample: the rate is undefined, not zero"


def test_excluded_tools_are_not_offered_and_lookups_are_logged(grader: StubGrader, tmp_path) -> None:
    @tool
    def lean_loogle() -> Tool:
        async def execute(query: str) -> str:
            """Search Mathlib by type (web service).

            Args:
                query: Loogle query.
            """
            return "Nat.add_comm"

        return execute

    # Network off: the web-backed tool is removed from what the model is offered.
    offered: list[list[str]] = []

    class Recording(Script):
        def __call__(self, input, tools, tool_choice, config):
            offered.append(sorted(t.name for t in tools))
            return super().__call__(input, tools, tool_choice, config)

    script = Recording([call("end_session")])
    _, _, chain = run(make_task(grader, max_sessions=1, extra_tools=[lean_loogle()], exclude=("lean_loogle",)), script, tmp_path)
    assert offered[0] == ["end_session", "write_file"] and chain["tools"] == ["end_session", "write_file"]

    # Network on: it is offered, and both its queries and addresses used from other tools are logged.
    script = Recording([
        call("lean_loogle", query="_ + _ = _ + _"),
        call("write_file", path="notes.txt", content="see https://example.org/paper.pdf and https://example.org/paper.pdf."),
        call("end_session"),
    ])
    grader2 = StubGrader()
    _, _, chain = run(make_task(grader2, max_sessions=1, extra_tools=[lean_loogle()]), script, tmp_path)
    assert "lean_loogle" in chain["tools"]
    assert chain["search"]["lean_search_queries"] == ["_ + _ = _ + _"]
    assert chain["search"]["urls"] == ["https://example.org/paper.pdf"]
    assert all(e["session"] == 1 for e in chain["search_log"])


def test_export_bundle_has_what_the_statistics_need(grader: StubGrader, tmp_path) -> None:
    script = Script([call("write_file", path=WORK, content=PARTIAL), call("end_session"), call("write_file", path=WORK, content=SOLVED), call("end_session")])
    log, _, _ = run(make_task(grader, max_sessions=2), script, tmp_path)
    bundle = bundle_from_log(log)
    assert bundle["schema"] == "proofbench-agent-bundle-v1" and bundle["model"] == "mockllm/model"
    assert bundle["run_metadata"]["protocol"] == "agent"
    [s] = bundle["samples"]
    assert s["problem"]["problem_id"] == "P900" and s["problem"]["difficulty"] == "Calibration"
    assert s["chain"]["solved_at_session"] == 2 and s["chain"]["final_solution"] == SOLVED
    assert s["challenge"] == CHALLENGE and s["error"] is None
