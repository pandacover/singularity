/**
 * Memory setups: what the agent is given before a run, and what it learns after.
 *
 * The evaluation compares setups on the same tasks: no memory and saved
 * scripts (`scripts`). Each one plugs in here. (The graph, hooks and
 * workflows setups were removed with the memory designs they measured, and
 * the first saved-scripts setups, `saved-scripts` and `saved-scripts-top2`,
 * with their search; `eval report` still reads their results.)
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

/** What memory cost to prepare or hand over, when it called a model. */
export interface Spent {
  readonly costUsd: number
  readonly usage: Usage
}

export interface Injection {
  /** Appended to Claude Code's system prompt for this run. */
  readonly systemPrompt: string | undefined
  /** Recorded with the run, e.g. which memory was retrieved. */
  readonly info: Readonly<Record<string, unknown>>
  /**
   * What preparing the memory cost, if it called a model. The run's totals
   * include it, so setups that spend tokens on retrieval are compared fairly.
   */
  readonly spent?: Spent | undefined
  /** More arguments for Claude Code, e.g. `--settings` with hooks. */
  readonly args?: ReadonlyArray<string> | undefined
  /** More environment for Claude Code, and so for its hooks. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /**
   * For memory handed over during the run (by hooks) rather than before it:
   * read once the agent has finished, it adds what was handed over to `info`
   * and what that cost to `spent`.
   */
  readonly delivered?: Effect.Effect<Delivered, MemoryError, SetupServices> | undefined
}

export interface Delivered {
  readonly info: Readonly<Record<string, unknown>>
  readonly spent?: Spent | undefined
}

export const addSpent = (a: Spent | undefined, b: Spent | undefined): Spent | undefined =>
  a === undefined || b === undefined ? a ?? b : { costUsd: a.costUsd + b.costUsd, usage: addUsage(a.usage, b.usage) }

/** What a setup sees after a run, to learn from it. */
export interface Outcome {
  readonly task: Task
  /** Null when the task has no checks. */
  readonly success: boolean | null
  readonly trace: Trace | undefined
  readonly diff: string
}

/** What setups may use: files, and processes (git, the agent). */
export type SetupServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

export interface MemorySetup {
  readonly name: string
  /**
   * Prepare memory for this run. May write files into the workspace, and into
   * the run's output directory (absent for previews).
   */
  readonly beforeRun: (task: Task, workspace: string, runDir?: string) => Effect.Effect<Injection, MemoryError, SetupServices>
  /** Learn from a finished run. Called once checks have run. */
  readonly afterRun: (outcome: Outcome) => Effect.Effect<void, MemoryError, SetupServices>
}

export const NoMemory: MemorySetup = {
  name: "no-memory",
  beforeRun: () => Effect.succeed({ systemPrompt: undefined, info: {} }),
  afterRun: () => Effect.void
}

export const SETUPS = ["no-memory", "scripts"] as const
export type SetupName = (typeof SETUPS)[number]
