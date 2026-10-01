class StoreError(Exception):
    pass


class GraphNotFound(StoreError):
    pass


class GraphExists(StoreError):
    pass


class CandidateNotFound(StoreError):
    pass


class NodeNotFound(StoreError):
    def __init__(self, node_ids: list[str]):
        super().__init__(f"no such node(s): {', '.join(node_ids)}")
        self.node_ids = node_ids


class InvalidEdit(StoreError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


class Conflict(StoreError):
    """The graph moved on since the candidate was proposed, or it was already decided."""
