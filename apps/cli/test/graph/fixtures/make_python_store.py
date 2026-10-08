"""Writes the fixtures for the cross-compatibility tests in test/graph/store.test.ts.

- python-store/: a graph store written by the Python JsonGraphStore.
- python-results.json: what the Python store returns for a set of reads and
  failing calls against that store, so the TypeScript store can be checked
  for identical results.

store.test.ts replays the same operations (with the same timestamps) against
the TypeScript store and expects byte-identical files, so keep the two in sync.

It needs the Python implementation, which was removed after the port to
TypeScript; it's in commit 53dacd2. To regenerate, check that commit out in a
separate worktree and run from its root:
PYTHONPATH=src python <path to this file>
"""

import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from singularity.graph import (
    Edge,
    EdgeFacts,
    EditSet,
    JsonGraphStore,
    Node,
    NodeType,
    Relation,
    StoreError,
    json_store,
)

HERE = Path(__file__).parent
ROOT = HERE / "python-store"
RESULTS = HERE / "python-results.json"
G = "excalidraw-tasks"

# created_at of each proposal, as milliseconds after BASE.
BASE = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
OFFSETS_MS = [0, 1250, 61001, 3600000, 3600999, 7200500, 86400000]
_times = iter(BASE + timedelta(milliseconds=ms) for ms in OFFSETS_MS)
json_store._now = lambda: next(_times).isoformat()


def build(store: JsonGraphStore) -> None:
    store.create_graph(G, "Procedures for excalidraw tasks")
    store.create_graph("empty")

    c1 = store.propose(
        G,
        EditSet(
            add_nodes=[
                Node("start", NodeType.START, "Task begins"),
                Node("find_config", NodeType.ACTION, "Find the config file", command_patterns=[r"\b(rg|grep|find)\b.*config"]),
                Node(
                    "run_tests",
                    NodeType.ACTION,
                    "Run the test suite",
                    command_patterns=[r"\b(pytest|yarn test|npm test)\b", r"^vitest\s"],
                    script="scripts/run-tests.sh",
                ),
                Node("think", NodeType.REASONING, 'Décider quoi faire — "quoted" \\ back\\slash\nnew line\ttab 🚀'),
                Node("end", NodeType.END, "Task done"),
            ],
            add_edges=[
                Edge("start", "find_config", guidance="Locate config before editing"),
                Edge(
                    "find_config",
                    "run_tests",
                    relation=Relation.TRIGGERS,
                    condition="Config change made",
                    pitfalls="Don't run the full suite first",
                    facts={
                        "excalidraw": EdgeFacts(
                            paths=["packages/excalidraw/vitest.config.mts"],
                            commands=["yarn test:app --watch=false"],
                            dead_ends=["jest.config.js does not exist"],
                        ),
                        "9": EdgeFacts(paths=["Makefile"]),
                        "10": EdgeFacts(commands=["make test"]),
                        "Zeta": EdgeFacts(),
                        "-dash": EdgeFacts(dead_ends=["ü"]),
                    },
                ),
                Edge("find_config", "think", relation=Relation.PROVIDES_INPUT_FOR),
                Edge("think", "run_tests", relation=Relation.CONVERGES_TO),
                Edge("run_tests", "end"),
            ],
        ),
        rationale="initial procedure",
    )
    store.commit(G, c1.id, score=1.0)

    c2 = store.propose(G, EditSet(delete_nodes=["think"]), rationale="seems unused")
    store.reject(G, c2.id, reason="validation score dropped 0.8 -> 0.6", score=0.6)

    c3 = store.propose(
        G,
        EditSet(
            add_nodes=[Node("lint", NodeType.ACTION, "Run linter", command_patterns=[r"\b(eslint|yarn lint)\b"])],
            add_edges=[Edge("run_tests", "lint", guidance="Lint after tests pass"), Edge("lint", "end")],
            delete_edges=[("run_tests", "end")],
        ),
        rationale="lint before finishing",
    )
    store.commit(G, c3.id, score=0.1 + 0.2)

    store.propose(G, EditSet(add_nodes=[Node("x", NodeType.STATE, "pending state")]), base_version=1, rationale="stale base")

    c5 = store.propose(G, EditSet(add_edges=[Edge("start", "run_tests", condition="Config already known")]))
    store.reject(G, c5.id, reason="", score=2.5e-05)

    store.propose(
        G,
        EditSet(
            add_nodes=[Node("start", NodeType.START, "Task begins (revised)")],
            add_edges=[
                Edge(
                    "start",
                    "find_config",
                    guidance="Check packages/excalidraw first",
                    facts={"excalidraw": EdgeFacts(paths=["packages/excalidraw"])},
                )
            ],
        ),
        rationale="revise start",
    )

    c7 = store.propose(G, EditSet(delete_edges=[("find_config", "think")], delete_nodes=["think"]))
    store.commit(G, c7.id)


