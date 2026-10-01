/**
 * The procedural graph as a memory setup.
 *
 * Before a run, once: find the steps whose descriptions share words with the
 * task prompt, and take the part of the graph within two steps of them (and of
 * the start). A small model then reads the task and those steps with their
 * conditions and picks the ones that apply (StepSelector); word overlap alone
 * can't read conditions or "don't add a shortcut". The agent gets the chosen
 * steps as an ordered checklist with each step's conditions, guidance,
 * pitfalls and repository facts. There's no per-step guidance call (the
 * paper's online mode), which is where its extra token cost came from. The
 * selection call's cost counts toward the run.
 *
 * After a run (unless frozen): an LLM turns the run into graph edits
 * (GraphLearner), committed as the next version. One graph per repository; its
 * id and the key for repository facts are both the suite name.
 *
 * Like saved-scripts, retrieval sees only the prompt text, never task ids.
 */
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import type { Edge, Graph } from "../graph/index.ts"
import { GraphStore, JsonGraphStore } from "../graph/index.ts"
import { compareCodePoints } from "../graph/PythonCompat.ts"
import type { LearnerConfig } from "./GraphLearner.ts"
import { learnFromRun } from "./GraphLearner.ts"
import type { Injection, MemorySetup, Outcome } from "./Setups.ts"
import { MemoryError } from "./Setups.ts"
import type { SelectorConfig } from "./StepSelector.ts"
import { selectSteps } from "./StepSelector.ts"
import { isoNow } from "./Time.ts"

/** Matching steps used as entry points. */
export const SEED_LIMIT = 6
/** Steps whose description scores below this against the prompt aren't entry points. */
export const MIN_NODE_SCORE = 0.1
/** How far from an entry point, in either direction, candidate steps can be. */
export const HOPS = 2

export const LEARN_LOG = "learn-log.jsonl"

export interface GraphMemoryOptions {
  /** The store's root directory (the setup's memory directory). */
  readonly root: string
  /** Graph id and the key for this repository's facts. */
  readonly graphId: string
  readonly frozen: boolean
  /**
   * Hand over the graph as it was at this committed version instead of the
   * head, e.g. after learning from the first task's runs only. Read-only.
   */
  readonly version?: number | undefined
  /** Picks the steps that apply. Without it, every candidate step is handed over. */
  readonly selector?: SelectorConfig | undefined
  /** Needed only for learning. */
  readonly learner?: LearnerConfig | undefined
}

/** One line of learn-log.jsonl. */
const LogLine = Schema.Struct({ task_id: Schema.String, version: Schema.Number })

