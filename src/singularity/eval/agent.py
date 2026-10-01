"""Launch Claude Code headless for one run."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .proc import ProcResult, run_process
from .suite import AgentConfig

# Variables a parent Claude Code session sets for its children. Dropping them
# makes a run behave like a fresh launch from a terminal, wherever the harness
# itself runs. CLAUDE_EFFORT in particular would silently override the effort.
SESSION_VARS = frozenset(
    {
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_SESSION_ID",
    }
)


@dataclass
class AgentRun:
    command: list[str]
    session_id: str
    proc: ProcResult
    # The `--output-format json` result object, if Claude Code printed one.
    result: dict[str, Any] | None


def default_claude() -> list[str]:
    exe = shutil.which("claude")
    if exe is None:
        raise FileNotFoundError("`claude` is not on PATH; pass --claude")
    return [exe]


def build_command(
    claude: list[str],
    cfg: AgentConfig,
    session_id: str,
    append_system_prompt_file: Path | None = None,
) -> list[str]:
    cmd = [
        *claude,
        "-p",
        "--output-format", "json",
        "--session-id", session_id,
        "--permission-mode", cfg.permission_mode,
        # Nobody is there to answer a prompt; deny instead of waiting.
        "--permission-prompts", "none",
        # Keep the user's MCP servers out of the runs.
        "--strict-mcp-config",
    ]  # fmt: skip
    if cfg.model:
        cmd += ["--model", cfg.model]
    if cfg.effort:
        cmd += ["--effort", cfg.effort]
    if cfg.max_turns is not None:
        cmd += ["--max-turns", str(cfg.max_turns)]
    if cfg.max_budget_usd is not None:
        cmd += ["--max-budget-usd", str(cfg.max_budget_usd)]
    if append_system_prompt_file is not None:
        cmd += ["--append-system-prompt-file", str(append_system_prompt_file)]
    if cfg.allowed_tools:
        cmd += ["--allowed-tools", ",".join(cfg.allowed_tools)]
    if cfg.disallowed_tools:
        cmd += ["--disallowed-tools", ",".join(cfg.disallowed_tools)]
    return cmd + list(cfg.extra_args)


def agent_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = {k: v for k, v in (os.environ if base is None else base).items() if k not in SESSION_VARS}
    # Claude Code's own auto-memory would carry notes from one run to the next
    # and contaminate every setup, so it is always off.
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    return env


def run_agent(command: list[str], session_id: str, prompt: str, cwd: Path, timeout_s: float) -> AgentRun:
    # The prompt goes on stdin, which avoids shell quoting problems on Windows.
    proc = run_process(command, cwd=cwd, timeout_s=timeout_s, env=agent_env(), input=prompt)
    return AgentRun(command=command, session_id=session_id, proc=proc, result=parse_result(proc.stdout))


def parse_result(stdout: str) -> dict[str, Any] | None:
    """The result object from `--output-format json`, tolerating stray lines."""
    candidates = [stdout.strip()] + [line.strip() for line in reversed(stdout.splitlines())]
    for text in candidates:
        if not text.startswith("{"):
            continue
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "result":
            return obj
    return None
