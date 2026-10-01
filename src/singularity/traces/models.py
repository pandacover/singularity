"""Normalized view of a Claude Code session transcript."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens + self.cache_creation_input_tokens + self.cache_read_input_tokens

    def __add__(self, other: Usage) -> Usage:
        return Usage(
            self.input_tokens + other.input_tokens,
            self.output_tokens + other.output_tokens,
            self.cache_creation_input_tokens + other.cache_creation_input_tokens,
            self.cache_read_input_tokens + other.cache_read_input_tokens,
        )

    @classmethod
    def from_api(cls, d: dict[str, Any] | None) -> Usage:
        """From an API response's `usage` (snake_case)."""
        d = d or {}
        return cls(
            int(d.get("input_tokens") or 0),
            int(d.get("output_tokens") or 0),
            int(d.get("cache_creation_input_tokens") or 0),
            int(d.get("cache_read_input_tokens") or 0),
        )

    @classmethod
    def from_model_usage(cls, d: dict[str, Any] | None) -> Usage:
        """From one entry of Claude Code's `modelUsage` (camelCase)."""
        d = d or {}
        return cls(
            int(d.get("inputTokens") or 0),
            int(d.get("outputTokens") or 0),
            int(d.get("cacheCreationInputTokens") or 0),
            int(d.get("cacheReadInputTokens") or 0),
        )

    def max(self, other: Usage) -> Usage:
        """Field-wise max, for merging repeated logs of one response."""
        return Usage(
            max(self.input_tokens, other.input_tokens),
            max(self.output_tokens, other.output_tokens),
            max(self.cache_creation_input_tokens, other.cache_creation_input_tokens),
            max(self.cache_read_input_tokens, other.cache_read_input_tokens),
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "input": self.input_tokens,
            "output": self.output_tokens,
            "cache_creation": self.cache_creation_input_tokens,
            "cache_read": self.cache_read_input_tokens,
            "total": self.total,
        }


@dataclass
class Prompt:
    """A message typed by the user (or sent by the harness) on the main thread."""

    text: str
    timestamp: datetime | None


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]
    # None for the main thread, otherwise the subagent's id.
    agent_id: str | None
    started_at: datetime | None
    finished_at: datetime | None = None
    # Text of the tool result; None if no result was logged (e.g. interrupted).
    result: str | None = None
    is_error: bool = False

    @property
    def duration_s(self) -> float | None:
        if self.started_at is None or self.finished_at is None:
            return None
        return (self.finished_at - self.started_at).total_seconds()


@dataclass
class Response:
    """One model API response. Claude Code logs each content block as its own line."""

    id: str
    model: str
    agent_id: str | None
    timestamp: datetime | None
    usage: Usage
    text: str = ""
    tool_call_ids: list[str] = field(default_factory=list)
    stop_reason: str | None = None


@dataclass
class Trace:
    session_id: str
    path: Path
    cwd: str | None = None
    git_branch: str | None = None
    version: str | None = None
    prompts: list[Prompt] = field(default_factory=list)
    responses: list[Response] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    # Synthetic assistant messages Claude Code writes when an API call fails.
    api_errors: int = 0
    # Claude Code's own running totals from the last "cost-state" line. Unlike
    # `responses`, these include side calls (e.g. WebFetch summarization).
    cost_state: dict[str, Any] | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    skipped_lines: int = 0

    @property
    def usage(self) -> Usage:
        return sum((r.usage for r in self.responses), Usage())

    def usage_by_model(self) -> dict[str, Usage]:
        out: dict[str, Usage] = {}
        for r in self.responses:
            out[r.model] = out.get(r.model, Usage()) + r.usage
        return out

    @property
    def models(self) -> list[str]:
        return sorted({r.model for r in self.responses})

    @property
    def agent_ids(self) -> list[str]:
        return sorted({r.agent_id for r in self.responses if r.agent_id is not None})

    @property
    def wall_time_s(self) -> float | None:
        if self.started_at is None or self.ended_at is None:
            return None
        return (self.ended_at - self.started_at).total_seconds()
