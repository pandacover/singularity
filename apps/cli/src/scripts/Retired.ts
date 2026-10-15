/**
 * Retired scripts: stored records the search passes over from now on. Records
 * are evidence and are never deleted; a script is retired by a line in
 * `<tenant dir>/scripts/retired.jsonl` that names it and says why:
 *
 * - `reverted`: a commit since says "This reverts commit <its commit>";
 * - `gone`: every file it changed was changed past recognition or deleted
 *   (Fresh.ts), on the branch it was committed to;
 * - `superseded by <id>`: a newer stored change of the same files asked for
 *   the same thing;
 * - `folded into <id>`: a follow-up commit of the same session that only
 *   touched its files was stored with it, as one script (Commits.ts).
 *
 * Task start (Start.ts) writes the first three when it finds them, and only
 * when it may write (not in `recall`); storing commits writes the fourth. A
 * record whose commit is missing from the repo is not retired: another clone
 * may have it.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"

export const Retirement = Schema.Struct({
  id: Schema.String,
  commit: Schema.NullOr(Schema.String),
  reason: Schema.String,
  at: Schema.String
})
export type Retirement = typeof Retirement.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Retirement))

export const retiredFile = (tenantDir: string, path: Path.Path): string => path.join(tenantDir, "scripts", "retired.jsonl")

/** Every retired script, by record id (the first reason it was retired for). */
export const readRetired = Effect.fn("scripts.readRetired")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(retiredFile(tenantDir, path)).pipe(Effect.orElseSucceed(() => ""))
  const out = new Map<string, Retirement>()
  for (const r of text.split(/\r?\n/).flatMap((l) => Option.toArray(decode(l)))) if (!out.has(r.id)) out.set(r.id, r)
  return out
})

export const retire = Effect.fn("scripts.retire")(function*(tenantDir: string, entries: ReadonlyArray<Retirement>) {
  if (entries.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = retiredFile(tenantDir, path)
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, entries.map((e) => JSON.stringify(e) + "\n").join(""), { flag: "a" })
})

/** How many scripts are retired, by reason (`superseded by x` and `folded into y` count as `superseded`, `folded`); of one subject's when given. */
export const countRetired = Effect.fn("scripts.countRetired")(function*(tenantDir: string, subject?: string) {
  const counts = new Map<string, number>()
  for (const r of (yield* readRetired(tenantDir)).values()) {
    if (subject !== undefined && !r.id.startsWith(`${subject}-`)) continue
    const kind = r.reason.split(" ")[0]
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return counts
})
