/**
 * Conditions for optional steps, written by a model from the evidence: the
 * tasks that took a step against those of the same kind that didn't (or took
 * it only on their own initiative). One call per kind, only for steps whose
 * condition is still the builder's placeholder.
 *
 * The condition is what the model at task start reads to decide whether a new
 * task takes the step, so it must be checkable against a task's wording.
 */
import { Effect, Schema } from "effect"
import { callStructured } from "../eval/Llm.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { stepIdOf } from "./Build.ts"
import type { Kind, MemoryGraph } from "./Models.ts"

export const PLACEHOLDERS = new Set([
  "only when the task asks for it",
  "when the task asks for it",
  "when the change needs it: some tasks of this kind did, some didn't"
])

export const CONDITIONS_PROMPT = `You write conditions for optional steps of a procedure that a coding agent follows in one repository.

Each step below was taken by some tasks of one kind and not by others. You see the tasks that took it (because they asked for it, or their change needed it) and the tasks that didn't (or whose agent did it without being asked). Write, for each step, the condition under which a new task of this kind should take it.

The condition is read by a model deciding, from a new task's wording alone, whether the step applies. So state it in terms a task's wording can show: "when the task asks for a new test", "when the setting has to survive a reload", "when the task adds a keyboard shortcut". If nothing in the wording separates the two groups, say when the change needs the step, as the tasks that took it show. If the step was only ever the agent's own initiative, the condition is "only when the task explicitly asks for it" followed by what it would ask for.

One sentence each, starting with "when" or "only when".`

export const Conditions = Schema.Struct({
  conditions: Schema.Array(Schema.Struct({ step: Schema.String, condition: Schema.String }))
})

export interface ConditionsConfig {
  readonly claude: ReadonlyArray<string>
  readonly cwd: string
  readonly model: string
}

const quote = (s: string) => s.trim().replace(/\s+/g, " ")

/** The prompt for one kind, or undefined if it has no step that needs a condition. */
export const conditionsPrompt = (kind: Kind, graph: MemoryGraph, records: ReadonlyArray<WorkflowRecord>): string | undefined => {
  const open = kind.route.filter((e) => !e.required && e.condition !== null && PLACEHOLDERS.has(e.condition))
  if (open.length === 0) return undefined
  const ofKind = records.filter((r) => kind.evidence.includes(r.id) && r.model !== null)
  const steps = new Map(graph.steps.map((s) => [s.id, s]))
  const lines = [`Kind of task: ${kind.name}: ${kind.description}`, ""]
  for (const e of open) {
    const step = steps.get(e.step)
    const took = new Set<string>()
    const skipped = new Set<string>()
    for (const r of ofKind) {
      const s = r.model!.steps.find((x) => stepIdOf(x.name) === e.step)
      if (s !== undefined && s.origin !== "chosen") took.add(quote(r.task.prompt))
      else skipped.add(quote(r.task.prompt) + (s !== undefined ? " (the agent did it unasked)" : ""))
    }
    lines.push(`## Step ${e.step}: ${step?.name ?? e.step}`, step?.purpose ?? "", "", "Tasks that took it:")
    lines.push(...(took.size === 0 ? ["(none: only ever done unasked)"] : [...took].map((p) => `- ${p}`)))
    lines.push("", "Tasks that didn't:")
    lines.push(...(skipped.size === 0 ? ["(none)"] : [...skipped].map((p) => `- ${p}`)), "")
  }
  return lines.join("\n")
}

/** The graph with conditions written for every placeholder; the cost of the calls. */
export const writeConditions = Effect.fn("writeConditions")(function*(
  graph: MemoryGraph,
  records: ReadonlyArray<WorkflowRecord>,
  config: ConditionsConfig
) {
  let costUsd = 0
  const kinds: Array<Kind> = []
  for (const kind of graph.kinds) {
    const prompt = conditionsPrompt(kind, graph, records)
    if (prompt === undefined) {
      kinds.push(kind)
      continue
    }
    const answer = yield* callStructured({
      claude: config.claude,
      system: CONDITIONS_PROMPT,
      prompt,
      schema: Conditions,
      model: config.model,
      thinking: false,
      cwd: config.cwd,
      maxBudgetUsd: 0.5,
      timeoutS: 300
    })
    costUsd += answer.costUsd ?? 0
    const written = new Map(answer.value.conditions.map((c) => [c.step, c.condition.trim()]))
    kinds.push({
      ...kind,
      route: kind.route.map((e) => {
        const c = written.get(e.step)
        return c !== undefined && c !== "" && e.condition !== null && PLACEHOLDERS.has(e.condition) ? { ...e, condition: c } : e
      })
    })
  }
  return { graph: { ...graph, kinds }, costUsd }
})
