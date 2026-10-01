"""Effort metrics for a parsed trace."""

from __future__ import annotations

import os
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .models import Trace, Usage

READ_TOOLS = {"Read"}
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}
SEARCH_TOOLS = {"Glob", "Grep"}


@dataclass
class TraceMetrics:
    api_calls: int
    # Summed over logged responses (main thread and subagents). Excludes side
    # calls such as WebFetch summarization; Claude Code's cost-state has those.
    usage: Usage
    tool_calls: int
    tool_errors: int
    tools: dict[str, int] = field(default_factory=dict)
    shell_commands: int = 0
    searches: int = 0
    reads: int = 0
    unique_files_read: int = 0
    files_edited: list[str] = field(default_factory=list)
    subagents: int = 0
    api_errors: int = 0
    wall_time_s: float | None = None

    @property
    def repeat_reads(self) -> int:
        """Reads of a file that was already read: a rough signal of wasted effort."""
        return self.reads - self.unique_files_read

    @classmethod
    def from_trace(cls, trace: Trace) -> TraceMetrics:
        calls = trace.tool_calls
        read_paths = [_norm(c.input.get("file_path")) for c in calls if c.name in READ_TOOLS]
        edited = {_norm(c.input.get("file_path") or c.input.get("notebook_path")) for c in calls if c.name in EDIT_TOOLS}
        return cls(
            api_calls=len(trace.responses),
            usage=trace.usage,
            tool_calls=len(calls),
            tool_errors=sum(c.is_error for c in calls),
            tools=dict(Counter(c.name for c in calls).most_common()),
            shell_commands=sum(c.name in SHELL_TOOLS for c in calls),
            searches=sum(c.name in SEARCH_TOOLS for c in calls),
            reads=len(read_paths),
            unique_files_read=len(set(read_paths)),
            files_edited=sorted(p for p in edited if p),
            subagents=len(trace.agent_ids),
            api_errors=trace.api_errors,
            wall_time_s=trace.wall_time_s,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "api_calls": self.api_calls,
            "usage": self.usage.to_dict(),
            "tool_calls": self.tool_calls,
            "tool_errors": self.tool_errors,
            "tools": self.tools,
            "shell_commands": self.shell_commands,
            "searches": self.searches,
            "reads": self.reads,
            "unique_files_read": self.unique_files_read,
            "repeat_reads": self.repeat_reads,
            "files_edited": self.files_edited,
            "subagents": self.subagents,
            "api_errors": self.api_errors,
            "wall_time_s": self.wall_time_s,
        }


def _norm(path: Any) -> str:
    return os.path.normcase(os.path.normpath(path)) if isinstance(path, str) and path else ""
