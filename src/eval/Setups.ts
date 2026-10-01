/**
 * Memory setups: what the agent is given before a run, and what it learns after.
 *
 * The evaluation compares setups on the same tasks: no memory, saved scripts,
 * and the procedural graph. Each one plugs in here.
 */
import type { FileSystem, Path } from "effect"
import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Trace, Usage } from "../traces/index.ts"
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

export const SETUPS = ["no-memory", "saved-scripts", "saved-scripts-top2", "graph"] as const
export type SetupName = (typeof SETUPS)[number]
