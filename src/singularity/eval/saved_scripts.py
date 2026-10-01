"""The simple baseline: remember each successful run as a worked example.

After a successful run, save its prompt, the files it changed, its source diff
(snapshot files are listed but not included) and the shell commands that
worked. Before a run, find the saved run whose prompt is most similar to the
new one and hand it to the agent in the system prompt. An exact repeat gets
the whole recipe; a similar task gets a worked example to adapt.

Retrieval uses the prompt text only, never the task id or family, so the
setup has no information the agent wouldn't have in real use.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..traces.metrics import SHELL_TOOLS
from .setups import Injection, MemorySetup, Outcome
from .suite import Task

# Below this prompt similarity, nothing is injected.
MIN_SIMILARITY = 0.35
MAX_DIFF_CHARS = 16_000
MAX_COMMANDS = 8

STOPWORDS = set(
    "a an and are as at be but by for from has have in into is it its of on or "
    "should so that the this to was were will with make sure pass tests typecheck".split()
)


@dataclass
class Entry:
    id: str
    task_id: str
    prompt: str
    files_changed: list[str]
    snapshots_changed: list[str]
    source_diff: str
    commands: list[str]
    tool_calls: int | None
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))


class SavedScripts(MemorySetup):
    name = "saved-scripts"

    def __init__(self, memory_dir: Path, frozen: bool = False):
        self.dir = Path(memory_dir)
        self.frozen = frozen

    # --- MemorySetup ---------------------------------------------------------

    def before_run(self, task: Task, workspace: Path) -> Injection:
        entries = self.entries()
        best, score = _best_match(task.prompt, entries)
        info: dict[str, Any] = {"entries": len(entries), "frozen": self.frozen, "similarity": round(score, 3)}
        if best is None or score < MIN_SIMILARITY:
            return Injection(info={**info, "retrieved": None})
        info["retrieved"] = {"id": best.id, "task_id": best.task_id}
        return Injection(system_prompt=render(best), info=info)

    def after_run(self, outcome: Outcome) -> None:
        if self.frozen or not outcome.success:
            return
        entry = make_entry(outcome)
        # Keep one entry per prompt: the cheapest successful run.
        for old in self.entries():
            if old.prompt == entry.prompt:
                if (old.tool_calls or 0) <= (entry.tool_calls or 0):
                    return
                (self.dir / f"{old.id}.json").unlink()
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / f"{entry.id}.json").write_text(json.dumps(asdict(entry), indent=2) + "\n", encoding="utf-8")

    # --- storage -------------------------------------------------------------

    def entries(self) -> list[Entry]:
        if not self.dir.is_dir():
            return []
        return [Entry(**json.loads(p.read_text(encoding="utf-8"))) for p in sorted(self.dir.glob("*.json"))]


def make_entry(outcome: Outcome) -> Entry:
    files, snapshots, source = _split_diff(outcome.diff)
    trace = outcome.trace
    commands: list[str] = []
    if trace is not None:
        for c in trace.tool_calls:
            cmd = str(c.input.get("command") or "").strip()
            if c.name in SHELL_TOOLS and not c.is_error and cmd and cmd not in commands:
                commands.append(cmd[:300])
    return Entry(
        id=f"{outcome.task.id}-{datetime.now(UTC):%Y%m%d%H%M%S%f}",
        task_id=outcome.task.id,
        prompt=outcome.task.prompt,
        files_changed=files,
        snapshots_changed=snapshots,
        source_diff=source,
        commands=commands[-MAX_COMMANDS:],
        tool_calls=len(trace.tool_calls) if trace is not None else None,
    )


def render(entry: Entry) -> str:
    files = "\n".join(f"- {f}" for f in entry.files_changed) or "- (none)"
    snaps = "\n".join(f"- {f}" for f in entry.snapshots_changed)
    commands = "\n".join(f"- `{c}`" for c in entry.commands) or "- (none recorded)"
    diff = entry.source_diff
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n... (diff truncated)\n"
    parts = [
        "# Notes from a previous task in this repository",
        "",
        "A task like the one you're about to do was solved successfully here before. "
        "Below is what that run changed. Use it as a guide where it applies, and adapt "
        "it to the current task: names, keys and details may differ.",
        "",
        "## The previous task",
        "",
        entry.prompt,
        "",
        "## Files it changed",
        "",
        files,
    ]
    if snaps:
        parts += ["", "Snapshot files it regenerated (not shown below):", "", snaps]
    parts += [
        "",
        "## Shell commands it ran successfully",
        "",
        commands,
        "",
        "## Its change to source files",
        "",
        "```diff",
        diff.rstrip("\n"),
        "```",
        "",
    ]
    return "\n".join(parts)


def _split_diff(diff: str) -> tuple[list[str], list[str], str]:
    """Changed files, changed snapshot files, and the diff without snapshots."""
    files, snapshots, kept = [], [], []
    for chunk in re.split(r"(?m)^(?=diff --git )", diff):
        if not chunk.startswith("diff --git "):
            continue
        path = chunk.splitlines()[0].rsplit(" b/", 1)[-1]
        if path.endswith(".snap") or "/__snapshots__/" in path:
            snapshots.append(path)
        else:
            files.append(path)
            kept.append(chunk)
    return files, snapshots, "".join(kept)


def _words(text: str) -> Counter[str]:
    return Counter(w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOPWORDS)


def _cosine(a: Counter[str], b: Counter[str]) -> float:
    dot = sum(a[w] * b[w] for w in a.keys() & b.keys())
    norm = math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values()))
    return dot / norm if norm else 0.0


def _best_match(prompt: str, entries: list[Entry]) -> tuple[Entry | None, float]:
    query = _words(prompt)
    scored = [(_cosine(query, _words(e.prompt)), e) for e in entries]
    if not scored:
        return None, 0.0
    score, entry = max(scored, key=lambda s: s[0])
    return entry, score
