/**
 * `singularity setup`: everything local memory needs, in one go, saying what
 * each step means as it happens, in the layout of Ui.ts.
 *
 *   1. The machine: only what is missing (git).
 *   2. Your agents: memory's hooks where the agent has them, the skill
 *      everywhere (Agents.ts says what each agent gets).
 *   3. The `singularity` command, on PATH for new terminals (said at the end).
 *   4. Learning: the agent whose model learns (Claude Code, Codex or Hermes
 *      Agent, asked when there are several, Learner.ts); on its own after
 *      changes, within a daily limit.
 *   5. This repo: in a repo with past sessions, a first memory from them.
 *
 * Running it again updates everything in place. `--yes` takes every default
 * and asks nothing; it never spends on learning right away.
 */
import { Console, Effect, Layer, Path } from "effect"
import type { ModelAgent, ModelCli } from "../eval/Llm.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { storePast } from "../workflows/Commits.ts"
import { type PastSession, pastSessions } from "../workflows/Transcripts.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { learnState, learnSubject, type LearnOutcome, roundUsd } from "../workflows/Learn.ts"
import { type Agent, type AgentDirs, type AgentId, CODEX_TRUST_NOTE, type Reach, sessionHomes } from "./Agents.ts"
import { markLock, releaseLearning, takeLock } from "./Background.ts"
import { codexHooks, trustCodexHooks } from "./CodexHooks.ts"
import { LEARNER_ACCOUNTS, LEARNER_MODELS, LEARNER_NAMES, learnerConfig, learnerModel, learnersHere } from "./Learner.ts"
import { configuredLearnerModel, modelChoices, probeModel } from "./LearnerModel.ts"
import { addToPath, COMMAND, type PathChange, writeLaunchers } from "./Launcher.ts"
import { learnIsSet, modelFor, readLearn, writeLearn } from "./Preferences.ts"
import { askChoice, askDollars, askMany, askText, confirm, listWords, makeStyle, makeTree, marks, plural, type Style, tilde, title, TITLED_ENV, type Tree, usd, withSpinner } from "./Ui.ts"
import { agentStates, detectAgents, findCommand, findExecutable, HOOK_SCRIPT, MIN_NODE_MAJOR, nodeForHooks, skillDirsFor, unwireHooks, versionOf, wireHooks, wireSkills } from "./Wiring.ts"

export interface SetupOptions {
  /** Take every default and ask nothing. */
  readonly yes: boolean
  /** Only these agents (none: every agent found). */
  readonly only: ReadonlyArray<AgentId>
  /** Put the command on PATH. */
  readonly path: boolean
  /** Where setup runs: a repo there is offered its past sessions. */
  readonly cwd: string
  /** The user's home directory, and the environment agents' directories come from. */
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether there is a person at a terminal to ask. */
  readonly interactive: boolean
  readonly color: boolean
  /** What learning on its own may spend a day, in dollars, when the user said so already (`--daily-limit`): not asked. */
  readonly dailyLimit?: number | undefined
  /** The agent whose model learns, when the user said so already (`--learn-with`): not asked. */
  readonly learnWith?: ModelAgent | undefined
  /** The model it learns with, when the user said so already (`--learn-model`): checked, not asked. */
  readonly learnModel?: string | undefined
}

export const INTRO = [
  "Coding agents start every session from zero. singularity remembers how",
  "tasks get done in your repos and hands that to the next agent."
]

/** The Windows installer, for WSL users whose agents run on Windows. */
export const WINDOWS_INSTALL = "irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex"

/** What memory does in an agent, by how far it reaches there. */
export const REACH: Record<Reach, string> = {
  "learns": "memory at task start, learns from its sessions",
  "hands-over": "memory at task start",
  "on-request": "memory when you ask for it"
}

const SESSION_OF: Record<PastSession["agent"], string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes Agent" }

