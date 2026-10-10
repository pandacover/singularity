/**
 * One-shot structured calls through Codex's command line, for learning when
 * Codex is the agent memory learns with (ModelCall.ts).
 *
 * `codex exec --output-schema` answers with JSON matching the schema, with
 * the user's own Codex login and model. The call is made a plain model call:
 * our system prompt in place of Codex's (`model_instructions_file`), none of
 * the instructions Codex adds about permissions, apps or the environment, no
 * AGENTS.md, no web search, no update check, a read-only sandbox, and no
 * saved session (`--ephemeral`). Its plugins, hooks, memories, shell and the
 * other tools it would offer are switched off where this Codex has them
 * (`codex features list`), and so is every MCP server it would start
 * (`codex mcp list --json`): a feature Codex doesn't know is an error.
 *
 * Codex reports tokens, not dollars. Its cost is reckoned from the tokens at
 * the model's API price (`codexUsd`): a ChatGPT plan charges nothing more for
 * them, but counts them toward its limits.
 */
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { homedir } from "node:os"
import { parse as parseToml } from "smol-toml"
import { codexHome, slashes } from "../setup/Agents.ts"
import type { Usage } from "../traces/index.ts"
import { agentEnv } from "./Agent.ts"
import { jsonSchemaOf, LlmError, type ModelCall, type StructuredResult } from "./Llm.ts"
import { runProcess } from "./Proc.ts"

const DEFAULT_TIMEOUT_S = 900

/**
 * Codex features that would give a one-shot answer tools, extra context or
 * side effects. Only those this Codex lists are switched off.
 */
export const OFF_FEATURES = [
  "plugins",
  "apps",
  "hooks",
  "memories",
  "goals",
  "multi_agent",
  "shell_tool",
  "unified_exec",
  "view_image",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "skill_search",
  "tool_suggest",
  "sleep_tool"
] as const

/**
 * OpenAI's API prices in dollars per million tokens (input, cached input,
 * output), by model name: the first prefix that matches. A model not listed
 * is counted at the dearest price, so that a daily limit errs on the side of
 * spending less. (From OpenAI's price lists, 2026-10.)
 */
const PRICES: ReadonlyArray<readonly [prefix: string, input: number, cached: number, output: number]> = [
  ["gpt-5.6-luna", 0.2, 0.02, 1.2],
  ["gpt-5.6-terra", 2, 0.2, 12],
  ["gpt-5.6-sol", 5, 0.5, 30],
  ["gpt-5.5", 5, 0.5, 30],
  ["gpt-5.4-nano", 0.2, 0.02, 1.25],
  ["gpt-5.4-mini", 0.75, 0.075, 4.5],
  ["gpt-5.4", 2.5, 0.25, 15],
  ["gpt-5.3-codex", 1.75, 0.175, 14],
  ["gpt-5.2", 1.75, 0.175, 14],
  ["gpt-5.1-codex-mini", 0.25, 0.025, 2],
  ["gpt-5-codex-mini", 0.25, 0.025, 2],
  ["gpt-5-mini", 0.25, 0.025, 2],
  ["gpt-5-nano", 0.05, 0.005, 0.4],
  ["gpt-5.1", 1.25, 0.125, 10],
  ["gpt-5", 1.25, 0.125, 10]
]
const DEAREST = [5, 0.5, 30] as const

/** A model's API price in dollars per million tokens, and whether it is listed (an unknown model gets the dearest). */
export const codexPrice = (model: string | undefined) => {
  const name = (model ?? "").toLowerCase()
  const listed = PRICES.find(([prefix]) => name.startsWith(prefix))
  const [, input, cached, output] = listed ?? ["", ...DEAREST]
  return { input, cached, output, listed: listed !== undefined }
}

