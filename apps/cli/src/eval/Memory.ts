/**
 * Build a memory setup by name.
 */
import { Effect } from "effect"
import { makeSavedScripts, makeScripts } from "./SavedScripts.ts"
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
  if (name === "saved-scripts") return Effect.succeed(makeSavedScripts(memoryDir, frozen))
  if (name === "scripts") return Effect.succeed(makeScripts(memoryDir, frozen))
  if (name === "saved-scripts-top2") return Effect.succeed(makeSavedScripts(memoryDir, frozen, 2))
  return Effect.fail(new MemoryError({ message: `unknown setup ${JSON.stringify(name)}` }))
}
