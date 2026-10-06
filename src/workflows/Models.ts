/**
 * Memory v1: small reusable workflows written with blanks (after Agent
 * Workflow Memory, arXiv 2409.07429), connected in a graph whose edges say
 * when one leads to another (after Procedural Graphs, arXiv 2609.09153).
 *
 * - A place is where a kind of edit goes, kept as the blocks that enclose it
 *   (Places.ts), never as lines of code: the hand-over finds it in the code
 *   as it is when used.
 * - A workflow is a sub-routine several tasks can share ("give an action a
 *   keyboard shortcut"): steps that say what to do, with the task's own
 *   values left as blanks ({key}), each at a place or where the agent decides.
 * - Edges connect workflows from `start` to `end`, each with when to take it.
 * - Pitfalls are mistakes earlier runs paid for, with an exact trigger when
 *   one can tell they are about to happen again.
 *
 * Persisted as JSON with snake_case keys, like everything else on disk here.
 */
import { Schema } from "effect"
import { Trigger } from "../records/Triggers.ts"

export const FORMAT = 1
export const START = "start"
export const END = "end"

export const StoredBlock = Schema.Struct({
  head: Schema.String,
  open: Schema.NullOr(Schema.String),
  opener: Schema.NullOr(Schema.String),
  close: Schema.NullOr(Schema.String)
})

/** New files: the directory they go in and how their siblings are named. */
export const NewFileSpot = Schema.Struct({ dir: Schema.String, prefix: Schema.String, ext: Schema.String })

export const Place = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  /** The file; for new files, the directory. */
  file: Schema.String,
  chain: Schema.Array(StoredBlock),
  group: Schema.NullOr(Schema.String),
  new_file: Schema.NullOr(NewFileSpot),
  /** The records of the runs that edited here, and their tasks. */
  evidence: Schema.Array(Schema.String),
  tasks: Schema.Array(Schema.String),
  /** How runs edited here. */
  edits: Schema.Struct({ add: Schema.Int, change: Schema.Int, create: Schema.Int }),
  /**
   * How the hand-over shows it: absent, the end of its block (its last
   * lines); "entry", its last whole entry (a component, a tag with its
   * attributes; for new files, the shortest existing one), where runs had to
   * read one before they could edit. Learned from results (Evolve.ts).
   */
  show: Schema.optionalKey(Schema.Literal("entry"))
})
export type Place = typeof Place.Type

export const Blank = Schema.Struct({ name: Schema.String, meaning: Schema.String })
export type Blank = typeof Blank.Type

export const WorkflowStep = Schema.Struct({
  /** What to do, with blanks in braces. */
  do: Schema.String,
  /** A place's id, or null where the agent finds the spot itself (the task's own file). */
  place: Schema.NullOr(Schema.String),
  /** When the step applies, if not always. */
  when: Schema.NullOr(Schema.String)
})
export type WorkflowStep = typeof WorkflowStep.Type

/**
 * Where a task's text states a blank's value (Cues.ts): the n-th name in
 * backticks, the n-th quoted name, the n-th key combination or its key, or
 * the word right after a phrase.
 */
export const Fill = Schema.Struct({
  /** The placeholder as the steps write it: `{field}`, `<text>`. */
  placeholder: Schema.String,
  from: Schema.Literals(["code", "quoted", "key", "key-letter", "after"]),
  /** Which one, from 1; unused for `after`. */
  n: Schema.Int,
  /** For `after`: the phrase the value follows. */
  phrase: Schema.NullOr(Schema.String)
})
export type Fill = typeof Fill.Type

/** A conditional step's cues: it applies when the task says one of `any` and none of `none`. */
export const StepCue = Schema.Struct({
  /** The step, numbered from 1. */
  step: Schema.Int,
  any: Schema.Array(Schema.String),
  none: Schema.Array(Schema.String)
})
export type StepCue = typeof StepCue.Type

/**
 * What in a task's text says a workflow is needed, which of its conditional
 * steps apply, and where its blanks' values are: plain phrases, matched in
 * any case at task start without a model (Cues.ts). Written once, when
 * memory is built.
 */
