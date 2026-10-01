"""Contract tests for GraphStore. Add new backends to the `store` fixture."""

import pytest

from singularity.graph import (
    CandidateStatus,
    Conflict,
    Edge,
    EdgeFacts,
    EditSet,
    GraphExists,
    GraphNotFound,
    GraphStore,
    InvalidEdit,
    JsonGraphStore,
    Node,
    NodeNotFound,
    NodeType,
)


@pytest.fixture(params=["json"])
def store(request, tmp_path) -> GraphStore:
    if request.param == "json":
        return JsonGraphStore(tmp_path / "graphs")
    raise ValueError(request.param)


def chain_edits() -> EditSet:
    """start -> find_config -> run_tests -> end"""
    return EditSet(
        add_nodes=[
            Node("start", NodeType.START, "Task begins"),
            Node("find_config", NodeType.ACTION, "Find the config file", command_patterns=[r"\b(rg|grep|find)\b.*config"]),
            Node("run_tests", NodeType.ACTION, "Run the test suite", command_patterns=[r"\b(pytest|yarn test|npm test)\b"]),
            Node("end", NodeType.END, "Task done"),
        ],
        add_edges=[
            Edge("start", "find_config", guidance="Locate config before editing"),
            Edge(
                "find_config",
                "run_tests",
                condition="Config change made",
                pitfalls="Don't run the full suite first",
                facts={"excalidraw": EdgeFacts(commands=["yarn test:app --watch=false"], dead_ends=["jest.config.js does not exist"])},
            ),
            Edge("run_tests", "end"),
        ],
    )


def seeded(store: GraphStore) -> GraphStore:
    store.create_graph("g", "test graph")
    c = store.propose("g", chain_edits())
    store.commit("g", c.id, score=1.0)
    return store


def test_create_and_list(store):
    info = store.create_graph("g", "desc")
    assert (info.graph_id, info.head) == ("g", 0)
    assert [i.graph_id for i in store.list_graphs()] == ["g"]
    assert store.snapshot("g").nodes == {}
    with pytest.raises(GraphExists):
        store.create_graph("g")
    with pytest.raises(GraphNotFound):
        store.head("missing")


def test_commit_round_trips_all_fields(store):
    seeded(store)
    assert store.head("g") == 1
    g = store.snapshot("g")
    assert set(g.nodes) == {"start", "find_config", "run_tests", "end"}
    edge = g.edges[("find_config", "run_tests")]
    assert edge.facts["excalidraw"].commands == ["yarn test:app --watch=false"]
    assert edge.pitfalls == "Don't run the full suite first"
    assert g.nodes["run_tests"].type is NodeType.ACTION


def test_neighborhood_hops_and_direction(store):
    seeded(store)
    out2 = store.neighborhood("g", ["start"], hops=2)
    assert set(out2.nodes) == {"start", "find_config", "run_tests"}
    assert set(out2.edges) == {("start", "find_config"), ("find_config", "run_tests")}
    assert set(store.neighborhood("g", ["end"], hops=1).nodes) == {"end"}
    assert set(store.neighborhood("g", ["end"], hops=1, direction="in").nodes) == {"end", "run_tests"}
    with pytest.raises(NodeNotFound):
        store.neighborhood("g", ["nope"])


def test_match_nodes_and_get_nodes(store):
    seeded(store)
    assert [n.id for n in store.match_nodes("g", "yarn test --watch=false")] == ["run_tests"]
    assert [n.id for n in store.match_nodes("g", "rg -n config packages/")] == ["find_config"]
    assert store.match_nodes("g", "ls") == []
    assert set(store.get_nodes("g", ["start", "missing"])) == {"start"}


def test_candidate_view_does_not_touch_head(store):
    seeded(store)
    c = store.propose("g", EditSet(add_nodes=[Node("lint", NodeType.ACTION, "Run linter")], add_edges=[Edge("run_tests", "lint")]))
    assert c.status is CandidateStatus.PENDING and c.base_version == 1
    assert "lint" in store.snapshot("g", at=c.id).nodes
    assert "lint" in store.neighborhood("g", ["run_tests"], hops=1, at=c.id).nodes
    assert "lint" not in store.snapshot("g").nodes
    assert store.head("g") == 1


def test_reject_keeps_rejection_memory(store):
    seeded(store)
    c = store.propose("g", EditSet(delete_nodes=["find_config"]), rationale="seems unused")
    store.reject("g", c.id, reason="validation score dropped 0.8 -> 0.6", score=0.6)
    rejected = store.candidates("g", CandidateStatus.REJECTED)
    assert [(r.id, r.reason, r.rationale) for r in rejected] == [(c.id, "validation score dropped 0.8 -> 0.6", "seems unused")]
    assert "find_config" in store.snapshot("g").nodes
    with pytest.raises(Conflict):
        store.commit("g", c.id)


def test_commit_conflicts_when_head_moved(store):
    seeded(store)
    a = store.propose("g", EditSet(add_nodes=[Node("a", NodeType.STATE, "a")]))
    b = store.propose("g", EditSet(add_nodes=[Node("b", NodeType.STATE, "b")]))
    assert store.commit("g", a.id) == 2
    with pytest.raises(Conflict):
        store.commit("g", b.id)
    assert "b" not in store.snapshot("g").nodes


def test_invalid_edits_are_refused(store):
    seeded(store)
    with pytest.raises(InvalidEdit) as e:
        store.propose("g", EditSet(add_edges=[Edge("start", "ghost")], delete_nodes=["nope"]))
    assert len(e.value.errors) == 2
    with pytest.raises(InvalidEdit):
        store.propose("g", EditSet())
    with pytest.raises(InvalidEdit):
        store.propose("g", EditSet(add_nodes=[Node("bad", NodeType.ACTION, "x", command_patterns=["(unclosed"])]))
    assert store.candidates("g", CandidateStatus.PENDING) == []


def test_delete_node_removes_its_edges(store):
    seeded(store)
    c = store.propose("g", EditSet(delete_nodes=["find_config"]))
    store.commit("g", c.id)
    assert set(store.snapshot("g").edges) == {("run_tests", "end")}


def test_add_existing_replaces_attributes(store):
    seeded(store)
    c = store.propose("g", EditSet(add_edges=[Edge("start", "find_config", guidance="Check packages/excalidraw first")]))
    store.commit("g", c.id)
    assert store.snapshot("g").edges[("start", "find_config")].guidance == "Check packages/excalidraw first"


def test_diff_reproduces_history(store):
    seeded(store)
    c = store.propose(
        "g",
        EditSet(
            delete_nodes=["find_config"],
            add_nodes=[Node("lint", NodeType.ACTION, "Run linter")],
            add_edges=[Edge("start", "run_tests"), Edge("run_tests", "lint")],
        ),
    )
    store.commit("g", c.id)
    d = store.diff("g", 1, 2)
    assert [n.id for n in d.add_nodes] == ["lint"]
    assert d.delete_nodes == ["find_config"]
    assert sorted(d.delete_edges) == [("find_config", "run_tests"), ("start", "find_config")]

    # Replaying the diff on version 1 gives version 2.
    replay = store.propose("g", d, base_version=1)
    assert store.snapshot("g", at=replay.id) == store.snapshot("g", at=2)