/** "3 past Claude Code sessions", or "4 past sessions (Claude Code 3, Codex 1)" when they ran in several agents. */
export const pastCount = (agents: ReadonlyArray<PastSession["agent"]>): string => {
  const counts = [...new Set(agents)].map((a) => [SESSION_OF[a], agents.filter((b) => b === a).length] as const)
  if (counts.length === 1) return plural(agents.length, `past ${counts[0][0]} session`)
  return `${plural(agents.length, "past session")} (${counts.map(([name, n]) => `${name} ${n}`).join(", ")})`
}

/** What learning on its own costs a round, for the user deciding. */
const ROUND_USD = 0.25

const stores = (home: Home, path: Path.Path) =>
  Layer.merge(
    JsonRecordStore.layer(home.tenantDir, home.tenant),
    JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
  )

/** What a learning round did: an item's line, then the workflows under it, two further in. */
export const describeOutcome = (s: Style, o: LearnOutcome): ReadonlyArray<string> => {
  if (o.kind === "waiting") return [`${s.dim("·")} not yet: ${o.reason}`]
  if (o.kind === "kept") return [`${s.dim("·")} ${o.reason} (${usd(o.costUsd)})`]
  const what = `${plural(o.workflows.length, "workflow")} and ${plural(o.pitfalls, "known mistake")}`
  return [
    `${s.green("✓")} ${o.round === "build" ? "Learned" : "Now knows"} ${what} from ${plural(o.sessions, "change")} ${s.dim(`(${usd(o.costUsd)})`)}:`,
    ...o.workflows.slice(0, 6).map((name) => `  ${s.dim("·")} ${name}`),
    ...(o.workflows.length > 6 ? [`  ${s.dim(`· and ${o.workflows.length - 6} more`)}`] : [])
  ]
}

/** The note under an agent: done ("✓ ...", said dimly) or still to do. */
const noteLine = (s: Style, note: string) => (note.startsWith("✓") ? s.dim(note.slice(1).trim()) : marks(s).warn(note))