NEIGHBORHOODS = [
    {"node_ids": ["start"], "hops": 2, "direction": "out", "at": None},
    {"node_ids": ["end"], "hops": 1, "direction": "out", "at": None},
    {"node_ids": ["end"], "hops": 1, "direction": "in", "at": None},
    {"node_ids": ["think"], "hops": 1, "direction": "both", "at": 1},
    {"node_ids": ["start"], "hops": 0, "direction": "out", "at": None},
    {"node_ids": ["run_tests"], "hops": 1, "direction": "out", "at": "c000004"},
    {"node_ids": ["find_config", "lint"], "hops": 5, "direction": "both", "at": 2},
]
MATCHES = [
    {"command": "yarn test --watch=false", "at": None},
    {"command": "rg -n config packages/", "at": None},
    {"command": "ls", "at": None},
    {"command": "vitest run", "at": None},
    {"command": "yarn lint", "at": 2},
    {"command": "yarn lint", "at": 1},
    {"command": "npm test && yarn lint", "at": None},
]
GET_NODES = [
    {"node_ids": ["start", "missing", "end"], "at": None},
    {"node_ids": ["think"], "at": 1},
    {"node_ids": ["x", "start"], "at": "c000004"},
]
DIFFS = [(1, 2), (2, 1), (0, 3), (2, 3), (3, 3)]
# Rejected, pending on a stale base, and pending on an older head.
CANDIDATE_VIEWS = ["c000002", "c000004", "c000006"]
# Failing calls. None of them writes anything.
ERRORS = [
    ("head", {"graph_id": "missing"}),
    ("create_graph", {"graph_id": G}),
    ("create_graph", {"graph_id": "bad id"}),
    ("get_candidate", {"graph_id": G, "candidate_id": "c000099"}),
    ("get_candidate", {"graph_id": G, "candidate_id": "../graph"}),
    ("snapshot", {"graph_id": G, "at": 99}),
    ("snapshot", {"graph_id": G, "at": "c000099"}),
    ("neighborhood", {"graph_id": G, "node_ids": ["nope", "start", "gone"]}),
    ("commit", {"graph_id": G, "candidate_id": "c000006"}),
    ("reject", {"graph_id": G, "candidate_id": "c000002", "reason": "again"}),
    ("propose", {"graph_id": G, "edits": EditSet().to_dict()}),
    ("propose", {"graph_id": G, "edits": EditSet(add_edges=[Edge("start", "ghost")], delete_nodes=["nope"]).to_dict()}),
    ("propose", {"graph_id": G, "edits": EditSet(delete_nodes=["start"]).to_dict(), "base_version": 99}),
    ("diff", {"graph_id": G, "from_version": 0, "to_version": 7}),
]


def call(store: JsonGraphStore, op: str, args: dict):
    args = dict(args)
    if "edits" in args:
        args["edits"] = EditSet.from_dict(args["edits"])
    return getattr(store, op)(**args)


def results(store: JsonGraphStore) -> dict:
    head = store.head(G)
    candidates = store.candidates(G)
    errors = []
    for op, args in ERRORS:
        try:
            call(store, op, args)
        except StoreError as e:
            errors.append({"op": op, "args": args, "error": type(e).__name__, "message": str(e)})
        else:
            raise AssertionError(f"{op} {args} did not fail")
    return {
        "list_graphs": [{"graph_id": i.graph_id, "description": i.description, "head": i.head} for i in store.list_graphs()],
        "head": head,
        "snapshots": {str(v): store.snapshot(G, at=v).to_dict() for v in range(head + 1)},
        "candidate_views": {c: store.snapshot(G, at=c).to_dict() for c in CANDIDATE_VIEWS},
        "candidates": [c.to_dict() for c in candidates],
        "candidate_ids_by_status": {s: [c.id for c in store.candidates(G, s)] for s in ("pending", "committed", "rejected")},
        "neighborhoods": [{**q, "result": store.neighborhood(G, **q).to_dict()} for q in NEIGHBORHOODS],
        "match_nodes": [{**q, "result": [n.id for n in store.match_nodes(G, **q)]} for q in MATCHES],
        "get_nodes": [{**q, "result": [n.to_dict() for n in store.get_nodes(G, **q).values()]} for q in GET_NODES],
        "diffs": [{"from": a, "to": b, "result": store.diff(G, a, b).to_dict()} for a, b in DIFFS],
        "errors": errors,
    }


def main() -> None:
    shutil.rmtree(ROOT, ignore_errors=True)
    store = JsonGraphStore(ROOT)
    build(store)
    with RESULTS.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(results(store), f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
