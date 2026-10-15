/**
 * The log of what memory handed over, for the record:
 *
 *     <tenant dir>/workflows/handovers.jsonl    every hand-over, one per line
 *
 * The path keeps the name memory v1 gave it, so logs written before stay in
 * one file.
 */
import { Effect, FileSystem, Path } from "effect"

/** A session id as a file name. */
export const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_")

/** One line of the hand-over log. */
export const logHandover = Effect.fn("workflows.logHandover")(function*(tenantDir: string, entry: Readonly<Record<string, unknown>>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(tenantDir, "workflows")
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(path.join(dir, "handovers.jsonl"), JSON.stringify(entry) + "\n", { flag: "a" })
})
