/**
 * Learn a procedural graph from recorded runs, with an LLM.
 *
 * For each run, Claude reads the current graph and the run (task, outcome,
 * source diff, condensed transcript) and proposes edits in the paper's format:
 * nodes to add or delete, edges to add or delete. Nodes are steps of work;
 * edges say when to go from one step to the next, how, and what to avoid, plus
 * concrete facts for this repository (paths, commands, dead ends).
 *
 * The edits go into the store as a candidate and are committed right away.
 * Validation gating (the paper's refiner loop) comes later.
 */
import { Effect, Schema } from "effect"
import type { Graph } from "../graph/index.ts"
import { Edge, EdgeFacts, edgeKey, EdgeRef, EditSet, GraphStore, Node, NodeType, Relation } from "../graph/index.ts"
import { condenseTrace } from "../traces/index.ts"
import { callStructured } from "./Llm.ts"
import { MAX_DIFF_CHARS, splitDiff } from "./SavedScripts.ts"
import type { Outcome } from "./Setups.ts"

const LearnedNode = Schema.Struct({
  id: Schema.String,
  type: NodeType,
  description: Schema.String,
  command_patterns: Schema.Array(Schema.String),
  script: Schema.NullOr(Schema.String)
})

const LearnedFacts = Schema.Struct({
  paths: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
  dead_ends: Schema.Array(Schema.String)
})

const LearnedEdge = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
  relation: Relation,
  condition: Schema.NullOr(Schema.String),
  guidance: Schema.NullOr(Schema.String),
  pitfalls: Schema.NullOr(Schema.String),
  /** For the repository being learned only; other repositories' facts are kept as they are. */
  facts: LearnedFacts
})

/** What the LLM returns: the paper's four edit lists, with the rationale first. */
export const LearnedEdits = Schema.Struct({
  rationale: Schema.String,
  delete_edges: Schema.Array(EdgeRef),
  delete_nodes: Schema.Array(Schema.String),
  add_nodes: Schema.Array(LearnedNode),
  add_edges: Schema.Array(LearnedEdge)
})
export type LearnedEdits = typeof LearnedEdits.Type

export const SYSTEM_PROMPT = `You maintain a procedural memory graph for coding agents that work in a software repository. The graph records how tasks in the repository get done: the steps (nodes) and the transitions between them (edges). When a new task starts, the steps that match it are shown to the agent as a short checklist, so it can skip exploration it would otherwise repeat and avoid mistakes earlier runs made.

You will see the current graph and one recorded run of the agent: the task it was given, whether it succeeded, the changes it made, and a condensed log of what it did. Propose edits that make the graph a better guide for future tasks in this repository: not just exact repeats of this task, but also tasks that reuse some of its steps, such as the same kind of change to a different feature, or only part of this change.

## Nodes

A node is one step of work, at the level of a developer's checklist: "add the new key code", "register the shortcut in the shortcut map", "update the snapshot files". Not a tool call ("read a file", "run grep") and not a whole task.

- id: short snake_case, stable. To revise a node, add it again with the same id: it replaces the old one completely.
- type: "action" for steps that do work, "reasoning" for a decision or check, "state" for a situation the agent can be in (for example "tests fail with unexpected snapshot changes"), and exactly one "start" and one "end" node, with ids "start" and "end".
- description: one sentence saying what the step achieves, in the words a task request would use (feature names such as "keyboard shortcut", "help dialog", "context menu", "Preferences menu", "app state field"). New tasks are matched against descriptions by word overlap, so use the vocabulary of requests, not file names or code identifiers.
- command_patterns: JavaScript regular expressions (no surrounding slashes, no flags) matching a shell command or a file path the agent touches while doing this step, for example "HelpDialog\\\\.tsx" or "vitest .*(-u|--update)". They tell which step an agent is on, so keep them specific to the step.
- script: null, unless one shell command performs the whole step.

## Edges

An edge from A to B means: after A, do B, when the condition holds. It carries the advice for doing B in that situation. There is at most one edge per (source, target) pair.

- relation: "leads_to" for the usual order of steps; "triggers" when A makes B necessary even though a task wouldn't mention B (a new app state field triggers snapshot updates); "provides_input_for" when A finds something B needs; "converges_to" when alternative paths rejoin.
- condition: when this transition applies, as a test the agent can check against its own task ("when the setting needs a keyboard shortcut"). null if always.
- guidance: how to do B, concretely enough to save exploration, in statements that hold beyond this one task.
- pitfalls: mistakes runs made on this step, with the symptom and the fix, so the agent recognizes the situation. null if none were seen.
- facts: concrete details for this repository only. paths: files to edit or read for B, relative to the repository root. commands: exact commands that worked. dead_ends: specific things that wasted time or mislead, such as a search that finds an unrelated match.

Keep general advice in condition, guidance and pitfalls; put file paths, code identifiers and commands in facts.

## Learning from the run

- Every step the final change needed should be in the graph, in order from "start" to "end", including steps a task wouldn't mention but that turned out to be required: registering something in a second place, updating snapshots, running the checks.
- Detours are the most valuable part. Where the agent lost time (a failing test it had to debug, a wrong file, a misleading search), record the cause and the fix as a pitfall or dead end on the edge into the step where it happened, so the next agent avoids it.
- Trust the final diff over what the agent believed along the way.
- Reuse and revise existing nodes and edges instead of adding near-duplicates. If the run shows that something in the graph is wrong, fix or delete it.
- When you revise an edge, its facts replace the old facts for this repository, so carry over the ones that still hold.
- Keep the graph small, at most about 20 nodes. Merge steps that always happen together.
- Leave out details that belong to this task alone (the exact key letter, the feature's name): future tasks will have different ones. Write steps and conditions so they fit the variants a future task might be.
- Make conditions tell variants apart: if a step only applies to some tasks (only when a shortcut is wanted, only when the value is saved), say so.

Return the edits with a short rationale first. Return empty lists if the graph needs no change.`

