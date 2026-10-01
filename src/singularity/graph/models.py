"""Data model for procedural graphs.

Follows "Procedural Graphs" (arXiv 2609.09153): nodes are procedures, edges are
transitions carrying condition / guidance / pitfalls. Edges also carry
repo-specific facts (paths, commands, dead ends), which the paper does not have.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class NodeType(StrEnum):
    START = "start"
    ACTION = "action"
    REASONING = "reasoning"
    STATE = "state"
    END = "end"


class Relation(StrEnum):
    # The relation vocabulary used in the paper.
    LEADS_TO = "leads_to"
    TRIGGERS = "triggers"
    PROVIDES_INPUT_FOR = "provides_input_for"
    CONVERGES_TO = "converges_to"


class CandidateStatus(StrEnum):
    PENDING = "pending"
    COMMITTED = "committed"
    REJECTED = "rejected"


@dataclass
class Node:
    id: str
    type: NodeType
    description: str
    # Regexes over commands / tool calls that place the agent at this node.
    command_patterns: list[str] = field(default_factory=list)
    # A saved script or skill that performs this step outright.
    script: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type.value,
            "description": self.description,
            "command_patterns": list(self.command_patterns),
            "script": self.script,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Node:
        return cls(
            id=d["id"],
            type=NodeType(d["type"]),
            description=d.get("description", ""),
            command_patterns=list(d.get("command_patterns", [])),
            script=d.get("script"),
        )


@dataclass
class EdgeFacts:
    """Concrete details learned for one transition in one repo."""

    paths: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    dead_ends: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"paths": list(self.paths), "commands": list(self.commands), "dead_ends": list(self.dead_ends)}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EdgeFacts:
        return cls(
            paths=list(d.get("paths", [])),
            commands=list(d.get("commands", [])),
            dead_ends=list(d.get("dead_ends", [])),
        )


EdgeKey = tuple[str, str]


@dataclass
class Edge:
    source: str
    target: str
    relation: Relation = Relation.LEADS_TO
    condition: str | None = None
    guidance: str | None = None
    pitfalls: str | None = None
    # Keyed by repo id. condition/guidance/pitfalls stay general; anything tied
    # to one repo goes here so it doesn't leak into guidance for other repos.
    facts: dict[str, EdgeFacts] = field(default_factory=dict)

    @property
    def key(self) -> EdgeKey:
        return (self.source, self.target)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "target": self.target,
            "relation": self.relation.value,
            "condition": self.condition,
            "guidance": self.guidance,
            "pitfalls": self.pitfalls,
            "facts": {repo: f.to_dict() for repo, f in sorted(self.facts.items())},
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Edge:
        return cls(
            source=d["source"],
            target=d["target"],
            relation=Relation(d.get("relation", Relation.LEADS_TO)),
            condition=d.get("condition"),
            guidance=d.get("guidance"),
            pitfalls=d.get("pitfalls"),
            facts={repo: EdgeFacts.from_dict(f) for repo, f in d.get("facts", {}).items()},
        )


@dataclass
class Graph:
    """A full graph or a subgraph returned by a query."""

    nodes: dict[str, Node] = field(default_factory=dict)
    edges: dict[EdgeKey, Edge] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        # Sorted so snapshots diff cleanly.
        return {
            "nodes": [self.nodes[k].to_dict() for k in sorted(self.nodes)],
            "edges": [self.edges[k].to_dict() for k in sorted(self.edges)],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Graph:
        nodes = [Node.from_dict(n) for n in d.get("nodes", [])]
        edges = [Edge.from_dict(e) for e in d.get("edges", [])]
        return cls(nodes={n.id: n for n in nodes}, edges={e.key: e for e in edges})


@dataclass
class EditSet:
    """A batch of edits, in the paper's refiner output format.

    Applied in the paper's order: delete edges, delete nodes, add nodes, add
    edges. Adding a node or edge that already exists replaces it, which is how
    attributes get revised. Deleting a node also deletes its edges.
    """

    add_nodes: list[Node] = field(default_factory=list)
    delete_nodes: list[str] = field(default_factory=list)
    add_edges: list[Edge] = field(default_factory=list)
    delete_edges: list[EdgeKey] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.add_nodes or self.delete_nodes or self.add_edges or self.delete_edges)

    def to_dict(self) -> dict[str, Any]:
        return {
            "add_nodes": [n.to_dict() for n in self.add_nodes],
            "delete_nodes": list(self.delete_nodes),
            "add_edges": [e.to_dict() for e in self.add_edges],
            "delete_edges": [{"source": s, "target": t} for s, t in self.delete_edges],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EditSet:
        return cls(
            add_nodes=[Node.from_dict(n) for n in d.get("add_nodes", [])],
            delete_nodes=list(d.get("delete_nodes", [])),
            add_edges=[Edge.from_dict(e) for e in d.get("add_edges", [])],
            delete_edges=[(e["source"], e["target"]) for e in d.get("delete_edges", [])],
        )


@dataclass
class Candidate:
    """A proposed edit set against a base version, awaiting validation."""

    id: str
    graph_id: str
    base_version: int
    edits: EditSet
    rationale: str = ""
    status: CandidateStatus = CandidateStatus.PENDING
    score: float | None = None
    # Why it was rejected; fed back to the refiner as negative evidence.
    reason: str = ""
    committed_version: int | None = None
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "graph_id": self.graph_id,
            "base_version": self.base_version,
            "edits": self.edits.to_dict(),
            "rationale": self.rationale,
            "status": self.status.value,
            "score": self.score,
            "reason": self.reason,
            "committed_version": self.committed_version,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Candidate:
        return cls(
            id=d["id"],
            graph_id=d["graph_id"],
            base_version=d["base_version"],
            edits=EditSet.from_dict(d["edits"]),
            rationale=d.get("rationale", ""),
            status=CandidateStatus(d.get("status", CandidateStatus.PENDING)),
            score=d.get("score"),
            reason=d.get("reason", ""),
            committed_version=d.get("committed_version"),
            created_at=d.get("created_at", ""),
        )


@dataclass
class GraphInfo:
    graph_id: str
    description: str
    head: int