export const makeGraphMemory = (options: GraphMemoryOptions): MemorySetup => {
  const { frozen, graphId, root } = options
  const repo = graphId
  const store = JsonGraphStore.layer(root)
  const toMemoryError = (e: { readonly message: string }) =>
    e instanceof MemoryError ? e : new MemoryError({ message: `graph memory: ${e.message}` })

  /** Task ids the graph had learned from by `version`, so reports can tell exact repeats from similar tasks. */
  const sources = Effect.fn("GraphMemory.sources")(function*(version: number) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(root, LEARN_LOG)
    if (!(yield* fs.exists(file))) return [] as Array<string>
    const ids = new Set<string>()
    for (const line of (yield* fs.readFileString(file)).split(/\r?\n/)) {
      if (line.trim() === "") continue
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LogLine))(line)
      if (decoded.version <= version) ids.add(decoded.task_id)
    }
    return [...ids].sort(compareCodePoints)
  })

  const beforeRun = Effect.fn("GraphMemory.beforeRun")(function*(task: { readonly prompt: string }) {
    const graphs = yield* GraphStore
    const exists = (yield* graphs.listGraphs()).some((g) => g.graph_id === graphId)
    const head = exists ? yield* graphs.head(graphId) : 0
    if (options.version !== undefined && options.version > head) {
      return yield* new MemoryError({ message: `graph ${graphId} has no version ${options.version} (head is ${head})` })
    }
    const version = options.version ?? head
    const at = { at: version }
    const info = { graph: graphId, version, frozen, sources: yield* sources(version) }
    if (version === 0) return { systemPrompt: undefined, info: { ...info, seeds: [], nodes: [] } } satisfies Injection
    // Start and end describe the whole procedure, so they match everything; they aren't entry points.
    const matches = (yield* graphs.searchNodes(graphId, task.prompt, { ...at, limit: SEED_LIMIT + 2, minScore: MIN_NODE_SCORE }))
      .filter((m) => m.node.type !== "start" && m.node.type !== "end")
      .slice(0, SEED_LIMIT)
    const seeds = matches.map((m) => m.node.id)
    const seedInfo = matches.map((m) => ({ id: m.node.id, score: Math.round(m.score * 1000) / 1000 }))
    if (seeds.length === 0) return { systemPrompt: undefined, info: { ...info, seeds: seedInfo, nodes: [] } } satisfies Injection
    const start = yield* graphs.getNodes(graphId, ["start"], at)
    const candidates = yield* graphs.neighborhood(graphId, [...start.keys(), ...seeds], { ...at, hops: HOPS, direction: "both" })
    const order = stepOrder(candidates)
    const all = { ...info, seeds: seedInfo, candidates: order }
    if (options.selector === undefined) {
      return { systemPrompt: renderChecklist(candidates, order, repo), info: { ...all, nodes: order } } satisfies Injection
    }
    yield* (yield* FileSystem.FileSystem).makeDirectory(options.selector.cwd, { recursive: true })
    const selection = yield* Effect.result(selectSteps(options.selector, task.prompt, candidates, order))
    if (Result.isFailure(selection)) {
      // A failed call shouldn't sink the run: hand over every candidate, and say so.
      const failed = { ...all, nodes: order, selector: { model: options.selector.model, error: selection.failure.message } }
      return { systemPrompt: renderChecklist(candidates, order, repo), info: failed } satisfies Injection
    }
    const { costUsd, reasons, steps, usage } = selection.success
    const chosen = { ...all, nodes: steps, selector: { model: options.selector.model, reasons, cost_usd: costUsd } }
    const spent = { costUsd, usage }
    if (steps.length === 0) return { systemPrompt: undefined, info: chosen, spent } satisfies Injection
    return {
      systemPrompt: renderChecklist(candidates, steps, repo, new Set(["start", ...steps])),
      info: chosen,
      spent
    } satisfies Injection
  }, Effect.provide(store), Effect.mapError(toMemoryError))

  const afterRun = Effect.fn("GraphMemory.afterRun")(function*(outcome: Outcome) {
    if (frozen) return
    if (options.version !== undefined) {
      return yield* new MemoryError({ message: "a graph read at a past version can't learn; use --frozen" })
    }
    if (options.learner === undefined) {
      return yield* new MemoryError({ message: "graph memory needs the claude command to learn" })
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const graphs = yield* GraphStore
    if (!(yield* graphs.listGraphs()).some((g) => g.graph_id === graphId)) {
      yield* graphs.createGraph(graphId, `procedures learned from runs in ${repo}`)
    }
    yield* fs.makeDirectory(options.learner.cwd, { recursive: true })
    const learned = yield* learnFromRun(options.learner, graphId, repo, outcome)
    const n = (yield* fs.exists(path.join(root, LEARN_LOG)))
      ? (yield* fs.readFileString(path.join(root, LEARN_LOG))).split(/\r?\n/).filter((l) => l.trim()).length + 1
      : 1
    const promptDir = path.join(root, "learn-prompts")
    yield* fs.makeDirectory(promptDir, { recursive: true })
    yield* fs.writeFileString(path.join(promptDir, `${String(n).padStart(3, "0")}-${outcome.task.id}.md`), learned.prompt)
    const line = {
      at: isoNow(),
      task_id: outcome.task.id,
      session_id: outcome.trace?.sessionId ?? null,
      success: outcome.success,
      candidate: learned.candidateId,
      version: learned.version,
      attempts: learned.attempts,
      cost_usd: learned.costUsd,
      tokens: learned.tokens,
      rationale: learned.rationale
    }
    yield* fs.writeFileString(path.join(root, LEARN_LOG), JSON.stringify(line) + "\n", { flag: "a" })
  }, Effect.provide(store), Effect.mapError(toMemoryError))

  return { name: "graph", beforeRun, afterRun }
}