export const runSetup = Effect.fn("runSetup")(function*(o: SetupOptions) {
  const s = makeStyle(o.color)
  const M = marks(s)
  const T = makeTree(s)
  const path = yield* Path.Path
  const say = (line = "") => Console.log(line)
  const asking = o.interactive && !o.yes
  // A question takes the next branch: what is held goes out first.
  const ask = (message: string, initial: boolean) =>
    asking ? T.pause.pipe(Effect.andThen(confirm(message, initial, asking)), Effect.orElseSucceed(() => initial)) : Effect.succeed(initial)

  if (o.env[TITLED_ENV] === undefined) yield* say(title(s, "setup"))
  yield* say()
  for (const line of INTRO) yield* say(`  ${s.dim(line)}`)

  // 1. The machine: said only when something is missing.
  const nodeMajor = Number(process.versions.node.split(".")[0])
  const git = yield* versionOf("git")
  if (git === undefined || nodeMajor < MIN_NODE_MAJOR) {
    yield* T.section("Your machine")
    if (nodeMajor < MIN_NODE_MAJOR) yield* T.item(M.warn(`node ${process.versions.node} is older than memory needs (${MIN_NODE_MAJOR} or later)`))
    if (git === undefined) {
      yield* T.item(M.fail("git isn't on your PATH. Memory knows your repos through git:"))
      yield* T.note(`install it, then run ${s.cyan("singularity setup")} again`)
      yield* T.close
      yield* say()
      return false
    }
  }
  const home = yield* loadHome()
  const layers = stores(home, path)

  // 2. The agents.
  yield* T.section("Your agents")
  const dirs: AgentDirs = { home: o.home, env: o.env }
  const found = (yield* detectAgents(dirs, (c) => findExecutable(c, o.env).pipe(Effect.map((p) => p !== undefined))))
    .filter((f) => f.found && (o.only.length === 0 || o.only.includes(f.agent.id)))
    .map((f) => f.agent)
  let chosen: ReadonlyArray<Agent> = []
  if (found.length === 0) {
    yield* T.item(M.warn("No coding agent found here. Install one (Claude Code gets all of memory),"))
    yield* T.note(`then run ${s.cyan("singularity setup")} again.`)
  } else {
    // One question for all of them, ticked to begin with: the agents that have memory
    // already (hooks, or the skill where that is all an agent gets), or all of them the first time.
    const states = yield* agentStates(found.map((agent) => ({ agent, found: true })), dirs)
    const had = states
      .filter((st) => st.hookEvents.length > 0 || (st.agent.hooks === undefined && st.agent.plugin === undefined && st.skill))
      .map((st) => st.agent)
    if (asking) yield* T.pause
    const picked = yield* askMany(
      "Set up memory in which agents?",
      found.map((a) => ({ title: a.name, description: REACH[a.reach], value: a.id, selected: had.length === 0 || had.includes(a) })),
      asking
    )
    chosen = found.filter((a) => picked.includes(a.id))
    // Memory's hooks stay out of agents left out, including hooks an earlier setup put there.
    const leftOut = found.filter((a) => !chosen.includes(a))
    for (const a of leftOut) yield* unwireHooks(a)
    const launches = {
      claude: { node: process.execPath, script: HOOK_SCRIPT },
      other: { node: yield* nodeForHooks(), script: HOOK_SCRIPT }
    }
    const width = Math.max(...chosen.map((a) => a.name.length))
    for (const a of chosen) {
      const wired = yield* wireHooks(a, launches)
      // Codex's question, if it asks one, comes before Codex's line, so the answer goes under it.
      if (asking && a.id === "codex") yield* T.pause
      const note = a.id === "codex" && wired.hooks !== undefined ? yield* codexTrust(o, asking) : a.note
      yield* T.item(wired.problem !== undefined ? M.fail(`${a.name}  ${wired.problem}`) : M.ok(a.name.padEnd(width), REACH[a.reach]))
      if (note !== undefined) yield* T.note(noteLine(s, note))
    }
    if (chosen.length > 0) {
      const blocked = yield* wireSkills(skillDirsFor(chosen, dirs))
      for (const d of blocked) yield* T.item(M.warn(`${tilde(d, o.home)} has a skill of yours named singularity; left it alone`))
    }
    if (leftOut.length > 0) yield* T.item(M.skip(`${listWords(leftOut.map((a) => a.name))} left out`))
  }
  // WSL has agents of its own; the ones that run on Windows are set up from Windows.
  if (o.env.WSL_DISTRO_NAME !== undefined) {
    yield* T.item(M.skip("This is WSL. For the agents you run on Windows, run this in PowerShell:"))
    yield* T.note(s.cyan(WINDOWS_INSTALL))
  }

  // 3. The command: said at the end, with what to do next.
  const bin = yield* writeLaunchers(home.root, process.execPath, COMMAND, process.platform)
  const onPath: PathChange | undefined = o.path
    ? yield* addToPath(bin, { home: o.home, shell: o.env.SHELL, platform: process.platform, pathValue: o.env.PATH ?? o.env.Path })
    : undefined
  const end = (learning: boolean) => done(s, T, o, chosen, bin, onPath, learning)

  // 4. Learning.
  yield* T.section("Learning")
  const prefs = yield* readLearn(home.root)
  const learners = yield* learnersHere(dirs)
  if (learners.length === 0) {
    yield* T.item(M.warn("Memory learns with the model of Claude Code, Codex or Hermes Agent, and none of them is here."))
    yield* T.note(`Install one, then run ${s.cyan("singularity setup")} again to turn learning on.`)
    return yield* end(false)
  }
  yield* T.text(`Memory keeps the changes your agents commit with checks passing. Every ${prefs.every}`)
  yield* T.text(`in a repo, a model can learn workflows from them: about ${usd(ROUND_USD)} a round.`)
  if (o.learnWith !== undefined && !learners.some((l) => l.agent === o.learnWith)) {
    yield* T.item(M.warn(`${LEARNER_NAMES[o.learnWith]} isn't here, so learning can't go through it.`))
  }
  if (asking) yield* T.pause
  const learner = yield* pickLearner(learners, o, prefs.with, chosen, asking)
  const learnCwd = path.join(defaultWorkspaces(), "_learner")
  const model = yield* pickModel(learner, o, modelFor(prefs, learner.agent), dirs, learnCwd, asking, s, T)
  const auto = yield* ask("Learn on its own?", (yield* learnIsSet(home.root)) ? prefs.auto : true)
  if (asking) yield* T.pause
  const limit = o.dailyLimit !== undefined
    ? Math.max(0, o.dailyLimit)
    : auto
    ? yield* askDollars("At most how many dollars a day?", prefs.max_usd_per_day, asking).pipe(Effect.orElseSucceed(() => prefs.max_usd_per_day))
    : prefs.max_usd_per_day
  const { model: _before, ...kept } = prefs
  yield* writeLearn({ ...kept, auto, max_usd_per_day: limit, with: learner.agent, ...(model === undefined ? {} : { model }) }, home.root)
  const through = `${learnerModel(learner.agent, model)}, on ${LEARNER_ACCOUNTS[learner.agent]}`
  yield* T.item(auto
    ? M.ok(`on its own with ${LEARNER_NAMES[learner.agent]}, up to ${usd(limit)} a day`, through)
    : M.skip(`when you run singularity learn, with ${LEARNER_NAMES[learner.agent]} (${through})`))
  const others = learners.filter((l) => l.agent !== learner.agent)
  if (!asking && o.learnWith === undefined && others.length > 0) {
    yield* T.note(s.dim(`to learn with ${listWords(others.map((l) => LEARNER_NAMES[l.agent]))} instead: singularity setup --learn-with ${others.map((l) => l.agent).join("|")}`))
  }

  // 5. This repo's past sessions.
  const repo = yield* identifyRepo(o.cwd)
  const homes = sessionHomes(dirs, chosen.map((a) => a.id))
  const past = repo === undefined ? [] : yield* pastSessions(repo.root, homes).pipe(Effect.orElseSucceed(() => []))
  if (repo === undefined || past.length === 0) return yield* end(true)
  yield* T.section(`This repo  ${s.dim(path.basename(repo.root))}`)
  const read = yield* withSpinner(`reading ${pastCount(past.map((p) => p.agent))}`, storePast(repo.root, homes, home.tenantDir).pipe(Effect.provide(layers), Effect.result), o.interactive)
  if (read._tag === "Failure") {
    yield* T.item(M.fail(`couldn't read its past sessions (${read.failure.message}); ${s.cyan("singularity learn --past")} tries again`))
    return yield* end(true)
  }
  const n = read.success.stored.length + read.success.existing.length
  if (n === 0) {
    yield* T.item(M.skip(`its ${pastCount(past.map((p) => p.agent))} committed no change with passing checks; memory learns as you work`))
    return yield* end(true)
  }
  yield* T.item(M.ok(`${n === 1 ? "one change" : `${n} changes`} committed with passing checks`, `from ${pastCount(past.map((p) => p.agent))}`))
  const { subject, price } = yield* Effect.gen(function*() {
    const subject = yield* (yield* RecordStore).subjectFor(repo)
    return { subject, price: subject === undefined ? 0 : roundUsd(yield* learnState(subject.id)) }
  }).pipe(Effect.provide(layers))
  if (subject === undefined || o.yes) {
    yield* T.item(M.skip(`run singularity learn here to learn from ${n === 1 ? "it" : "them"}`))
    return yield* end(true)
  }
  const go = yield* ask(`Learn from ${n === 1 ? "it" : `those ${n}`} now, with ${LEARNER_NAMES[learner.agent]}? About ${usd(price)}.`, true)
  if (go && !takeLock(home.root)) {
    yield* T.item(M.skip("a learning round is running now; run singularity learn when it's done"))
  } else if (go) {
    markLock(home.root, subject.id)
    yield* T.pause
    const learned = yield* withSpinner(
      "learning (a minute or two)",
      learnSubject(subject, {
        ...learnerConfig(learner, learnCwd, model),
        every: prefs.every,
        now: true
      }).pipe(Effect.provide(layers), Effect.result, Effect.ensuring(Effect.sync(() => releaseLearning(home.root)))),
      o.interactive
    )
    if (learned._tag === "Success") {
      const [first, ...rest] = describeOutcome(s, learned.success)
      yield* T.item(first)
      for (const line of rest) yield* T.note(line.trim())
    } else yield* T.item(M.fail(`learning failed (${learned.failure.message}); try ${s.cyan("singularity learn")} later`))
  }
  return yield* end(true)
})

