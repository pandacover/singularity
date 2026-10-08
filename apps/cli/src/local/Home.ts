/**
 * Where local memory lives: `~/.singularity`, or `$SINGULARITY_HOME`.
 *
 *     <home>/config.json                                 { "tenant": "local" }
 *     <home>/tenants/<tenant>/subjects.json              the repos memory is about
 *     <home>/tenants/<tenant>/records/<subject>/<id>.json one workflow record per run
 *     <home>/tenants/<tenant>/memory/                    the graph built from the records
 *     <home>/tenants/<tenant>/sessions/<session id>.json what was handed over in a session
 *
 * A tenant holds memory that may be shared between its subjects (repos), and
 * never with another tenant. Locally there is one tenant, named in
 * config.json; every item still carries it, so the hosted version can keep
 * tenants apart without changing the data.
 */
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"
import { homedir } from "node:os"

export const HOME_ENV = "SINGULARITY_HOME"
export const DEFAULT_TENANT = "local"

/** Tenant, subject and record ids are also directory and file names. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export class HomeError extends Schema.TaggedError<HomeError>()("HomeError", {
  message: Schema.String
}) {}

const ConfigFile = Schema.Struct({ tenant: Schema.String })

export interface Home {
  readonly root: string
  readonly tenant: string
  readonly tenantDir: string
}

/** `$SINGULARITY_HOME`, or `~/.singularity`. */
export const homeRoot: Effect.Effect<string, never, Path.Path> = Effect.gen(function*() {
  const path = yield* Path.Path
  const configured = yield* Config.option(Config.String(HOME_ENV)).pipe(
    Effect.orElseSucceed(() => Option.none<string>())
  )
  return Option.getOrElse(Option.filter(configured, (s) => s.trim() !== ""), () => path.join(homedir(), ".singularity"))
})

/** The home and its tenant. Creates the home with the default tenant if it doesn't exist yet. */
export const loadHome = Effect.fn("loadHome")(function*(root?: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = root ?? (yield* homeRoot)
  const file = path.join(dir, "config.json")
  const fail = (message: string) => new HomeError({ message: `${file}: ${message}` })
  let tenant = DEFAULT_TENANT
  if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
    const text = yield* fs.readFileString(file).pipe(Effect.mapError((e) => fail(e.message)))
    tenant = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile))(text).pipe(
      Effect.mapError((e) => fail(e.message))
    )).tenant
  } else {
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError((e) => fail(e.message)))
    yield* fs.writeFileString(file, JSON.stringify({ tenant }, null, 2) + "\n").pipe(Effect.mapError((e) => fail(e.message)))
  }
  if (!ID.test(tenant)) return yield* fail(`invalid tenant id ${JSON.stringify(tenant)}`)
  return { root: dir, tenant, tenantDir: path.join(dir, "tenants", tenant) } satisfies Home
})
