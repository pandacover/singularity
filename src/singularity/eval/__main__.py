"""Evaluate memory setups on a task suite.

    python -m singularity.eval run SUITE.toml [--setup no-memory] [--reps N] [--task ID ...]
    python -m singularity.eval run SUITE.toml --setup saved-scripts --memory DIR [--frozen]
    python -m singularity.eval learn SUITE.toml RESULTS [RESULTS ...] --setup saved-scripts --memory DIR [--task ID ...]
    python -m singularity.eval report RESULTS [RESULTS ...] [--compare]
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

from .agent import build_command, default_claude
from .learn import learn
from .report import compare, load_records, summarize
from .runner import Record, default_workspaces, run_suite
from .setups import SETUPS, make_setup
from .suite import SuiteError, load_suite
from .workspace import Workspace, WorkspaceError


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m singularity.eval", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="run a suite")
    run.add_argument("suite", type=Path)
    run.add_argument("--setup", default="no-memory", choices=SETUPS)
    run.add_argument("--memory", type=Path, help="memory store for setups that learn (e.g. saved-scripts)")
    run.add_argument("--frozen", action="store_true", help="read memory but don't add to it (for measurement runs)")
    run.add_argument("--reps", type=int, default=1, help="runs per task (default 1)")
    run.add_argument("--task", action="append", dest="tasks", metavar="ID", help="only this task (repeatable)")
    run.add_argument("--out", type=Path, help="output dir (default runs/<suite>/<time>-<setup>)")
    run.add_argument("--workspaces", type=Path, default=default_workspaces(), help="where repo clones live (default %(default)s)")
    run.add_argument("--claude", help="path to the claude executable (default: from PATH)")
    run.add_argument("--dry-run", action="store_true", help="resolve tasks and print the agent command without running")

    lrn = sub.add_parser("learn", help="feed finished runs into a memory setup")
    lrn.add_argument("suite", type=Path)
    lrn.add_argument("results", type=Path, nargs="+", help="results.jsonl files or run output dirs")
    lrn.add_argument("--setup", required=True, choices=[s for s in SETUPS if s != "no-memory"])
    lrn.add_argument("--memory", type=Path, required=True, help="memory store to add to")
    lrn.add_argument("--task", action="append", dest="tasks", metavar="ID", help="only runs of this task (repeatable)")

    rep = sub.add_parser("report", help="summarize results")
    rep.add_argument("results", type=Path, nargs="+", help="results.jsonl files or run output dirs")
    rep.add_argument("--compare", action="store_true", help="each memory setup against no-memory, split into exact repeats and similar tasks")

    args = ap.parse_args(argv)
    try:
        return {"run": _run, "learn": _learn, "report": _report}[args.cmd](args)
    except (SuiteError, WorkspaceError, FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


def _report(args: argparse.Namespace) -> int:
    records = load_records(args.results)
    print(compare(records) if args.compare else summarize(records))
    return 0


def _learn(args: argparse.Namespace) -> int:
    suite = load_suite(args.suite)
    setup = make_setup(args.setup, args.memory)
    n = learn(setup, suite, args.results, args.tasks)
    print(f"fed {n} runs into {args.setup} memory at {args.memory}")
    return 0


def _run(args: argparse.Namespace) -> int:
    suite = load_suite(args.suite)
    claude = [args.claude] if args.claude else default_claude()
    setup = make_setup(args.setup, args.memory, args.frozen)

    if args.dry_run:
        ws = Workspace(suite.repo, args.workspaces / suite.name, suite.keep)
        print(f"repo       {suite.repo}\nworkspace  {ws.path}")
        for t in [suite.task(i) for i in args.tasks] if args.tasks else suite.tasks:
            print(f"task       {t.id} @ {ws.resolve(t.base)[:12]}  checks: {len(t.checks)}")
        print("command    " + " ".join(build_command(claude, suite.agent, "<session-id>")))
        return 0

    out = args.out or Path("runs") / suite.name / f"{datetime.now():%Y%m%d-%H%M%S}-{setup.name}"
    print(f"writing to {out}", file=sys.stderr)
    records = run_suite(suite, setup, out, claude, args.workspaces, args.reps, args.tasks, on_record=_progress)
    print()
    print(summarize(records))
    return 0


def _progress(r: Record, i: int, total: int) -> None:
    outcome = {True: "pass", False: "FAIL", None: "-"}[r.get("success")]
    cost = f"${r['cost_usd']:.2f}" if r.get("cost_usd") is not None else "$?"
    calls = (r.get("trace") or {}).get("tool_calls", "?")
    wall = f"{r['wall_time_s']:.0f}s" if r.get("wall_time_s") is not None else "?"
    print(f"[{i}/{total}] {r['setup']} {r['task_id']} r{r['rep']}  {outcome}  {cost}  {wall}  {calls} tool calls  ({r['status']})", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
