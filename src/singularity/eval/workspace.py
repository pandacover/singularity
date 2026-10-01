"""A disposable clone of the suite repo that every run starts from."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class WorkspaceError(RuntimeError):
    pass


class Workspace:
    """A clone of `source`, reset to a task's base commit before every run.

    The clone has no remote, so nothing the agent does (e.g. `git push`) can
    reach the source repo. Reset deletes everything untracked except `keep`
    paths, so expensive setup like node_modules survives between runs.
    """

    def __init__(self, source: Path, path: Path, keep: list[str] | None = None):
        self.source = source
        self.path = path
        self.keep = keep or []

    def resolve(self, ref: str) -> str:
        """Full commit sha for `ref` in the source repo."""
        return _git(self.source, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()

    def reset(self, sha: str) -> None:
        if not (self.path / ".git").exists():
            if self.path.exists() and any(self.path.iterdir()):
                raise WorkspaceError(f"{self.path} exists and is not a workspace clone")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            _git(None, "clone", "--quiet", "--no-checkout", "--no-hardlinks", str(self.source), str(self.path))
            _git(self.path, "remote", "remove", "origin")
        if not self._has_commit(sha):
            _git(self.path, "fetch", "--quiet", "--tags", str(self.source), "+refs/heads/*:refs/remotes/source/*")
        _git(self.path, "checkout", "--quiet", "--force", "--detach", sha)
        _git(self.path, "clean", "-ffdxq", *[arg for k in self.keep for arg in ("-e", k)])
        self._hide_other_commits()

    def _hide_other_commits(self) -> None:
        """Drop every ref and reflog entry, leaving only the detached base commit.

        Later commits in the source repo can hold the answer (hidden tests,
        notes from earlier attempts), and `git log --all` or `git reflog`
        would otherwise show them to the agent.
        """
        refs = _git(self.path, "for-each-ref", "--format=%(refname)").split()
        if refs:
            p = subprocess.run(
                ["git", "-C", str(self.path), "update-ref", "--stdin"],
                # Bytes, not text: on Windows text mode would send CRLF.
                input="".join(f"delete {r}\n" for r in refs).encode(),
                capture_output=True,
            )
            if p.returncode != 0:
                err = p.stderr.decode(errors="replace").strip()
                raise WorkspaceError(f"deleting refs in {self.path} failed: {err}")
        _git(self.path, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all")

    def diff(self, sha: str) -> str:
        """Everything the agent changed since `sha`, including new files and commits."""
        _git(self.path, "add", "--all")
        return _git(self.path, "diff", "--cached", "--binary", sha)

    def overlay(self, files: Path) -> None:
        shutil.copytree(files, self.path, dirs_exist_ok=True)

    def _has_commit(self, sha: str) -> bool:
        p = subprocess.run(
            ["git", "-C", str(self.path), "cat-file", "-e", f"{sha}^{{commit}}"],
            capture_output=True,
        )
        return p.returncode == 0


def _git(cwd: Path | None, *args: str) -> str:
    cmd = ["git", *(["-C", str(cwd)] if cwd else []), *args]
    p = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise WorkspaceError(f"{' '.join(cmd)} failed: {p.stderr.strip()}")
    return p.stdout
