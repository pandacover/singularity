"""Feed finished runs into a memory setup, without running the agent again.

Any run output directory works as a source of experience: a no-memory
baseline's successful runs are exactly the "successful traces" a memory setup
learns from.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from pathlib import Path

from ..traces import parse_session
from .report import load_records
from .setups import MemorySetup, Outcome
from .suite import Suite, SuiteError


def outcomes(suite: Suite, results: Iterable[Path], task_ids: list[str] | None = None) -> Iterator[Outcome]:
    """Outcomes of recorded runs, in the order they ran. Skips tasks the suite no longer has."""
    for path in results:
        out_dir = path if path.is_dir() else path.parent
        for rec in load_records([path]):
            if task_ids and rec["task_id"] not in task_ids:
                continue
            try:
                task = suite.task(rec["task_id"])
            except SuiteError:
                continue
            run_dir = out_dir / "runs" / rec["run_id"]
            diff_path = run_dir / "diff.patch"
            transcript = run_dir / "transcript" / f"{rec.get('session_id')}.jsonl"
            yield Outcome(
                task=task,
                success=rec.get("success"),
                trace=parse_session(transcript) if transcript.is_file() else None,
                diff=diff_path.read_text(encoding="utf-8") if diff_path.is_file() else "",
            )


def learn(setup: MemorySetup, suite: Suite, results: Iterable[Path], task_ids: list[str] | None = None) -> int:
    """Call `setup.after_run` for each recorded run. Returns how many were fed in."""
    n = 0
    for outcome in outcomes(suite, results, task_ids):
        setup.after_run(outcome)
        n += 1
    return n
