/**
 * Build a memory setup by name.
 */
import { Effect } from "effect"
import type { LearnerConfig } from "./GraphLearner.ts"
import { makeGraphMemory } from "./GraphMemory.ts"
import { makeSavedScripts } from "./SavedScripts.ts"
import type { MemorySetup } from "./Setups.ts"
import { MemoryError, NoMemory, SETUPS } from "./Setups.ts"
import type { SelectorConfig } from "./StepSelector.ts"

export interface SetupContext {
  /** The graph's id and the key for repository facts: the suite name. */
  readonly graphId?: string | undefined
  /** Read the graph at this committed version instead of the head. */
  readonly graphVersion?: number | undefined
  /** How the graph setup calls a model to pick the steps that apply. */
  readonly selector?: SelectorConfig | undefined
  /** How the graph setup calls Claude to learn. */
  readonly learner?: LearnerConfig | undefined
}

/** Setups that learn need `memoryDir`; `frozen` makes them read-only (for measurement runs). */
export const makeSetup = (
  name: string,
  memoryDir?: string,
  frozen = false,
  context: SetupContext = {}
): Effect.Effect<MemorySetup, MemoryError> => {
  if (!(SETUPS as ReadonlyArray<string>).includes(name)) {
    return Effect.fail(new MemoryError({ message: `unknown setup ${JSON.stringify(name)}` }))
  }
  if (name === NoMemory.name) return Effect.succeed(NoMemory)
  if (memoryDir === undefined) return Effect.fail(new MemoryError({ message: `${name} needs a memory directory (--memory)` }))
  if (name === "saved-scripts") return Effect.succeed(makeSavedScripts(memoryDir, frozen))
  if (name === "saved-scripts-top2") return Effect.succeed(makeSavedScripts(memoryDir, frozen, 2))
  if (name === "graph") {
    return context.graphId === undefined
      ? Effect.fail(new MemoryError({ message: "graph needs a graph id (the suite name)" }))
      : Effect.succeed(makeGraphMemory({
        root: memoryDir,
        graphId: context.graphId,
        frozen,
        version: context.graphVersion,
        selector: context.selector,
        learner: context.learner
      }))
  }
  return Effect.fail(new MemoryError({ message: `unknown setup ${JSON.stringify(name)}` }))
}
