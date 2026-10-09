/**
 * A web session as memory keeps it while it runs: what was handed over at the
 * start, the pointers and warnings handed over during it, and the last page
 * the agent read. Read by the step hook after every browser call, so this
 * module loads nothing but the file system and schemas.
 *
 *     <tenant dir>/web/sessions/<id>.json          what was handed over at the start
 *     <tenant dir>/web/sessions/<id>.events.jsonl  pointers and warnings handed over during it
 *     <tenant dir>/web/sessions/<id>.page.json     the last page the agent read
 *     <tenant dir>/web/handovers.jsonl             every hand-over, for the record
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { Trigger } from "../records/Triggers.ts"
import { Pitfall } from "../workflows/Models.ts"
import { firstUrl, originOf, webSubjectId } from "./Places.ts"
import { webDir } from "./Records.ts"

export const MAX_WEB_HANDOVER_CHARS = 9800

export const WebSession = Schema.Struct({
  session_id: Schema.String,
  tenant: Schema.String,
  subject: Schema.String,
  origin: Schema.String,
  prompt: Schema.String,
  values: Schema.Array(Schema.String),
  version: Schema.Int,
  workflows: Schema.Array(Schema.Struct({ id: Schema.String, skip: Schema.Array(Schema.Int) })),
  /** Places of the steps handed over, to point at when a page shows them. */
  places: Schema.Array(Schema.String),
  /** Pitfalls handed over at the start. */
  pitfalls: Schema.Array(Schema.String),
  /** Pitfalls with a trigger, watched on every browser call. */
  triggers: Schema.Array(Pitfall),
  started_at: Schema.String
})
export type WebSession = typeof WebSession.Type

export const WebEvent = Schema.Struct({ kind: Schema.Literals(["pointer", "trigger"]), id: Schema.String, at: Schema.String, page: Schema.NullOr(Schema.String) })
export type WebEvent = typeof WebEvent.Type

export const PageFile = Schema.Struct({ url: Schema.NullOr(Schema.String), yaml: Schema.NullOr(Schema.String) })

export const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_")
export const sessionsDir = (tenantDir: string, path: Path.Path) => path.join(webDir(tenantDir, path), "sessions")

export const webSessionFile = (tenantDir: string, sessionId: string, path: Path.Path) => path.join(sessionsDir(tenantDir, path), `${safeId(sessionId)}.json`)

export const readWebState = Effect.fn("web.readState")(function*(tenantDir: string, sessionId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = webSessionFile(tenantDir, sessionId, path)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return undefined
  const text = yield* fs.readFileString(file)
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(WebSession))(text))
})

export const readEvents = Effect.fn("web.readEvents")(function*(tenantDir: string, sessionId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(sessionsDir(tenantDir, path), `${safeId(sessionId)}.events.jsonl`)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<WebEvent>
  return (yield* fs.readFileString(file)).split(/\r?\n/).flatMap((l) => Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(WebEvent))(l)))
})

export const appendEvents = Effect.fn("web.appendEvents")(function*(tenantDir: string, sessionId: string, events: ReadonlyArray<WebEvent>) {
  if (events.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = sessionsDir(tenantDir, path)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(path.join(dir, `${safeId(sessionId)}.events.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { flag: "a" })
})

export const logHandover = Effect.fn("web.logHandover")(function*(tenantDir: string, entry: Readonly<Record<string, unknown>>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = webDir(tenantDir, path)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(path.join(dir, "handovers.jsonl"), JSON.stringify(entry) + "\n", { flag: "a" })
})

/** The app a task is about: the first address in its text. */
export const webTarget = (prompt: string): { readonly origin: string; readonly subject: string } | undefined => {
  const url = firstUrl(prompt)
  const origin = url === undefined ? undefined : originOf(url)
  return origin === undefined ? undefined : { origin, subject: webSubjectId(origin) }
}


/** A tool response as text: MCP content blocks joined, a string as is, anything else as JSON. */
export const responseText = (response: unknown): string | undefined => {
  if (response === undefined || response === null) return undefined
  if (typeof response === "string") return response
  const blocks = Array.isArray(response) ? response : Array.isArray((response as { content?: unknown }).content) ? (response as { content: Array<unknown> }).content : undefined
  if (blocks !== undefined) {
    return blocks.map((b) => (typeof b === "string" ? b : typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "")).join("\n")
  }
  return JSON.stringify(response)
}

const containsAll = (text: string, all: ReadonlyArray<string>) => all.every((s) => text.includes(s))
const containsNone = (text: string, none: ReadonlyArray<string>) => none.every((s) => !text.includes(s))

/** Whether a web pitfall's trigger fires: on what the page shows, the control an action used, or a failed call's output. */
export const webTriggerFires = (t: Trigger, e: { readonly page: string | undefined; readonly control: string | undefined; readonly error: string | undefined }): boolean => {
  switch (t.on) {
    case "page":
      return e.page !== undefined && containsAll(e.page, t.all) && containsNone(e.page, t.none)
    case "action":
      return e.control !== undefined && containsAll(e.control, t.all) && containsNone(e.control, t.none)
    case "error":
      return e.error !== undefined && containsAll(e.error, t.all)
    default:
      return false
  }
}