/**
 * The agent learning goes through, of those here: the one `--learn-with`
 * names; else, asked when there are several, the one chosen before, or the
 * first of those memory was just set up in, or the first here.
 */
const pickLearner = Effect.fnUntraced(function*(
  learners: ReadonlyArray<ModelCli>,
  o: SetupOptions,
  before: ModelAgent | undefined,
  chosen: ReadonlyArray<Agent>,
  asking: boolean
) {
  const named = learners.find((l) => l.agent === o.learnWith)
  if (named !== undefined || learners.length === 1) return named ?? learners[0]
  const initial = learners.find((l) => l.agent === before)
    ?? learners.find((l) => chosen.some((a) => a.id === l.agent))
    ?? learners[0]
  const agent = yield* askChoice(
    "Learn with which agent's model?",
    learners.map((l) => ({ title: LEARNER_NAMES[l.agent], description: `${LEARNER_MODELS[l.agent]}, on ${LEARNER_ACCOUNTS[l.agent]}`, value: l.agent })),
    initial.agent,
    asking
  ).pipe(Effect.orElseSucceed(() => initial.agent))
  return learners.find((l) => l.agent === agent) ?? initial
})

/** The choice for a model typed in. */
const OTHER_MODEL = "\u0000other"

/**
 * The model the learner learns with, checked with one tiny call: the one
 * `--learn-model` names, or the one chosen before, or the agent's own
 * setting (undefined). When it doesn't answer, offers the models the agent
 * lists and checks the one chosen; with nobody to ask, says how to choose
 * and keeps what there was. Claude Code learns with Sonnet, unchecked.
 */
