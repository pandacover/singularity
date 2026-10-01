"""Evaluation suites, loaded from TOML.

A suite is one source repo, how to run the agent, and a list of tasks. Example:

    name = "toy"
    repo = "../.."              # relative to this file
    base = "017370d"            # default base commit for tasks
    setup = []                  # run in the workspace before each run, untimed
    keep = []                   # gitignored paths kept across resets, e.g. node_modules
    command_timeout_s = 600     # for setup commands and checks

    [agent]
    model = "haiku"
    max_budget_usd = 0.5

    [[tasks]]
    id = "delete-graph"
    family = "graph-admin"      # tasks in one family are "similar"
    prompt = "..."
    checks = ["python -m pytest -q"]
    check_files = "hidden/delete_graph"   # copied over the workspace before checks
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

DEFAULT_ALLOWED_TOOLS = ["Bash", "PowerShell", "Read", "Edit", "Write", "Glob", "Grep"]


class SuiteError(ValueError):
    pass


@dataclass
class AgentConfig:
    model: str | None = None
    effort: str | None = None
    permission_mode: str = "acceptEdits"
    allowed_tools: list[str] = field(default_factory=lambda: list(DEFAULT_ALLOWED_TOOLS))
    disallowed_tools: list[str] = field(default_factory=list)
    max_turns: int | None = None
    max_budget_usd: float | None = None
    timeout_s: float = 1800
    # Passed to `claude` as-is, e.g. ["--safe-mode"].
    extra_args: list[str] = field(default_factory=list)


@dataclass
class Task:
    id: str
    prompt: str
    base: str
    family: str | None = None
    checks: list[str] = field(default_factory=list)
    # Directory copied over the workspace after the agent finishes and before
    # checks run, so tests the agent never saw can't be edited to pass.
    check_files: Path | None = None


@dataclass
class Suite:
    name: str
    path: Path
    repo: Path
    tasks: list[Task]
    agent: AgentConfig = field(default_factory=AgentConfig)
    setup: list[str] = field(default_factory=list)
    keep: list[str] = field(default_factory=list)
    command_timeout_s: float = 600

    def task(self, task_id: str) -> Task:
        for t in self.tasks:
            if t.id == task_id:
                return t
        raise SuiteError(f"no task {task_id!r} in suite {self.name!r}")


def load_suite(path: str | Path) -> Suite:
    path = Path(path).resolve()
    with path.open("rb") as f:
        raw = tomllib.load(f)
    here = path.parent

    _check_keys("suite", raw, {"name", "repo", "base", "setup", "keep", "command_timeout_s", "agent", "tasks"})
    for key in ("name", "repo"):
        if key not in raw:
            raise SuiteError(f"suite: missing {key!r}")

    agent_raw = raw.get("agent", {})
    _check_keys("agent", agent_raw, {f.name for f in fields(AgentConfig)})
    agent = AgentConfig(**agent_raw)

    tasks = []
    for i, t in enumerate(raw.get("tasks", [])):
        where = f"tasks[{i}]"
        _check_keys(where, t, {f.name for f in fields(Task)})
        for key in ("id", "prompt"):
            if key not in t:
                raise SuiteError(f"{where}: missing {key!r}")
        base = t.get("base", raw.get("base"))
        if base is None:
            raise SuiteError(f"{where}: no 'base' commit, and the suite has no default")
        check_files = here / t["check_files"] if "check_files" in t else None
        if check_files is not None and not check_files.is_dir():
            raise SuiteError(f"{where}: check_files {check_files} is not a directory")
        tasks.append(
            Task(
                id=t["id"],
                prompt=t["prompt"].strip(),
                base=base,
                family=t.get("family"),
                checks=list(t.get("checks", [])),
                check_files=check_files,
            )
        )

    ids = [t.id for t in tasks]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise SuiteError(f"duplicate task ids: {', '.join(dupes)}")
    if not tasks:
        raise SuiteError("suite has no tasks")

    return Suite(
        name=raw["name"],
        path=path,
        repo=(here / raw["repo"]).resolve(),
        tasks=tasks,
        agent=agent,
        setup=list(raw.get("setup", [])),
        keep=list(raw.get("keep", [])),
        command_timeout_s=float(raw.get("command_timeout_s", 600)),
    )


def _check_keys(where: str, d: dict[str, Any], allowed: set[str]) -> None:
    unknown = sorted(set(d) - allowed)
    if unknown:
        raise SuiteError(f"{where}: unknown key(s) {', '.join(unknown)}")
