/**
 * What the user chose at setup, kept in the memory home's config.json next to
 * the tenant (Home.ts reads only that):
 *
 *     { "tenant": "local", "learn": { "auto": true, "every": 3, "max_usd_per_day": 1, "with": "codex" } }
 *
 * - `auto`: learn on its own after a change is stored, once a repo has
 *   `every` new changes, in the background.
 * - `max_usd_per_day`: what learning on its own may spend in a day. A round
 *   starts on its own only when its estimate fits in what is left of it;
 *   otherwise it waits for another day, a higher limit or `singularity learn`.
 * - `with`: the agent learning goes through, on the user's account with it:
 *   `claude`, `codex` or `hermes` (Learner.ts). Homes set up before there was
 *   a choice don't have it; they learned through Claude Code.
 * - `model`: the model that agent learns with, when its own setting won't
 *   do (refused on the user's plan, say, or retired): setup checks that the
 *   model answers and asks for another when it doesn't (LearnerModel.ts). It
 *   goes with `with`: another agent learns with its own model.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { type ModelAgent, MODEL_AGENTS } from "../eval/Llm.ts"
import { DEFAULT_TENANT, homeRoot } from "../local/Home.ts"
import { DEFAULT_EVERY } from "../workflows/Learn.ts"

export const LearnPreferences = Schema.Struct({
  auto: Schema.Boolean,
  every: Schema.Int,
  max_usd_per_day: Schema.Number,
  with: Schema.optionalKey(Schema.Literals(MODEL_AGENTS)),
  model: Schema.optionalKey(Schema.String)
})
export type LearnPreferences = typeof LearnPreferences.Type

export const DEFAULT_LEARN: LearnPreferences = { auto: false, every: DEFAULT_EVERY, max_usd_per_day: 1 }

const ConfigLearn = Schema.fromJsonString(Schema.Struct({
  learn: Schema.optionalKey(Schema.Struct({
    auto: Schema.optionalKey(Schema.Boolean),
    every: Schema.optionalKey(Schema.Int),
    max_usd_per_day: Schema.optionalKey(Schema.Number),
    // Any string, so that a name this version doesn't know leaves the rest readable.
    with: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String)
  }))
}))

const isModelAgent = (s: string | undefined): s is ModelAgent => (MODEL_AGENTS as ReadonlyArray<string | undefined>).includes(s)
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const configFile = Effect.fnUntraced(function*(root?: string) {
  const path = yield* Path.Path
  return path.join(root ?? (yield* homeRoot), "config.json")
})

/** The learning preferences, the defaults for any not set. */
export const readLearn = Effect.fn("readLearn")(function*(root?: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(yield* configFile(root)).pipe(Effect.orElseSucceed(() => "{}"))
  const learn = Option.getOrUndefined(Schema.decodeUnknownOption(ConfigLearn)(text))?.learn
  const chosen = learn?.with
  return {
    auto: learn?.auto ?? DEFAULT_LEARN.auto,
    every: Math.max(1, learn?.every ?? DEFAULT_LEARN.every),
    max_usd_per_day: learn?.max_usd_per_day ?? DEFAULT_LEARN.max_usd_per_day,
    ...(isModelAgent(chosen) ? { with: chosen } : {}),
    ...(isModelAgent(chosen) && learn?.model !== undefined && learn.model.trim() !== "" ? { model: learn.model.trim() } : {})
  } satisfies LearnPreferences
})

/** The model to learn with through `agent`: the one chosen for it, else undefined (its own setting; Sonnet for Claude Code). */
export const modelFor = (learn: LearnPreferences, agent: ModelAgent): string | undefined => (learn.with === agent ? learn.model : undefined)

/** Whether the user chose learning preferences yet (setup asks with its defaults until then). */
export const learnIsSet = Effect.fn("learnIsSet")(function*(root?: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(yield* configFile(root)).pipe(Effect.orElseSucceed(() => "{}"))
  return Option.getOrUndefined(Schema.decodeUnknownOption(ConfigLearn)(text))?.learn !== undefined
})

/** Keep learning preferences in config.json; everything else in it stays. */
export const writeLearn = Effect.fn("writeLearn")(function*(learn: LearnPreferences, root?: string) {
  const fs = yield* FileSystem.FileSystem
  const file = yield* configFile(root)
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "{}"))
  const config = Option.getOrElse(Schema.decodeUnknownOption(ConfigObject)(text), () => ({}) as Record<string, unknown>)
  yield* fs.writeFileString(file, JSON.stringify({ tenant: DEFAULT_TENANT, ...config, learn }, null, 2) + "\n")
})
