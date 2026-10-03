/**
 * Retrieval keys of a record: what exact search and word search look at.
 *
 * Exact keys are strings a hook can see in a later session: commands and
 * what they run, file paths, error text, trigger strings and landmark anchors.
 * The text is what word search ranks: the task, and the model's names for its
 * kind, steps and lessons. Meaning (embeddings) is for the hosted version.
 */
import type { WorkflowRecord } from "./Models.ts"

export interface ExactKey {
  /** Where in the record: "command", "key", "file", "read", "error", "trigger", "anchor". */
  readonly field: string
  readonly value: string
}

export const exactKeys = (r: WorkflowRecord): Array<ExactKey> => {
  const keys: Array<ExactKey> = []
  const add = (field: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value.trim() !== "") keys.push({ field, value })
  }
  for (const c of r.commands) {
    add("command", c.command)
    for (const k of c.keys) add("key", k)
    add("error", c.error)
  }
  for (const f of r.files) add("file", f.path)
  for (const f of r.files_read) add("read", f)
  for (const d of r.detours) {
    add("error", d.symptom)
    add("command", d.failed.command)
    add("file", d.failed.file)
  }
  for (const l of r.model?.lessons ?? []) for (const s of l.trigger?.all ?? []) add("trigger", s)
  for (const s of r.model?.steps ?? []) {
    for (const l of s.landmarks) {
      add("file", l.file)
      for (const a of l.anchors) add("anchor", a)
    }
  }
  return keys
}

/** The words that describe a record, for word search. */
export const recordText = (r: WorkflowRecord): string => {
  const m = r.model
  const parts = [r.task.prompt, ...r.task.followups]
  if (m !== null) {
    parts.push(m.kind.name, m.kind.description, ...m.asked)
    for (const s of m.steps) parts.push(s.name, s.purpose, ...s.landmarks.map((l) => l.fact))
    for (const l of m.lessons) parts.push(l.lesson)
    for (const f of m.false_leads) parts.push(f.what)
  }
  return parts.join("\n")
}