/** LLM calls made while learning into the store at `root`, and what they cost. */
export const learnCost = Effect.fn("learnCost")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(root, LEARN_LOG)
  if (!(yield* fs.exists(file))) return { calls: 0, costUsd: 0 }
  const Line = Schema.fromJsonString(Schema.Struct({ cost_usd: Schema.Number, attempts: Schema.Number }))
  let calls = 0
  let costUsd = 0
  for (const line of (yield* fs.readFileString(file)).split(/\r?\n/)) {
    if (line.trim() === "") continue
    const decoded = yield* Schema.decodeUnknownEffect(Line)(line).pipe(
      Effect.mapError((e) => new MemoryError({ message: `${file}: ${e.message}` }))
    )
    calls += decoded.attempts
    costUsd += decoded.cost_usd
  }
  return { calls, costUsd }
})

/**
 * Steps in the order to do them: edges point forward, ties go to the step
 * fewer hops from the start, then by id. Cycles are broken at the step that
 * comes first by that rule.
 */
export const stepOrder = (graph: Graph): Array<string> => {
  const ids = graph.sortedNodes().map((n) => n.id)
  const depth = new Map<string, number>()
  const roots = graph.nodes.has("start") ? ["start"] : ids.filter((id) => ![...graph.edges.values()].some((e) => e.target === id))
  let frontier = roots
  for (const r of roots) depth.set(r, 0)
  for (let d = 1; frontier.length > 0; d++) {
    const next: Array<string> = []
    for (const e of graph.sortedEdges()) {
      if (frontier.includes(e.source) && !depth.has(e.target)) {
        depth.set(e.target, d)
        next.push(e.target)
      }
    }
    frontier = next
  }
  const rank = (id: string) => depth.get(id) ?? Number.MAX_SAFE_INTEGER
  const byRank = (a: string, b: string) => rank(a) - rank(b) || compareCodePoints(a, b)
  const indegree = new Map(ids.map((id) => [id, 0]))
  for (const e of graph.edges.values()) if (e.source !== e.target) indegree.set(e.target, indegree.get(e.target)! + 1)
  const done = new Set<string>()
  const order: Array<string> = []
  while (order.length < ids.length) {
    const remaining = ids.filter((id) => !done.has(id))
    const ready = remaining.filter((id) => indegree.get(id) === 0)
    const pick = (ready.length > 0 ? ready : remaining).sort(byRank)[0]
    done.add(pick)
    order.push(pick)
    for (const e of graph.edges.values()) {
      if (e.source === pick && e.target !== pick && !done.has(e.target)) indegree.set(e.target, indegree.get(e.target)! - 1)
    }
  }
  return order
}

const unique = (xs: ReadonlyArray<string | null | undefined>): Array<string> => [
  ...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))
]

const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"

/**
 * Steps of `graph` as a numbered checklist, in `order`. Each step shows the
 * advice on the edges leading into it: from the steps in `from` when there are
 * any (the path this task takes), otherwise from all of them. Its conditions
 * show only if every one of those edges has one: a condition on one of several
 * paths says when to take that path (say, skipping a step), not when the step
 * applies.
 */
