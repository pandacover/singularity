/**
 * Local search over memory: exact and word search, never meaning (that's the
 * hosted version's semantic search).
 *
 * - Exact: strings an item carries (commands, file paths, error text, trigger
 *   strings, landmark anchors) that contain the query. Cheap enough to run
 *   on every tool call.
 * - Words: BM25 over each item's text (a task, a step's name and purpose, a
 *   warning's lesson).
 *
 * Items are records and the memory graph's task kinds, steps and warnings,
 * all turned into the same kind of document.
 */
import type { ExactKey } from "../records/Keys.ts"
import { exactKeys, recordText } from "../records/Keys.ts"
import type { MemoryGraph, Reach } from "../memory/Models.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { buildIndex, search } from "./Lexical.ts"

export type DocType = "record" | "kind" | "step" | "warning"

export interface SearchDoc {
  readonly id: string
  readonly type: DocType
  /** The subjects it's about: a record's one, or a memory item's reach. Empty for "every subject". */
  readonly subjects: ReadonlyArray<string>
  /** One line, for showing it. */
  readonly title: string
  readonly text: string
  readonly exact: ReadonlyArray<ExactKey>
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? ""

export const recordDoc = (r: WorkflowRecord): SearchDoc => ({
  id: r.id,
  type: "record",
  subjects: [r.subject],
  title: r.model?.kind.name ?? firstLine(r.task.prompt),
  text: recordText(r),
  exact: exactKeys(r)
})

const reachSubjects = (reach: Reach) => (reach.scope === "tenant" ? [] : reach.subjects)

/** The memory graph's items as documents: kinds by their tasks, steps by where they happen, warnings by their triggers. */
export const memoryDocs = (g: MemoryGraph): Array<SearchDoc> => [
  ...g.kinds.map((k): SearchDoc => ({
    id: k.id,
    type: "kind",
    subjects: reachSubjects(k.reach),
    title: k.name,
    text: [k.name, k.description, ...k.examples].join("\n"),
    exact: []
  })),
  ...g.steps.map((s): SearchDoc => {
    const places = Object.values(s.where)
    return {
      id: s.id,
      type: "step",
      subjects: reachSubjects(s.reach),
      title: s.name,
      text: [s.name, s.purpose, ...places.flatMap((p) => p.landmarks.map((l) => l.fact))].join("\n"),
      exact: places.flatMap((p) => [
        ...p.files.map((f) => ({ field: "file", value: f.path })),
        ...p.landmarks.flatMap((l) => [{ field: "file", value: l.file }, ...l.anchors.map((a) => ({ field: "anchor", value: a }))]),
        ...p.checks.map((c) => ({ field: "command", value: c }))
      ])
    }
  }),
  ...g.warnings.map((w): SearchDoc => ({
    id: w.id,
    type: "warning",
    subjects: reachSubjects(w.reach),
    title: firstLine(w.lesson),
    text: w.lesson,
    exact: (w.trigger?.all ?? []).map((value) => ({ field: "trigger", value }))
  }))
]

export interface TextHit {
  readonly doc: SearchDoc
  readonly score: number
  readonly coverage: number
}

export const searchText = (docs: ReadonlyArray<SearchDoc>, query: string, limit = 10): Array<TextHit> => {
  const byId = new Map(docs.map((d) => [`${d.type}:${d.id}`, d]))
  return search(buildIndex(docs.map((d) => ({ id: `${d.type}:${d.id}`, text: d.text }))), query, limit)
    .map((h) => ({ doc: byId.get(h.id)!, score: h.score, coverage: h.coverage }))
}

export interface ExactHit {
  readonly doc: SearchDoc
  readonly field: string
  readonly value: string
}

/** Every exact key containing `query`, one hit per (item, field, value). */
export const searchExact = (
  docs: ReadonlyArray<SearchDoc>,
  query: string,
  options: { readonly ignoreCase?: boolean | undefined; readonly limit?: number | undefined } = {}
): Array<ExactHit> => {
  const needle = options.ignoreCase === true ? query.toLowerCase() : query
  const hits: Array<ExactHit> = []
  const seen = new Set<string>()
  for (const doc of docs) {
    for (const k of doc.exact) {
      const hay = options.ignoreCase === true ? k.value.toLowerCase() : k.value
      if (!hay.includes(needle)) continue
      const key = `${doc.type}:${doc.id}\u0000${k.field}\u0000${k.value}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ doc, field: k.field, value: k.value })
      if (options.limit !== undefined && hits.length >= options.limit) return hits
    }
  }
  return hits
}

/** `value` cut down to the part around `query`, on one line. */
export const excerpt = (value: string, query: string, width = 120): string => {
  const flat = value.replace(/\s+/g, " ")
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (flat.length <= width || at < 0) return flat.length <= width ? flat : flat.slice(0, width - 3) + "..."
  const start = Math.max(0, at - Math.floor((width - query.length) / 2))
  const end = Math.min(flat.length, start + width)
  return (start > 0 ? "..." : "") + flat.slice(start, end) + (end < flat.length ? "..." : "")
}
