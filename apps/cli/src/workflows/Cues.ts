/**
 * Memory v1 without a model at task start: cues.
 *
 * When memory is built, a model writes once, for each workflow, what in a
 * task's text says the workflow is needed, which of its conditional steps
 * apply, and where a task states its blanks' values (Models.ts: WorkflowCues).
 * At task start they are matched exactly: no model call, and the same answer
 * every time. Phrases are plain text in any case, never regular expressions,
 * and are matched against the task with its negated clauses taken out
 * ("Don't add a keyboard shortcut", "but not in view mode"), so what a task
 * rules out doesn't set them off.
 *
 * Blanks are filled only with values the task states as written: a name in
 * backticks, a quoted name, a key combination or its key, the word after a
 * phrase. Anything a value would have to be derived from stays a blank for
 * the agent.
 *
 * A task that lists several changes (a numbered or bulleted list) is picked
 * and filled change by change, each with what the task says of all of them.
 *
 * This module is what task start needs; writing the cues is CueWriter.ts.
 */
import { type Fill, graphOrder, type Workflow, type WorkflowMemory } from "./Models.ts"
import type { Selected } from "./Select.ts"

/** The task's text without its negated clauses: from "not", "n't", "never", "no" or "without" to the end of the clause. */
export const positiveText = (task: string): string =>
  task.replace(/(?:\b(?:not|never|no|without)\b|n't\b)[^.,;:()\n]*/gi, " ")

/** Text for matching: any case, and a phrase still matches where the task's text breaks a line in it. */
const folded = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")

const said = (text: string, phrases: ReadonlyArray<string>): string | undefined => {
  const t = folded(text)
  return phrases.find((p) => p.trim() !== "" && t.includes(folded(p)))
}

/** The phrase of `any` the text says, when it says none of `none`. */
const cueMatch = (text: string, any: ReadonlyArray<string>, none: ReadonlyArray<string>): string | undefined => {
  const hit = said(text, any)
  return hit === undefined || said(text, none) !== undefined ? undefined : hit
}

export const hasCues = (m: WorkflowMemory): boolean => m.workflows.some((w) => w.cues !== undefined)

/**
 * The workflows a task's text asks for by their cues, in graph order, each
 * without the conditional steps whose cues it doesn't say. A workflow without
 * cues is never picked.
 */
export const cueChoice = (memory: WorkflowMemory, task: string): Array<Selected> => {
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
    return [{ workflow: w, skip, why: `says ${JSON.stringify(hit)}` }]
  })
}

const KEY = /\b(?:(?:Alt|Ctrl|Cmd|Shift|Meta|CtrlOrCmd)\+)+[A-Za-z0-9/']/g

const unique = (xs: ReadonlyArray<string>) => [...new Set(xs.map((x) => x.trim()).filter((x) => x !== ""))]

/** What a task's text states, in the order it states it. */
export const statedValues = (task: string) => ({
  code: unique([...task.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])),
  quoted: unique([...task.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)].map((m) => m[1] ?? m[2])),
  key: unique([...task.matchAll(KEY)].map((m) => m[0]))
})

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A fill's value in a task's text, or undefined if the text doesn't state one. */
export const fillValue = (task: string, f: Fill): string | undefined => {
  const v = statedValues(task)
  if (f.from === "after") {
    const phrase = f.phrase?.trim()
    if (!phrase) return undefined
    const m = new RegExp(`${escape(phrase)}\\s*[:=(]?\\s*["'\`]?([A-Za-z0-9_$.+-]+)`, "i").exec(task)
    // A value at the end of a sentence doesn't take its period ("default false." is false).
    const value = m?.[1]?.replace(/[.+-]+$/, "")
    return value === "" ? undefined : value
  }
  if (!Number.isInteger(f.n) || f.n < 1) return undefined
  if (f.from === "key-letter") {
    const k = v.key[f.n - 1]
    const letter = k?.slice(k.lastIndexOf("+") + 1)
    return letter !== undefined && /^[A-Za-z0-9]$/.test(letter) ? letter.toUpperCase() : undefined
  }
  return v[f.from][f.n - 1]
}

/** A workflow's placeholders and the values the task states for them. */
export const fillsFor = (task: string, w: Workflow): Map<string, string> => {
  const out = new Map<string, string>()
  for (const f of w.cues?.fills ?? []) {
    const value = fillValue(task, f)
    if (value !== undefined && !out.has(f.placeholder)) out.set(f.placeholder, value)
  }
  return out
}

/** Text with each placeholder replaced by its value. */
export const applyFills = (text: string, values: ReadonlyMap<string, string>): string => {
  let out = text
  for (const [placeholder, value] of values) out = out.split(placeholder).join(value)
  return out
}

