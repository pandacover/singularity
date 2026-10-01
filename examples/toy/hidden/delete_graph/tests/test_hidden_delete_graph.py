import pytest

from singularity.graph import EditSet, GraphNotFound, JsonGraphStore, Node, NodeType


def test_delete_graph(tmp_path):
    store = JsonGraphStore(tmp_path)
    store.create_graph("a")
    store.create_graph("b")
    c = store.propose("a", EditSet(add_nodes=[Node("n", NodeType.ACTION, "n")]))
    store.commit("a", c.id)

    store.delete_graph("a")
    assert [g.graph_id for g in store.list_graphs()] == ["b"]
    with pytest.raises(GraphNotFound):
        store.head("a")
    with pytest.raises(GraphNotFound):
        store.delete_graph("a")

    store.create_graph("a")
    assert store.head("a") == 0
    assert store.candidates("a") == []
