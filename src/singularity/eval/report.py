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


def run_kind(r: Record) -> str:
    """How a memory run relates to what it retrieved: exact repeat, similar task, or nothing."""
    retrieved = ((r.get("injection") or {}).get("retrieved") or {}).get("task_id")
    if retrieved is None:
        return "no match"
    return "exact repeat" if retrieved == r["task_id"] else "similar task"


METRICS = [
    ("tool calls", lambda r: (r.get("trace") or {}).get("tool_calls"), "{:.0f}"),
    ("tokens", lambda r: ((r.get("tokens") or {}).get("total") or 0) / 1000 or None, "{:,.0f}k"),
    ("cost $", lambda r: r.get("cost_usd"), "{:.2f}"),
    ("wall s", lambda r: r.get("wall_time_s"), "{:.0f}"),
]


def compare(records: list[Record], baseline: str = "no-memory") -> str:
    """Each memory setup against the baseline, per task and per kind of run.

    Task rows read "baseline -> setup (change)", using medians. Group rows give
    the median of the per-task changes (and their range), so a cheap task and
    an expensive one count equally instead of pooling runs with different
    baselines.
    """
    base: dict[str, list[Record]] = {}
    other: dict[tuple[str, str], list[Record]] = {}
    for r in records:
        if r["setup"] == baseline:
            base.setdefault(r["task_id"], []).append(r)
        else:
            other.setdefault((r["setup"], r["task_id"]), []).append(r)
    if not base or not other:
        raise ValueError(f"need runs of {baseline!r} and of at least one other setup")

    header = ["setup", "task", "kind", "runs", "success", *(m[0] for m in METRICS)]
    rows = []
    # (setup, kind) -> per-task changes for each metric, plus run counts
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for (setup, task), rs in other.items():
        b = base.get(task, [])
        kinds = sorted({run_kind(r) for r in rs})
        rows.append([setup, task, ", ".join(kinds), f"{len(b)} / {len(rs)}", f"{_ok(b)} / {_ok(rs)}",
                     *(_delta(b, rs, get, fmt) for _, get, fmt in METRICS)])
        for kind in kinds:
            sub = [r for r in rs if run_kind(r) == kind]
            g = groups.setdefault((setup, kind), {"tasks": 0, "runs": 0, "ok": [], **{m[0]: [] for m in METRICS}})
            g["tasks"] += 1
            g["runs"] += len(sub)
            g["ok"] += [r.get("success") for r in sub if r.get("success") is not None]
            for name, get, _ in METRICS:
                change = _change(b, sub, get)
                if change is not None:
                    g[name].append(change)
    for (setup, kind), g in sorted(groups.items()):
        ok = f"{sum(g['ok'])}/{len(g['ok'])}" if g["ok"] else "n/a"
        rows.append([setup, f"**{g['tasks']} tasks**", f"**{kind}**", str(g["runs"]), ok,
                     *(_spread_pct(g[name]) for name, _, _ in METRICS)])
    note = (f"Task rows: {baseline} -> setup (change), medians; runs and success are {baseline} / setup.\n"
            "Group rows: median per-task change (range across tasks); runs and success are the setup's.")
    return note + "\n\n" + _table(header, rows)


def _change(b: list[Record], s: list[Record], get) -> float | None:
    bx = [v for v in map(get, b) if isinstance(v, (int, float))]
    sx = [v for v in map(get, s) if isinstance(v, (int, float))]
    if not bx or not sx or not statistics.median(bx):
        return None
    mb = statistics.median(bx)
    return (statistics.median(sx) - mb) / mb


def _spread_pct(changes: list[float]) -> str:
    if not changes:
        return "-"
    med = f"{statistics.median(changes):+.0%}"
    return med if len(changes) == 1 else f"{med} ({min(changes):+.0%} to {max(changes):+.0%})"


def _ok(rs: list[Record]) -> str:
    known = [r["success"] for r in rs if r.get("success") is not None]
    return f"{sum(known)}/{len(known)}" if known else "n/a"


def _delta(b: list[Record], s: list[Record], get, fmt: str) -> str:
    bx = [v for v in map(get, b) if isinstance(v, (int, float))]
    sx = [v for v in map(get, s) if isinstance(v, (int, float))]
    if not bx or not sx:
        return "-"
    mb, ms = statistics.median(bx), statistics.median(sx)
    change = f" ({(ms - mb) / mb:+.0%})" if mb else ""
    return f"{fmt.format(mb)} -> {fmt.format(ms)}{change}"
