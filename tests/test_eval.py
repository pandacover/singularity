import json
import subprocess
import sys
from pathlib import Path

import pytest

from singularity.eval import NoMemory, SuiteError, Workspace, load_records, load_suite, run_suite, summarize
from singularity.eval.agent import agent_env, build_command, parse_result
from singularity.eval.suite import AgentConfig

FAKE_CLAUDE = [sys.executable, str(Path(__file__).with_name("fake_claude.py"))]


def git(cwd, *args):
    out = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=cwd, capture_output=True, text=True, check=True
    )
    return out.stdout.strip()


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "src-repo"
    path.mkdir()
    git(path, "init", "-q")
    (path / ".gitignore").write_text("node_modules/\n")
    (path / "app.txt").write_text("v1\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "one")
    (path / "app.txt").write_text("v2\n")
    git(path, "commit", "-qam", "two")
    return path


def write_suite(tmp_path, repo, body=""):
    (tmp_path / "hidden" / "t1").mkdir(parents=True, exist_ok=True)
    (tmp_path / "hidden" / "t1" / "check_answer.py").write_text(
        "import sys\nsys.exit(open('answer.txt').read().strip() != '42')\n"
    )
    path = tmp_path / "suite.toml"
    path.write_text(
        f"""
name = "unit"
repo = "{repo.as_posix()}"
base = "HEAD~1"
{body}
[agent]
model = "haiku"
max_budget_usd = 0.25

[[tasks]]
id = "t1"
family = "f"
prompt = "  Write 42 to answer.txt  "
checks = ['"{Path(sys.executable).as_posix()}" check_answer.py']
check_files = "hidden/t1"

[[tasks]]
id = "t2"
base = "HEAD"
prompt = "Do nothing"
"""
    )
    return path


def test_load_suite(tmp_path, repo):
    suite = load_suite(write_suite(tmp_path, repo))
    assert suite.repo == repo.resolve()
    t1, t2 = suite.tasks
    assert (t1.base, t2.base) == ("HEAD~1", "HEAD")
    assert t1.prompt == "Write 42 to answer.txt"
    assert t1.check_files == tmp_path / "hidden" / "t1"
    assert t2.checks == [] and t2.family is None
    assert suite.agent.model == "haiku" and suite.agent.permission_mode == "acceptEdits"


@pytest.mark.parametrize(
    "toml, error",
    [
        ('name = "x"\nrepo = "."\nbogus = 1\n[[tasks]]\nid = "a"\nprompt = "p"\nbase = "HEAD"', "unknown key"),
        ('name = "x"\nrepo = "."\n[[tasks]]\nid = "a"\nprompt = "p"', "no 'base'"),
        ('name = "x"\nrepo = "."\nbase = "HEAD"\n[[tasks]]\nid = "a"\nprompt = "p"\n[[tasks]]\nid = "a"\nprompt = "q"', "duplicate"),
        ('name = "x"\nrepo = "."\nbase = "HEAD"\n[agent]\nmodle = "haiku"\n[[tasks]]\nid = "a"\nprompt = "p"', "unknown key"),
    ],
)
def test_load_suite_errors(tmp_path, toml, error):
    path = tmp_path / "s.toml"
    path.write_text(toml)
    with pytest.raises(SuiteError, match=error):
        load_suite(path)


def test_workspace_reset_and_diff(tmp_path, repo):
    ws = Workspace(repo, tmp_path / "ws", keep=["node_modules"])
    first = ws.resolve("HEAD~1")
    ws.reset(first)
    assert (ws.path / "app.txt").read_text() == "v1\n"
    assert git(ws.path, "remote") == ""  # no way back to the source repo

    (ws.path / "app.txt").write_text("changed\n")
    (ws.path / "new.txt").write_text("new\n")
    (ws.path / "node_modules").mkdir()
    (ws.path / "node_modules" / "dep.js").write_text("x")
    diff = ws.diff(first)
    assert "+changed" in diff and "new.txt" in diff and "dep.js" not in diff

    ws.reset(ws.resolve("HEAD"))
    assert (ws.path / "app.txt").read_text() == "v2\n"
    assert not (ws.path / "new.txt").exists()
    assert (ws.path / "node_modules" / "dep.js").exists()


def test_workspace_hides_later_commits(tmp_path, repo):
    ws = Workspace(repo, tmp_path / "ws")
    ws.reset(ws.resolve("HEAD~1"))
    assert git(ws.path, "for-each-ref") == ""
    assert "two" not in git(ws.path, "log", "--all", "--reflog", "--format=%s")
    # The later commit is still there to reset to, without a fetch.
    ws.reset(ws.resolve("HEAD"))
    assert (ws.path / "app.txt").read_text() == "v2\n"


def test_workspace_fetches_new_commits(tmp_path, repo):
    ws = Workspace(repo, tmp_path / "ws")
    ws.reset(ws.resolve("HEAD"))
    (repo / "app.txt").write_text("v3\n")
    git(repo, "commit", "-qam", "three")
    ws.reset(ws.resolve("HEAD"))
    assert (ws.path / "app.txt").read_text() == "v3\n"


def test_build_command_and_env():
    cfg = AgentConfig(model="haiku", effort="low", max_budget_usd=1.5, max_turns=30, extra_args=["--safe-mode"])
    cmd = build_command(["claude"], cfg, "sid", Path("mem.md"))
    joined = " ".join(cmd)
    for part in ("-p", "--output-format json", "--session-id sid", "--model haiku", "--effort low", "--max-budget-usd 1.5",
                 "--max-turns 30", "--append-system-prompt-file mem.md", "--strict-mcp-config", "--permission-prompts none"):
        assert part in joined
    assert cmd[-1] == "--safe-mode"

    env = agent_env({"PATH": "x", "CLAUDECODE": "1", "CLAUDE_EFFORT": "max", "CLAUDE_CONFIG_DIR": "c", "ANTHROPIC_API_KEY": "k"})
    assert env == {"PATH": "x", "CLAUDE_CONFIG_DIR": "c", "ANTHROPIC_API_KEY": "k", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}


def test_parse_result_tolerates_noise():
    assert parse_result('warning: something\n{"type": "result", "subtype": "success"}\n')["subtype"] == "success"
    assert parse_result("not json") is None


def test_run_suite_end_to_end(tmp_path, repo, monkeypatch):
    home = tmp_path / "claude-home"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))
    monkeypatch.setenv("CLAUDECODE", "1")
    suite = load_suite(write_suite(tmp_path, repo))
    out = tmp_path / "out"

    records = run_suite(suite, NoMemory(), out, FAKE_CLAUDE, workspaces=tmp_path / "workspaces", reps=2, task_ids=["t1"])

    assert len(records) == 2
    r = records[0]
    assert (r["status"], r["success"], r["task_id"], r["family"], r["rep"]) == ("completed", True, "t1", "f", 0)
    assert r["base_sha"] == git(repo, "rev-parse", "HEAD~1")
    assert r["cost_usd"] == 0.0123
    # Headline tokens come from the result, which includes side calls.
    assert r["tokens_source"] == "result" and r["tokens"]["total"] == 10 + 40 + 200 + 100 + 1000 + 10
    assert r["trace"]["tool_calls"] == 1 and r["trace"]["usage"]["total"] == 2 * 175
    assert r["models"] == ["claude-fake"]
    assert r["agent"]["num_turns"] == 2 and r["diff_lines"] == 1
    assert r["files_changed"] == ["answer.txt"]

    run_dir = out / "runs" / r["run_id"]
    assert (run_dir / "transcript" / f"{r['session_id']}.jsonl").is_file()
    assert "answer.txt" in (run_dir / "diff.patch").read_text()
    assert [json.loads(line)["run_id"] for line in (out / "results.jsonl").read_text().splitlines()] == [x["run_id"] for x in records]
    assert json.loads((out / "meta.json").read_text())["claude_version"] == "0.0.0 (fake)"

    seen = json.loads(next(home.glob(f"projects/*/{r['session_id']}.env.json")).read_text())
    assert "CLAUDECODE" not in seen["env"]
    assert seen["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"

    table = summarize(load_records([out]))
    assert "| no-memory | t1" in table and "2/2" in table


def test_failed_check_is_recorded(tmp_path, repo, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    suite = load_suite(write_suite(tmp_path, repo))
    (tmp_path / "hidden" / "t1" / "check_answer.py").write_text("raise SystemExit(1)\n")
    [r] = run_suite(suite, NoMemory(), tmp_path / "out", FAKE_CLAUDE, workspaces=tmp_path / "ws", task_ids=["t1"])
    assert r["status"] == "completed" and r["success"] is False
    assert r["checks"][0]["exit_code"] == 1


def test_setup_failure_skips_agent(tmp_path, repo, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    suite = load_suite(write_suite(tmp_path, repo, body='setup = ["exit 3"]'))
    [r] = run_suite(suite, NoMemory(), tmp_path / "out", FAKE_CLAUDE, workspaces=tmp_path / "ws", task_ids=["t1"])
    assert r["status"] == "setup_failed"
    assert not (tmp_path / "claude-home").exists()


def test_summarize_groups_and_totals():
    def rec(setup, task, success, cost, status="completed"):
        return {"setup": setup, "task_id": task, "success": success, "cost_usd": cost, "status": status,
                "tokens": {"total": 1000}, "wall_time_s": 10, "trace": {"tool_calls": 4}}

    table = summarize([rec("a", "x", True, 0.1), rec("a", "x", False, 0.3, "timeout"), rec("a", "y", True, 0.2), rec("b", "x", True, 0.05)])
    lines = table.splitlines()
    assert lines[2].startswith("| a     | x       | 2    | 1/2     | 0.20 (0.10-0.30)")
    assert "1 timeout" in lines[2]
    assert any(line.startswith("| a     | **all**") and "2/3" in line for line in lines)


def test_compare_splits_repeats_and_similar_tasks():
    from singularity.eval import compare

    def rec(setup, task, calls, retrieved=None):
        injection = {"retrieved": {"task_id": retrieved}} if retrieved else {}
        return {"setup": setup, "task_id": task, "success": True, "cost_usd": calls / 100,
                "tokens": {"total": calls * 1000}, "wall_time_s": calls, "trace": {"tool_calls": calls},
                "injection": injection, "status": "completed"}

    records = [rec("no-memory", "a", 40), rec("no-memory", "a", 50), rec("no-memory", "b", 40),
               rec("saved", "a", 10, retrieved="a"), rec("saved", "b", 30, retrieved="a")]
    out = compare(records)
    rows = {tuple(c.strip() for c in line.split("|")[1:4]) for line in out.splitlines() if line.startswith("| saved")}
    assert ("saved", "a", "exact repeat") in rows and ("saved", "b", "similar task") in rows
    assert "45 -> 10 (-78%)" in out  # median 45 against 10
    assert "40 -> 30 (-25%)" in out
    assert "**exact repeat**" in out and "**similar task**" in out
    assert "| -78% " in out.replace("  ", " ")  # one task per group: its own change
    with pytest.raises(ValueError):
        compare(records[:3])
