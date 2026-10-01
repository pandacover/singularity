"""Storage interface for procedural graphs.

Designed so a graph DB can implement it: callers query what they need
(neighborhoods, pattern matches) instead of loading whole graphs, and
versioning is part of the interface rather than left to files and git.

Versioning model:
- Each graph has a linear history of committed versions, starting at 0 (empty).
- The refiner proposes a Candidate: an EditSet against a base version.
- Reads can target a candidate (pass its id as `at`), so validation runs can
  use the candidate graph without committing it.
- commit() makes the candidate the new head only if the head hasn't moved
  since it was proposed. reject() keeps it with a reason, as rejection memory.

The `at` argument on reads: None for head, an int for a committed version,
or a str candidate id for that candidate's view.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable

from .models import Candidate, CandidateStatus, EditSet, Graph, GraphInfo, Node
from .ops import Direction

At = int | str | None


class GraphStore(ABC):
    # --- graphs ---

    @abstractmethod
    def create_graph(self, graph_id: str, description: str = "") -> GraphInfo:
        """Create an empty graph at version 0. Raises GraphExists."""

    @abstractmethod
    def list_graphs(self) -> list[GraphInfo]: ...

    @abstractmethod
    def head(self, graph_id: str) -> int:
        """Latest committed version."""

    # --- reads ---

    @abstractmethod
    def get_nodes(self, graph_id: str, node_ids: Iterable[str], at: At = None) -> dict[str, Node]:
        """The requested nodes that exist; missing ids are left out."""

    @abstractmethod
    def match_nodes(self, graph_id: str, command: str, at: At = None) -> list[Node]:
        """Nodes whose command patterns match `command`. Used to localize the agent."""

    @abstractmethod
    def neighborhood(
        self,
        graph_id: str,
        node_ids: Iterable[str],
        hops: int = 2,
        direction: Direction = "out",
        at: At = None,
    ) -> Graph:
        """Nodes within `hops` of the given nodes and the edges between them."""

    @abstractmethod
    def snapshot(self, graph_id: str, at: At = None) -> Graph:
        """The whole graph. For the refiner and debugging, not for per-task retrieval."""

    # --- evolution ---

    @abstractmethod
    def propose(self, graph_id: str, edits: EditSet, base_version: int | None = None, rationale: str = "") -> Candidate:
        """Record a candidate against `base_version` (default: head).

        Raises InvalidEdit if the edits don't apply cleanly to the base.
        """

    @abstractmethod
    def commit(self, graph_id: str, candidate_id: str, score: float | None = None) -> int:
        """Make a pending candidate the new head and return its version.

        Raises Conflict if the head moved since the candidate's base version,
        or if the candidate is not pending.
        """

    @abstractmethod
    def reject(self, graph_id: str, candidate_id: str, reason: str, score: float | None = None) -> None:
        """Mark a pending candidate rejected. Raises Conflict if it is not pending."""

    @abstractmethod
    def get_candidate(self, graph_id: str, candidate_id: str) -> Candidate: ...

    @abstractmethod
    def candidates(self, graph_id: str, status: CandidateStatus | None = None) -> list[Candidate]:
        """Candidates oldest first. status=REJECTED gives the refiner's rejection memory."""

    @abstractmethod
    def diff(self, graph_id: str, from_version: int, to_version: int) -> EditSet:
        """Edits that turn `from_version` into `to_version`."""
