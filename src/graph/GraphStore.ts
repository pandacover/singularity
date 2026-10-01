/**
 * Storage interface for procedural graphs.
 *
 * Designed so a graph database can implement it: callers query what they need
 * (neighborhoods, pattern matches) instead of loading whole graphs, and
 * versioning is part of the interface rather than left to files and git.
 *
 * Versioning model:
 * - Each graph has a linear history of committed versions, starting at 0 (empty).
 * - The refiner proposes a Candidate: an EditSet against a base version.
 * - Reads can target a candidate (pass its id as `at`), so validation runs can
 *   use the candidate graph without committing it.
 * - commit() makes the candidate the new head only if the head hasn't moved
 *   since it was proposed. reject() keeps it with a reason, as rejection memory.
 *
 * Implementations are layers: `JsonGraphStore.layer(root)` keeps graphs in JSON files.
 */
import { Context, type Effect } from "effect"
import type { CandidateNotFound, Conflict, GraphExists, GraphNotFound, InvalidEdit, NodeNotFound, StoreError } from "./Errors.ts"
import type { Candidate, CandidateStatus, EditSet, Graph, GraphInfo, Node } from "./Models.ts"
import type { Direction } from "./Ops.ts"

/** The version a read sees: undefined for head, a number for a committed version, a candidate id for that candidate's view. */
export type At = number | string | undefined

export interface ReadOptions {
  readonly at?: At
}

export interface NeighborhoodOptions extends ReadOptions {
  /** Default 2. */
  readonly hops?: number
  /** Which edges to follow from a node. Default "out". */
  readonly direction?: Direction
}

export interface ProposeOptions {
  /** Default: head. */
  readonly baseVersion?: number
  readonly rationale?: string
}

export interface ScoreOptions {
  /** The validation score that decided the candidate. */
  readonly score?: number
}

/** Failures of reads. InvalidEdit only when `at` names a candidate whose edits no longer apply. */
export type ReadError = GraphNotFound | CandidateNotFound | InvalidEdit | StoreError

export class GraphStore extends Context.Service<GraphStore, {
  // --- graphs ---

  /** Create an empty graph at version 0. */
  createGraph(graphId: string, description?: string): Effect.Effect<GraphInfo, GraphExists | StoreError>
  listGraphs(): Effect.Effect<ReadonlyArray<GraphInfo>, StoreError>
  /** Latest committed version. */
  head(graphId: string): Effect.Effect<number, GraphNotFound | StoreError>

  // --- reads ---

  /** The requested nodes that exist; missing ids are left out. */
  getNodes(
    graphId: string,
    nodeIds: Iterable<string>,
    options?: ReadOptions
  ): Effect.Effect<ReadonlyMap<string, Node>, ReadError>
  /** Nodes whose command patterns match `command`, sorted by id. Used to localize the agent. */
  matchNodes(graphId: string, command: string, options?: ReadOptions): Effect.Effect<ReadonlyArray<Node>, ReadError>
  /** Nodes within `hops` of the given nodes and the edges between them. */
  neighborhood(
    graphId: string,
    nodeIds: Iterable<string>,
    options?: NeighborhoodOptions
  ): Effect.Effect<Graph, ReadError | NodeNotFound>
  /** The whole graph. For the refiner and debugging, not for per-task retrieval. */
  snapshot(graphId: string, options?: ReadOptions): Effect.Effect<Graph, ReadError>

  // --- evolution ---

  /** Record a candidate against a base version. Fails with InvalidEdit if the edits don't apply cleanly to the base. */
  propose(
    graphId: string,
    edits: EditSet,
    options?: ProposeOptions
  ): Effect.Effect<Candidate, GraphNotFound | InvalidEdit | StoreError>
  /**
   * Make a pending candidate the new head and return its version. Fails with
   * Conflict if the head moved since the candidate's base version, or if the
   * candidate is not pending.
   */
  commit(
    graphId: string,
    candidateId: string,
    options?: ScoreOptions
  ): Effect.Effect<number, GraphNotFound | CandidateNotFound | Conflict | InvalidEdit | StoreError>
  /** Mark a pending candidate rejected. Fails with Conflict if it is not pending. */
  reject(
    graphId: string,
    candidateId: string,
    reason: string,
    options?: ScoreOptions
  ): Effect.Effect<void, GraphNotFound | CandidateNotFound | Conflict | StoreError>
  getCandidate(graphId: string, candidateId: string): Effect.Effect<Candidate, GraphNotFound | CandidateNotFound | StoreError>
  /** Candidates oldest first. Status "rejected" gives the refiner's rejection memory. */
  candidates(graphId: string, status?: CandidateStatus): Effect.Effect<ReadonlyArray<Candidate>, GraphNotFound | StoreError>
  /** Edits that turn `fromVersion` into `toVersion`. */
  diff(graphId: string, fromVersion: number, toVersion: number): Effect.Effect<EditSet, GraphNotFound | StoreError>
}>()("singularity/graph/GraphStore") {}
