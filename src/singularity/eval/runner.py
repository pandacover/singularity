"""Run a suite under one memory setup and record one result per run.

Each run: reset the workspace to the task's base commit, run setup commands,
let the memory setup prepare, run Claude Code on the prompt, save its
transcript and diff, then run the task's checks. Output layout:

    <out>/meta.json
    <out>/results.jsonl          one record per run
    <out>/runs/<run id>/         transcript, diff, agent output, command logs
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..traces import Trace, TraceMetrics, Usage, find_transcript, parse_session
from .agent import AgentRun, build_command, run_agent
from .proc import ProcResult, run_process
from .setups import MemorySetup, Outcome
from .suite import Suite, Task
from .workspace import Workspace

Record = dict[str, Any]


def default_workspaces() -> Path:
    # Outside the repo (and OneDrive): workspaces can hold large dependency trees.
    # Also outside the home folder, so runs don't pick up a CLAUDE.md that sits
    # there (Claude Code loads every CLAUDE.md from the cwd up to the root).
    if env := os.environ.get("SINGULARITY_WORKSPACES"):
        return Path(env)
    if os.name == "nt":
        return Path(Path.home().anchor) / "singularity-workspaces"
    return Path.home() / ".singularity" / "workspaces"


def run_suite(
    suite: Suite,
    setup: MemorySetup,
    out_dir: Path,
    claude: list[str],
    workspaces: Path | None = None,
    reps: int = 1,
    task_ids: list[str] | None = None,
    on_record: Callable[[Record, int, int], None] | None = None,
) -> list[Record]:
    tasks = [suite.task(t) for t in task_ids] if task_ids else suite.tasks
    ws = Workspace(suite.repo, (workspaces or default_workspaces()) / suite.name, suite.keep)
    shas = {t.id: ws.resolve(t.base) for t in tasks}  # fail on bad refs before spending anything

    out_dir.mkdir(parents=True, exist_ok=True)
    version = run_process([*claude, "--version"], cwd=out_dir, timeout_s=60)
    meta = {
        "suite": suite.name,
        "suite_path": str(suite.path),
        "setup": setup.name,
        "reps": reps,
        "tasks": [t.id for t in tasks],
        "claude_version": version.stdout.strip(),
        "started_at": _now(),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    records = []
    total = reps * len(tasks)
    # Rep-major order: each pass runs every task once, so a slow stretch of API
    # latency is spread across tasks instead of landing on one.
    for rep in range(reps):
        for task in tasks:
            record = run_task(suite, task, shas[task.id], setup, ws, rep, out_dir, claude)
            with (out_dir / "results.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
            records.append(record)
            if on_record:
                on_record(record, len(records), total)
    return records


def run_task(
    suite: Suite,
    task: Task,
    sha: str,
    setup: MemorySetup,
    ws: Workspace,
    rep: int,
    out_dir: Path,
    claude: list[str],
) -> Record:
    run_id = f"{task.id}-r{rep}-{uuid.uuid4().hex[:6]}"
    run_dir = out_dir / "runs" / run_id
    run_dir.mkdir(parents=True)
    record: Record = {
        "run_id": run_id,
        "suite": suite.name,
        "setup": setup.name,
        "task_id": task.id,
        "family": task.family,
        "rep": rep,
        "base_sha": sha,
        "started_at": _now(),
    }

    ws.reset(sha)
    setup_results = [_command(c, ws.path, suite.command_timeout_s) for c in suite.setup]
    _write_logs(run_dir / "setup.log", setup_results)
    if not all(r.ok for _, r in setup_results):
        return {**record, "status": "setup_failed", "success": None}

    injection = setup.before_run(task, ws.path)
    prompt_file = None
    if injection.system_prompt:
        prompt_file = run_dir / "injected.md"
        prompt_file.write_text(injection.system_prompt, encoding="utf-8")

    session_id = str(uuid.uuid4())
    command = build_command(claude, suite.agent, session_id, prompt_file)
    agent = run_agent(command, session_id, task.prompt, ws.path, suite.agent.timeout_s)
    (run_dir / "agent.stdout.json").write_text(agent.proc.stdout, encoding="utf-8")
    (run_dir / "agent.stderr.txt").write_text(agent.proc.stderr, encoding="utf-8")

    trace = _save_trace(session_id, run_dir / "transcript")
    diff = ws.diff(sha)
    (run_dir / "diff.patch").write_text(diff, encoding="utf-8")

    if task.check_files is not None:
        ws.overlay(task.check_files)
    check_results = [_command(c, ws.path, suite.command_timeout_s) for c in task.checks]
    _write_logs(run_dir / "checks.log", check_results)
    success = all(r.ok for _, r in check_results) if check_results else None

    setup.after_run(Outcome(task=task, success=success, trace=trace, diff=diff))

    usage, usage_source = _headline_usage(agent.result, trace)
    return {
        **record,
        "status": _status(agent),
        "success": success,
        "session_id": session_id,
        "models": trace.models if trace else None,
        "cost_usd": _cost(agent.result, trace),
        "tokens": usage.to_dict() if usage else None,
        "tokens_source": usage_source,
        "wall_time_s": round(agent.proc.duration_s, 3),
        "agent": _agent_info(agent),
        "trace": TraceMetrics.from_trace(trace).to_dict() if trace else None,
        "checks": [
            {"command": c, "exit_code": r.exit_code, "timed_out": r.timed_out, "duration_s": round(r.duration_s, 3)}
            for c, r in check_results
        ],
        "injection": injection.info,
        "diff_lines": sum(1 for line in diff.splitlines() if line[:1] in "+-" and line[:3] not in ("+++", "---")),
        # From the diff, so it covers edits made through the shell too.
        "files_changed": changed_files(diff),
    }


def changed_files(diff: str) -> list[str]:
    files = []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            files.append(line.rsplit(" b/", 1)[-1])
    return files


def _status(agent: AgentRun) -> str:
    if agent.proc.timed_out:
        return "timeout"
    if agent.result is None:
        return "agent_crashed"
    return "completed" if agent.result.get("subtype") == "success" else str(agent.result.get("subtype") or "agent_error")


def _agent_info(agent: AgentRun) -> dict[str, Any]:
    r = agent.result or {}
    return {
        "exit_code": agent.proc.exit_code,
        "subtype": r.get("subtype"),
        "num_turns": r.get("num_turns"),
        "duration_ms": r.get("duration_ms"),
        "duration_api_ms": r.get("duration_api_ms"),
        "permission_denials": len(r.get("permission_denials") or []),
        "command": agent.command,
    }


def _headline_usage(result: dict[str, Any] | None, trace: Trace | None) -> tuple[Usage | None, str | None]:
    """Tokens for the whole run, preferring sources that include side calls."""
    if result and result.get("modelUsage"):
        return _sum_model_usage(result["modelUsage"]), "result"
    if trace and trace.cost_state and trace.cost_state.get("modelUsage"):
        return _sum_model_usage(trace.cost_state["modelUsage"]), "cost-state"
    if trace:
        return trace.usage, "transcript"
    return None, None


def _sum_model_usage(model_usage: dict[str, Any]) -> Usage:
    return sum((Usage.from_model_usage(v) for v in model_usage.values()), Usage())


def _cost(result: dict[str, Any] | None, trace: Trace | None) -> float | None:
    if result and result.get("total_cost_usd") is not None:
        return float(result["total_cost_usd"])
    if trace and trace.cost_state and trace.cost_state.get("totalCostUSD") is not None:
        return float(trace.cost_state["totalCostUSD"])
    return None


def _save_trace(session_id: str, dest: Path) -> Trace | None:
    """Copy the run's transcript out of Claude Code's config dir and parse it.

    Claude Code deletes old transcripts after a while, so results keep a copy.
    """
    src = find_transcript(session_id)
    if src is None:
        return None
    dest.mkdir(parents=True)
    main = dest / src.name
    shutil.copy2(src, main)
    subagents = src.with_suffix("") / "subagents"
    if subagents.is_dir():
        shutil.copytree(subagents, dest / session_id / "subagents")
    return parse_session(main)


def _command(command: str, cwd: Path, timeout_s: float) -> tuple[str, ProcResult]:
    return command, run_process(command, cwd=cwd, timeout_s=timeout_s, shell=True, env=dict(os.environ))


def _write_logs(path: Path, results: list[tuple[str, ProcResult]]) -> None:
    if not results:
        return
    parts = []
    for command, r in results:
        status = "timed out" if r.timed_out else f"exit {r.exit_code}"
        parts.append(f"$ {command}\n[{status}, {r.duration_s:.1f}s]\n{r.stdout}{r.stderr}\n")
    path.write_text("\n".join(parts), encoding="utf-8")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