/** What a call's tokens cost at the model's API price; `input` includes the cached tokens, as Codex counts them. */
export const codexUsd = (model: string | undefined, input: number, cached: number, output: number): number => {
  const price = codexPrice(model)
  return (Math.max(0, input - cached) * price.input + cached * price.cached + output * price.output) / 1e6
}

/**
 * The JSON Schema as OpenAI's strict structured outputs take it: every
 * object closed to other keys. (Memory's answers have no optional keys, which
 * strict outputs can't express.)
 */
export const strictSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(strictSchema)
  if (!Predicate.isObject(schema)) return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) out[k] = strictSchema(v)
  if (out.type === "object" || Predicate.isObject(out.properties)) out.additionalProperties = false
  return out
}

/** The model Codex's own config would use: the profile's, else the top level's (undefined: Codex's default). */
export const configuredModel = (configText: string): string | undefined => {
  let config: Record<string, unknown>
  try {
    config = parseToml(configText) as Record<string, unknown>
  } catch {
    return undefined
  }
  const profiles = Predicate.isObject(config.profiles) ? config.profiles as Record<string, unknown> : {}
  const profile = typeof config.profile === "string" && Predicate.isObject(profiles[config.profile]) ? profiles[config.profile] as Record<string, unknown> : {}
  const model = profile.model ?? config.model
  return typeof model === "string" && model.trim() !== "" ? model.trim() : undefined
}

/** The feature names `codex features list` prints, one a line before its stage and state. */
export const featureNames = (listing: string): Set<string> =>
  new Set(listing.split(/\r?\n/).map((l) => /^([a-z0-9_.]+)\s+\S.*\s(?:true|false)\s*$/.exec(l.trim())?.[1]).filter(Predicate.isString))

const McpList = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })))

/** The MCP servers Codex would start, from `codex mcp list --json`, by names `-c` can address. */
export const enabledServers = (json: string): Array<string> =>
  Option.match(Schema.decodeUnknownOption(McpList)(json.trim()), {
    onNone: () => [],
    onSome: (servers) => servers.filter((s) => s.enabled && /^[A-Za-z0-9_-]+$/.test(s.name)).map((s) => s.name)
  })

const CodexEvent = Schema.fromJsonString(Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  item: Schema.optionalKey(Schema.Struct({ type: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) })),
  usage: Schema.optionalKey(Schema.Struct({
    input_tokens: Schema.optionalKey(Schema.Number),
    cached_input_tokens: Schema.optionalKey(Schema.Number),
    output_tokens: Schema.optionalKey(Schema.Number)
  }))
}))
type CodexEvent = typeof CodexEvent.Type

/** The events `codex exec --json` printed, one a line; other lines are left out. */
export const codexEvents = (stdout: string): Array<CodexEvent> =>
  stdout.split(/\r?\n/).flatMap((line) => Option.toArray(Schema.decodeUnknownOption(CodexEvent)(line.trim())))

/** What a call's turns used, as Claude Code counts it (input without the cached tokens). */
export const codexUsage = (events: ReadonlyArray<CodexEvent>): { readonly input: number; readonly cached: number; readonly output: number } => {
  let input = 0
  let cached = 0
  let output = 0
  for (const e of events) {
    if (e.type !== "turn.completed" || e.usage === undefined) continue
    input += e.usage.input_tokens ?? 0
    cached += e.usage.cached_input_tokens ?? 0
    output += e.usage.output_tokens ?? 0
  }
  return { input, cached, output }
}

/** Why a call failed, in Codex's words. */
const failureOf = (events: ReadonlyArray<CodexEvent>): string | undefined =>
  events.flatMap((e) => (e.type === "turn.failed" ? [e.error?.message] : e.type === "error" ? [e.message] : [])).filter(Predicate.isString).at(-1)

const AnswerJson = Schema.fromJsonString(Schema.Unknown)

/** A TOML string, as `-c key=value` reads its value. */
const tomlString = (s: string) => JSON.stringify(s)

