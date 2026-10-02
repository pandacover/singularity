/**
 * Memory setups: what the agent is given before a run, and what it learns after.
 *
 * The evaluation compares setups on the same tasks: no memory, saved scripts,
 * the procedural graph, and saved scripts with the graph's warnings. Each one
 * plugs in here.
 */
import type { FileSystem, Path } from "effect"
import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Trace, Usage } from "../traces/index.ts"
import { addUsage } from "../traces/index.ts"
import type { Task } from "./Suite.ts"

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  message: Schema.String
}) {}

export interface Injection {
  /** Appended to Claude Code's system prompt for this run. */
  readonly systemPrompt: string | undefined
  /** Recorded with the run, e.g. which memory was retrieved. */
  readonly info: Readonly<Record<string, unknown>>
  /**
   * What preparing the memory cost, if it called a model. The run's totals
   * include it, so setups that spend tokens on retrieval are compared fairly.
   */
  readonly spent?: { readonly costUsd: number; readonly usage: Usage } | undefined
}

/** What a setup sees after a run, to learn from it. */
export interface Outcome {
  readonly task: Task
  /** Null when the task has no checks. */
  readonly success: boolean | null
  readonly trace: Trace | undefined
  readonly diff: string
}

/** Setups that learn with an LLM run `claude`, hence the process spawner. */
export type SetupServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

export interface MemorySetup {
  readonly name: string
  /** Prepare memory for this run. May write files into the workspace. */
  readonly beforeRun: (task: Task, workspace: string) => Effect.Effect<Injection, MemoryError, SetupServices>
  /** Learn from a finished run. Called once checks have run. */
  readonly afterRun: (outcome: Outcome) => Effect.Effect<void, MemoryError, SetupServices>
}

export const NoMemory: MemorySetup = {
  name: "no-memory",
  beforeRun: () => Effect.succeed({ systemPrompt: undefined, info: {} }),
  afterRun: () => Effect.void
}

/**
 * Two setups as one: both prepare memory, the second's text after the first's,
 * and both learn from each run. The second's info is recorded under `key`.
 */
export const combine = (name: string, first: MemorySetup, second: MemorySetup, key: string): MemorySetup => ({
  name,
  beforeRun: (task, workspace) =>
    Effect.gen(function*() {
      const a = yield* first.beforeRun(task, workspace)
      const b = yield* second.beforeRun(task, workspace)
      const texts = [a.systemPrompt, b.systemPrompt].filter((t): t is string => t !== undefined && t !== "")
      const spent = a.spent === undefined || b.spent === undefined
        ? a.spent ?? b.spent
        : { costUsd: a.spent.costUsd + b.spent.costUsd, usage: addUsage(a.spent.usage, b.spent.usage) }
      return {
        systemPrompt: texts.length > 0 ? texts.join("\n") : undefined,
        info: { ...a.info, [key]: b.info },
        spent
      } satisfies Injection
    }),
  afterRun: (outcome) => Effect.andThen(first.afterRun(outcome), second.afterRun(outcome))
})

export const SETUPS = ["no-memory", "saved-scripts", "saved-scripts-top2", "saved-scripts-warnings", "graph"] as const
export type SetupName = (typeof SETUPS)[number]