const pickModel = Effect.fnUntraced(function*(
  learner: ModelCli,
  o: SetupOptions,
  before: string | undefined,
  dirs: AgentDirs,
  cwd: string,
  asking: boolean,
  s: Style,
  T: Tree
) {
  const M = marks(s)
  if (learner.agent === "claude") return o.learnModel ?? before
  const name = LEARNER_NAMES[learner.agent]
  const check = (model: string | undefined) =>
    Effect.gen(function*() {
      const label = model ?? (yield* configuredLearnerModel(learner, dirs)) ?? `${name}'s own model`
      yield* T.pause
      const probe = yield* withSpinner(`checking that ${label} answers through ${name}`, probeModel(learner, model, cwd), o.interactive)
      yield* T.item(probe.ok ? M.ok(`${label} answers through ${name}`) : M.warn(`${label} doesn't answer through ${name}: ${probe.reason}`))
      return probe.ok
    })
  const model = o.learnModel ?? before
  if (yield* check(model)) return model
  const choices = yield* modelChoices(learner, dirs)
  if (!asking) {
    const examples = choices.slice(0, 3).map((c) => c.id)
    yield* T.note(s.yellow(`Learning needs a model that answers: singularity setup --learn-model <model>${examples.length > 0 ? ` (${name} lists ${listWords(examples)})` : ""}`))
    return model
  }
  for (let tries = 0; tries < 3; tries++) {
    yield* T.pause
    const picked = choices.length === 0
      ? OTHER_MODEL
      : yield* askChoice(
        `Learn with which ${name} model?`,
        [...choices.map((c) => ({ title: c.id, description: c.note, value: c.id })), { title: "another", description: "type its name", value: OTHER_MODEL }],
        choices[0].id,
        asking
      ).pipe(Effect.orElseSucceed(() => choices[0].id))
    const typed = picked === OTHER_MODEL ? yield* askText(`The ${name} model to learn with:`, "", asking).pipe(Effect.orElseSucceed(() => "")) : picked
    if (typed === "") break
    if (yield* check(typed)) return typed
  }
  yield* T.note(s.yellow(`Learning needs a model that answers; choose one later with singularity setup --learn-model <model>`))
  return before
})