/** For each chosen workflow, the values the task states for its placeholders (only workflows with any). */
export const fillsOfChosen = (task: string, chosen: ReadonlyArray<Selected>): Map<string, Map<string, string>> =>
  new Map(chosen.flatMap((c) => {
    const values = fillsFor(task, c.workflow)
    return values.size === 0 ? [] : [[c.workflow.id, values] as const]
  }))

/** One change of a task that lists several: its number in the list (its place, for bullets) and its text. */
export interface TaskPart {
  readonly label: string
  readonly text: string
}

const ITEM = /^\s{0,3}(?:(\d{1,2})[.)]|[-*•])\s+/

/**
 * The changes a task lists, when it lists two or more (a numbered or bulleted
 * list): each item with the lines that follow it, up to the next item or a
 * blank line followed by text that isn't indented. `shared` is the rest, what
 * the task says of all of them ("Make sure the tests pass"). Undefined for a
 * task that is one change.
 */
export const taskParts = (task: string): { readonly parts: ReadonlyArray<TaskPart>; readonly shared: string } | undefined => {
  const parts: Array<{ label: string; lines: Array<string> }> = []
  const shared: Array<string> = []
  let current: { label: string; lines: Array<string> } | undefined
  let blank = false
  for (const line of task.replace(/\r\n/g, "\n").split("\n")) {
    const item = ITEM.exec(line)
    if (item !== null) {
      current = { label: item[1] ?? String(parts.length + 1), lines: [line.slice(item[0].length)] }
      parts.push(current)
    } else if (line.trim() === "") {
      blank = true
      continue
    } else if (current !== undefined && (!blank || /^\s{2,}/.test(line))) {
      current.lines.push(line.trim())
    } else {
      current = undefined
      shared.push(line)
    }
    blank = false
  }
  return parts.length < 2 ? undefined : { parts: parts.map((p) => ({ label: p.label, text: p.lines.join("\n") })), shared: shared.join("\n") }
}

/** How one change of a task in parts asks for a workflow: the steps it leaves out and the values it states. */
export interface PartUse {
  readonly label: string
  readonly skip: ReadonlyArray<number>
  readonly values: ReadonlyMap<string, string>
}

/**
 * A task that lists several changes, picked change by change: each item, with
 * what the task says of all of them, is a task of its own for the cues and
 * the fills, so each change gets its own values (the second change's key is
 * never the first's) and what one change rules out doesn't rule it out for
 * another. A workflow several changes need is chosen once, without the steps
 * none of them needs.
 */
export interface PartsChoice {
  readonly chosen: Array<Selected>
  /** For each chosen workflow, the changes that ask for it, in the task's order. */
  readonly uses: Map<string, Array<PartUse>>
  /** How many changes the task lists. */
  readonly count: number
}

/** The cues' choice for a task that lists several changes; undefined for a task that is one change. */
export const partsChoice = (memory: WorkflowMemory, task: string): PartsChoice | undefined => {
  const split = taskParts(task)
  if (split === undefined) return undefined
  const uses = new Map<string, Array<PartUse>>()
  const whys = new Map<string, Array<string>>()
  for (const p of split.parts) {
    const text = split.shared.trim() === "" ? p.text : `${p.text}\n\n${split.shared}`
    for (const c of cueChoice(memory, text)) {
      const id = c.workflow.id
      uses.set(id, [...(uses.get(id) ?? []), { label: p.label, skip: c.skip, values: fillsFor(text, c.workflow) }])
      whys.set(id, [...(whys.get(id) ?? []), `${p.label}: ${c.why}`])
    }
  }
  const chosen = graphOrder(memory).flatMap((w) => {
    const u = uses.get(w.id)
    if (u === undefined) return []
    const skip = u[0].skip.filter((s) => u.every((x) => x.skip.includes(s)))
    return [{ workflow: w, skip, why: (whys.get(w.id) ?? []).join("; ") }]
  })
  return { chosen, uses, count: split.parts.length }
}

/** The values the changes state for a workflow, as one set; undefined when two changes give a blank different values. */
export const mergedValues = (uses: ReadonlyArray<PartUse>): Map<string, string> | undefined => {
  const out = new Map<string, string>()
  for (const u of uses) {
    for (const [placeholder, value] of u.values) {
      const had = out.get(placeholder)
      if (had !== undefined && had !== value) return undefined
      out.set(placeholder, value)
    }
  }
  return out
}

/** The workflows the cues pick for a task: change by change when it lists several. */
export const choiceByCues = (memory: WorkflowMemory, task: string): Array<Selected> =>
  partsChoice(memory, task)?.chosen ?? cueChoice(memory, task)
