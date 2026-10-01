import pytest

from singularity.graph import EditSet, GraphExists, GraphNotFound, JsonGraphStore, Node, NodeType


def test_rename_graph(tmp_path):
    store = JsonGraphStore(tmp_path)
    store.create_graph("a", "desc")
    store.create_graph("b")
    c = store.propose("a", EditSet(add_nodes=[Node("n", NodeType.ACTION, "n")]))
    store.commit("a", c.id)

    store.rename_graph("a", "c")
    assert sorted(g.graph_id for g in store.list_graphs()) == ["b", "c"]
    assert store.head("c") == 1
    assert "n" in store.snapshot("c").nodes
    assert store.get_candidate("c", c.id).graph_id == "c"
    with pytest.raises(GraphNotFound):
        store.head("a")

    with pytest.raises(GraphExists):
        store.rename_graph("c", "b")
    with pytest.raises(GraphNotFound):
        store.rename_graph("missing", "d")
