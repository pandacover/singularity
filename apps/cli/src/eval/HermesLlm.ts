/**
 * One-shot structured calls through Hermes Agent's command line, for
 * learning when Hermes Agent is the agent memory learns with (ModelCall.ts).
 *
 * `hermes chat -Q --query-file -` answers one prompt, read from stdin, with
 * the model and provider Hermes is set to use. Our system prompt is added to
 * Hermes's own for the call (`HERMES_EPHEMERAL_SYSTEM_PROMPT`, never saved);
 * `--ignore-rules` leaves out its SOUL.md, AGENTS.md files and memories; the
 * `bot_room` toolset has no tools, so no MCP server starts either; and the
 * session is tagged `tool`, which Hermes keeps out of the user's session
 * lists and searches. `--format stream-json` ends with a result line: the
 * answer, its session and its tokens.
 *
 * Hermes has no structured output: the prompt ends with the JSON Schema to
 * answer in, and the answer is checked against it, and asked for once more
 * when it doesn't hold. The cost is what Hermes reckoned for the session, as
 * its database keeps it (`state.db`); none when Hermes doesn't know the
 * model's price.
 */
import { Effect, Option, Path, Schema } from "effect"
import { homedir } from "node:os"
import { hermesHome } from "../setup/Agents.ts"
import { addUsage, emptyUsage, hermesSessionRow, type Usage } from "../traces/index.ts"
import { agentEnv } from "./Agent.ts"
import { jsonSchemaOf, LlmError, type ModelCall, type StructuredResult } from "./Llm.ts"
import { runProcess } from "./Proc.ts"

const DEFAULT_TIMEOUT_S = 900

/** System prompts longer than this go at the start of the prompt instead of in the environment, which caps a value's length. */
const MAX_ENV_PROMPT = 30_000

const HermesResult = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("result"),
  session_id: Schema.optionalKey(Schema.String),
  exit_code: Schema.optionalKey(Schema.Number),
  text: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Schema.Struct({
    input: Schema.optionalKey(Schema.Number),
    output: Schema.optionalKey(Schema.Number),
    cache_read: Schema.optionalKey(Schema.Number),
    cache_write: Schema.optionalKey(Schema.Number)
  })),
  error: Schema.optionalKey(Schema.String)
}))
type HermesResult = typeof HermesResult.Type

/** The result line `--format stream-json` ends with; undefined when Hermes printed none. */
export const hermesResult = (stdout: string): HermesResult | undefined =>
  stdout.split(/\r?\n/).reverse().flatMap((line) => Option.toArray(Schema.decodeUnknownOption(HermesResult)(line.trim())))[0]

const usageOf = (tokens: HermesResult["tokens"]): Usage => ({
  input_tokens: tokens?.input ?? 0,
  output_tokens: tokens?.output ?? 0,
  cache_creation_input_tokens: tokens?.cache_write ?? 0,
  cache_read_input_tokens: tokens?.cache_read ?? 0
})

/** The JSON object in a model's answer: the answer itself, or what code fences or words around it hold. */
export const jsonIn = (text: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

/** The end of every prompt: the answer's form. */
export const answerFormat = (schema: unknown): string =>
  "## Your answer\n\nAnswer with one JSON object and nothing else: no code fences, no words before or after it. It must follow this JSON Schema:\n\n" +
  JSON.stringify(schema)

const AnswerJson = Schema.fromJsonString(Schema.Unknown)

export const callHermes = Effect.fn("callHermes")(function*<A>(call: ModelCall<A>) {
  const [program, ...first] = call.cli.command
  const timeoutS = call.timeoutS ?? DEFAULT_TIMEOUT_S
  const inEnv = call.system.length <= MAX_ENV_PROMPT
  const env = { ...agentEnv(), ...(inEnv ? { HERMES_EPHEMERAL_SYSTEM_PROMPT: call.system } : {}) }
  const args = [
    ...first,
    "chat",
    "-Q",
    "--query-file", "-",
    "--format", "stream-json",
    "--ignore-rules",
    "--source", "tool",
    "--toolsets", "bot_room",
    ...(call.model === undefined ? [] : ["--model", call.model]),
    ...(call.effort === undefined ? [] : ["--reasoning", call.effort])
  ]
  const db = (yield* Path.Path).join(hermesHome({ home: homedir(), env: process.env }), "state.db")
  const format = answerFormat(jsonSchemaOf(call.schema))
  let costUsd: number | null = null
  let usage = emptyUsage
  let durationS = 0
  let again = ""
  for (let attempt = 0; ; attempt++) {
    const prompt = [inEnv ? "" : call.system, call.prompt, format, again].filter((s) => s !== "").join("\n\n")
    const proc = yield* runProcess(program, args, { cwd: call.cwd, timeoutS, env, input: prompt })
    durationS += proc.durationS
    if (proc.timedOut) return yield* new LlmError({ message: `hermes timed out after ${timeoutS}s` })
    const result = hermesResult(proc.stdout)
    usage = addUsage(usage, usageOf(result?.tokens))
    if (result?.session_id !== undefined) {
      const row = yield* hermesSessionRow(db, result.session_id)
      const cost = row?.actual_cost_usd ?? row?.estimated_cost_usd
      if (typeof cost === "number") costUsd = (costUsd ?? 0) + cost
    }
    const text = result?.text ?? ""
    if (proc.exitCode !== 0 || result === undefined || (result.exit_code ?? 0) !== 0 || text.trim() === "") {
      const why = result?.error ?? (proc.stderr.trim() || text.trim() || proc.stdout.trim())
      return yield* new LlmError({ message: `hermes failed (exit ${proc.exitCode}): ${why.slice(0, 500)}` })
    }
    const decoded = yield* Schema.decodeUnknownEffect(AnswerJson)(jsonIn(text)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(call.schema)),
      Effect.result
    )
    if (decoded._tag === "Success") return { value: decoded.success, costUsd, usage, durationS } satisfies StructuredResult<A>
    if (attempt > 0) return yield* new LlmError({ message: `the answer doesn't match the schema: ${decoded.failure.message.slice(0, 500)}` })
    again = `## Your answer before\n\nYou answered this, which isn't a JSON object of that schema (${decoded.failure.message.slice(0, 1500)}):\n\n` +
      `${text.slice(0, 3000)}\n\nAnswer again: the JSON object alone.`
  }
}, Effect.mapError((e) => (e instanceof LlmError ? e : new LlmError({ message: e.message }))))
