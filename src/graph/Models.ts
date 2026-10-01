/**
 * Data model for procedural graphs.
 *
 * Follows "Procedural Graphs" (arXiv 2609.09153): nodes are procedures, edges are
 * transitions carrying condition / guidance / pitfalls. Edges also carry
 * repo-specific facts (paths, commands, dead ends), which the paper does not have.
 *
 * Fields use the snake_case keys of the Python version's JSON files, and each
 * schema's encoded form is that JSON. Keys missing from a file decode to the
 * defaults Python's `from_dict` used.
 */
import { Effect, Schema, SchemaTransformation } from "effect"
import { compareCodePoints } from "./PythonCompat.ts"

export const NodeType = Schema.Literals(["start", "action", "reasoning", "state", "end"])
export type NodeType = typeof NodeType.Type

/** The relation vocabulary used in the paper. */
export const Relation = Schema.Literals(["leads_to", "triggers", "provides_input_for", "converges_to"])
export type Relation = typeof Relation.Type

export const CandidateStatus = Schema.Literals(["pending", "committed", "rejected"])
export type CandidateStatus = typeof CandidateStatus.Type

/** The key may be missing from a file; it decodes to `value()`. */
const decodeDefault = <S extends Schema.Top>(value: () => S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.sync(value))

/** Optional both in files and in the constructor, like a dataclass field with a default. */
const withDefault = <S extends Schema.Top & Schema.WithoutConstructorDefault>(
  value: () => S["Encoded"] & S["~type.make.in"]
) =>
(schema: S) => schema.pipe(decodeDefault<S>(value), Schema.withConstructorDefault(Effect.sync(value)))

const strings = () => Schema.Array(Schema.String).pipe(withDefault(() => []))
const optionalText = () => Schema.NullOr(Schema.String).pipe(withDefault(() => null))

export class Node extends Schema.Class<Node>("singularity/graph/Node")({
  id: Schema.String,
  type: NodeType,
  description: Schema.String.pipe(decodeDefault(() => "")),
  /** Regexes over commands / tool calls that place the agent at this node. */
  command_patterns: strings(),
  /** A saved script or skill that performs this step outright. */
  script: optionalText()
}) {}

/** Concrete details learned for one transition in one repo. */
export class EdgeFacts extends Schema.Class<EdgeFacts>("singularity/graph/EdgeFacts")({
  paths: strings(),
  commands: strings(),
  dead_ends: strings()
}) {}

/**
 * Key of an edge in `Graph.edges`, made from its (source, target) pair.
 * Python keyed edges by the tuple itself.
 */
export type EdgeKey = string

export const edgeKey = (source: string, target: string): EdgeKey => JSON.stringify([source, target])

export class Edge extends Schema.Class<Edge>("singularity/graph/Edge")({
  source: Schema.String,
  target: Schema.String,
  relation: Relation.pipe(withDefault((): Relation => "leads_to")),
  condition: optionalText(),
  guidance: optionalText(),
  pitfalls: optionalText(),
  /**
   * Keyed by repo id. condition/guidance/pitfalls stay general; anything tied
   * to one repo goes here so it doesn't leak into guidance for other repos.
   */
  facts: Schema.Record(Schema.String, EdgeFacts).pipe(withDefault(() => ({})))
}) {
  get key(): EdgeKey {
    return edgeKey(this.source, this.target)
  }
}

/** An edge named by its endpoints, as in `EditSet.delete_edges`. Python used (source, target) tuples. */
export const EdgeRef = Schema.Struct({ source: Schema.String, target: Schema.String })
export type EdgeRef = typeof EdgeRef.Type

const byId = (a: Node, b: Node) => compareCodePoints(a.id, b.id)

/** Python's order for edge keys: by source, then target. */
const byEnds = (a: EdgeRef, b: EdgeRef) => compareCodePoints(a.source, b.source) || compareCodePoints(a.target, b.target)

/** A full graph or a subgraph returned by a query. */
export class Graph extends Schema.Class<Graph>("singularity/graph/Graph")({
  nodes: Schema.ReadonlyMap(Schema.String, Node),
  edges: Schema.ReadonlyMap(Schema.String, Edge)
}) {
  /** A graph keyed by node id and edge key. Later duplicates replace earlier ones. */
  static fromArrays(nodes: Iterable<Node>, edges: Iterable<Edge>): Graph {
    return new Graph({
      nodes: new Map(Array.from(nodes, (node) => [node.id, node])),
      edges: new Map(Array.from(edges, (edge) => [edge.key, edge]))
    })
  }

  /** Nodes sorted by id. */
  sortedNodes(): Array<Node> {
    return Array.from(this.nodes.values()).sort(byId)
  }

  /** Edges sorted by (source, target). */
  sortedEdges(): Array<Edge> {
    return Array.from(this.edges.values()).sort(byEnds)
  }
}

/**
 * The JSON form of a graph: node and edge lists, sorted so snapshots diff
 * cleanly. Python's `Graph.to_dict` and `Graph.from_dict`.
 */
export const GraphJson = Schema.Struct({
  nodes: Schema.Array(Node).pipe(decodeDefault(() => [])),
  edges: Schema.Array(Edge).pipe(decodeDefault(() => []))
}).pipe(
  Schema.decodeTo(
    Schema.toType(Graph),
    SchemaTransformation.transform({
      decode: ({ edges, nodes }) => Graph.fromArrays(nodes, edges),
      encode: (graph) => ({ nodes: graph.sortedNodes(), edges: graph.sortedEdges() })
    })
  )
)

/**
 * A batch of edits, in the paper's refiner output format.
 *
 * Applied in the paper's order: delete edges, delete nodes, add nodes, add
 * edges. Adding a node or edge that already exists replaces it, which is how
 * attributes get revised. Deleting a node also deletes its edges.
 */
export class EditSet extends Schema.Class<EditSet>("singularity/graph/EditSet")({
  add_nodes: Schema.Array(Node).pipe(withDefault(() => [])),
  delete_nodes: strings(),
  add_edges: Schema.Array(Edge).pipe(withDefault(() => [])),
  delete_edges: Schema.Array(EdgeRef).pipe(withDefault(() => []))
}) {
  isEmpty(): boolean {
    return this.add_nodes.length === 0 && this.delete_nodes.length === 0 && this.add_edges.length === 0 &&
      this.delete_edges.length === 0
  }
}

/** A proposed edit set against a base version, awaiting validation. */
export class Candidate extends Schema.Class<Candidate>("singularity/graph/Candidate")({
  id: Schema.String,
  graph_id: Schema.String,
  base_version: Schema.Int,
  edits: EditSet,
  rationale: Schema.String.pipe(withDefault(() => "")),
  status: CandidateStatus.pipe(withDefault((): CandidateStatus => "pending")),
  score: Schema.NullOr(Schema.Finite).pipe(withDefault(() => null)),
  /** Why it was rejected; fed back to the refiner as negative evidence. */
  reason: Schema.String.pipe(withDefault(() => "")),
  committed_version: Schema.NullOr(Schema.Int).pipe(withDefault(() => null)),
  created_at: Schema.String.pipe(withDefault(() => ""))
}) {}

export class GraphInfo extends Schema.Class<GraphInfo>("singularity/graph/GraphInfo")({
  graph_id: Schema.String,
  description: Schema.String,
  head: Schema.Int
}) {}
