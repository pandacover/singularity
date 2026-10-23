/**
 * A model picks the past change a task's start points to, when the person
 * chose it at setup (local/Home.ts `Picks`). Word search (Search.ts) misses a
 * task told in other words than its past change ("it takes ages before the
 * options show" for "Lazy-load the command's modules") and matches on words a
 * task shares by chance; a model reading the task and the repo's stored
 * changes tells them apart.
 *
 * Measured on 2026-10-23 (examples kept outside the repo, in
 * C:\singularity-workspaces\intent-bench): on 62 real task starts, judged by
 * a stronger model that saw no pick, word search handed over 6 wrong changes
 * and 9 right ones, Haiku picking from the changes' commit titles and
 * requests 3 wrong and 12 right; on 31 tasks reworded away from their past
 * change's words, word search found 1, Haiku 30. Intents a model wrote for
 * each change when storing it added nothing, so storing calls no model.
 *
 * The model runs through the agent's own command (`claude -p`), with no
 * tools, no settings (so none of memory's hooks) and no session kept, and
 * takes about 4 to 5 seconds, most of it the command starting: the hook that
 * calls it runs in the background (setup/Agents.ts, `async`), and Claude Code
 * hands its answer to the agent at its next step. When the model can't be
 * asked, memory's word search picks instead.
 */
import { Effect, Schema } from "effect"
import { procOk, runProcess } from "../eval/Proc.ts"
import type { Picks } from "../local/Home.ts"
import { changeTitle } from "../records/Task.ts"
import { findClaude } from "../setup/Wiring.ts"

export class PickError extends Schema.TaggedError<PickError>()("PickError", {
  message: Schema.String
}) {}

/** The models setup offers for Claude Code, the cheapest first, and the default. */
export const CLAUDE_MODELS = [
  { model: "haiku", title: "Haiku", description: "the cheapest, about $0.002 a task" },
  { model: "sonnet", title: "Sonnet", description: "more careful, costs more" },
  { model: "opus", title: "Opus", description: "the most careful, costs the most" }
] as const
export const DEFAULT_MODEL = "haiku"

/** The most recent stored changes listed for the model: the list, and with it the price, stays the same as memory grows. */
export const MAX_LISTED = 150
/** How much of a change's request the list shows beside its commit's title. */
const REQUEST_CHARS = 150
/** How much of the new task the model reads: a long brief's first part says what it is for. */
const TASK_CHARS = 3000
/** The background hook waits this long for an answer, then falls back to word search. */
export const PICK_TIMEOUT_S = 60

export const PICK_SYSTEM = `A person just sent a message to their coding agent. Below are changes stored from earlier sessions in the same repository, each with what it was for. Pick the one earlier change whose goal is the same as the new message's, so that seeing it would clearly help the agent with this task. Shared generic words or the same broad area are not enough. If the message is not a task, or no earlier change has the same goal, pick none - a wrong pick misleads the agent, so only pick when you are confident.

Answer with JSON only: {"pick": <number> | null}`

const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)} …` : text)
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** A stored change as the model reads it. */
export interface PickDoc {
  readonly prompt: string
  readonly message?: string | undefined
}

/** The changes the model picks from, numbered from 1: each one's title, then the start of the request behind it. */
export const pickList = (docs: ReadonlyArray<PickDoc>): string =>
  docs.map((d, i) => {
    const title = changeTitle(d).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? ""
    const request = cut(oneLine(d.prompt), REQUEST_CHARS)
    return `${i + 1}. ${title} — request: ${request === "" ? "(none)" : request}`
  }).join("\n")

/** What the model is sent: the new task, then the list. */
export const pickInput = (task: string, docs: ReadonlyArray<PickDoc>): string =>
  `NEW MESSAGE:\n${cut(task, TASK_CHARS)}\n\nEARLIER CHANGES:\n${pickList(docs)}`

/** What `claude -p --output-format json` prints, the parts read. */
const CliResult = Schema.Struct({
  result: Schema.String,
  is_error: Schema.optionalKey(Schema.Boolean),
  total_cost_usd: Schema.optionalKey(Schema.Number)
})

const Answer = Schema.Struct({ pick: Schema.NullOr(Schema.Number) })

/**
 * The change a model's answer picks, as an index into the `n` changes listed
 * (from 0), or null for none; undefined when the answer isn't one.
 */
export const readAnswer = (text: string, n: number): number | null | undefined => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) return undefined
  const answer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer))(text.slice(start, end + 1))
  if (answer._tag === "None") return undefined
  const pick = answer.value.pick
  if (pick === null) return null
  return Number.isInteger(pick) && pick >= 1 && pick <= n ? pick - 1 : undefined
}

export interface Picked {
  /** The change picked, as an index into the docs asked about, or null for none. */
  readonly index: number | null
  readonly seconds: number
  readonly costUsd: number | null
}

/**
 * Ask the model which of `docs` (store order, the most recent last) a new
 * task's past change is. Runs in `cwd`, away from any project's settings,
 * with Claude Code's command on PATH (`command`: another, for tests).
 */
export const askModel = Effect.fn("askModel")(function*(
  picks: Picks,
  task: string,
  docs: ReadonlyArray<PickDoc>,
  cwd: string,
  command?: ReadonlyArray<string>
) {
  if (docs.length === 0) return { index: null, seconds: 0, costUsd: null } satisfies Picked
  const claude = command ?? (yield* findClaude(process.env))
  if (claude === undefined) return yield* new PickError({ message: "Claude Code's command isn't on PATH" })
  const args = [
    ...claude.slice(1),
    "-p",
    "--model", picks.model,
    "--effort", "low",
    "--tools", "",
    "--setting-sources", "",
    "--no-session-persistence",
    "--system-prompt", PICK_SYSTEM,
    "--output-format", "json"
  ]
  const run = yield* runProcess(claude[0], args, {
    cwd,
    timeoutS: PICK_TIMEOUT_S,
    // Memory's hooks stay out of the model's own session.
    env: { ...process.env, SINGULARITY_HOOKS: "off" },
    input: pickInput(task, docs)
  })
  if (!procOk(run)) {
    const why = run.timedOut ? `no answer in ${PICK_TIMEOUT_S} s` : `exit ${run.exitCode}: ${oneLine(run.stderr || run.stdout).slice(0, 300)}`
    return yield* new PickError({ message: `claude -p: ${why}` })
  }
  const out = Schema.decodeUnknownOption(Schema.fromJsonString(CliResult))(run.stdout.trim())
  if (out._tag === "None" || out.value.is_error === true) return yield* new PickError({ message: `claude -p: ${oneLine(run.stdout).slice(0, 300)}` })
  const index = readAnswer(out.value.result, docs.length)
  if (index === undefined) return yield* new PickError({ message: `an answer that picks nothing listed: ${oneLine(out.value.result).slice(0, 200)}` })
  return { index, seconds: Math.round(run.durationS * 10) / 10, costUsd: out.value.total_cost_usd ?? null } satisfies Picked
})
