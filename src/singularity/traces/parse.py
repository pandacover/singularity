"""Parse Claude Code session transcripts.

Claude Code writes one JSONL file per session to
`<config dir>/projects/<project slug>/<session id>.jsonl`, and each subagent's
transcript to `<session id>/subagents/**/agent-<agent id>.jsonl` next to it.
Lines we use:

- "assistant": one content block of a model response. A response with several
  blocks (thinking, text, tool_use) spans several lines sharing `message.id`,
  each repeating the response's usage, so usage must be counted once per id.
- "user": a prompt, or tool results (`tool_result` blocks).
- "cost-state": Claude Code's running cost and token totals for the session.

Everything else (attachments, queue operations, titles) is ignored.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import Prompt, Response, ToolCall, Trace, Usage

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def claude_home() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def find_transcript(session_id: str, home: Path | None = None) -> Path | None:
    matches = sorted(((home or claude_home()) / "projects").glob(f"*/{session_id}.jsonl"))
    return matches[0] if matches else None


def subagent_transcripts(path: Path) -> list[Path]:
    root = path.with_suffix("") / "subagents"
    return sorted(root.rglob("agent-*.jsonl")) if root.is_dir() else []


def parse_session(path: str | os.PathLike[str], include_subagents: bool = True) -> Trace:
    path = Path(path)
    trace = Trace(session_id=path.stem, path=path)
    parser = _Parser(trace)
    parser.feed(path, agent_id=None)
    if include_subagents:
        for sub in subagent_transcripts(path):
            parser.feed(sub, agent_id=sub.stem.removeprefix("agent-"))
    parser.finish()
    return trace


class _Parser:
    def __init__(self, trace: Trace):
        self.trace = trace
        self.responses: dict[str, Response] = {}
        self.tool_calls: dict[str, ToolCall] = {}
        self.timestamps: list[datetime] = []

    def feed(self, path: Path, agent_id: str | None) -> None:
        with path.open(encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    self.trace.skipped_lines += 1
                    continue
                if isinstance(record, dict):
                    self.record(record, agent_id)

    def record(self, r: dict[str, Any], file_agent_id: str | None) -> None:
        t = self.trace
        kind = r.get("type")
        ts = _timestamp(r.get("timestamp"))
        if ts is not None:
            self.timestamps.append(ts)
        # Older Claude Code versions logged subagents inline as sidechains.
        agent_id = file_agent_id
        if agent_id is None and r.get("isSidechain"):
            agent_id = r.get("agentId") or "sidechain"

        if file_agent_id is None:
            t.cwd = t.cwd or r.get("cwd")
            t.git_branch = t.git_branch or r.get("gitBranch")
            t.version = t.version or r.get("version")

        if kind == "assistant":
            self.assistant(r, agent_id, ts)
        elif kind == "user":
            self.user(r, agent_id, ts)
        elif kind == "cost-state" and file_agent_id is None:
            t.cost_state = r

    def assistant(self, r: dict[str, Any], agent_id: str | None, ts: datetime | None) -> None:
        msg = r.get("message") or {}
        if r.get("isApiErrorMessage"):
            self.trace.api_errors += 1
            return
        model = msg.get("model") or "unknown"
        if model == "<synthetic>":
            return
        msg_id = msg.get("id") or r.get("uuid") or f"line-{len(self.responses)}"
        usage = Usage.from_api(msg.get("usage"))
        resp = self.responses.get(msg_id)
        if resp is None:
            resp = Response(id=msg_id, model=model, agent_id=agent_id, timestamp=ts, usage=usage)
            self.responses[msg_id] = resp
        else:
            resp.usage = resp.usage.max(usage)
        resp.stop_reason = msg.get("stop_reason") or resp.stop_reason

        for block in _blocks(msg.get("content")):
            if block.get("type") == "text":
                resp.text += ("\n" if resp.text else "") + block.get("text", "")
            elif block.get("type") == "tool_use" and block.get("id") not in self.tool_calls:
                call = ToolCall(
                    id=block["id"],
                    name=block.get("name", "unknown"),
                    input=block.get("input") or {},
                    agent_id=agent_id,
                    started_at=ts,
                )
                self.tool_calls[call.id] = call
                resp.tool_call_ids.append(call.id)

    def user(self, r: dict[str, Any], agent_id: str | None, ts: datetime | None) -> None:
        msg = r.get("message") or {}
        blocks = _blocks(msg.get("content"))
        results = [b for b in blocks if b.get("type") == "tool_result"]
        for b in results:
            call = self.tool_calls.get(b.get("tool_use_id", ""))
            if call is None:
                continue
            call.result = _result_text(b.get("content"))
            call.is_error = bool(b.get("is_error"))
            call.finished_at = ts
        if results or agent_id is not None or r.get("isMeta") or r.get("isCompactSummary"):
            return
        text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        if text:
            self.trace.prompts.append(Prompt(text=text, timestamp=ts))

    def finish(self) -> None:
        t = self.trace
        t.responses = sorted(self.responses.values(), key=lambda x: _sort_key(x.timestamp))
        t.tool_calls = sorted(self.tool_calls.values(), key=lambda x: _sort_key(x.started_at))
        if self.timestamps:
            t.started_at, t.ended_at = min(self.timestamps), max(self.timestamps)


def _blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def _result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for b in _blocks(content):
        if b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif b.get("type") == "image":
            parts.append("[image]")
    return "\n".join(parts)


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        ts = datetime.fromisoformat(value)
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def _sort_key(ts: datetime | None) -> tuple[bool, datetime]:
    return (ts is None, ts or _EPOCH)
