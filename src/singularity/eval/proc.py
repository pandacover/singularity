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
) -> ProcResult:
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
        **_new_process_group(),
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


def _new_process_group() -> dict[str, Any]:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _kill_tree(proc: subprocess.Popen[str]) -> None:
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.kill()
