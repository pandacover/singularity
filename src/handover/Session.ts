/**
 * What a session was handed, kept while it runs, so that later hooks match
 * triggers locally without asking anything, and so the session's record can
 * say what each piece of memory did.
 *
 *     <tenant dir>/sessions/<session id>.json         what was handed over at task start
 *     <tenant dir>/sessions/<session id>.fired.jsonl  warnings whose trigger fired, one per line
 *     <tenant dir>/handovers.jsonl                    every handover, for the record
 *
 * Fired warnings are appended rather than written into the session file:
 * hooks for tool calls made in parallel run at the same time.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { Warning } from "../memory/Models.ts"

export const SessionState = Schema.Struct({
  session_id: Schema.String,
  tenant: Schema.String,
  subject: Schema.NullOr(Schema.String),
  /** The repo's top directory, and its HEAD when the task started. */
  repo: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  started_at: Schema.String,
  prompt: Schema.String,
  /** The memory version it was handed from. */
  version: Schema.Int,
  kind: Schema.NullOr(Schema.String),
  steps: Schema.Array(Schema.String),
  /** Warnings handed over at the start. */
  warnings: Schema.Array(Schema.String),
  /** Warnings with a trigger this subject may get, matched on every tool call. */
  triggers: Schema.Array(Warning),
  /** The model call that confirmed the route, if any. */
  selection: Schema.NullOr(Schema.Struct({
    model: Schema.String,
    cost_usd: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String)
  }))
})
export type SessionState = typeof SessionState.Type

export const Fired = Schema.Struct({ warning: Schema.String, at: Schema.String, tool: Schema.String })
export type Fired = typeof Fired.Type

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionState))
const encodeState = Schema.encodeEffect(SessionState)

const sessionsDir = (tenantDir: string, path: Path.Path) => path.join(tenantDir, "sessions")
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_")

export const readSession = Effect.fn("readSession")(function*(tenantDir: string, sessionId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(sessionsDir(tenantDir, path), `${safe(sessionId)}.json`)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return undefined
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeState),
    Effect.option,
    Effect.map(Option.getOrUndefined)
  )
})

export const writeSession = Effect.fn("writeSession")(function*(tenantDir: string, state: SessionState) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = sessionsDir(tenantDir, path)
  yield* fs.makeDirectory(dir, { recursive: true })
  const file = path.join(dir, `${safe(state.session_id)}.json`)
  yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(yield* encodeState(state), null, 2) + "\n")
  yield* fs.rename(`${file}.tmp`, file)
})

export const readFired = Effect.fn("readFired")(function*(tenantDir: string, sessionId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(sessionsDir(tenantDir, path), `${safe(sessionId)}.fired.jsonl`)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<Fired>
  const out: Array<Fired> = []
  for (const line of (yield* fs.readFileString(file)).split(/\r?\n/)) {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Fired))(line)
    if (Option.isSome(decoded)) out.push(decoded.value)
  }
  return out
})

export const appendFired = Effect.fn("appendFired")(function*(tenantDir: string, sessionId: string, fired: ReadonlyArray<Fired>) {
  if (fired.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = sessionsDir(tenantDir, path)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(
    path.join(dir, `${safe(sessionId)}.fired.jsonl`),
    fired.map((f) => JSON.stringify(f)).join("\n") + "\n",
    { flag: "a" }
  )
})

/** One line of handovers.jsonl. */
export const logHandover = Effect.fn("logHandover")(function*(tenantDir: string, entry: Readonly<Record<string, unknown>>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(tenantDir, { recursive: true })
  yield* fs.writeFileString(path.join(tenantDir, "handovers.jsonl"), JSON.stringify(entry) + "\n", { flag: "a" })
})
