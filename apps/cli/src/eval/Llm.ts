/**
 * One-shot structured calls to Claude through the `claude` CLI, for building memory.
 *
 * `claude -p --json-schema` answers with an object matching the schema
 * (`structured_output` in the result), using the user's own login, so no API
 * key is needed. Calls run with no tools, our system prompt in place of Claude
 * Code's, auto-memory off and no saved session. Run them in a directory with no
 * CLAUDE.md above it, or Claude Code adds that file to the conversation.
 *
 * Learning in daily use can go through Codex or Hermes Agent instead, as the
 * user chose (ModelCall.ts); the eval harness and the commands that build
 * memory by hand always use Claude Code.
 */
import { Effect, FileSystem, Path, Predicate, Schema } from "effect"
import type { Usage } from "../traces/index.ts"
import { addUsage, emptyUsage, usageFromModelUsage } from "../traces/index.ts"
import { agentEnv, parseResult } from "./Agent.ts"
import { runProcess } from "./Proc.ts"

export class LlmError extends Schema.TaggedError<LlmError>()("LlmError", {
  message: Schema.String
}) {}

/** The agents whose command lines memory can make its model calls through. */
export const MODEL_AGENTS = ["claude", "codex", "hermes"] as const
export type ModelAgent = (typeof MODEL_AGENTS)[number]

/** An agent's command line for one-shot model calls: which agent it is, and the command that starts it. */
export interface ModelCli {
  readonly agent: ModelAgent
  /** e.g. ["C:/.../claude.exe"], or node and the script an npm shim runs. */
  readonly command: ReadonlyArray<string>
}

/** Claude Code's command line. */
export const claudeCli = (command: ReadonlyArray<string>): ModelCli => ({ agent: "claude", command })

/** A structured call through any of the agents (ModelCall.ts). */
export interface ModelCall<A> extends Omit<StructuredCall<A>, "claude" | "model"> {
  readonly cli: ModelCli
  /** undefined: the model the agent is set to use (Codex's and Hermes Agent's own setting). */
  readonly model?: string | undefined
}

export interface StructuredCall<A> {
  /** The `claude` command, e.g. ["C:/.../claude.exe"]. */
  readonly claude: ReadonlyArray<string>
  readonly system: string
  readonly prompt: string
  /** Decodes the answer; its JSON Schema is what Claude must follow. */
  readonly schema: Schema.Decoder<A>
  readonly model: string
  readonly effort?: string | undefined
  /**
   * false turns extended thinking off. For small judgments: Haiku otherwise
   * thinks for thousands of tokens before a two-line answer.
   */
  readonly thinking?: boolean | undefined
  readonly cwd: string
  readonly maxBudgetUsd?: number | undefined
  readonly timeoutS?: number | undefined
}

export interface StructuredResult<A> {
  readonly value: A
  readonly costUsd: number | null
  readonly usage: Usage
  readonly durationS: number
}

const DEFAULT_TIMEOUT_S = 900

/** The JSON Schema for `--json-schema`. */
export const jsonSchemaOf = (schema: Schema.Top): unknown => Schema.toJsonSchemaDocument(schema).schema

export const callStructured = Effect.fn("callStructured")(function*<A>(call: StructuredCall<A>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "singularity-llm-" })
  const systemFile = path.join(dir, "system.md")
  yield* fs.writeFileString(systemFile, call.system)
  const timeoutS = call.timeoutS ?? DEFAULT_TIMEOUT_S
  const args = [
    ...call.claude.slice(1),
    "-p",
    "--output-format", "json",
    "--model", call.model,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt-file", systemFile,
    "--json-schema", JSON.stringify(jsonSchemaOf(call.schema))
  ]
  if (call.effort !== undefined) args.push("--effort", call.effort)
  if (call.thinking === false) args.push("--settings", JSON.stringify({ alwaysThinkingEnabled: false }))
  if (call.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(call.maxBudgetUsd))
  const proc = yield* runProcess(call.claude[0], args, { cwd: call.cwd, timeoutS, env: agentEnv(), input: call.prompt })
  if (proc.timedOut) return yield* new LlmError({ message: `claude timed out after ${timeoutS}s` })
  const result = parseResult(proc.stdout)
  if (result === undefined || result.subtype !== "success" || result.is_error === true) {
    const why = result === undefined ? proc.stderr.trim() || proc.stdout.trim() : JSON.stringify(result.subtype)
    return yield* new LlmError({ message: `claude failed (exit ${proc.exitCode}): ${why.slice(0, 500)}` })
  }
  const value = yield* Schema.decodeUnknownEffect(call.schema)(result.structured_output).pipe(
    Effect.mapError((e) => new LlmError({ message: `the answer doesn't match the schema: ${e.message}` }))
  )
  const usage = Predicate.isObject(result.modelUsage)
    ? Object.values(result.modelUsage).reduce<Usage>((acc, v) => addUsage(acc, usageFromModelUsage(v)), emptyUsage)
    : emptyUsage
  return {
    value,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    usage,
    durationS: proc.durationS
  } satisfies StructuredResult<A>
}, Effect.scoped, Effect.mapError((e) => (e instanceof LlmError ? e : new LlmError({ message: e.message }))))