export const renderChecklist = (
  graph: Graph,
  order: ReadonlyArray<string>,
  repo: string,
  from?: ReadonlySet<string>
): string => {
  const incoming = (id: string): Array<Edge> => {
    const all = graph.sortedEdges().filter((e) => e.target === id && e.source !== id)
    const onPath = from === undefined ? [] : all.filter((e) => from.has(e.source))
    return onPath.length > 0 ? onPath : all
  }
  const lines = [
    "# Procedure notes for this repository",
    "",
    "Earlier tasks in this repository went through the steps below, in this order. " +
    "Each step says when it applies, how it was done, mistakes to avoid, and the files and " +
    "commands involved. Do the steps that apply to your task, skip the rest, and check details " +
    "against the code: names and keys differ between tasks.",
    ""
  ]
  let n = 0
  for (const id of order) {
    const node = graph.nodes.get(id)
    if (node === undefined || node.type === "start") continue
    const edges = incoming(id)
    const facts = edges.map((e) => e.facts[repo])
    const conditional = edges.length > 0 && edges.every((e) => (e.condition ?? "").trim() !== "")
    const when = conditional ? unique(edges.map((e) => e.condition)) : []
    const how = unique(edges.map((e) => e.guidance))
    const avoid = unique(edges.map((e) => e.pitfalls))
    const paths = unique(facts.flatMap((f) => f?.paths ?? []))
    const commands = unique(facts.flatMap((f) => f?.commands ?? []))
    const deadEnds = unique(facts.flatMap((f) => f?.dead_ends ?? []))
    if (node.type === "end" && when.length + how.length + avoid.length + commands.length === 0) continue
    n += 1
    lines.push(`${n}. **${node.description.trim()}**`)
    for (const w of when) lines.push(`   - When: ${w}`)
    for (const h of how) lines.push(`   - How: ${h}`)
    for (const a of avoid) lines.push(`   - Avoid: ${a}`)
    if (paths.length > 0) lines.push(`   - Files: ${paths.map(code).join(", ")}`)
    if (commands.length > 0) lines.push(`   - Commands: ${commands.map(code).join("; ")}`)
    for (const d of deadEnds) lines.push(`   - Dead end: ${d}`)
    if (node.script !== null) lines.push(`   - Script: ${code(node.script)}`)
  }
  return lines.join("\n") + "\n"
}

/** A whole graph as Markdown, for people: steps in order, then every transition with its advice and facts. */
export const describeGraph = (graph: Graph, graphId: string, version: number): string => {
  const order = stepOrder(graph)
  const lines = [`# Graph ${graphId}, version ${version}`, "", `${graph.nodes.size} steps, ${graph.edges.size} transitions.`, "", "## Steps", ""]
  for (const id of order) {
    const node = graph.nodes.get(id)!
    lines.push(`- **${id}** (${node.type}): ${node.description}`)
    if (node.command_patterns.length > 0) lines.push(`  - patterns: ${node.command_patterns.map(code).join(", ")}`)
    if (node.script !== null) lines.push(`  - script: ${code(node.script)}`)
  }
  lines.push("", "## Transitions", "")
  const position = new Map(order.map((id, i) => [id, i]))
  const edges = graph.sortedEdges().sort((a, b) =>
    position.get(a.target)! - position.get(b.target)! || position.get(a.source)! - position.get(b.source)!
  )
  for (const e of edges) {
    lines.push(`### ${e.source} → ${e.target} (${e.relation})`, "")
    if (e.condition) lines.push(`- When: ${e.condition}`)
    if (e.guidance) lines.push(`- How: ${e.guidance}`)
    if (e.pitfalls) lines.push(`- Avoid: ${e.pitfalls}`)
    for (const [repo, f] of Object.entries(e.facts)) {
      if (f.paths.length > 0) lines.push(`- Files (${repo}): ${f.paths.map(code).join(", ")}`)
      if (f.commands.length > 0) lines.push(`- Commands (${repo}): ${f.commands.map(code).join("; ")}`)
      for (const d of f.dead_ends) lines.push(`- Dead end (${repo}): ${d}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}