/** The graph as the LLM sees it: the same shape as its answer, with this repository's facts only. */
export const graphForPrompt = (graph: Graph, repo: string): string => {
  if (graph.nodes.size === 0) return "(empty: this is the first run)"
  const noFacts = { paths: [], commands: [], dead_ends: [] }
  return JSON.stringify(
    {
      nodes: graph.sortedNodes().map((n) => ({
        id: n.id,
        type: n.type,
        description: n.description,
        command_patterns: n.command_patterns,
        script: n.script
      })),
      edges: graph.sortedEdges().map((e) => ({
        source: e.source,
        target: e.target,
        relation: e.relation,
        condition: e.condition,
        guidance: e.guidance,
        pitfalls: e.pitfalls,
        facts: e.facts[repo] ?? noFacts
      }))
    },
    null,
    1
  )
}

export const runForPrompt = (outcome: Outcome): string => {
  const [files, snapshots, source] = splitDiff(outcome.diff)
  let diff = source
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)\n"
  const result = outcome.success === true
    ? "the checks passed"
    : outcome.success === false
    ? "the checks failed"
    : "the task had no checks"
  const calls = outcome.trace === undefined ? "" : `, after ${outcome.trace.toolCalls.length} tool calls`
  return [
    "Task given to the agent:",
    "",
    outcome.task.prompt,
    "",
    `Outcome: ${result}${calls}.`,
    "",
    "### The change it made",
    "",
    `Files changed: ${files.join(", ") || "(none)"}`,
    `Snapshot files regenerated (contents not shown): ${snapshots.join(", ") || "(none)"}`,
    "",
    "```diff",
    diff.replace(/\n+$/, ""),
    "```",
    "",
    "### What it did (condensed log: the agent's messages, then each tool call and its result)",
    "",
    outcome.trace === undefined ? "(no transcript)" : condenseTrace(outcome.trace)
  ].join("\n")
}

export const learnerPrompt = (graph: Graph, repo: string, outcome: Outcome, version: number): string =>
  [
    `Repository: ${repo}`,
    "",
    `## The current graph (version ${version})`,
    "",
    graphForPrompt(graph, repo),
    "",
    "## The run",
    "",
    runForPrompt(outcome)
  ].join("\n")

