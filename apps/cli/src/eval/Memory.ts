/**
 * Build a memory setup by name.
 */
import { Effect } from "effect"
import { withRecall } from "./Recall.ts"
import { makeScripts } from "./SavedScripts.ts"
import type { MemorySetup } from "./Setups.ts"
import { MemoryError, NoMemory, SETUPS } from "./Setups.ts"

/**
 * Setups other than no-memory need `memoryDir`; `frozen` makes them
 * read-only (for measurement runs).
 */
export const makeSetup = (
  name: string,
  memoryDir?: string,
  frozen = false
): Effect.Effect<MemorySetup, MemoryError> => {
  if (!(SETUPS as ReadonlyArray<string>).includes(name)) {
    return Effect.fail(new MemoryError({ message: `unknown setup ${JSON.stringify(name)}` }))
  }
  if (name === NoMemory.name) return Effect.succeed(NoMemory)
  if (memoryDir === undefined) return Effect.fail(new MemoryError({ message: `${name} needs a memory directory (--memory)` }))
  // The recall note and command come with it, as setup gives them in daily use (Recall.ts).
  if (name === "scripts") return Effect.succeed(withRecall(makeScripts(memoryDir, frozen), memoryDir))
  return Effect.fail(new MemoryError({ message: `unknown setup ${JSON.stringify(name)}` }))
}
