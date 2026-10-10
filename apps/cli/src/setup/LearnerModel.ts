/**
 * Whether the model memory would learn with answers, and the others it
 * could use when it doesn't. Codex and Hermes Agent learn with the model the
 * user set them to use, and that model may not answer: a ChatGPT plan that
 * refuses it, a model the provider has since retired. Learning would then
 * fail at every round, so setup makes one tiny call first (a fraction of a
 * cent, or nothing on a plan), and when it fails offers the models the agent
 * lists, cheapest first, for the user to choose. The choice is kept as
 * `learn.model` (Preferences.ts); memory never picks a model on its own,
 * since prices differ a hundredfold.
 *
 * - Codex lists the models the user's account may use in its home's
 *   `models_cache.json`; their prices are its API prices (CodexLlm.ts).
 * - Hermes Agent keeps the models of each provider in
 *   `provider_models_cache.json`; it says no prices, so the free ones come
 *   first and the user can type any other.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { parseDocument } from "yaml"
import { codexPrice, configuredModel } from "../eval/CodexLlm.ts"
import type { ModelCli } from "../eval/Llm.ts"
import { callModel } from "../eval/ModelCall.ts"
import { type AgentDirs, codexHome, hermesHome } from "./Agents.ts"

/** A model the user may choose, with a few words on it (its price, or that it is free). */
export interface ModelChoice {
  readonly id: string
  readonly note?: string | undefined
}

/** How many models setup offers; the user can still type any other. */
const MAX_CHOICES = 8

const Ok = Schema.Struct({ ok: Schema.Boolean })

/** The reason in an agent's error, without the JSON around it: `The 'x' model is not supported ...`. */
export const reasonOf = (message: string): string => {
  const inner = [...message.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1]
  const text = (inner ?? message).replace(/\\"/g, "\"").replace(/\s+/g, " ").trim()
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}

/**
 * One tiny call to `model` (undefined: the agent's own setting), as learning
 * makes its calls; the reason when it fails.
 */
export const probeModel = Effect.fn("probeModel")(function*(cli: ModelCli, model: string | undefined, cwd: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.ignore)
  return yield* callModel({
    cli,
    model,
    cwd,
    system: "You check that a model answers. Reply with the JSON asked for and nothing else.",
    prompt: "Reply with {\"ok\": true}.",
    schema: Ok,
    effort: "low",
    timeoutS: 180
  }).pipe(
    Effect.as({ ok: true as const }),
    Effect.catch((e) => Effect.succeed({ ok: false as const, reason: reasonOf(e.message) }))
  )
})

const CodexModels = Schema.fromJsonString(Schema.Struct({
  models: Schema.Array(Schema.Struct({ slug: Schema.String, visibility: Schema.optionalKey(Schema.String) }))
}))

const HermesModels = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Struct({ models: Schema.optionalKey(Schema.Array(Schema.String)) })))

const perMillion = (x: number) => `$${x < 1 ? x.toFixed(2) : x.toFixed(x % 1 === 0 ? 0 : 2)}`

/** The models Codex lists for the user's account, cheapest first, with their API prices. */
export const codexChoices = Effect.fn("codexChoices")(function*(dirs: AgentDirs) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(path.join(codexHome(dirs), "models_cache.json")).pipe(Effect.orElseSucceed(() => ""))
  const models = Option.getOrUndefined(Schema.decodeUnknownOption(CodexModels)(text))?.models ?? []
  return models
    .filter((m) => m.visibility === undefined || m.visibility === "list")
    .map((m) => ({ id: m.slug, price: codexPrice(m.slug) }))
    .sort((a, b) => a.price.input + a.price.output - (b.price.input + b.price.output) || a.id.localeCompare(b.id))
    .slice(0, MAX_CHOICES)
    .map(({ id, price }): ModelChoice => ({
      id,
      note: price.listed ? `${perMillion(price.input)} in / ${perMillion(price.output)} out per million tokens at API prices` : undefined
    }))
})

/** The model and provider Hermes Agent is set to use, from its config.yaml. */
export const hermesModel = Effect.fn("hermesModel")(function*(dirs: AgentDirs) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(path.join(hermesHome(dirs), "config.yaml")).pipe(Effect.orElseSucceed(() => ""))
  const doc = parseDocument(text, { version: "1.1" })
  const model = doc.errors.length > 0 ? undefined : doc.get("model")
  const field = (key: string): string | undefined => {
    const value = (model as { get?: (k: string) => unknown } | undefined)?.get?.(key)
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
  }
  return typeof model === "string" ? { model: model.trim(), provider: undefined } : { model: field("default"), provider: field("provider") }
})

/** The models Hermes Agent knows its provider has: the free ones first. */
export const hermesChoices = Effect.fn("hermesChoices")(function*(dirs: AgentDirs) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { provider } = yield* hermesModel(dirs)
  if (provider === undefined) return []
  const text = yield* fs.readFileString(path.join(hermesHome(dirs), "provider_models_cache.json")).pipe(Effect.orElseSucceed(() => ""))
  const models = Option.getOrUndefined(Schema.decodeUnknownOption(HermesModels)(text))?.[provider]?.models ?? []
  const free = models.filter((m) => /(?:^|[:/_-])free\b/i.test(m))
  return free.slice(0, MAX_CHOICES).map((id): ModelChoice => ({ id, note: "free" }))
})

/** The models the agent could learn with instead, as setup offers them. */
export const modelChoices = (cli: ModelCli, dirs: AgentDirs) =>
  cli.agent === "codex" ? codexChoices(dirs) : cli.agent === "hermes" ? hermesChoices(dirs) : Effect.succeed<ReadonlyArray<ModelChoice>>([])

/** The model the agent is set to use, for saying which one didn't answer. */
export const configuredLearnerModel = Effect.fn("configuredLearnerModel")(function*(cli: ModelCli, dirs: AgentDirs) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (cli.agent === "codex") {
    const text = yield* fs.readFileString(path.join(codexHome(dirs), "config.toml")).pipe(Effect.orElseSucceed(() => ""))
    return configuredModel(text)
  }
  if (cli.agent === "hermes") return (yield* hermesModel(dirs)).model
  return undefined
})
