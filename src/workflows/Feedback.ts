/**
 * What became of the memory a run was handed, judged from what the run did:
 * the evidence learning from results starts from (Evolve.ts).
 *
 * - A place shown was followed when the run edited there, else ignored. A
 *   place the run edited that memory didn't show is noted too: memory lacked
 *   it, or didn't pick it for this task.
 * - A workflow was followed when the run edited at one of its places shown;
 *   ignored when it had places shown and the run edited none of them.
 * - A pitfall handed over at the start was ignored when its trigger matched
 *   during the run anyway; one that fired during the run was ignored when it
 *   matched again after firing. Without a trigger, nobody can tell.
 *
 * Pure: the caller gives what was handed over and what the run did.
 */
import type { MemoryItem, MemoryUse } from "../records/Models.ts"
import { matchTrigger, type ToolEvent } from "../records/Triggers.ts"
import type { Pitfall } from "./Models.ts"

export interface Handed {
  readonly version: number
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly places: ReadonlyArray<string> }>
  /** Places shown (ids). */
  readonly shown: ReadonlyArray<string>
  /** Of those, places shown to be read (a test helper's class), which a run isn't expected to edit. */
  readonly read?: ReadonlyArray<string>
  /** Pitfalls handed over at the start, and those whose trigger fired during the run (with when). */
  readonly pitfalls: ReadonlyArray<string>
  readonly fired: ReadonlyArray<{ readonly pitfall: string; readonly at: number }>
  readonly triggers: ReadonlyArray<Pitfall>
}

export interface Did {
  /** Places the run edited (ids), and where they are. */
  readonly edited: ReadonlyMap<string, string>
  /** The run's tool calls as trigger events, with when each started (ms), if known. */
  readonly events: ReadonlyArray<{ readonly event: ToolEvent; readonly at: number | undefined }>
}

export const SETUP = "workflows"

export const feedbackOf = (handed: Handed, did: Did): MemoryUse => {
  const items: Array<MemoryItem> = []
  const read = new Set(handed.read ?? [])
  const shown = new Set(handed.shown.filter((p) => !read.has(p)))
  for (const w of handed.workflows) {
    const mine = w.places.filter((p) => shown.has(p))
    const used = mine.filter((p) => did.edited.has(p))
    items.push({
      id: w.id,
      kind: "workflow",
      moment: "start",
      outcome: mine.length === 0 ? "unknown" : used.length > 0 ? "followed" : "ignored",
      note: mine.length === 0 ? null : `edited ${used.length} of its ${mine.length} places shown`
    })
  }
  for (const p of handed.shown) {
    if (read.has(p)) {
      items.push({ id: p, kind: "read-place", moment: "start", outcome: "unknown", note: "shown to read" })
      continue
    }
    const edited = did.edited.has(p)
    items.push({ id: p, kind: "place", moment: "start", outcome: edited ? "followed" : "ignored", note: edited ? null : "shown, not edited" })
  }
  for (const [p, file] of did.edited) {
    if (!shown.has(p)) items.push({ id: p, kind: "place-not-shown", moment: "start", outcome: "unknown", note: `edited in ${file}, not shown` })
  }
  const byId = new Map(handed.triggers.map((p) => [p.id, p]))
  for (const id of handed.pitfalls) {
    const t = byId.get(id)?.trigger ?? null
    if (t === null) {
      items.push({ id, kind: "pitfall", moment: "start", outcome: "unknown", note: null })
      continue
    }
    const made = did.events.some((e) => matchTrigger(t, e.event))
    items.push({ id, kind: "pitfall", moment: "start", outcome: made ? "ignored" : "followed", note: made ? "its trigger matched anyway" : null })
  }
  for (const f of handed.fired) {
    const t = byId.get(f.pitfall)?.trigger ?? null
    if (t === null) continue
    const again = did.events.some((e) => e.at !== undefined && e.at > f.at && matchTrigger(t, e.event))
    items.push({
      id: f.pitfall,
      kind: "pitfall",
      moment: "trigger",
      outcome: again ? "ignored" : "followed",
      note: again ? "the same mistake came again after the warning" : null
    })
  }
  return { setup: SETUP, version: handed.version, items }
}
