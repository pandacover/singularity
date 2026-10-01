/**
 * Pure operations on in-memory graphs.
 *
 * Backends that keep graphs in memory or in files use these directly. A graph
 * database backend would implement the same semantics as queries instead.
 */
import { Equal, Result } from "effect"
import { InvalidEdit, NodeNotFound } from "./Errors.ts"
import { type EdgeKey, edgeKey, EditSet, Graph, type Node } from "./Models.ts"
import { compareCodePoints, repr } from "./PythonCompat.ts"

export type Direction = "out" | "in" | "both"

/**
 * Why `pattern` can't be used as a command pattern, or undefined if it can.
 * Patterns are JavaScript regular expressions without flags.
 */
export const patternError = (pattern: string): string | undefined => {
  try {
    new RegExp(pattern)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A copy of `graph` with `edits` applied. Every problem found goes into one InvalidEdit. */
export const applyEdits = (graph: Graph, edits: EditSet): Result.Result<Graph, InvalidEdit> => {
  const nodes = new Map(graph.nodes)
  const edges = new Map(graph.edges)
  const errors: Array<string> = []

  for (const { source, target } of edits.delete_edges) {
    if (!edges.delete(edgeKey(source, target))) {
      errors.push(`delete_edges: no edge ${source} -> ${target}`)
    }
  }

  for (const nodeId of edits.delete_nodes) {
    if (nodes.delete(nodeId)) {
      for (const [key, edge] of edges) {
        if (edge.source === nodeId || edge.target === nodeId) edges.delete(key)
      }
    } else {
      errors.push(`delete_nodes: no node ${nodeId}`)
    }
  }

  const seenNodes = new Set<string>()
  for (const node of edits.add_nodes) {
    if (seenNodes.has(node.id)) errors.push(`add_nodes: ${node.id} listed twice`)
    seenNodes.add(node.id)
    for (const pattern of node.command_patterns) {
      const problem = patternError(pattern)
      if (problem !== undefined) {
        errors.push(`add_nodes: ${node.id} has invalid command pattern ${repr(pattern)}: ${problem}`)
      }
    }
    nodes.set(node.id, node)
  }

  const seenEdges = new Set<EdgeKey>()
  for (const edge of edits.add_edges) {
    if (seenEdges.has(edge.key)) errors.push(`add_edges: ${edge.source} -> ${edge.target} listed twice`)
    seenEdges.add(edge.key)
    const missing = [edge.source, edge.target].filter((id) => !nodes.has(id))
    if (missing.length > 0) {
      errors.push(`add_edges: ${edge.source} -> ${edge.target} references missing node(s) ${missing.join(", ")}`)
      continue
    }
    edges.set(edge.key, edge)
  }

  return errors.length > 0 ? Result.fail(new InvalidEdit({ errors })) : Result.succeed(new Graph({ nodes, edges }))
}

/** Edits that turn `from` into `to`: applyEdits(from, diff(from, to)) equals `to`. */
export const diff = (from: Graph, to: Graph): EditSet => {
  const changed = <A>(before: A | undefined, after: A) => before === undefined || !Equal.equals(before, after)
  return new EditSet({
    add_nodes: to.sortedNodes().filter((node) => changed(from.nodes.get(node.id), node)),
    delete_nodes: Array.from(from.nodes.keys()).filter((id) => !to.nodes.has(id)).sort(compareCodePoints),
    add_edges: to.sortedEdges().filter((edge) => changed(from.edges.get(edge.key), edge)),
    delete_edges: from.sortedEdges()
      .filter((edge) => !to.edges.has(edge.key))
      .map(({ source, target }) => ({ source, target }))
  })
}

/** Nodes within `hops` of any seed, plus every edge between them. */
export const neighborhood = (
  graph: Graph,
  seeds: Iterable<string>,
  hops = 2,
  direction: Direction = "out"
): Result.Result<Graph, NodeNotFound> => {
  const seedIds = Array.from(seeds)
  const missing = seedIds.filter((id) => !graph.nodes.has(id))
  if (missing.length > 0) return Result.fail(new NodeNotFound({ nodeIds: missing }))

  const followOut = direction === "out" || direction === "both"
  const followIn = direction === "in" || direction === "both"
  const visited = new Set(seedIds)
  let frontier = new Set(seedIds)
  for (let hop = 0; hop < hops; hop++) {
    const next = new Set<string>()
    for (const { source, target } of graph.edges.values()) {
      if (followOut && frontier.has(source)) next.add(target)
      if (followIn && frontier.has(target)) next.add(source)
    }
    frontier = new Set(Array.from(next).filter((id) => !visited.has(id)))
    for (const id of frontier) visited.add(id)
    if (frontier.size === 0) break
  }

  return Result.succeed(
    new Graph({
      nodes: new Map(Array.from(graph.nodes).filter(([id]) => visited.has(id))),
      edges: new Map(
        Array.from(graph.edges).filter(([, edge]) => visited.has(edge.source) && visited.has(edge.target))
      )
    })
  )
}

/** Nodes whose command patterns match `command`, sorted by id. Patterns that don't compile never match. */
export const matchNodes = (graph: Graph, command: string): Array<Node> =>
  graph.sortedNodes().filter((node) => node.command_patterns.some((pattern) => search(pattern, command)))

const search = (pattern: string, text: string): boolean => {
  try {
    return new RegExp(pattern).test(text)
  } catch {
    return false
  }
}
