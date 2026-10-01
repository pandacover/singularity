"""Run a subprocess with a timeout that also kills everything it started."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class ProcResult:
    exit_code: int | None
    timed_out: bool
    duration_s: float
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


def run_process(
    args: list[str] | str,
    *,
    cwd: Path,
    timeout_s: float,
    env: dict[str, str] | None = None,
    input: str | None = None,
    shell: bool = False,
    low_priority: bool = False,
) -> ProcResult:
    """Run `args`, killing the whole process tree on timeout or interrupt.

    `low_priority` starts the process below normal priority (inherited by the
    processes it starts), so long eval runs don't make the machine sluggish.
    """
    start = time.perf_counter()
    proc = subprocess.Popen(
        args,
        cwd=cwd,
        env=env,
        shell=shell,
        stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
        **_process_options(low_priority),
    )
    timed_out = False
    try:
        stdout, stderr = proc.communicate(input, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_tree(proc)
        stdout, stderr = proc.communicate()
    except BaseException:
        # The child is in its own process group, so Ctrl+C doesn't reach it.
        # Without this, an interrupted harness leaves the agent running.
        _kill_tree(proc)
        raise
    return ProcResult(
        exit_code=proc.returncode,
        timed_out=timed_out,
        duration_s=time.perf_counter() - start,
        stdout=stdout or "",
        stderr=stderr or "",
    )


def _process_options(low_priority: bool) -> dict[str, Any]:
    # A new process group, so the whole tree can be killed together.
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP
        if low_priority:
            flags |= subprocess.BELOW_NORMAL_PRIORITY_CLASS
        return {"creationflags": flags}
    opts: dict[str, Any] = {"start_new_session": True}
    if low_priority:
        opts["preexec_fn"] = lambda: os.nice(10)
    return opts


def _kill_tree(proc: subprocess.Popen[str]) -> None:
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.kill()
