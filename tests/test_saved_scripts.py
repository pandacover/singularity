from pathlib import Path
from types import SimpleNamespace

import pytest

from singularity.eval import SavedScripts, Task, load_suite, make_setup, run_suite
from singularity.eval.saved_scripts import MIN_SIMILARITY, _best_match, _split_diff, make_entry, render
from singularity.eval.setups import Outcome

from test_eval import FAKE_CLAUDE, repo, write_suite  # noqa: F401  (fixtures)

DIFF = """diff --git a/src/keys.ts b/src/keys.ts
--- a/src/keys.ts
+++ b/src/keys.ts
@@ -1 +1,2 @@
 A: "a",
+M: "m",
diff --git a/tests/__snapshots__/x.test.tsx.snap b/tests/__snapshots__/x.test.tsx.snap
--- a/tests/__snapshots__/x.test.tsx.snap
+++ b/tests/__snapshots__/x.test.tsx.snap
@@ -1 +1 @@
-old
+new
"""


def task(prompt="Change the zen mode shortcut from Alt+Z to Alt+M", id="zen"):
    return Task(id=id, prompt=prompt, base="HEAD")


def test_split_diff_drops_snapshots():
    files, snaps, source = _split_diff(DIFF)
    assert files == ["src/keys.ts"]
    assert snaps == ["tests/__snapshots__/x.test.tsx.snap"]
    assert "M: \"m\"" in source and "+new" not in source


def test_learns_only_from_successes_and_not_when_frozen(tmp_path):
    s = SavedScripts(tmp_path / "mem")
    s.after_run(Outcome(task=task(), success=False, trace=None, diff=DIFF))
    assert s.entries() == []
    SavedScripts(tmp_path / "mem", frozen=True).after_run(Outcome(task=task(), success=True, trace=None, diff=DIFF))
    assert s.entries() == []
    s.after_run(Outcome(task=task(), success=True, trace=None, diff=DIFF))
    [e] = s.entries()
    assert e.task_id == "zen" and e.files_changed == ["src/keys.ts"]


def fake_trace(calls):
    # make_entry only needs tool_calls with name, input and is_error.
    return SimpleNamespace(tool_calls=[SimpleNamespace(name="Bash", input={"command": f"echo {i}"}, is_error=False) for i in range(calls)])


def test_keeps_cheapest_run_per_prompt(tmp_path):
    s = SavedScripts(tmp_path / "mem")
    for calls in (10, 5, 8):
        s.after_run(Outcome(task=task(), success=True, trace=fake_trace(calls), diff=DIFF))
    [kept] = s.entries()
    assert kept.tool_calls == 5 and kept.commands[-1] == "echo 4"


def test_retrieval_by_prompt_similarity(tmp_path):
    s = SavedScripts(tmp_path / "mem")
    s.after_run(Outcome(task=task(), success=True, trace=None, diff=DIFF))
    similar = s.before_run(task("Change the view mode shortcut from Alt+R to Alt+J", id="view"), tmp_path)
    assert similar.system_prompt and "Alt+Z to Alt+M" in similar.system_prompt
    assert similar.info["retrieved"]["task_id"] == "zen" and similar.info["similarity"] >= MIN_SIMILARITY
    unrelated = s.before_run(task("Add a minimap toggle stored in appState", id="minimap"), tmp_path)
    assert unrelated.system_prompt is None and unrelated.info["retrieved"] is None
    assert _best_match("anything", []) == (None, 0.0)


def test_render_mentions_snapshots_without_their_content(tmp_path):
    text = render(make_entry(Outcome(task=task(), success=True, trace=None, diff=DIFF)))
    assert "x.test.tsx.snap" in text and "+new" not in text and "```diff" in text


def test_make_setup():
    assert make_setup("no-memory").name == "no-memory"
    with pytest.raises(ValueError, match="memory"):
        make_setup("saved-scripts")
    with pytest.raises(ValueError, match="unknown"):
        make_setup("nope")


def test_end_to_end_learn_then_frozen(tmp_path, repo, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    suite = load_suite(write_suite(tmp_path, repo))
    mem = tmp_path / "mem"
    [first] = run_suite(suite, SavedScripts(mem), tmp_path / "learn", FAKE_CLAUDE, workspaces=tmp_path / "ws", task_ids=["t1"])
    assert first["success"] and first["injection"]["retrieved"] is None
    assert len(SavedScripts(mem).entries()) == 1

    # A relative output dir, as the CLI passes it: the injected file's path must
    # still resolve from the agent's working directory (the workspace).
    monkeypatch.chdir(tmp_path)
    [second] = run_suite(suite, SavedScripts(mem, frozen=True), Path("measure"), FAKE_CLAUDE, workspaces=tmp_path / "ws", task_ids=["t1"])
    assert second["status"] == "completed"
    assert second["injection"]["retrieved"]["task_id"] == "t1" and second["injection"]["frozen"]
    args = second["agent"]["command"]
    injected = Path(args[args.index("--append-system-prompt-file") + 1])
    assert injected.is_absolute() and "answer.txt" in injected.read_text(encoding="utf-8")


def test_learn_from_recorded_runs(tmp_path, repo, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    from singularity.eval.__main__ import main

    suite_path = write_suite(tmp_path, repo)
    suite = load_suite(suite_path)
    run_suite(suite, make_setup("no-memory"), tmp_path / "base", FAKE_CLAUDE, workspaces=tmp_path / "ws", reps=2)
    mem = tmp_path / "mem"
    assert main(["learn", str(suite_path), str(tmp_path / "base"), "--setup", "saved-scripts", "--memory", str(mem), "--task", "t1"]) == 0
    [e] = SavedScripts(mem).entries()  # two successful t1 runs, deduped by prompt
    assert e.task_id == "t1" and e.files_changed == ["answer.txt"] and e.tool_calls == 1
