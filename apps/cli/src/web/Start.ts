/**
 * start, for the web reader: the app is the first address in the task's
 * text. Memory hands over every rule it has for the app, whatever the task
 * (a rule that only came with a picked workflow was lost whenever the task's
 * wording picked none), and the forms that open with fields already set
 * (Presets.ts); then the workflows it picks by their cues (no model), the
 * blanks the task states filled in, each step's place in words. Pitfalls with
 * a trigger are armed for the session (Step.ts).
 */
import { DateTime, Effect, FileSystem, Path } from "effect"
import { writeFileWhole } from "../local/Files.ts"
import { applyFills, cueChoice, fillsOfChosen, hasCues } from "../workflows/Cues.ts"
import { END, START, type WorkflowMemory } from "../workflows/Models.ts"
import { type Selected, wordChoice } from "../workflows/Select.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import { describeWebPlace, taskValues } from "./Places.ts"
import { isPresetNote, logHandover, MAX_WEB_HANDOVER_CHARS, sessionsDir, type WebSession, webSessionFile, webTarget } from "./Session.ts"

/** Room for the app's rules, and for the notes on fields that start set; the workflows get the rest. */
const RULES_CHARS = 4500
const PRESETS_CHARS = 1500

/** Memory a subject may get: its own workflows, places and pitfalls, and the edges between them. */
export const forWebSubject = (m: WorkflowMemory, subject: string): WorkflowMemory => {
  const workflows = m.workflows.filter((w) => w.subject === subject)
  const ids = new Set(workflows.map((w) => w.id))
  const known = (x: string) => x === START || x === END || ids.has(x)
  return {
    ...m,
    workflows,
    places: m.places.filter((p) => p.subject === subject),
    pitfalls: m.pitfalls.filter((p) => p.subject === subject),
    edges: m.edges.filter((e) => known(e.from) && known(e.to))
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The lines that fit in the room, in order; one too long for what is left gives way to the next. */
const within = <T extends { readonly line: string }>(items: ReadonlyArray<T>, room: number): Array<T> => {
  const out: Array<T> = []
  let used = 0
  for (const it of items) {
    if (used + it.line.length + 1 > room) continue
    out.push(it)
    used += it.line.length + 1
  }
  return out
}

/** The hand-over at task start: the app's rules and the forms that start set, every time; then the workflows picked, each step with its place in words. */
export const renderWebHandover = (
  memory: WorkflowMemory,
  chosen: ReadonlyArray<Selected>,
  fills: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
  origin: string,
  budget = MAX_WEB_HANDOVER_CHARS
): { readonly text: string | undefined; readonly places: Array<string>; readonly pitfalls: Array<string> } => {
  const places = new Map(memory.places.map((p) => [p.id, p]))
  const usedPlaces: Array<string> = []
  const lines: Array<string> = [
    `Memory from earlier sessions in this app (${origin}): its rules, and how this kind of work was done before.`,
    "Steps are what earlier sessions did, not a script: read each page and form before you act on it, since the task may need what they don't say. Places say where earlier sessions found each control; when a page you read shows one, memory points to it then. Pages may have changed since: trust what the page shows.",
    ""
  ]
  // The picked workflows' rules first, then the rest, those more sessions showed first.
  const picked = new Set(chosen.flatMap((c) => c.workflow.pitfalls))
  const rules = within(
    memory.pitfalls
      .filter((p) => !isPresetNote(p))
      .sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)) || b.evidence.length - a.evidence.length || a.id.localeCompare(b.id))
      .map((p) => ({ id: p.id, line: `- ${p.text}` })),
    RULES_CHARS
  )
  if (rules.length > 0) lines.push("## Rules of this app, from earlier sessions and the manager's feedback", ...rules.map((r) => r.line), "")
  const presets = within(memory.pitfalls.filter(isPresetNote).map((p) => ({ id: p.id, line: `- ${p.text}` })), PRESETS_CHARS)
  if (presets.length > 0) lines.push("## Forms that open with fields already set", ...presets.map((r) => r.line), "")
  for (const c of chosen) {
    const w = c.workflow
    const values = fills?.get(w.id) ?? new Map<string, string>()
    lines.push(`## ${w.name}`)
    if (w.blanks.length > 0) lines.push(`Blanks: ${w.blanks.map((b) => `{${b.name}}${values.has(`{${b.name}}`) ? ` = ${values.get(`{${b.name}}`)}` : ""} (${b.meaning})`).join("; ")}`)
    let n = 0
    w.steps.forEach((s, i) => {
      if (c.skip.includes(i + 1)) return
      n++
      const p = s.place === null ? undefined : places.get(s.place)
      if (p !== undefined && !usedPlaces.includes(p.id)) usedPlaces.push(p.id)
      const where = p === undefined ? "" : ` (at ${describeWebPlace(p)})`
      lines.push(`${n}. ${applyFills(s.do, values)}${s.when === null ? "" : ` [${s.when}]`}${where}`)
    })
    lines.push("")
  }
  if (chosen.length === 0 && rules.length === 0 && presets.length === 0) return { text: undefined, places: [], pitfalls: [] }
  return { text: clip(lines.join("\n").trimEnd(), budget), places: usedPlaces, pitfalls: [...rules, ...presets].map((r) => r.id) }
}

export interface WebStartResult {
  readonly text: string | undefined
  readonly state: WebSession | undefined
}

/** start, for the web: what memory knows for this task in this app. */
export const webStart = Effect.fn("web.start")(function*(
  input: { readonly sessionId: string; readonly prompt: string },
  options: { readonly tenantDir: string; readonly persist?: boolean | undefined }
) {
  const target = webTarget(input.prompt)
  if (target === undefined) return { text: undefined, state: undefined } satisfies WebStartResult
  const store = yield* WorkflowStore
  const version = yield* store.head()
  const memory = forWebSubject(yield* store.memory(), target.subject)
  if (memory.workflows.length === 0 && memory.pitfalls.length === 0) return { text: undefined, state: undefined } satisfies WebStartResult
  const chosen = hasCues(memory) ? cueChoice(memory, input.prompt) : wordChoice(memory, input.prompt)
  const fills = hasCues(memory) ? fillsOfChosen(input.prompt, chosen) : undefined
  const handover = renderWebHandover(memory, chosen, fills, target.origin)
  const now = DateTime.formatIso(yield* DateTime.now)
  const state: WebSession = {
    session_id: input.sessionId,
    tenant: store.tenant,
    subject: target.subject,
    origin: target.origin,
    prompt: input.prompt,
    values: taskValues(input.prompt),
    version,
    workflows: chosen.map((c) => ({ id: c.workflow.id, skip: [...c.skip] })),
    places: handover.places,
    pitfalls: handover.pitfalls,
    triggers: memory.pitfalls.filter((p) => p.trigger !== null),
    started_at: now
  }
  if (options.persist !== false) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(sessionsDir(options.tenantDir, path), { recursive: true })
    yield* writeFileWhole(fs, webSessionFile(options.tenantDir, input.sessionId, path), JSON.stringify(state, null, 2) + "\n")
    yield* logHandover(options.tenantDir, {
      at: now,
      session_id: input.sessionId,
      moment: "start",
      subject: target.subject,
      version,
      workflows: state.workflows,
      reasons: chosen.map((c) => `${c.workflow.id}: ${c.why}`),
      places: handover.places,
      pitfalls: handover.pitfalls,
      triggers: state.triggers.map((p) => p.id),
      chars: handover.text?.length ?? 0,
      text: handover.text ?? null
    })
  }
  return { text: handover.text, state } satisfies WebStartResult
})

