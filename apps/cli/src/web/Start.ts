/**
 * start, for the web reader: the app is the first address in the task's
 * text; memory for it picks workflows by their cues (no model), fills the
 * blanks the task states, and hands them over with each step's place in
 * words, then the app's rules no workflow carries. Pitfalls with a trigger
 * are armed for the session (Step.ts).
 */
import { DateTime, Effect, FileSystem, Path } from "effect"
import { writeFileWhole } from "../local/Files.ts"
import { applyFills, cueChoice, fillsOfChosen, hasCues } from "../workflows/Cues.ts"
import { END, type Pitfall, START, type WorkflowMemory } from "../workflows/Models.ts"
import { type Selected, wordChoice } from "../workflows/Select.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import { describeWebPlace, taskValues } from "./Places.ts"
import { logHandover, MAX_WEB_HANDOVER_CHARS, sessionsDir, type WebSession, webSessionFile, webTarget } from "./Session.ts"

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

/** The hand-over at task start: the workflows picked, each step with its place in words; then what memory knows of the app's rules. */
export const renderWebHandover = (
  memory: WorkflowMemory,
  chosen: ReadonlyArray<Selected>,
  fills: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
  origin: string,
  budget = MAX_WEB_HANDOVER_CHARS
): { readonly text: string | undefined; readonly places: Array<string>; readonly pitfalls: Array<string> } => {
  const places = new Map(memory.places.map((p) => [p.id, p]))
  const pitfalls = new Map(memory.pitfalls.map((p) => [p.id, p]))
  const usedPlaces: Array<string> = []
  const usedPitfalls: Array<string> = []
  const lines: Array<string> = [
    `Memory from earlier sessions in this app (${origin}): how this kind of work was done before, and what went wrong.`,
    "Places say where earlier sessions found each control; when a page you read shows one, memory points to it then. Pages may have changed since: trust what the page shows.",
    ""
  ]
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
    // A workflow's own pitfalls come with it, triggered or not: rules are cheap to read and costly to miss.
    const own = w.pitfalls.map((id) => pitfalls.get(id)).filter((p): p is Pitfall => p !== undefined)
    for (const p of own) {
      if (!usedPitfalls.includes(p.id)) usedPitfalls.push(p.id)
      lines.push(`Watch out: ${p.text}`)
    }
    lines.push("")
  }
  // Rules of the app no workflow carries: what earlier sessions were told, or ran into, anywhere in it.
  const inWorkflows = new Set(memory.workflows.flatMap((w) => w.pitfalls))
  const general = memory.pitfalls.filter((p) => p.trigger === null && !inWorkflows.has(p.id) && !usedPitfalls.includes(p.id))
  if (general.length > 0) {
    lines.push("## What earlier sessions learned about this app")
    for (const p of general.slice(0, 12)) {
      usedPitfalls.push(p.id)
      lines.push(`- ${p.text}`)
    }
    lines.push("")
  }
  if (chosen.length === 0 && general.length === 0) return { text: undefined, places: [], pitfalls: [] }
  return { text: clip(lines.join("\n").trimEnd(), budget), places: usedPlaces, pitfalls: usedPitfalls }
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

