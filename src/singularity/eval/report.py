"""Summarize results.jsonl files into a comparison table."""

from __future__ import annotations

import json
import statistics
from collections.abc import Iterable
from pathlib import Path
from typing import Any

Record = dict[str, Any]


def load_records(paths: Iterable[Path]) -> list[Record]:
    records = []
    for p in paths:
        if p.is_dir():
            p = p / "results.jsonl"
        with p.open(encoding="utf-8") as f:
            records += [json.loads(line) for line in f if line.strip()]
    return records


def summarize(records: list[Record]) -> str:
    """Markdown table per (setup, task), plus a row per setup over all tasks.

    Medians with (min-max) ranges: run-to-run variance is large, so a single
    mean would hide whether two setups actually differ.
    """
    groups: dict[tuple[str, str], list[Record]] = {}
    for r in records:
        groups.setdefault((r["setup"], r["task_id"]), []).append(r)
    by_setup: dict[str, list[Record]] = {}
    for r in records:
        by_setup.setdefault(r["setup"], []).append(r)

    header = ["setup", "task", "runs", "success", "cost $", "tokens", "wall s", "tool calls", "issues"]
    rows = [_row(setup, task, rs) for (setup, task), rs in groups.items()]
    if len(groups) > len(by_setup):
        rows += [_row(setup, "**all**", rs) for setup, rs in by_setup.items()]
    return _table(header, rows)


def _row(setup: str, task: str, rs: list[Record]) -> list[str]:
    known = [r["success"] for r in rs if r.get("success") is not None]
    success = f"{sum(known)}/{len(known)}" if known else "n/a"
    issues = [r["status"] for r in rs if r.get("status") != "completed"]
    return [
        setup,
        task,
        str(len(rs)),
        success,
        _spread([r.get("cost_usd") for r in rs], "{:.2f}"),
        _spread([(r.get("tokens") or {}).get("total") for r in rs], "{:,.0f}", scale=1e-3, suffix="k"),
        _spread([r.get("wall_time_s") for r in rs], "{:.0f}"),
        _spread([(r.get("trace") or {}).get("tool_calls") for r in rs], "{:.0f}"),
        ", ".join(f"{issues.count(s)} {s}" for s in sorted(set(issues))),
    ]


def _spread(values: list[Any], fmt: str, scale: float = 1.0, suffix: str = "") -> str:
    xs = [v * scale for v in values if isinstance(v, (int, float))]
    if not xs:
        return "-"
    med = fmt.format(statistics.median(xs)) + suffix
    if len(xs) == 1:
        return med
    return f"{med} ({fmt.format(min(xs))}-{fmt.format(max(xs))})"


def _table(header: list[str], rows: list[list[str]]) -> str:
    widths = [max([len(h), *(len(r[i]) for r in rows)]) for i, h in enumerate(header)]
    def line(cells: list[str]) -> str:
        return "| " + " | ".join(c.ljust(w) for c, w in zip(cells, widths)) + " |"
    return "\n".join([line(header), "|" + "|".join("-" * (w + 2) for w in widths) + "|", *map(line, rows)])
