/**
 * Pick the steps of a graph that a new task needs, with one cheap model call.
 *
 * Word overlap finds where a task enters the graph, but whether a step applies
 * is in its conditions ("when the setting needs a keyboard shortcut"), which
 * are plain language, and tasks say what *not* to do. So a model reads the task
 * and the candidate steps with their conditions, once at task start, and
 * decides for each step whether it applies. Deciding step by step keeps it from
 * skipping steps it didn't think about. This is retrieval, not the paper's
 * per-step guidance: the agent gets the stored notes verbatim.
 */
import { Effect, Schema } from "effect"
import type { Graph } from "../graph/index.ts"
import type { Usage } from "../traces/index.ts"
import { callStructured } from "./Llm.ts"

export interface SelectorConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
}

export const DEFAULT_SELECTOR_MODEL = "sonnet"

export const StepDecisions = Schema.Struct({
  decisions: Schema.Array(Schema.Struct({
    id: Schema.String,
    why: Schema.String,
    applies: Schema.Boolean
  }))
})

export const SELECTOR_PROMPT = `You decide which steps of a procedure apply to a coding task.

The steps were learned from earlier tasks in the same repository. Each has an id, what it achieves, and the conditions under which it applies. A coding agent is about to start the task below; the steps that apply are shown to it as a checklist.

Decide for every step, in order, with a reason of a few words:

- A step applies when the task needs it, even if the task doesn't name it: a second place that must be updated, snapshot updates, the final checks.
- It doesn't apply when the task doesn't involve what it does, or says not to do it, or when its conditions clearly don't hold for this task.
- If the task can't tell you whether a condition holds (it depends on what the code already contains), the step applies: the agent can check.`

/** The steps as the model sees them: in order, with the conditions on the edges into each. */
export const stepListing = (graph: Graph, order: ReadonlyArray<string>): string => {
  const lines: Array<string> = []
  for (const id of order) {
    const node = graph.nodes.get(id)
    if (node === undefined || node.type === "start") continue
    lines.push(`- ${id}: ${node.description.trim()}`)
    const conditions = [
      ...new Set(
        graph.sortedEdges()
          .filter((e) => e.target === id && e.source !== id)
          .map((e) => (e.condition ?? "").trim())
          .filter((c) => c !== "")
      )
    ]
    if (conditions.length > 0) lines.push(`  applies: ${conditions.join(" | ")}`)
  }
  return lines.join("\n")
}

export interface Selection {
  readonly steps: ReadonlyArray<string>
  /** Each step's reason, as "id: why" for the ones that apply and "not id: why" for the rest. */
  readonly reasons: ReadonlyArray<string>
  readonly costUsd: number
  readonly usage: Usage
}

/** The steps the model said apply, in `order`; ids it made up are ignored. */
export const selectSteps = Effect.fn("selectSteps")(function*(
  config: SelectorConfig,
  taskPrompt: string,
  graph: Graph,
  order: ReadonlyArray<string>
) {
  const answer = yield* callStructured({
    claude: config.claude,
    system: SELECTOR_PROMPT,
    prompt: `## Task\n\n${taskPrompt}\n\n## Steps, in the order they are usually done\n\n${stepListing(graph, order)}`,
    schema: StepDecisions,
    model: config.model,
    thinking: false,
    cwd: config.cwd,
    maxBudgetUsd: 0.25,
    timeoutS: 180
  })
  const applies = new Set(answer.value.decisions.filter((d) => d.applies).map((d) => d.id))
  return {
    steps: order.filter((id) => applies.has(id) && graph.nodes.get(id)?.type !== "start"),
    reasons: answer.value.decisions.map((d) => `${d.applies ? "" : "not "}${d.id}: ${d.why}`),
    costUsd: answer.costUsd ?? 0,
    usage: answer.usage
  } satisfies Selection
})
