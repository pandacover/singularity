"""Memory setups: what the agent is given before a run, and what it learns after.

The evaluation compares three setups on the same tasks: no memory, saved
scripts/skills, and the procedural graph. Each one plugs in here.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..traces import Trace
from .suite import Task


@dataclass
class Injection:
    # Appended to Claude Code's system prompt for this run.
    system_prompt: str | None = None
    # Recorded with the run, e.g. which memory was retrieved.
    info: dict[str, Any] = field(default_factory=dict)


@dataclass
class Outcome:
    """What a setup sees after a run, to learn from it."""

    task: Task
    success: bool | None
    trace: Trace | None
    diff: str


class MemorySetup(ABC):
    name: str

    @abstractmethod
    def before_run(self, task: Task, workspace: Path) -> Injection:
        """Prepare memory for this run. May write files into the workspace."""

    def after_run(self, outcome: Outcome) -> None:
        """Learn from a finished run. Called once checks have run."""


class NoMemory(MemorySetup):
    name = "no-memory"

    def before_run(self, task: Task, workspace: Path) -> Injection:
        return Injection()


def make_setup(name: str, memory_dir: Path | None = None, frozen: bool = False) -> MemorySetup:
    """Build a setup by name. Setups that learn need `memory_dir`."""
    if name == NoMemory.name:
        return NoMemory()
    if name == "saved-scripts":
        from .saved_scripts import SavedScripts

        if memory_dir is None:
            raise ValueError("saved-scripts needs a memory directory (--memory)")
        return SavedScripts(memory_dir, frozen=frozen)
    raise ValueError(f"unknown setup {name!r}")


SETUPS = ["no-memory", "saved-scripts"]
