/**
 * Fields that start set, learned without a model: for each page sessions
 * acted on, the settings it opened with already made (a ticked box, a chosen
 * option) that some session left as they were, and how often sessions changed
 * each. Steps say what sessions changed; a form's defaults are what it does
 * when nobody touches them, and a procedure that doesn't mention them lets
 * the agent skip reading them. Text already in a box is left out: it is in
 * plain sight.
 *
 * Kept beside the app's rules, as pitfalls whose id starts with `preset-`:
 * handed over at the start of every task in the app, and again when a page
 * shows one of the fields. Written again from all the app's sessions at every
 * learning round; the model that writes the rules never sees them.
 */
import { createHash } from "node:crypto"
import { namedValue } from "../workflows/Induce.ts"
import type { Pitfall } from "../workflows/Models.ts"
import { parseHead } from "./Places.ts"
import type { WebRecord } from "./Records.ts"
import { PRESET_PREFIX } from "./Session.ts"

const MAX_FIELDS = 6
const TEXT_ROLES = new Set(["textbox", "searchbox", "spinbutton", "slider"])

interface Tally {
  readonly control: string
  readonly states: Set<string>
  seen: number
  changed: number
  /** Sessions that left it as it was and failed. */
  leftFailed: number
}

const describeState = (states: ReadonlySet<string>): string => {
  // Several values across sessions, or one that names a task's own value.
  if (states.size !== 1) return "already set"
  const s = [...states][0]
  return s === "ticked" || s === "partly ticked" || s === "selected" ? s : s === "filled" ? "already filled in" : `set to ${JSON.stringify(s)}`
}

const describeTally = (t: Tally): string =>
  `${t.control} ${describeState(t.states)} (earlier sessions changed it in ${t.changed} of ${t.seen}${t.leftFailed > 0 ? `; ${t.leftFailed === 1 ? "one" : t.leftFailed} that left it failed` : ""})`

/** The notes for an app's sessions, one per page with fields some session left as they were. */
export const presetNotes = (subject: string, records: ReadonlyArray<WebRecord>): Array<Pitfall> => {
  const pages = new Map<string, { evidence: Set<string>; fields: Map<string, Tally> }>()
  for (const r of records) {
    for (const f of r.forms ?? []) {
      const p = pages.get(f.page) ?? { evidence: new Set<string>(), fields: new Map<string, Tally>() }
      p.evidence.add(r.id)
      for (const x of f.fields) {
        const t = p.fields.get(x.control) ?? { control: x.control, states: new Set<string>(), seen: 0, changed: 0, leftFailed: 0 }
        t.states.add(x.state)
        t.seen++
        if (x.changed) t.changed++
        else if (r.success === false) t.leftFailed++
        p.fields.set(x.control, t)
      }
      pages.set(f.page, p)
    }
  }
  // Written without a model, so checked like its answers: no task's own values, from any session.
  const values = [...new Set(records.flatMap((r) => r.values))]
  const out: Array<Pitfall> = []
  for (const [page, p] of [...pages].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (namedValue(page, values) !== undefined) continue
    // A field every session changed is in the steps already. Text already in a box is in plain sight
    // (an address being edited); a ticked box or a chosen option is a setting that acts on its own.
    const fields = [...p.fields.values()]
      .filter((t) => t.changed < t.seen && !TEXT_ROLES.has(parseHead(t.control).role) && !t.states.has("filled") && namedValue(t.control, values) === undefined)
      .map((t): Tally => ([...t.states].some((s) => namedValue(s, values) !== undefined) ? { ...t, states: new Set<string>() } : t))
      .slice(0, MAX_FIELDS)
    if (fields.length === 0) continue
    // The trigger: the name of the field sessions changed or failed on most, or the longest part of it
    // that isn't a blank ("Charge renewal fee ({n})" is looked for as "Charge renewal fee").
    const label = [...fields]
      .sort((a, b) => b.changed + b.leftFailed - (a.changed + a.leftFailed))
      .map((t) => parseHead(t.control).name.split(/\{[a-z]+\}/i).map((s) => s.replace(/^[\s([:,.-]+|[\s([:,.-]+$/g, "")).sort((x, y) => y.length - x.length)[0] ?? "")
      .find((n) => n.length >= 5)
    out.push({
      id: `${PRESET_PREFIX}${createHash("sha256").update(`${subject}\u0000${page}`).digest("hex").slice(0, 8)}`,
      subject,
      text: `On ${page}, the form opens with ${fields.map(describeTally).join("; ")}. Steps from memory may not mention these: decide each against the task before you submit.`,
      trigger: label === undefined ? null : { on: "page", all: [label], none: [], file: null },
      evidence: [...p.evidence].sort(),
      cost_tokens: 0
    })
  }
  return out
}
