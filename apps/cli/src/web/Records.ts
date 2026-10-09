/**
 * Records of web sessions: what the web reader learns from. One per session,
 * successful or not, with the check's feedback when there was one: a failed
 * session and what the manager said about it is where a silent rule is
 * learned. Kept apart from code records (src/records/), which hold diffs.
 *
 *     <tenant dir>/web/records/<subject>/<id>.json
 *
 * Persisted with snake_case keys, like everything else on disk here.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { writeFileWhole } from "../local/Files.ts"

export const WebActionJson = Schema.Struct({
  index: Schema.Int,
  kind: Schema.String,
  page: Schema.NullOr(Schema.String),
  chain: Schema.NullOr(Schema.Array(Schema.Struct({ role: Schema.String, name: Schema.String }))),
  place: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  /** For a form field: what it was set to just before (`ticked`, an option). Absent in records from before it was kept. */
  was: Schema.optionalKey(Schema.NullOr(Schema.String)),
  failed: Schema.Boolean,
  error: Schema.NullOr(Schema.String)
})
export type WebActionJson = typeof WebActionJson.Type

/** A page the session acted on that opened with fields already set, and whether it changed each. */
export const WebFormJson = Schema.Struct({
  page: Schema.String,
  fields: Schema.Array(Schema.Struct({ control: Schema.String, state: Schema.String, changed: Schema.Boolean }))
})
export type WebFormJson = typeof WebFormJson.Type

export const WebRecord = Schema.Struct({
  id: Schema.String,
  tenant: Schema.String,
  subject: Schema.String,
  session_id: Schema.String,
  /** The eval chore, when there is one. */
  task_id: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  /** The task's own values, which memory must never carry. */
  values: Schema.Array(Schema.String),
  /** null when nobody said how it went. */
  success: Schema.NullOr(Schema.Boolean),
  feedback: Schema.NullOr(Schema.String),
  actions: Schema.Array(WebActionJson),
  messages: Schema.Array(Schema.Struct({ after: Schema.Int, page: Schema.NullOr(Schema.String), text: Schema.String })),
  /** Fields set before the session touched them. Absent in records from before they were kept. */
  forms: Schema.optionalKey(Schema.Array(WebFormJson)),
  turns: Schema.NullOr(Schema.Int),
  tokens: Schema.NullOr(Schema.Int),
  cost_usd: Schema.NullOr(Schema.Number),
  /** What memory handed the session, and what came of it; null when it had none. */
  memory: Schema.NullOr(Schema.Struct({
    version: Schema.Int,
    workflows: Schema.Array(Schema.String),
    places: Schema.Array(Schema.String),
    pointed: Schema.Array(Schema.String),
    used: Schema.Array(Schema.String),
    fired: Schema.Array(Schema.String)
  })),
  created_at: Schema.String
})
export type WebRecord = typeof WebRecord.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(WebRecord))
const encode = Schema.encodeEffect(WebRecord)

export const webDir = (tenantDir: string, path: Path.Path) => path.join(tenantDir, "web")
const recordsDir = (tenantDir: string, subject: string, path: Path.Path) => path.join(webDir(tenantDir, path), "records", subject)

export const putWebRecord = Effect.fn("web.putRecord")(function*(tenantDir: string, record: WebRecord) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = recordsDir(tenantDir, record.subject, path)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* writeFileWhole(fs, path.join(dir, `${record.id}.json`), JSON.stringify(yield* encode(record), null, 2) + "\n")
})

/** A subject's records, oldest first. */
export const webRecords = Effect.fn("web.records")(function*(tenantDir: string, subject: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = recordsDir(tenantDir, subject, path)
  if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<WebRecord>
  const out: Array<WebRecord> = []
  for (const name of (yield* fs.readDirectory(dir)).filter((n) => n.endsWith(".json")).sort()) {
    const r = decode(yield* fs.readFileString(path.join(dir, name)))
    if (Option.isSome(r)) out.push(r.value)
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
})

/** Every web subject with records. */
export const webSubjects = Effect.fn("web.subjects")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(webDir(tenantDir, path), "records")
  if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<string>
  return (yield* fs.readDirectory(dir)).sort()
})
