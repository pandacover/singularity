/**
 * The agent memory learns with. Learning is a model reading the changes
 * memory stored and writing workflows from them (a few calls a round,
 * workflows/Learn.ts), and the calls go through the command line of one of
 * the agents memory learns from: Claude Code, Codex or Hermes Agent, on the
 * user's own account with it (eval/ModelCall.ts).
 *
 * Setup asks which one when it finds more than one, and keeps the answer in
 * config.json (`learn.with`, Preferences.ts). Learning never moves to another
 * agent on its own: that would spend on another account. Homes set up before
 * there was a choice learn through Claude Code, as they did, or through the
 * first of the others found here when Claude Code isn't.
 *
 * Each learns with its own model, at high effort: Claude Code with Sonnet, as
 * memory's learning was measured; Codex with the model it is set to use;
 * Hermes Agent with the model and provider it is set to use.
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { CLAUDE_ENV, defaultClaude } from "../eval/Agent.ts"
import { type ModelAgent, type ModelCli, MODEL_AGENTS } from "../eval/Llm.ts"
import { DEFAULT_INDUCE_EFFORT, DEFAULT_INDUCE_MODEL, type InduceConfig } from "../workflows/Induce.ts"
import { type AgentDirs, hermesHome } from "./Agents.ts"
import { commandOf, findClaude, findCommand } from "./Wiring.ts"

export class LearnerError extends Schema.TaggedError<LearnerError>()("LearnerError", {
  message: Schema.String
}) {}

export const LEARNER_NAMES: Record<ModelAgent, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes Agent" }

/** Whose account a round goes on, for the user deciding. */
export const LEARNER_ACCOUNTS: Record<ModelAgent, string> = {
  claude: "your Claude account",
  codex: "your Codex account",
  hermes: "the provider Hermes Agent uses"
}

/** What each learns with, in a few words. */
export const LEARNER_MODELS: Record<ModelAgent, string> = {
  claude: "Sonnet",
  codex: "the model Codex is set to use",
  hermes: "the model Hermes Agent is set to use"
}

/**
 * Hermes Agent's own command: the one in its home's `bin`, where its
 * installer puts it, else a `hermes` on PATH, but only where its home exists
 * (a `hermes` alone may be the JavaScript engine of that name).
 */
const findHermes = Effect.fn("findHermes")(function*(dirs: AgentDirs) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = hermesHome(dirs)
  if (!(yield* fs.exists(home).pipe(Effect.orElseSucceed(() => false)))) return undefined
  const names = process.platform === "win32" ? ["hermes.exe", "hermes.cmd"] : ["hermes"]
  for (const name of names) {
    const file = path.join(home, "bin", name)
    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) return yield* commandOf(file)
  }
  return yield* findCommand("hermes", dirs.env)
})

/** An agent's command line on this machine, or undefined when it isn't here. */
export const findLearner = Effect.fn("findLearner")(function*(agent: ModelAgent, dirs: AgentDirs) {
  const command: ReadonlyArray<string> | undefined = agent === "claude"
    ? dirs.env[CLAUDE_ENV]?.trim()
      ? yield* defaultClaude(dirs.env).pipe(Effect.orElseSucceed(() => undefined))
      : yield* findClaude(dirs.env)
    : agent === "codex"
    ? yield* findCommand("codex", dirs.env)
    : yield* findHermes(dirs)
  return command === undefined ? undefined : { agent, command } satisfies ModelCli
})

/** The agents here that memory can learn with, in the order setup offers them. */
export const learnersHere = Effect.fn("learnersHere")(function*(dirs: AgentDirs) {
  const out: Array<ModelCli> = []
  for (const agent of MODEL_AGENTS) {
    const cli = yield* findLearner(agent, dirs)
    if (cli !== undefined) out.push(cli)
  }
  return out
})

/**
 * The agent learning goes through: the one the user chose, else (in a home
 * set up before the choice) the first here of Claude Code, Codex and Hermes
 * Agent. Fails, saying why, when that agent isn't here.
 */
export const resolveLearner = Effect.fn("resolveLearner")(function*(chosen: ModelAgent | undefined, dirs: AgentDirs) {
  if (chosen !== undefined) {
    const cli = yield* findLearner(chosen, dirs)
    if (cli !== undefined) return cli
    return yield* new LearnerError({ message: `learning goes through ${LEARNER_NAMES[chosen]}, which isn't on this machine now; run singularity setup to choose another agent` })
  }
  const here = yield* learnersHere(dirs)
  if (here.length > 0) return here[0]
  return yield* new LearnerError({ message: "learning needs Claude Code, Codex or Hermes Agent, and none is on this machine" })
})

/** How an agent learns: its model and effort, run in `cwd`, a directory with no CLAUDE.md or AGENTS.md above it. */
export const learnerConfig = (cli: ModelCli, cwd: string): InduceConfig => ({
  cli,
  cwd,
  model: cli.agent === "claude" ? DEFAULT_INDUCE_MODEL : undefined,
  effort: DEFAULT_INDUCE_EFFORT
})
