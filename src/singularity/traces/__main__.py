"""Summarize a Claude Code session: python -m singularity.traces <path or session id>"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .metrics import TraceMetrics
from .models import Trace
from .parse import find_transcript, parse_session


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m singularity.traces", description=__doc__)
    ap.add_argument("session", help="path to a transcript .jsonl, or a session id")
    ap.add_argument("--json", action="store_true", help="print metrics as JSON")
    args = ap.parse_args(argv)

    path = Path(args.session)
    if not path.is_file():
        found = find_transcript(args.session)
        if found is None:
            ap.error(f"no transcript file or session id {args.session!r}")
        path = found

    trace = parse_session(path)
    metrics = TraceMetrics.from_trace(trace)
    if args.json:
        json.dump({"session_id": trace.session_id, "path": str(trace.path), **metrics.to_dict()}, sys.stdout, indent=2)
        print()
    else:
        print(format_summary(trace, metrics))
    return 0


def format_summary(trace: Trace, m: TraceMetrics) -> str:
    u = m.usage
    lines = [
        f"session  {trace.session_id}  ({', '.join(trace.models) or 'no responses'}; Claude Code {trace.version or '?'})",
        f"cwd      {trace.cwd or '?'}",
        f"prompts  {len(trace.prompts)}   api calls {m.api_calls}"
        + (f" ({m.api_errors} failed)" if m.api_errors else "")
        + f"   subagents {m.subagents}   wall {_duration(m.wall_time_s)}",
        f"tokens   input {u.input_tokens:,}  output {u.output_tokens:,}  cache write {u.cache_creation_input_tokens:,}"
        f"  cache read {u.cache_read_input_tokens:,}  total {u.total:,}",
    ]
    if trace.cost_state and trace.cost_state.get("totalCostUSD") is not None:
        lines.append(f"cost     ${trace.cost_state['totalCostUSD']:.2f} (Claude Code's running total, incl. side calls)")
    tools = ", ".join(f"{k} {v}" for k, v in m.tools.items())
    lines.append(f"tools    {m.tool_calls} calls ({m.tool_errors} failed)" + (f": {tools}" if tools else ""))
    lines.append(f"files    {m.reads} reads of {m.unique_files_read} files ({m.repeat_reads} repeats), {len(m.files_edited)} edited")
    return "\n".join(lines)


def _duration(seconds: float | None) -> str:
    if seconds is None:
        return "?"
    minutes, s = divmod(int(round(seconds)), 60)
    return f"{minutes}m {s:02d}s" if minutes else f"{s}s"


if __name__ == "__main__":
    raise SystemExit(main())
