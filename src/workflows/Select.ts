/**
 * At task start: which workflows a task needs, and which of their conditional
 * steps. A model reads the task and the graph (workflows with what they are
 * for, their steps' conditions, the edges' conditions) and decides each, with
 * a reason (one call, a cent or so). Without a model, workflows whose purpose
 * shares enough words with the task are taken whole.
 */
import { Effect, FileSystem, Schema } from "effect"
import { callStructured } from "../eval/Llm.ts"
import { tokenize } from "../search/Lexical.ts"
import type { Usage } from "../traces/index.ts"
import { graphOrder, type Workflow, type WorkflowMemory } from "./Models.ts"

export const SELECT_PROMPT = `You prepare a coding agent for a task by picking, from its memory of this repository, the workflows the task needs.

You get the task and the workflows memory holds, in the order tasks usually take them, with the edges between them. A workflow is a reusable sub-routine; its steps may say when they apply. For every workflow, decide whether this task needs it, with a reason of a few words; and if it does, which of its steps don't apply.

- A workflow applies when the task needs what it does, even if the task doesn't name it: a second place that must be updated, test snapshots that change, the final checks.
- It doesn't apply when the task doesn't involve what it does, or says not to do it. A workflow or step meant for when a task asks for something (a keyboard shortcut, a menu entry, a new test) applies only if this task asks for it.
- A workflow marked "only if the task explicitly asks for it" was learned from work no task asked for. It applies only when this task's text explicitly asks for that very thing (to add a new test, say), never when it asks to update, fix or keep passing what already exists.
- It applies only to the kind of thing it was learned on, in the part of the code its files show. A task about a different kind of thing that is described with similar words (another subsystem, another kind of object) doesn't get it. When you are unsure, leave a workflow out: a wrong one sends the agent to the wrong places and costs more than a missing one.
- Skip a step when its condition clearly doesn't hold for this task. If the task can't tell you whether it holds (it depends on what the code contains), keep it: the agent can check.
- Blanks in braces are filled by the agent from its task; you don't fill them.`

export const SelectionAnswer = Schema.Struct({
  workflows: Schema.Array(Schema.Struct({
    id: Schema.String,
    applies: Schema.Boolean,
    why: Schema.String,
    /** Steps, numbered from 1, that don't apply although the workflow does. */
    skip_steps: Schema.Array(Schema.Int)
  }))
})
export type SelectionAnswer = typeof SelectionAnswer.Type

export interface Selected {
  readonly workflow: Workflow
  /** Steps that don't apply, numbered from 1. */
  readonly skip: ReadonlyArray<number>
  readonly why: string
}

export const selectionPrompt = (task: string, memory: WorkflowMemory): string => {
  const places = new Map(memory.places.map((p) => [p.id, p]))
  const lines = ["## Task", "", task.trim(), "", "## Workflows in memory", ""]
  for (const w of graphOrder(memory)) {
    lines.push(`### ${w.id}: ${w.name}`, `Use when: ${w.use_when}${w.only_if_asked ? " (only if the task explicitly asks for it)" : ""}`)
    const files = [...new Set(w.steps.flatMap((s) => {
      const p = s.place === null ? undefined : places.get(s.place)
      return p === undefined ? [] : [p.new_file === null ? p.file : `${p.new_file.dir}/${p.new_file.prefix}…${p.new_file.ext}`]
    }))]
    if (files.length > 0) lines.push(`Files: ${files.join(", ")}`)
    w.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.do}${s.when === null ? "" : ` [only when: ${s.when}]`}`))
    lines.push("")
  }
  const conditional = memory.edges.filter((e) => e.condition !== null)
  if (conditional.length > 0) {
    lines.push("## Edges with conditions", "")
    for (const e of conditional) lines.push(`- ${e.from} -> ${e.to}: ${e.condition}`)
    lines.push("")
  }
  return lines.join("\n")
}

/** The workflows the model said apply, in graph order. */
export const chosenWorkflows = (memory: WorkflowMemory, answer: SelectionAnswer): Array<Selected> => {
  const said = new Map(answer.workflows.map((w) => [w.id, w]))
  return graphOrder(memory).flatMap((w) => {
    const a = said.get(w.id)
    if (a === undefined || !a.applies) return []
    const skip = a.skip_steps.filter((n) => Number.isInteger(n) && n >= 1 && n <= w.steps.length)
    // A workflow with every step skipped hands over nothing.
    return skip.length >= w.steps.length ? [] : [{ workflow: w, skip, why: a.why }]
  })
}

/**
 * Without a model: workflows whose name and purpose share at least `min`
 * words with the task, whole; never one that waits to be asked for, since
 * words can't tell asking from mentioning.
 */
export const wordChoice = (memory: WorkflowMemory, task: string, min = 3): Array<Selected> => {
  const words = new Set(tokenize(task))
  return graphOrder(memory).filter((w) => !w.only_if_asked).flatMap((w) => {
    const shared = new Set(tokenize(`${w.name} ${w.use_when}`).filter((t) => words.has(t)))
    return shared.size >= min ? [{ workflow: w, skip: [], why: `shares ${[...shared].join(", ")}` }] : []
  })
}

export interface SelectorConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
  /** Let the model think before it answers (slower and a little dearer; default off). */
  readonly thinking?: boolean | undefined
}

export interface Selection {
  readonly chosen: ReadonlyArray<Selected>
  /** The model call, if one was made: what it cost, or why it failed (then words chose). */
  readonly call: { readonly model: string; readonly costUsd: number | null; readonly usage: Usage | null; readonly error: string | null } | null
  readonly reasons: ReadonlyArray<string>
}

export const selectWorkflows = Effect.fn("selectWorkflows")(function*(memory: WorkflowMemory, task: string, config: SelectorConfig | undefined) {
  if (memory.workflows.length === 0) return { chosen: [], call: null, reasons: [] } satisfies Selection
  if (config === undefined) {
    const chosen = wordChoice(memory, task)
    return { chosen, call: null, reasons: chosen.map((c) => `${c.workflow.id}: ${c.why}`) } satisfies Selection
  }
  // The model runs in a directory of its own, with no CLAUDE.md above it.
  yield* (yield* FileSystem.FileSystem).makeDirectory(config.cwd, { recursive: true }).pipe(Effect.ignore)
  const called = yield* Effect.result(callStructured({
    claude: config.claude,
    system: SELECT_PROMPT,
    prompt: selectionPrompt(task, memory),
    schema: SelectionAnswer,
    model: config.model,
    thinking: config.thinking ?? false,
    cwd: config.cwd,
    maxBudgetUsd: 0.25,
    timeoutS: 90
  }))
  if (called._tag === "Failure") {
    // A failed call shouldn't cost the task its memory: words decide instead.
    const chosen = wordChoice(memory, task)
    return {
      chosen,
      call: { model: config.model, costUsd: null, usage: null, error: called.failure.message },
      reasons: chosen.map((c) => `${c.workflow.id}: ${c.why}`)
    } satisfies Selection
  }
  const answer = called.success.value
  return {
    chosen: chosenWorkflows(memory, answer),
    call: { model: config.model, costUsd: called.success.costUsd, usage: called.success.usage, error: null },
    reasons: answer.workflows.map((w) => `${w.applies ? "" : "not "}${w.id}: ${w.why}${w.skip_steps.length > 0 ? ` (skip steps ${w.skip_steps.join(", ")})` : ""}`)
  } satisfies Selection
})
