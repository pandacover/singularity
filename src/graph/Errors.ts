/**
 * Errors raised by graph stores.
 *
 * Python had a `StoreError` base class with the others as subclasses. Tagged
 * errors have no hierarchy, so `GraphStoreError` is the union of all of them.
 * Messages match the Python version's `str(error)`.
 */
import { Schema } from "effect"

/**
 * A store operation failed: invalid graph id, missing version, or a file that
 * can't be read, written or decoded (Python raised OSError or KeyError there).
 */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export class GraphNotFound extends Schema.TaggedError<GraphNotFound>()("GraphNotFound", {
  graphId: Schema.String
}) {
  override get message(): string {
    return this.graphId
  }
}

export class GraphExists extends Schema.TaggedError<GraphExists>()("GraphExists", {
  graphId: Schema.String
}) {
  override get message(): string {
    return this.graphId
  }
}

export class CandidateNotFound extends Schema.TaggedError<CandidateNotFound>()("CandidateNotFound", {
  graphId: Schema.String,
  candidateId: Schema.String
}) {
  override get message(): string {
    return `${this.graphId}/${this.candidateId}`
  }
}

export class NodeNotFound extends Schema.TaggedError<NodeNotFound>()("NodeNotFound", {
  nodeIds: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `no such node(s): ${this.nodeIds.join(", ")}`
  }
}

/** The edits don't apply cleanly. `errors` lists every problem found, not just the first. */
export class InvalidEdit extends Schema.TaggedError<InvalidEdit>()("InvalidEdit", {
  errors: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return this.errors.join("; ")
  }
}

/** The graph moved on since the candidate was proposed, or the candidate was already decided. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String
}) {}

export type GraphStoreError =
  | StoreError
  | GraphNotFound
  | GraphExists
  | CandidateNotFound
  | NodeNotFound
  | InvalidEdit
  | Conflict