/**
 * The LLM's answer as an EditSet. Edges keep other repositories' facts from the
 * edge they replace; an item listed twice keeps its last version.
 */
export const toEditSet = (learned: LearnedEdits, repo: string, current: Graph): EditSet => {
  const nodes = new Map(learned.add_nodes.map((n) => [n.id, n]))
  const edges = new Map(learned.add_edges.map((e) => [edgeKey(e.source, e.target), e]))
  return new EditSet({
    delete_edges: learned.delete_edges,
    delete_nodes: [...new Set(learned.delete_nodes)],
    add_nodes: [...nodes.values()].map((n) => new Node(n)),
    add_edges: [...edges.values()].map(({ facts, ...e }) => {
      const kept = { ...current.edges.get(edgeKey(e.source, e.target))?.facts }
      delete kept[repo]
      const learnedAny = facts.paths.length + facts.commands.length + facts.dead_ends.length > 0
      return new Edge({ ...e, facts: learnedAny ? { ...kept, [repo]: new EdgeFacts(facts) } : kept })
    })
  })
}

/** Sonnet, as for the agent; extraction is a few cents per run, so it thinks harder. */
export const DEFAULT_LEARNER_MODEL = "sonnet"
export const DEFAULT_LEARNER_EFFORT = "high"

export interface LearnerConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the LLM runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
  readonly effort: string | undefined
}

export interface Learned {
  readonly candidateId: string | null
  readonly version: number
  readonly rationale: string
  readonly costUsd: number
  readonly tokens: number
  readonly attempts: number
  readonly prompt: string
}

const MAX_ATTEMPTS = 2

/**
 * Learn from one run: ask for edits, propose them, and commit. If the store
 * refuses the edits, the LLM gets the errors and one more try.
 */
export const learnFromRun = Effect.fn("learnFromRun")(function*(
  config: LearnerConfig,
  graphId: string,
  repo: string,
  outcome: Outcome
) {
  const store = yield* GraphStore
  const version = yield* store.head(graphId)
  const graph = yield* store.snapshot(graphId, { at: version })
  const prompt = learnerPrompt(graph, repo, outcome, version)
  let costUsd = 0
  let tokens = 0
  let feedback = ""
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const answer = yield* callStructured({
      claude: config.claude,
      system: SYSTEM_PROMPT,
      prompt: prompt + feedback,
      schema: LearnedEdits,
      model: config.model,
      effort: config.effort,
      cwd: config.cwd,
      maxBudgetUsd: 2
    })
    costUsd += answer.costUsd ?? 0
    tokens += answer.usage.input_tokens + answer.usage.output_tokens + answer.usage.cache_creation_input_tokens +
      answer.usage.cache_read_input_tokens
    const edits = toEditSet(answer.value, repo, graph)
    const base = { rationale: answer.value.rationale, costUsd, tokens, attempts: attempt, prompt }
    if (edits.isEmpty()) return { ...base, candidateId: null, version } satisfies Learned
    const proposed = yield* store.propose(graphId, edits, { baseVersion: version, rationale: answer.value.rationale }).pipe(
      Effect.map((candidate) => ({ candidate, errors: [] as ReadonlyArray<string> })),
      Effect.catchTag("InvalidEdit", (e) => Effect.succeed({ candidate: undefined, errors: e.errors }))
    )
    if (proposed.candidate !== undefined) {
      const committed = yield* store.commit(graphId, proposed.candidate.id)
      return { ...base, candidateId: proposed.candidate.id, version: committed } satisfies Learned
    }
    feedback = "\n\n## Your previous answer was refused\n\nThe store rejected those edits:\n\n" +
      proposed.errors.map((e) => `- ${e}`).join("\n") +
      "\n\nReturn the complete corrected edits."
    if (attempt === MAX_ATTEMPTS) {
      return yield* Effect.fail(new LearnerError({ message: `edits refused twice: ${proposed.errors.join("; ")}` }))
    }
  }
  return yield* Effect.fail(new LearnerError({ message: "unreachable" }))
})

export class LearnerError extends Schema.TaggedError<LearnerError>()("LearnerError", {
  message: Schema.String
}) {}
