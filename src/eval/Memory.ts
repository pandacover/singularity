/**
 * Build a memory setup by name.
 */
import { Effect } from "effect"
import { makeSavedScripts } from "./SavedScripts.ts"
import type { MemorySetup } from "./Setups.ts"
import { MemoryError, NoMemory } from "./Setups.ts"

/** Setups that learn need `memoryDir`; `frozen` makes them read-only (for measurement runs). */
export const makeSetup = (
  name: string,
  memoryDir?: string,
  frozen = false
): Effect.Effect<MemorySetup, MemoryError> => {
  if (name === NoMemory.name) return Effect.succeed(NoMemory)
  if (name === "saved-scripts") {
    return memoryDir === undefined
      ? Effect.fail(new MemoryError({ message: "saved-scripts needs a memory directory (--memory)" }))
      : Effect.succeed(makeSavedScripts(memoryDir, frozen))
  }
  return Effect.fail(new MemoryError({ message: `unknown setup ${JSON.stringify(name)}` }))
}