/**
 * Codex runs memory's hooks only once the user trusts them. Asks, when some
 * aren't trusted yet, and trusts them as Codex's `/hooks` would; the line to
 * show under Codex ("✓ ..." when it is done), or undefined when there is
 * nothing to say.
 */
export const codexTrust = Effect.fnUntraced(function*(
  o: Pick<SetupOptions, "home" | "env">,
  asking: boolean
) {
  const codex = yield* findCommand("codex", o.env)
  const hooks = codex === undefined ? undefined : yield* codexHooks(codex, { home: o.home, env: o.env })
  if (codex === undefined || hooks === undefined || hooks.length === 0) return CODEX_TRUST_NOTE
  const untrusted = hooks.filter((h) => !h.trusted)
  if (untrusted.length === 0) return "✓ Codex trusts them"
  if (!asking) return CODEX_TRUST_NOTE
  const yes = yield* confirm(`Codex runs new hooks only once you trust them. Trust memory's ${plural(untrusted.length, "hook")} in Codex now?`, true, asking).pipe(Effect.orElseSucceed(() => false))
  if (!yes) return CODEX_TRUST_NOTE
  return (yield* trustCodexHooks(codex, { home: o.home, env: o.env }, untrusted)) ? "✓ trusted in Codex" : CODEX_TRUST_NOTE
})

/** The end of setup: whether it's ready, what to do now, and the commands to know. */
const done = Effect.fnUntraced(function*(
  s: Style,
  T: Tree,
  o: SetupOptions,
  chosen: ReadonlyArray<Agent>,
  bin: string,
  onPath: PathChange | undefined,
  learning: boolean
) {
  const M = marks(s)
  const ready = chosen.length > 0
  yield* T.head(`${ready ? s.green("✓") : s.yellow("!")} ${s.bold(ready ? "Ready" : "Not set up in any agent")}${ready ? `  ${s.dim("agents running now get memory from their next start")}` : ""}`)
  if (onPath === undefined) yield* T.item(s.dim(`the singularity command is ${tilde(bin, o.home)}/singularity`))
  else if (onPath.state === "added") yield* T.item(s.dim("open a new terminal for the singularity command"))
  else if (onPath.state === "failed") yield* T.item(M.warn(`add ${tilde(bin, o.home)} to your PATH to run singularity anywhere`))
  if (!learning) yield* T.item(s.dim("learning is off until Claude Code, Codex or Hermes Agent is here"))
  yield* T.section("Commands")
  const commands: ReadonlyArray<readonly [string, string]> = [
    ["singularity status", "what memory knows, repo by repo"],
    ["singularity recall \"<task>\"", "what a task would be handed"],
    ["singularity learn", "learn from new changes now"],
    ["singularity update", "get the latest version"],
    ["singularity uninstall", "take it all out (memory stays)"]
  ]
  const w = Math.max(...commands.map(([c]) => c.length)) + 3
  for (const [c, what] of commands) yield* T.item(`${s.cyan(c.padEnd(w))}${s.dim(what)}`)
  yield* T.close
  yield* Console.log("")
  return true
})
