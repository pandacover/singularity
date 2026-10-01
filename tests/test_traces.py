import json

from singularity.traces import TraceMetrics, Usage, find_transcript, parse_session

SID = "11111111-2222-3333-4444-555555555555"


def ts(sec: int) -> str:
    return f"2026-10-01T10:00:{sec:02d}.000Z"


def usage(out: int, read: int = 1000, write: int = 100) -> dict:
    return {"input_tokens": 3, "output_tokens": out, "cache_read_input_tokens": read, "cache_creation_input_tokens": write}


def assistant(sec, msg_id, block, u, **extra):
    return {
        "type": "assistant",
        "timestamp": ts(sec),
        "sessionId": SID,
        "cwd": "/repo",
        "gitBranch": "main",
        "version": "2.1.286",
        "message": {"id": msg_id, "model": "claude-test", "role": "assistant", "content": [block], "usage": u, "stop_reason": "tool_use"},
        **extra,
    }


def tool_use(tid, name, **inp):
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def user(sec, content, **extra):
    return {"type": "user", "timestamp": ts(sec), "sessionId": SID, "message": {"role": "user", "content": content}, **extra}


def result(tid, content, is_error=False):
    return {"type": "tool_result", "tool_use_id": tid, "content": content, "is_error": is_error}


def write_session(tmp_path):
    main = [
        {"type": "queue-operation", "operation": "enqueue", "timestamp": ts(0), "sessionId": SID},
        user(1, "Fix the failing test", promptSource="cli"),
        # One response logged as two lines; the first carries a partial output count.
        assistant(2, "msg_1", {"type": "thinking", "thinking": "..."}, usage(1)),
        assistant(2, "msg_1", tool_use("t1", "Read", file_path="/repo/a.py"), usage(40)),
        user(3, [result("t1", "print('a')")]),
        assistant(4, "msg_2", tool_use("t2", "Bash", command="pytest"), usage(30)),
        assistant(4, "msg_2", tool_use("t3", "Read", file_path="/repo/a.py"), usage(30)),
        user(5, [result("t2", [{"type": "text", "text": "boom"}], is_error=True), result("t3", "print('a')")]),
        assistant(6, "msg_3", tool_use("t4", "Agent", prompt="find config"), usage(20)),
        user(20, [result("t4", "config is in setup.cfg")]),
        {"type": "assistant", "timestamp": ts(21), "isApiErrorMessage": True, "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "API Error"}]}},
        assistant(22, "msg_4", {"type": "text", "text": "Done."}, usage(10)),
        user(23, "<system-reminder>meta</system-reminder>", isMeta=True),
        {"type": "cost-state", "sessionId": SID, "totalCostUSD": 0.12, "modelUsage": {"claude-test": {"inputTokens": 9}}},
        "not json",
    ]
    sub = [
        user(7, "find config", isSidechain=True),
        assistant(8, "msg_s1", tool_use("s1", "Grep", pattern="config"), usage(5), isSidechain=True),
        user(9, [result("s1", "setup.cfg")], isSidechain=True),
        assistant(10, "msg_s2", {"type": "text", "text": "setup.cfg"}, usage(5), isSidechain=True),
    ]
    project = tmp_path / "projects" / "-repo"
    (project / SID / "subagents").mkdir(parents=True)
    path = project / f"{SID}.jsonl"
    path.write_text("\n".join(x if isinstance(x, str) else json.dumps(x) for x in main) + "\n", encoding="utf-8")
    (project / SID / "subagents" / "agent-abc.jsonl").write_text("\n".join(json.dumps(x) for x in sub) + "\n", encoding="utf-8")
    return path


def test_parse_session(tmp_path):
    trace = parse_session(write_session(tmp_path))

    assert trace.session_id == SID
    assert (trace.cwd, trace.git_branch, trace.version) == ("/repo", "main", "2.1.286")
    assert [p.text for p in trace.prompts] == ["Fix the failing test"]
    assert [r.id for r in trace.responses] == ["msg_1", "msg_2", "msg_3", "msg_s1", "msg_s2", "msg_4"]
    assert trace.api_errors == 1
    assert trace.skipped_lines == 1
    assert trace.agent_ids == ["abc"]
    assert trace.cost_state["totalCostUSD"] == 0.12
    assert trace.wall_time_s == 23

    # Each response counted once, with its final output count.
    assert trace.responses[0].usage == Usage(3, 40, 100, 1000)
    assert trace.usage == Usage(18, 110, 600, 6000)

    calls = {c.id: c for c in trace.tool_calls}
    assert [c.id for c in trace.tool_calls] == ["t1", "t2", "t3", "t4", "s1"]
    assert calls["t2"].is_error and calls["t2"].result == "boom"
    assert calls["t1"].duration_s == 1
    assert calls["s1"].agent_id == "abc" and calls["t1"].agent_id is None
    assert trace.responses[-1].text == "Done."


def test_metrics(tmp_path):
    m = TraceMetrics.from_trace(parse_session(write_session(tmp_path)))
    assert (m.api_calls, m.tool_calls, m.tool_errors) == (6, 5, 1)
    assert m.tools == {"Read": 2, "Bash": 1, "Agent": 1, "Grep": 1}
    assert (m.reads, m.unique_files_read, m.repeat_reads) == (2, 1, 1)
    assert (m.shell_commands, m.searches, m.subagents) == (1, 1, 1)
    assert m.to_dict()["usage"]["total"] == 18 + 110 + 600 + 6000


def test_find_transcript(tmp_path):
    path = write_session(tmp_path)
    assert find_transcript(SID, home=tmp_path) == path
    assert find_transcript("nope", home=tmp_path) is None
