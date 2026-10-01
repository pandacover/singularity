"""GraphStore backed by JSON files.

Layout, one directory per graph:

    <root>/<graph_id>/graph.json              id, description, head version
    <root>/<graph_id>/versions/000003.json    full snapshot of each committed version
    <root>/<graph_id>/candidates/c000007.json one file per proposed candidate

Reads load the snapshot they need; graphs are small enough that this is cheap.
Writes are atomic per file, but there is no locking, so two processes
committing to the same graph at the same moment can race.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import ops
from .errors import CandidateNotFound, Conflict, GraphExists, GraphNotFound, InvalidEdit, StoreError
from .models import Candidate, CandidateStatus, EditSet, Graph, GraphInfo, Node
from .ops import Direction
from .store import At, GraphStore

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


class JsonGraphStore(GraphStore):
    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    # --- graphs ---

    def create_graph(self, graph_id: str, description: str = "") -> GraphInfo:
        if not _ID_RE.match(graph_id):
            raise StoreError(f"invalid graph id {graph_id!r}")
        gdir = self.root / graph_id
        if gdir.exists():
            raise GraphExists(graph_id)
        (gdir / "versions").mkdir(parents=True)
        (gdir / "candidates").mkdir()
        self._write_version(graph_id, 0, Graph(), candidate_id=None, score=None)
        info = GraphInfo(graph_id=graph_id, description=description, head=0)
        self._write_info(info, next_candidate=1)
        return info

    def list_graphs(self) -> list[GraphInfo]:
        return [self._info(p.name) for p in sorted(self.root.iterdir()) if (p / "graph.json").is_file()]

    def head(self, graph_id: str) -> int:
        return self._info(graph_id).head

    # --- reads ---

    def get_nodes(self, graph_id: str, node_ids: Iterable[str], at: At = None) -> dict[str, Node]:
        g = self._resolve(graph_id, at)
        return {k: g.nodes[k] for k in node_ids if k in g.nodes}

    def match_nodes(self, graph_id: str, command: str, at: At = None) -> list[Node]:
        return ops.match_nodes(self._resolve(graph_id, at), command)

    def neighborhood(
        self,
        graph_id: str,
        node_ids: Iterable[str],
        hops: int = 2,
        direction: Direction = "out",
        at: At = None,
    ) -> Graph:
        return ops.neighborhood(self._resolve(graph_id, at), node_ids, hops, direction)

    def snapshot(self, graph_id: str, at: At = None) -> Graph:
        return self._resolve(graph_id, at)

    # --- evolution ---

    def propose(self, graph_id: str, edits: EditSet, base_version: int | None = None, rationale: str = "") -> Candidate:
        raw = self._read_info(graph_id)
        base = raw["head"] if base_version is None else base_version
        if edits.is_empty():
            raise InvalidEdit(["edit set is empty"])
        ops.apply_edits(self._load_version(graph_id, base), edits)  # validate only

        candidate = Candidate(
            id=f"c{raw['next_candidate']:06d}",
            graph_id=graph_id,
            base_version=base,
            edits=edits,
            rationale=rationale,
            created_at=_now(),
        )
        raw["next_candidate"] += 1
        _write_json(self.root / graph_id / "graph.json", raw)
        self._write_candidate(candidate)
        return candidate

    def commit(self, graph_id: str, candidate_id: str, score: float | None = None) -> int:
        candidate = self._pending(graph_id, candidate_id)
        info = self._info(graph_id)
        if candidate.base_version != info.head:
            raise Conflict(
                f"candidate {candidate_id} is based on version {candidate.base_version}, but head is {info.head}"
            )
        graph = ops.apply_edits(self._load_version(graph_id, info.head), candidate.edits)
        version = info.head + 1
        self._write_version(graph_id, version, graph, candidate_id=candidate_id, score=score)

        candidate.status = CandidateStatus.COMMITTED
        candidate.score = score
        candidate.committed_version = version
        self._write_candidate(candidate)

        raw = self._read_info(graph_id)
        raw["head"] = version
        _write_json(self.root / graph_id / "graph.json", raw)
        return version

    def reject(self, graph_id: str, candidate_id: str, reason: str, score: float | None = None) -> None:
        candidate = self._pending(graph_id, candidate_id)
        candidate.status = CandidateStatus.REJECTED
        candidate.reason = reason
        candidate.score = score
        self._write_candidate(candidate)

    def get_candidate(self, graph_id: str, candidate_id: str) -> Candidate:
        self._read_info(graph_id)
        path = self.root / graph_id / "candidates" / f"{candidate_id}.json"
        if not _ID_RE.match(candidate_id) or not path.is_file():
            raise CandidateNotFound(f"{graph_id}/{candidate_id}")
        return Candidate.from_dict(_read_json(path))

    def candidates(self, graph_id: str, status: CandidateStatus | None = None) -> list[Candidate]:
        self._read_info(graph_id)
        found = [Candidate.from_dict(_read_json(p)) for p in sorted((self.root / graph_id / "candidates").glob("*.json"))]
        return [c for c in found if status is None or c.status == status]

    def diff(self, graph_id: str, from_version: int, to_version: int) -> EditSet:
        return ops.diff(self._load_version(graph_id, from_version), self._load_version(graph_id, to_version))

    # --- internals ---

    def _resolve(self, graph_id: str, at: At) -> Graph:
        if at is None:
            return self._load_version(graph_id, self.head(graph_id))
        if isinstance(at, int):
            return self._load_version(graph_id, at)
        candidate = self.get_candidate(graph_id, at)
        return ops.apply_edits(self._load_version(graph_id, candidate.base_version), candidate.edits)

    def _pending(self, graph_id: str, candidate_id: str) -> Candidate:
        candidate = self.get_candidate(graph_id, candidate_id)
        if candidate.status != CandidateStatus.PENDING:
            raise Conflict(f"candidate {candidate_id} is already {candidate.status.value}")
        return candidate

    def _read_info(self, graph_id: str) -> dict[str, Any]:
        path = self.root / graph_id / "graph.json"
        if not _ID_RE.match(graph_id) or not path.is_file():
            raise GraphNotFound(graph_id)
        return _read_json(path)

    def _info(self, graph_id: str) -> GraphInfo:
        raw = self._read_info(graph_id)
        return GraphInfo(graph_id=raw["graph_id"], description=raw["description"], head=raw["head"])

    def _write_info(self, info: GraphInfo, next_candidate: int) -> None:
        _write_json(
            self.root / info.graph_id / "graph.json",
            {"graph_id": info.graph_id, "description": info.description, "head": info.head, "next_candidate": next_candidate},
        )

    def _load_version(self, graph_id: str, version: int) -> Graph:
        self._read_info(graph_id)
        path = self.root / graph_id / "versions" / f"{version:06d}.json"
        if not path.is_file():
            raise StoreError(f"{graph_id} has no version {version}")
        return Graph.from_dict(_read_json(path)["graph"])

    def _write_version(self, graph_id: str, version: int, graph: Graph, candidate_id: str | None, score: float | None) -> None:
        _write_json(
            self.root / graph_id / "versions" / f"{version:06d}.json",
            {"version": version, "candidate_id": candidate_id, "score": score, "graph": graph.to_dict()},
        )

    def _write_candidate(self, candidate: Candidate) -> None:
        _write_json(self.root / candidate.graph_id / "candidates" / f"{candidate.id}.json", candidate.to_dict())


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
