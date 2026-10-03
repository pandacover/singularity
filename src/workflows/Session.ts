/**
 * What a session was handed by memory v1, kept while it runs, so the tool-call
 * hook can match pitfall triggers locally, and so the session's end (or an
 * eval run's) can tell what each piece of memory did.
 *
 *     <tenant dir>/workflows/sessions/<session id>.json         what was handed over at task start
 *     <tenant dir>/workflows/sessions/<session id>.fired.jsonl  pitfalls whose trigger fired, one per line
 *     <tenant dir>/workflows/handovers.jsonl                    every hand-over, for the record
 *
 * Fired pitfalls are appended rather than written into the session file:
 * hooks for tool calls made in parallel run at the same time.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { Pitfall } from "./Models.ts"

export const ShownPlace = Schema.Struct({
  place: Schema.String,
  file: Schema.String,
  from: Schema.Int,
  to: Schema.Int
})

export const WorkflowSession = Schema.Struct({
  session_id: Schema.String,
  tenant: Schema.String,
  subject: Schema.NullOr(Schema.String),
  /** The repo's top directory, and its HEAD when the task started. */
  repo: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  started_at: Schema.String,
  prompt: Schema.String,
  version: Schema.Int,
  /** The workflows handed over, in order, and the steps of each that were left out (from 1). */
  workflows: Schema.Array(Schema.Struct({ id: Schema.String, skip: Schema.Array(Schema.Int) })),
  /** The places shown, as found in the code then. */
  shown: Schema.Array(ShownPlace),
  /** Places of chosen steps the code no longer had. */
  missing: Schema.Array(Schema.String),
  /** Pitfalls handed over with the workflows at the start. */
  pitfalls: Schema.Array(Schema.String),
  /** Pitfalls with a trigger, matched on every tool call. */
  triggers: Schema.Array(Pitfall),
  /** The model call that picked the workflows, if any. */
  selection: Schema.NullOr(Schema.Struct({
    model: Schema.String,
    cost_usd: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String)
  }))
})
export type WorkflowSession = typeof WorkflowSession.Type

export const Fired = Schema.Struct({ pitfall: Schema.String, at: Schema.String, tool: Schema.String })
export type Fired = typeof Fired.Type

const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowSession))
const encodeSession = Schema.encodeEffect(WorkflowSession)

export const sessionsDir = (tenantDir: string, path: Path.Path) => path.join(tenantDir, "workflows", "sessions")
export const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_")

export const readSession = Effect.fn("workflows.readSession")(function*(tenantDir: string, sessionId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(sessionsDir(tenantDir, path), `${safeId(sessionId)}.json`)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return undefined
  return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeSession), Effect.option, Effect.map(Option.getOrUndefined))
})

export const writeSession = Effect.fn("workflows.writeSession")(function*(tenantDir: string, state: WorkflowSession) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = sessionsDir(tenantDir, path)
  yield* fs.makeDirectory(dir, { recursive: true })
  const file = path.join(dir, `${safeId(state.session_id)}.json`)
  yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(yield* encodeSession(state), null, 2) + "\n")
  yield* fs.rename(`${file}.tmp`, file)
})

export const readFired = Effect.fn("workflows.readFired")(function*(tenantDir: string, sessionId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(sessionsDir(tenantDir, path), `${safeId(sessionId)}.fired.jsonl`)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<Fired>
  const out: Array<Fired> = []
  for (const line of (yield* fs.readFileString(file)).split(/\r?\n/)) {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Fired))(line)
    if (Option.isSome(decoded)) out.push(decoded.value)
  }
  return out
})

export const appendFired = Effect.fn("workflows.appendFired")(function*(tenantDir: string, sessionId: string, fired: ReadonlyArray<Fired>) {
  if (fired.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = sessionsDir(tenantDir, path)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(path.join(dir, `${safeId(sessionId)}.fired.jsonl`), fired.map((f) => JSON.stringify(f)).join("\n") + "\n", { flag: "a" })
})

/** One line of the hand-over log. */
export const logHandover = Effect.fn("workflows.logHandover")(function*(tenantDir: string, entry: Readonly<Record<string, unknown>>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(tenantDir, "workflows")
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(path.join(dir, "handovers.jsonl"), JSON.stringify(entry) + "\n", { flag: "a" })
})
