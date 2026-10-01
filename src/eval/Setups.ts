/**
 * Memory setups: what the agent is given before a run, and what it learns after.
 *
 * The evaluation compares setups on the same tasks: no memory, saved scripts,
 * and the procedural graph. Each one plugs in here.
 */
import type { FileSystem, Path } from "effect"
import { Effect, Schema } from "effect"
import type { Trace } from "../traces/index.ts"
import type { Task } from "./Suite.ts"

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  message: Schema.String
}) {}

export interface Injection {
  /** Appended to Claude Code's system prompt for this run. */
  readonly systemPrompt: string | undefined
  /** Recorded with the run, e.g. which memory was retrieved. */
  readonly info: Readonly<Record<string, unknown>>
}

/** What a setup sees after a run, to learn from it. */
export interface Outcome {
  readonly task: Task
  /** Null when the task has no checks. */
  readonly success: boolean | null
  readonly trace: Trace | undefined
  readonly diff: string
}

export type SetupServices = FileSystem.FileSystem | Path.Path

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

export const SETUPS = ["no-memory", "saved-scripts"] as const
export type SetupName = (typeof SETUPS)[number]
