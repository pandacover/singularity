/**
 * The memory graph: what the workflow records add up to, in three layers.
 *
 * - Task kinds: the kinds of task seen ("change an action's keyboard
 *   shortcut"), each with its route: the steps, in order, required or
 *   optional, with the condition for taking an optional one.
 * - Steps: each merged from every record that took it. A step shared by
 *   several kinds is one item (an implicit skill, such as "list the shortcut
 *   in the help dialog"). Where it happens (files, landmarks, the spots its
 *   edits went next to, the commands that check it) is kept per subject and
 *   never shared between subjects.
 * - Warnings: mistakes from detours, merged across records, each tied to the
 *   step or kind it happened in, with an exact trigger when one held up.
 *
 * Every item carries its tenant, its reach (the subjects it may be handed to)
 * and its evidence: the records behind it. Persisted as JSON with snake_case keys.
 */
import { Schema } from "effect"
import { Landmark, Spot } from "../records/Models.ts"
import { Trigger } from "../records/Triggers.ts"

export const Reach = Schema.Struct({
  /**
   * subject: only `subjects`; tools: subjects whose repos use every one of
   * `tools`; tenant: every subject in the tenant.
   */
  scope: Schema.Literals(["subject", "tools", "tenant"]),
  subjects: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String)
})
export type Reach = typeof Reach.Type

export const RouteEntry = Schema.Struct({
  step: Schema.String,
  /** Every run of the kind took it, and none did on its own. */
  required: Schema.Boolean,
  /** Optional steps: when to take one. */
  condition: Schema.NullOr(Schema.String),
  /** Of the kind's records: how many took the step, and how (asked for, needed without being asked, the agent's own choice). */
  taken: Schema.Int,
  asked: Schema.Int,
  needed: Schema.Int,
  chosen: Schema.Int
})
export type RouteEntry = typeof RouteEntry.Type

export const Kind = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("kind"),
  tenant: Schema.String,
  reach: Reach,
  name: Schema.String,
  description: Schema.String,
  /** The tasks of this kind, as asked: what a new task is matched against. */
  examples: Schema.Array(Schema.String),
  route: Schema.Array(RouteEntry),
  evidence: Schema.Array(Schema.String)
})
export type Kind = typeof Kind.Type

export const SeenLandmark = Schema.Struct({
  ...Landmark.fields,
  /** Records that found it. */
  seen: Schema.Int
})
export type SeenLandmark = typeof SeenLandmark.Type

/** A file a step edited, and in how many of the step's records. */
export const SeenFile = Schema.Struct({ path: Schema.String, seen: Schema.Int })
export type SeenFile = typeof SeenFile.Type

/**
 * Lines of existing code that a step's runs added their own lines between
 * (records/Spots.ts), and the records that did. The hand-over finds them in
 * the code as it is then and shows what is around them.
 */
export const SeenSpot = Schema.Struct({
  ...Spot.fields,
  records: Schema.Array(Schema.String)
})
export type SeenSpot = typeof SeenSpot.Type

/** A file a step's runs read, and left as it was, before writing a new file next to it; and the records that did. */
export const SeenExample = Schema.Struct({ path: Schema.String, records: Schema.Array(Schema.String) })
export type SeenExample = typeof SeenExample.Type

/** Where a step happens in one subject. */
export const Place = Schema.Struct({
  /** Records of the step in this subject. */
  runs: Schema.Int,
  /** Files the step edits, most often first. Ones only a few runs edited belong to those tasks' features. */
  files: Schema.Array(SeenFile),
  landmarks: Schema.Array(SeenLandmark),
  /** Commands that verified it, most often first. */
  checks: Schema.Array(Schema.String),
  /** Where in those files its edits went, best supported first. Absent when no record has any. */
  spots: Schema.optionalKey(Schema.Array(SeenSpot)),
  /** For a step that creates a file: existing files next to it that its runs read first. Absent when there are none. */
  examples: Schema.optionalKey(Schema.Array(SeenExample))
})
export type Place = typeof Place.Type

export const Step = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("step"),
  tenant: Schema.String,
  reach: Reach,
  name: Schema.String,
  purpose: Schema.String,
  /** Keyed by subject. */
  where: Schema.Record(Schema.String, Place),
  evidence: Schema.Array(Schema.String)
})
export type Step = typeof Step.Type

export const Warning = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("warning"),
  tenant: Schema.String,
  reach: Reach,
  lesson: Schema.String,
  /** The step it happened in; null for mistakes with the agent's own tools, which belong to no step. */
  step: Schema.NullOr(Schema.String),
  /** The task kind it happened in, for warnings that belong to a kind rather than a step (false leads). */
  kind: Schema.NullOr(Schema.String),
  trigger: Schema.NullOr(Trigger),
  /**
   * start: handed over with its step at task start; trigger: only when its
   * trigger fires; both: at the start, and again if the trigger fires.
   */
  moment: Schema.Literals(["start", "trigger", "both"]),
  /** Median cost when it happened. */
  cost: Schema.Struct({ tokens: Schema.Int, turns: Schema.Int }),
  /** Detours behind it. */
  seen: Schema.Int,
  evidence: Schema.Array(Schema.String)
})
export type Warning = typeof Warning.Type

export type Item = Kind | Step | Warning

export const MemoryGraph = Schema.Struct({
  kinds: Schema.Array(Kind),
  steps: Schema.Array(Step),
  warnings: Schema.Array(Warning)
})
export type MemoryGraph = typeof MemoryGraph.Type

export const emptyGraph: MemoryGraph = { kinds: [], steps: [], warnings: [] }

export const items = (g: MemoryGraph): Array<Item> => [...g.kinds, ...g.steps, ...g.warnings]

/** Items to add or replace, and ids to remove: how one version becomes the next. */
export const GraphEdits = Schema.Struct({
  upsert: Schema.Array(Schema.Union([Kind, Step, Warning])),
  remove: Schema.Array(Schema.String)
})
export type GraphEdits = typeof GraphEdits.Type

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Edits that turn `from` into `to`. */
export const diffGraphs = (from: MemoryGraph, to: MemoryGraph): GraphEdits => {
  const before = new Map(items(from).map((i) => [i.id, i]))
  const after = new Map(items(to).map((i) => [i.id, i]))
  return {
    upsert: items(to).filter((i) => !sameJson(before.get(i.id), i)),
    remove: [...before.keys()].filter((id) => !after.has(id)).sort()
  }
}

/** `graph` with `edits` applied, items in id order within each layer. */
export const applyEdits = (graph: MemoryGraph, edits: GraphEdits): MemoryGraph => {
  const all = new Map(items(graph).map((i) => [i.id, i]))
  for (const id of edits.remove) all.delete(id)
  for (const i of edits.upsert) all.set(i.id, i)
  const sorted = [...all.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    kinds: sorted.filter((i): i is Kind => i.type === "kind"),
    steps: sorted.filter((i): i is Step => i.type === "step"),
    warnings: sorted.filter((i): i is Warning => i.type === "warning")
  }
}

/** Whether an item may be handed to `subject`, whose repo uses `tools`. */
export const reaches = (reach: Reach, subject: string, tools: ReadonlySet<string> = new Set()): boolean => {
  switch (reach.scope) {
    case "subject":
      return reach.subjects.includes(subject)
    case "tools":
      return reach.subjects.includes(subject) || reach.tools.every((t) => tools.has(t))
    case "tenant":
      return true
  }
}