export const callCodex = Effect.fn("callCodex")(function*<A>(call: ModelCall<A>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const [program, ...first] = call.cli.command
  const env = agentEnv()
  const timeoutS = call.timeoutS ?? DEFAULT_TIMEOUT_S
  const probe = (args: ReadonlyArray<string>) =>
    runProcess(program, [...first, ...args], { cwd: call.cwd, timeoutS: 30, env }).pipe(
      Effect.map((r) => (r.exitCode === 0 ? r.stdout : "")),
      Effect.orElseSucceed(() => "")
    )
  const known = featureNames(yield* probe(["features", "list"]))
  const off = OFF_FEATURES.filter((f) => known.has(f)).flatMap((f) => ["--disable", f])
  const servers = enabledServers(yield* probe([...off, "mcp", "list", "--json"]))

  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "singularity-codex-" })
  const systemFile = path.join(dir, "system.md")
  const schemaFile = path.join(dir, "schema.json")
  const answerFile = path.join(dir, "answer.json")
  yield* fs.writeFileString(systemFile, call.system)
  yield* fs.writeFileString(schemaFile, JSON.stringify(strictSchema(jsonSchemaOf(call.schema))))
  const config = (key: string, value: string) => ["-c", `${key}=${value}`]
  const args = [
    ...first,
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--color", "never",
    "--output-schema", schemaFile,
    "--output-last-message", answerFile,
    "--cd", call.cwd,
    ...off,
    ...config("model_instructions_file", tomlString(slashes(systemFile))),
    ...config("include_permissions_instructions", "false"),
    ...config("include_apps_instructions", "false"),
    ...config("include_environment_context", "false"),
    ...config("include_collaboration_mode_instructions", "false"),
    ...config("project_doc_max_bytes", "0"),
    ...config("web_search", tomlString("disabled")),
    ...config("check_for_update_on_startup", "false"),
    ...config("notify", "[]"),
    ...servers.flatMap((name) => config(`mcp_servers.${name}.enabled`, "false")),
    ...(call.model === undefined ? [] : ["--model", call.model]),
    ...(call.effort === undefined ? [] : config("model_reasoning_effort", tomlString(call.effort))),
    // The prompt comes on stdin.
    "-"
  ]
  const proc = yield* runProcess(program, args, { cwd: call.cwd, timeoutS, env, input: call.prompt })
  if (proc.timedOut) return yield* new LlmError({ message: `codex timed out after ${timeoutS}s` })
  const events = codexEvents(proc.stdout)
  const answerText = yield* fs.readFileString(answerFile).pipe(Effect.orElseSucceed(() => ""))
  const lastMessage = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message").at(-1)?.item?.text
  const text = answerText.trim() !== "" ? answerText : lastMessage ?? ""
  if (proc.exitCode !== 0 || text.trim() === "") {
    const why = failureOf(events) ?? (proc.stderr.trim() || proc.stdout.trim())
    return yield* new LlmError({ message: `codex failed (exit ${proc.exitCode}): ${why.slice(0, 500)}` })
  }
  const value = yield* Schema.decodeUnknownEffect(AnswerJson)(text.trim()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(call.schema)),
    Effect.mapError((e) => new LlmError({ message: `the answer doesn't match the schema: ${e.message}` }))
  )
  const used = codexUsage(events)
  const model = call.model ?? configuredModel(yield* fs.readFileString(path.join(codexHome({ home: homedir(), env: process.env }), "config.toml")).pipe(Effect.orElseSucceed(() => "")))
  const usage: Usage = {
    input_tokens: Math.max(0, used.input - used.cached),
    output_tokens: used.output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: used.cached
  }
  return {
    value,
    costUsd: codexUsd(model, used.input, used.cached, used.output),
    usage,
    durationS: proc.durationS
  } satisfies StructuredResult<A>
}, Effect.scoped, Effect.mapError((e) => (e instanceof LlmError ? e : new LlmError({ message: e.message }))))
