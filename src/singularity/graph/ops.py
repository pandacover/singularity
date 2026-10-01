"""Pure operations on in-memory graphs.

Backends that keep graphs in memory or in files use these directly. A graph DB
backend would implement the same semantics as queries instead.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterable
from typing import Literal

from .errors import InvalidEdit, NodeNotFound
from .models import EditSet, Graph, Node

Direction = Literal["out", "in", "both"]


def apply_edits(graph: Graph, edits: EditSet) -> Graph:
    """Return a copy of `graph` with `edits` applied. Raises InvalidEdit."""
    g = copy.deepcopy(graph)
    errors: list[str] = []

    for key in edits.delete_edges:
        if key in g.edges:
            del g.edges[key]
        else:
            errors.append(f"delete_edges: no edge {key[0]} -> {key[1]}")

    for node_id in edits.delete_nodes:
        if node_id in g.nodes:
            del g.nodes[node_id]
            g.edges = {k: e for k, e in g.edges.items() if node_id not in k}
        else:
            errors.append(f"delete_nodes: no node {node_id}")

    seen_nodes: set[str] = set()
    for node in edits.add_nodes:
        if node.id in seen_nodes:
            errors.append(f"add_nodes: {node.id} listed twice")
        seen_nodes.add(node.id)
        for pattern in node.command_patterns:
            try:
                re.compile(pattern)
            except re.error as exc:
                errors.append(f"add_nodes: {node.id} has invalid command pattern {pattern!r}: {exc}")
        g.nodes[node.id] = copy.deepcopy(node)

    seen_edges: set[tuple[str, str]] = set()
    for edge in edits.add_edges:
        if edge.key in seen_edges:
            errors.append(f"add_edges: {edge.source} -> {edge.target} listed twice")
        seen_edges.add(edge.key)
        missing = [n for n in (edge.source, edge.target) if n not in g.nodes]
        if missing:
            errors.append(f"add_edges: {edge.source} -> {edge.target} references missing node(s) {', '.join(missing)}")
            continue
        g.edges[edge.key] = copy.deepcopy(edge)

    if errors:
        raise InvalidEdit(errors)
    return g


def diff(old: Graph, new: Graph) -> EditSet:
    """Edits that turn `old` into `new`: apply_edits(old, diff(old, new)) == new."""
    return EditSet(
        add_nodes=[n for k, n in sorted(new.nodes.items()) if old.nodes.get(k) != n],
        delete_nodes=sorted(k for k in old.nodes if k not in new.nodes),
        add_edges=[e for k, e in sorted(new.edges.items()) if old.edges.get(k) != e],
        delete_edges=sorted(k for k in old.edges if k not in new.edges),
    )


def neighborhood(graph: Graph, seeds: Iterable[str], hops: int = 2, direction: Direction = "out") -> Graph:
    """Nodes within `hops` of any seed, plus every edge between them."""
    seeds = list(seeds)
    missing = [s for s in seeds if s not in graph.nodes]
    if missing:
        raise NodeNotFound(missing)

    visited = set(seeds)
    frontier = set(seeds)
    for _ in range(hops):
        nxt: set[str] = set()
        for source, target in graph.edges:
            if direction in ("out", "both") and source in frontier:
                nxt.add(target)
            if direction in ("in", "both") and target in frontier:
                nxt.add(source)
        frontier = nxt - visited
        visited |= frontier
        if not frontier:
            break

    return Graph(
        nodes={k: graph.nodes[k] for k in visited},
        edges={k: e for k, e in graph.edges.items() if k[0] in visited and k[1] in visited},
    )


def match_nodes(graph: Graph, command: str) -> list[Node]:
    """Nodes whose command patterns match `command`, sorted by id."""
    return [
        n
        for _, n in sorted(graph.nodes.items())
        if any(re.search(p, command) for p in n.command_patterns)
    ]
