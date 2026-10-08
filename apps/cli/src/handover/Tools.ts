/**
 * What a repo uses, recognized by exact checks: its package manager (by lock
 * file) and its package.json dependencies and script names. Memory about a
 * tool reaches every repo that uses it.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"

const PackageJson = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
})

const LOCKS: ReadonlyArray<readonly [string, string]> = [
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["Cargo.lock", "cargo"],
  ["go.sum", "go"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"]
]

export const repoTools = Effect.fn("repoTools")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tools = new Set<string>()
  for (const [file, tool] of LOCKS) {
    if (yield* fs.exists(path.join(root, file)).pipe(Effect.orElseSucceed(() => false))) tools.add(tool)
  }
  const pkg = path.join(root, "package.json")
  if (yield* fs.exists(pkg).pipe(Effect.orElseSucceed(() => false))) {
    const text = yield* fs.readFileString(pkg).pipe(Effect.orElseSucceed(() => "{}"))
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(PackageJson))(text)
    if (Option.isSome(decoded)) {
      for (const name of Object.keys({ ...decoded.value.dependencies, ...decoded.value.devDependencies })) tools.add(name)
      for (const script of Object.values(decoded.value.scripts ?? {})) {
        const program = script.trim().split(/\s+/)[0]
        if (program) tools.add(program)
      }
    }
  }
  return tools
})
