/**
 * Computer-use memory's files in the tenant (Model.ts has the layout): the
 * salt, each app's trails and index, and what each session was handed.
 * Files are read back with their Schemas; one that doesn't decode is left
 * out, as if it weren't there.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { randomBytes } from "node:crypto"
import { writeFileWhole } from "../local/Files.ts"
import { buildIndex } from "./Index.ts"
import { AppIndex, Given, Trail } from "./Model.ts"
import { fileName } from "./Paths.ts"

export { fileName }

export const computerDir = (tenantDir: string, path: Path.Path) => path.join(tenantDir, "computer")

export const appDir = (tenantDir: string, app: string, path: Path.Path) => path.join(computerDir(tenantDir, path), "apps", fileName(app))

const decodeTrail = Schema.decodeUnknownOption(Schema.fromJsonString(Trail))
const decodeIndex = Schema.decodeUnknownOption(Schema.fromJsonString(AppIndex))
const decodeGiven = Schema.decodeUnknownOption(Schema.fromJsonString(Given))

const readText = (fs: FileSystem.FileSystem, file: string) => fs.readFileString(file).pipe(Effect.option)

/** The salt fingerprints are taken with: made once, kept in the home. */
export const loadSalt = Effect.fn("computer.loadSalt")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(computerDir(tenantDir, path), "salt")
  const existing = yield* readText(fs, file)
  if (Option.isSome(existing) && existing.value.trim().length >= 32) return existing.value.trim()
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const salt = randomBytes(32).toString("hex")
  yield* writeFileWhole(fs, file, `${salt}\n`)
  return salt
})

/** The salt if it exists, without making one: the hook reads, never writes it. */
export const readSalt = Effect.fn("computer.readSalt")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* readText(fs, path.join(computerDir(tenantDir, path), "salt"))
  return Option.isSome(text) && text.value.trim().length >= 32 ? text.value.trim() : undefined
})

export const readIndex = Effect.fn("computer.readIndex")(function*(tenantDir: string, app: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* readText(fs, path.join(appDir(tenantDir, app, path), "index.json"))
  return Option.isSome(text) ? Option.getOrUndefined(decodeIndex(text.value)) : undefined
})

export const readTrails = Effect.fn("computer.readTrails")(function*(tenantDir: string, app: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(appDir(tenantDir, app, path), "trails")
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>))
  const out: Array<Trail> = []
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const text = yield* readText(fs, path.join(dir, name))
    const trail = Option.isSome(text) ? Option.getOrUndefined(decodeTrail(text.value)) : undefined
    if (trail !== undefined) out.push(trail)
  }
  return out
})

/** The apps memory has trails of. */
export const listApps = Effect.fn("computer.listApps")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(computerDir(tenantDir, path), "apps")
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>))
  const out: Array<string> = []
  for (const name of names.sort()) {
    const index = yield* readText(fs, path.join(dir, name, "index.json"))
    const app = Option.isSome(index) ? Option.getOrUndefined(decodeIndex(index.value))?.app : undefined
    if (app !== undefined) out.push(app)
  }
  return out
})

/** Store a session's trail of an app, replacing an earlier one of the same session, and build the app's index again. */
export const storeTrail = Effect.fn("computer.storeTrail")(function*(tenantDir: string, trail: Trail) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = appDir(tenantDir, trail.app, path)
  yield* fs.makeDirectory(path.join(dir, "trails"), { recursive: true })
  yield* writeFileWhole(fs, path.join(dir, "trails", `${fileName(trail.session)}.json`), JSON.stringify(trail) + "\n")
  const index = buildIndex(trail.app, yield* readTrails(tenantDir, trail.app))
  yield* writeFileWhole(fs, path.join(dir, "index.json"), JSON.stringify(index) + "\n")
  return index
})

const givenFile = (tenantDir: string, session: string, path: Path.Path) => path.join(computerDir(tenantDir, path), "sessions", `${fileName(session)}.json`)

export const readGiven = Effect.fn("computer.readGiven")(function*(tenantDir: string, session: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* readText(fs, givenFile(tenantDir, session, path))
  return (Option.isSome(text) ? Option.getOrUndefined(decodeGiven(text.value)) : undefined) ?? { cards: [], screens: [] }
})

export const writeGiven = Effect.fn("computer.writeGiven")(function*(tenantDir: string, session: string, given: Given) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = givenFile(tenantDir, session, path)
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileWhole(fs, file, JSON.stringify(given) + "\n")
})
