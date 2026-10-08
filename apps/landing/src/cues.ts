// A line-for-line port of cueChoice and the fills in apps/cli/src/workflows/Cues.ts, and of graphOrder in
// apps/cli/src/workflows/Models.ts. (Importing them would bring Effect's Schema into the page.)
import type { Fill, Memory, Workflow } from "./data/memory.ts"

const START = "start"

export const graphOrder = (m: Memory): Array<Workflow> => {
  const byId = new Map(m.workflows.map((w) => [w.id, w]))
  const next = new Map<string, Array<string>>()
  for (const e of m.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const indegree = new Map(m.workflows.map((w) => [w.id, 0]))
  for (const e of m.edges) if (indegree.has(e.to) && e.from !== START) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  const order: Array<string> = [], seen = new Set<string>()
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

export const NEGATED = /(?:\b(?:not|never|no|without)\b|n't\b)[^.,;:()\n]*/gi
export const positiveText = (task: string) => task.replace(NEGATED, " ")

const said = (text: string, phrases: ReadonlyArray<string>) => {
  const t = text.toLowerCase()
  return phrases.find((p) => p.trim() !== "" && t.includes(p.trim().toLowerCase()))
}

export const cueMatch = (text: string, any: ReadonlyArray<string>, none: ReadonlyArray<string>) => {
  const hit = said(text, any)
  return hit === undefined || said(text, none) !== undefined ? undefined : hit
}

export interface Pick {
  readonly workflow: Workflow
  readonly skip: ReadonlyArray<number>
  readonly hit: string
}

export const cueChoice = (memory: Memory, task: string): Array<Pick> => {
  const text = positiveText(task)
  return graphOrder(memory).flatMap((w) => {
    const c = w.cues
    if (c === undefined) return []
    const hit = cueMatch(text, c.any, c.none)
    if (hit === undefined) return []
    const skip = c.steps
      .filter((s) => s.step >= 1 && s.step <= w.steps.length && cueMatch(text, s.any, s.none) === undefined)
      .map((s) => s.step)
    if (skip.length >= w.steps.length) return []
    return [{ workflow: w, skip, hit }]
  })
}

const KEY = /\b(?:(?:Alt|Ctrl|Cmd|Shift|Meta|CtrlOrCmd)\+)+[A-Za-z0-9/']/g
const unique = (xs: ReadonlyArray<string>) => [...new Set(xs.map((x) => x.trim()).filter((x) => x !== ""))]

const statedValues = (task: string): Record<string, ReadonlyArray<string>> => ({
  code: unique([...task.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)),
  quoted: unique([...task.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)].map((m) => m[1] ?? m[2]!)),
  key: unique([...task.matchAll(KEY)].map((m) => m[0]))
})

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const fillValue = (task: string, f: Fill): string | undefined => {
  const v = statedValues(task)
  if (f.from === "after") {
    const phrase = f.phrase?.trim()
    if (!phrase) return undefined
    const m = new RegExp(`${escapeRe(phrase)}\\s*[:=(]?\\s*["'\`]?([A-Za-z0-9_$.+-]+)`, "i").exec(task)
    const value = m?.[1]?.replace(/[.+-]+$/, "")
    return value === "" ? undefined : value
  }
  if (!Number.isInteger(f.n) || f.n < 1) return undefined
  if (f.from === "key-letter") {
    const k = v.key![f.n - 1]
    const letter = k?.slice(k.lastIndexOf("+") + 1)
    return letter !== undefined && /^[A-Za-z0-9]$/.test(letter) ? letter.toUpperCase() : undefined
  }
  return v[f.from]?.[f.n - 1]
}

export const fillsFor = (task: string, w: Workflow) => {
  const out = new Map<string, string>()
  for (const f of w.cues?.fills ?? []) {
    const value = fillValue(task, f)
    if (value !== undefined && !out.has(f.placeholder)) out.set(f.placeholder, value)
  }
  return out
}