export const WorkflowCues = Schema.Struct({
  any: Schema.Array(Schema.String),
  none: Schema.Array(Schema.String),
  steps: Schema.Array(StepCue),
  fills: Schema.Array(Fill)
})
export type WorkflowCues = typeof WorkflowCues.Type

export const Workflow = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  name: Schema.String,
  /** When a task needs it. */
  use_when: Schema.String,
  /** The same in exact phrases, for picking without a model; absent in memory built before cues. */
  cues: Schema.optionalKey(WorkflowCues),
  /**
   * Learned from what runs did unasked (a test nobody asked for): handed over
   * only when a task explicitly asks for that very thing.
   */
  only_if_asked: Schema.Boolean,
  blanks: Schema.Array(Blank),
  steps: Schema.Array(WorkflowStep),
  /** Commands that check it. */
  checks: Schema.Array(Schema.String),
  /**
   * Test snapshot files every run it was learned from regenerated: what the
   * checks rewrite when its change is right (Finish.ts). Absent in memory
   * built before the finish was folded into one command.
   */
  snapshots: Schema.optionalKey(Schema.Array(Schema.String)),
  pitfalls: Schema.Array(Schema.String),
  /** The records of the runs it was learned from, and their tasks. */
  evidence: Schema.Array(Schema.String),
  tasks: Schema.Array(Schema.String)
})
export type Workflow = typeof Workflow.Type

export const Relation = Schema.Literals(["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"])

export const Edge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  relation: Relation,
  condition: Schema.NullOr(Schema.String),
  guidance: Schema.NullOr(Schema.String),
  pitfalls: Schema.NullOr(Schema.String)
})
export type Edge = typeof Edge.Type

export const Pitfall = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  text: Schema.String,
  /** Handed over when it fires, during the task; without one, at the start with its workflow. */
  trigger: Schema.NullOr(Trigger),
  evidence: Schema.Array(Schema.String),
  /** What the mistake cost the runs that made it: the median, in tokens. */
  cost_tokens: Schema.Int
})
export type Pitfall = typeof Pitfall.Type

export const WorkflowMemory = Schema.Struct({
  format: Schema.Literal(FORMAT),
  tenant: Schema.String,
  places: Schema.Array(Place),
  workflows: Schema.Array(Workflow),
  edges: Schema.Array(Edge),
  pitfalls: Schema.Array(Pitfall)
})
export type WorkflowMemory = typeof WorkflowMemory.Type

export const emptyMemory = (tenant: string): WorkflowMemory => ({ format: FORMAT, tenant, places: [], workflows: [], edges: [], pitfalls: [] })

/** The workflows in graph order: along the edges from `start`, the rest after. */
export const graphOrder = (m: WorkflowMemory): Array<Workflow> => {
  const byId = new Map(m.workflows.map((w) => [w.id, w]))
  const next = new Map<string, Array<string>>()
  for (const e of m.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const indegree = new Map(m.workflows.map((w) => [w.id, 0]))
  for (const e of m.edges) if (indegree.has(e.to) && e.from !== START) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  // Kahn's order, starting from what `start` leads to, then anything left in id order.
  const order: Array<string> = []
  const seen = new Set<string>()
  const queue = [...(next.get(START) ?? []).filter((id) => byId.has(id))]
  for (const w of m.workflows) if ((indegree.get(w.id) ?? 0) === 0 && !queue.includes(w.id)) queue.push(w.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id) || !byId.has(id)) continue
    seen.add(id)
    order.push(id)
    for (const to of next.get(id) ?? []) {
      if (!byId.has(to)) continue
      indegree.set(to, (indegree.get(to) ?? 1) - 1)
      if ((indegree.get(to) ?? 0) <= 0) queue.push(to)
    }
  }
  for (const w of m.workflows) if (!seen.has(w.id)) order.push(w.id)
  return order.map((id) => byId.get(id)!)
}
