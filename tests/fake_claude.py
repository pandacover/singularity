"""Stands in for `claude -p` in harness tests.

Writes `answer.txt` in the working directory, logs a transcript where Claude
Code would, and prints a result object. Records the environment it saw so
tests can check what the harness passed through.
"""

import json
import os
import re
import sys
from pathlib import Path

args = sys.argv[1:]
if "--version" in args:
    print("0.0.0 (fake)")
    raise SystemExit(0)

session_id = args[args.index("--session-id") + 1]
prompt = sys.stdin.read()
cwd = Path.cwd()
(cwd / "answer.txt").write_text("42\n")

ts = "2026-10-01T10:00:0{}.000Z"
usage = {"input_tokens": 5, "output_tokens": 20, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 50}
lines = [
    {"type": "user", "timestamp": ts.format(0), "cwd": str(cwd), "message": {"role": "user", "content": prompt}},
    {
        "type": "assistant",
        "timestamp": ts.format(1),
        "message": {
            "id": "msg_1",
            "model": "claude-fake",
            "content": [{"type": "tool_use", "id": "t1", "name": "Write", "input": {"file_path": str(cwd / "answer.txt"), "content": "42"}}],
            "usage": usage,
        },
    },
    {"type": "user", "timestamp": ts.format(2), "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
    {"type": "assistant", "timestamp": ts.format(3), "message": {"id": "msg_2", "model": "claude-fake", "content": [{"type": "text", "text": "Done"}], "usage": usage}},
]
project = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))
project.mkdir(parents=True, exist_ok=True)
(project / f"{session_id}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
(project / f"{session_id}.env.json").write_text(json.dumps({"args": args, "env": dict(os.environ)}))

print(
    json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "num_turns": 2,
            "duration_ms": 1234,
            "session_id": session_id,
            "total_cost_usd": 0.0123,
            "permission_denials": [],
            # Includes a side call the transcript doesn't show.
            "modelUsage": {
                "claude-fake": {"inputTokens": 10, "outputTokens": 40, "cacheReadInputTokens": 200, "cacheCreationInputTokens": 100},
                "claude-side": {"inputTokens": 1000, "outputTokens": 10},
            },
        }
    )
)
