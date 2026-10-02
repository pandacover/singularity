/**
 * Procedural graph storage: the data model, the `GraphStore` service and its
 * JSON-file implementation, and pure operations on in-memory graphs.
 */
export {
  CandidateNotFound,
  Conflict,
  GraphExists,
  GraphNotFound,
  type GraphStoreError,
  InvalidEdit,
  NodeNotFound,
  StoreError
} from "./Errors.ts"
export {
  type At,
  GraphStore,
  type NeighborhoodOptions,
  type ProposeOptions,
  type ReadError,
  type ReadOptions,
  type ScoreOptions,
  type SearchOptions
} from "./GraphStore.ts"
export * as JsonGraphStore from "./JsonGraphStore.ts"
export {
  Candidate,
  CandidateStatus,
  Edge,
  EdgeFacts,
  type EdgeKey,
  edgeKey,
  EdgeRef,
  EditSet,
  Graph,
  GraphInfo,
  GraphJson,
  Node,
  NodeType,
  Relation
} from "./Models.ts"
export * as Ops from "./Ops.ts"
export type { Direction, NodeMatch } from "./Ops.ts"
export { textSimilarity } from "./Similarity.ts"
