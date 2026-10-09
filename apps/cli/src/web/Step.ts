/**
 * step, for the web reader: after each browser call, when the page the agent
 * just read shows a place of a step it was handed, a pointer to it (with the
 * reference the page has now), once per place; and a pitfall's warning when
 * its trigger appears (what the page shows, the control an action used, a
 * failed call's output), once per pitfall. Runs after every browser call.
 */
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { writeFileWhole } from "../local/Files.ts"
import { graphOrder, type Place, type Workflow, type WorkflowMemory } from "../workflows/Models.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import { browserTool } from "./Extract.ts"
import { findPlace, pagePattern } from "./Places.ts"
import { appendEvents, isPresetNote, logHandover, PageFile, readEvents, readWebState, responseText, safeId, sessionsDir, type WebEvent, webTriggerFires } from "./Session.ts"
import { byRef, pageOf, pageText, parseSnapshot } from "./Snapshot.ts"

const describeNode = (role: string, name: string, ref: string | undefined) => `${role}${name === "" ? "" : ` ${JSON.stringify(name)}`}${ref === undefined ? "" : ` [ref=${ref}]`}`

/** step, for the web: after a browser call, pointers to places this page shows and warnings whose trigger appeared. */
export const webStep = Effect.fn("web.step")(function*(
  input: { readonly sessionId: string; readonly tool: string; readonly toolInput: Readonly<Record<string, unknown>>; readonly response: unknown; readonly error: string | undefined },
  tenantDir: string
) {
  const kind = browserTool(input.tool)
  if (kind === undefined) return undefined
  const state = yield* readWebState(tenantDir, input.sessionId)
  if (state === undefined) return undefined
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const pageFile = path.join(sessionsDir(tenantDir, path), `${safeId(input.sessionId)}.page.json`)
  const before = (yield* fs.exists(pageFile).pipe(Effect.orElseSucceed(() => false)))
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(PageFile))(yield* fs.readFileString(pageFile)))
    : undefined
  const text = input.error ?? responseText(input.response)
  const view = pageOf(text)
  const url = view.url ?? before?.url ?? null
  const yaml = view.yaml ?? null
  if (view.url !== undefined || view.yaml !== undefined) {
    yield* writeFileWhole(fs, pageFile, JSON.stringify({ url, yaml: yaml ?? before?.yaml ?? null }) + "\n")
  }
  const events = yield* readEvents(tenantDir, input.sessionId)
  const pointed = new Set(events.filter((e) => e.kind === "pointer").map((e) => e.id))
  const fired = new Set(events.filter((e) => e.kind === "trigger").map((e) => e.id))
  const page = url === null ? undefined : pagePattern(url, state.values)
  const now = DateTime.formatIso(yield* DateTime.now)
  const out: Array<string> = []
  const added: Array<WebEvent> = []

  let memory: WorkflowMemory | undefined
  if (yaml !== null && state.places.some((id) => !pointed.has(id))) {
    const store = yield* WorkflowStore
    memory = yield* store.memory(state.version).pipe(Effect.orElseSucceed(() => undefined))
    const nodes = parseSnapshot(yaml)
    const places = new Map((memory?.places ?? []).map((p) => [p.id, p] as const))
    const stepsOf = (id: string) =>
      (memory === undefined ? [] : graphOrder(memory)).flatMap((w: Workflow) =>
        state.workflows.some((x) => x.id === w.id) ? w.steps.flatMap((s, i) => (s.place === id ? [`step ${i + 1} of "${w.name}"`] : [])) : []
      )
    for (const id of state.places) {
      if (pointed.has(id)) continue
      const place: Place | undefined = places.get(id)
      if (place === undefined) continue
      const found = findPlace(place, nodes, page)
      if (found === undefined) continue
      added.push({ kind: "pointer", id, at: now, page: page ?? null })
      out.push(`- ${stepsOf(id).join(", ") || "a step you were handed"}: ${describeNode(found.node.role, found.node.name, found.node.ref)} on this page`)
    }
  }

  // Warnings: what the page shows, the control the action used, a failed call's output.
  const lastNodes = before?.yaml ? parseSnapshot(before.yaml) : []
  const ref = typeof input.toolInput.target === "string" ? input.toolInput.target : typeof input.toolInput.ref === "string" ? input.toolInput.ref : undefined
  const control = [typeof input.toolInput.element === "string" ? input.toolInput.element : "", ref === undefined ? "" : byRef(lastNodes, ref)?.name ?? ""].filter((s) => s !== "").join(" ")
  const event = {
    page: yaml === null ? undefined : pageText(parseSnapshot(yaml)),
    control: control === "" ? undefined : control,
    error: input.error ?? (/(^|\n)### Error/.test(text ?? "") ? text : undefined)
  }
  const warnings = state.triggers.filter((p) => p.trigger !== null && !fired.has(p.id) && webTriggerFires(p.trigger, event))
  for (const p of warnings) added.push({ kind: "trigger", id: p.id, at: now, page: page ?? null })
  yield* appendEvents(tenantDir, input.sessionId, added)
  if (added.length === 0) return undefined
  yield* logHandover(tenantDir, { at: now, session_id: input.sessionId, moment: "step", subject: state.subject, version: state.version, tool: kind, page: page ?? null, pointers: added.filter((e) => e.kind === "pointer").map((e) => e.id), pitfalls: warnings.map((p) => p.id) })
  const lines: Array<string> = []
  if (out.length > 0) lines.push("Memory: this page has places from the steps you were handed:", ...out)
  const rules = warnings.filter((p) => !isPresetNote(p))
  const presets = warnings.filter(isPresetNote)
  if (rules.length > 0) lines.push("Memory from earlier sessions in this app: this matches a mistake made before.", ...rules.map((p) => `- ${p.text}`))
  if (presets.length > 0) lines.push("Memory: this form has fields that start set.", ...presets.map((p) => `- ${p.text}`))
  return lines.join("\n")
})

