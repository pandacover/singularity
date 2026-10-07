/**
 * Build a memory setup by name.
 */
import { Effect } from "effect"
import type { LearnerConfig } from "./GraphLearner.ts"
import { makeGraphMemory } from "./GraphMemory.ts"
import { makeHooksMemory } from "./HooksMemory.ts"
import { makeSavedScripts } from "./SavedScripts.ts"
import { makeWorkflowsMemory } from "./WorkflowsMemory.ts"
import type { MemorySetup } from "./Setups.ts"
import { combine, MemoryError, NoMemory, SETUPS } from "./Setups.ts"
import type { SelectorConfig } from "./StepSelector.ts"

export interface SetupContext {
  /** The graph's id and the key for repository facts: the suite name. */
  readonly graphId?: string | undefined
  /** Read the graph at this committed version instead of the head. */
  readonly graphVersion?: number | undefined
  /** saved-scripts-warnings: the graph store its warnings come from (and that it learns into). */
  readonly warningsDir?: string | undefined
  /** How the graph setup calls a model to pick the steps that apply. */
  readonly selector?: SelectorConfig | undefined
  /** How the graph setup calls Claude to learn. */
  readonly learner?: LearnerConfig | undefined
}

/**
 * Setups that learn need `memoryDir`; `frozen` makes them read-only (for
 * measurement runs). For `hooks` and `workflows` it is a memory home, which is
 * never changed.
 */
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
  if (name === "saved-scripts-warnings") {
    if (context.graphId === undefined) return Effect.fail(new MemoryError({ message: `${name} needs a graph id (the suite name)` }))
    if (context.warningsDir === undefined) {
      return Effect.fail(new MemoryError({ message: `${name} needs the graph store its warnings come from (--warnings)` }))
    }
    // No step selection: a warning that doesn't apply costs only its tokens.
    const warnings = makeGraphMemory({
      root: context.warningsDir,
      graphId: context.graphId,
      frozen,
      version: context.graphVersion,
      learner: context.learner,
      handOver: "warnings"
    })
    return Effect.succeed(combine(name, makeSavedScripts(memoryDir, frozen), warnings, "warnings"))
  }
  if (name === "hooks") {
    // The memory directory is a memory home; the hooks' model call runs the agent's Claude Code.
    return context.selector === undefined
      ? Effect.fail(new MemoryError({ message: "hooks needs the claude command for its model call" }))
      : Effect.succeed(makeHooksMemory({ home: memoryDir, claude: context.selector.claude, selectorModel: context.selector.model }))
  }
  if (name === "workflows" || name === "workflows-draft" || name === "workflows-cues" || name === "workflows-split") {
    // Like hooks: a memory home, handed over by v1's own hooks; their model calls run the agent's Claude Code.
    // workflows-draft hands over the change itself, drafted at task start (workflows/Draft.ts);
    // workflows-cues makes no model call: memory's cues pick, and fill the blanks the task states (workflows/Cues.ts);
    // workflows-split is workflows-cues with a long hand-over carried by two hooks (workflows/HookStart.ts).
    return context.selector === undefined
      ? Effect.fail(new MemoryError({ message: `${name} needs the claude command for its model call` }))
      : Effect.succeed(makeWorkflowsMemory({
        home: memoryDir,
        claude: context.selector.claude,
        selectorModel: context.selector.model,
        draft: name === "workflows-draft",
        cues: name === "workflows-cues" || name === "workflows-split",
        parts: name === "workflows-split" ? 2 : 1
      }))
  }
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
