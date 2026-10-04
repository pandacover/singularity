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
 * This module is what task start needs; writing the cues is CueWriter.ts.
 */
import { type Fill, graphOrder, type Workflow, type WorkflowMemory } from "./Models.ts"
import type { Selected } from "./Select.ts"

/** The task's text without its negated clauses: from "not", "n't", "never", "no" or "without" to the end of the clause. */
export const positiveText = (task: string): string =>
  task.replace(/(?:\b(?:not|never|no|without)\b|n't\b)[^.,;:()\n]*/gi, " ")

const said = (text: string, phrases: ReadonlyArray<string>): string | undefined => {
  const t = text.toLowerCase()
  return phrases.find((p) => p.trim() !== "" && t.includes(p.trim().toLowerCase()))
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
