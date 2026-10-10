/**
 * `singularity setup`: everything local memory needs, in one go, saying what
 * each step means as it happens.
 *
 *   1. The machine: node, git, and Claude Code, which memory learns from and
 *      learns with.
 *   2. The coding agents found here: memory's hooks where the agent has
 *      them, the skill everywhere (Agents.ts says what each agent gets).
 *   3. The `singularity` command, on PATH for new terminals.
 *   4. Learning: on its own after sessions, within a daily limit; and in a
 *      repo with past Claude Code sessions, a first memory from them.
 *
 * Running it again updates everything in place. `--yes` takes every default
 * and asks nothing; it never spends on learning right away.
 */
import { Console, Effect, Layer, Path } from "effect"
import { DEFAULT_INDUCE_EFFORT, DEFAULT_INDUCE_MODEL } from "../workflows/Induce.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { storePast } from "../workflows/Commits.ts"
import { type PastSession, pastSessions } from "../workflows/Transcripts.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { learnState, learnSubject, type LearnOutcome, roundUsd } from "../workflows/Learn.ts"
import { type Agent, type AgentDirs, type AgentId, type Reach, sessionHomes } from "./Agents.ts"
import { markLock, releaseLearning, takeLock } from "./Background.ts"
import { addToPath, COMMAND, writeLaunchers } from "./Launcher.ts"
import { learnIsSet, readLearn, writeLearn } from "./Preferences.ts"
import { askDollars, confirm, makeStyle, plural, type Style, tilde, usd, withSpinner } from "./Ui.ts"
import { detectAgents, findClaude, findExecutable, HOOK_SCRIPT, MIN_NODE_MAJOR, nodeForHooks, skillDirsFor, unwireHooks, versionOf, wireHooks, wireSkills } from "./Wiring.ts"

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
}

export const INTRO = [
  "Coding agents start every session from zero. singularity remembers how",
  "tasks get done in your repos (where a kind of change goes, how it is",
  "checked, which traps to avoid) and hands that to the next agent. On",
  "excalidraw, changes like ones it had seen took about half the tokens."
]

/** The Windows installer, for WSL users whose agents run on Windows. */
export const WINDOWS_INSTALL = "irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex"

const REACH: Record<Reach, string> = {
  "learns": "hands over memory at task start, learns from changes",
  "hands-over": "hands over memory at task start",
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

const heading = (s: Style, n: number, title: string) => `\n  ${s.magenta(String(n))}  ${s.bold(title)}\n`

const stores = (home: Home, path: Path.Path) =>
  Layer.merge(
    JsonRecordStore.layer(home.tenantDir, home.tenant),
    JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
  )

/** What a learning round did, in a line or a few. */
export const describeOutcome = (s: Style, o: LearnOutcome): ReadonlyArray<string> => {
  if (o.kind === "waiting") return [`${s.dim("·")} not yet: ${o.reason}`]
  if (o.kind === "kept") return [`${s.dim("·")} ${o.reason} (${usd(o.costUsd)})`]
  const what = `${plural(o.workflows.length, "workflow")} and ${plural(o.pitfalls, "known mistake")}`
  return [
    `${s.green("✓")} ${o.round === "build" ? "Learned" : "Now knows"} ${what} from ${plural(o.sessions, "change")} (${usd(o.costUsd)}):`,
    ...o.workflows.slice(0, 6).map((name) => `    ${s.dim("·")} ${name}`),
    ...(o.workflows.length > 6 ? [`    ${s.dim(`· and ${o.workflows.length - 6} more`)}`] : [])
  ]
}

export const runSetup = Effect.fn("runSetup")(function*(o: SetupOptions) {
  const s = makeStyle(o.color)
  const path = yield* Path.Path
  const say = (line = "") => Console.log(line)
  const item = (line: string) => Console.log(`     ${line}`)
  const asking = o.interactive && !o.yes
  const ask = (message: string, initial: boolean) =>
    confirm(message, initial, asking).pipe(Effect.orElseSucceed(() => initial))

  yield* say()
  yield* say(`  ${s.magenta("◆")} ${s.bold("singularity")}  ${s.dim("memory for coding agents")}`)
  yield* say()
  for (const line of INTRO) yield* say(`  ${line}`)

  // 1. The machine.
  yield* say(heading(s, 1, "Your machine"))
  const nodeMajor = Number(process.versions.node.split(".")[0])
  const git = yield* versionOf("git")
  const claudeCommand = yield* findClaude(o.env)
  const claude = claudeCommand === undefined ? undefined : yield* versionOf(claudeCommand[0], [...claudeCommand.slice(1), "--version"])
  const mark = (ok: boolean) => (ok ? s.green("✓") : s.red("✗"))
  yield* item([
    `${mark(nodeMajor >= MIN_NODE_MAJOR)} node ${process.versions.node}`,
    `${mark(git !== undefined)} ${git?.replace(/^git version\s*/, "git ") ?? "git"}`,
    `${mark(claude !== undefined)} Claude Code${claude === undefined ? "" : ` ${claude.replace(/\s*\(Claude Code\)\s*$/, "")}`}`
  ].join("   "))
  if (git === undefined) {
    yield* item(`${s.red("git isn't on your PATH.")} Memory knows your repos through git: install it, then run ${s.cyan("singularity setup")} again.`)
    return false
  }
  if (claude === undefined) {
    yield* item(s.yellow("Claude Code isn't on your PATH. Memory learns from its sessions, with its model calls:"))
    yield* item(s.yellow("install it from https://claude.com/claude-code. Other agents still get what memory has."))
  }
  const home = yield* loadHome()
  const layers = stores(home, path)

  // 2. The agents.
  yield* say(heading(s, 2, "Your coding agents"))
  const dirs: AgentDirs = { home: o.home, env: o.env }
  const found = (yield* detectAgents(dirs, (c) => findExecutable(c, o.env).pipe(Effect.map((p) => p !== undefined))))
    .filter((f) => f.found && (o.only.length === 0 || o.only.includes(f.agent.id)))
    .map((f) => f.agent)
  let chosen: ReadonlyArray<Agent> = []
  if (found.length === 0) {
    yield* item("No coding agent found here. Install one (Claude Code gets all of memory), then run setup again.")
  } else {
    const width = Math.max(...found.map((a) => a.name.length)) + 3
    for (const a of found) yield* item(`${a.name.padEnd(width)}${s.dim(REACH[a.reach])}`)
    if (asking) yield* say()
    if (yield* ask(found.length === 1 ? `Set up memory in ${found[0].name}?` : `Set up memory in all ${found.length}?`, true)) {
      chosen = found
    } else if (found.length > 1) {
      const picked: Array<Agent> = []
      for (const a of found) if (yield* ask(`Set up memory in ${a.name}?`, true)) picked.push(a)
      chosen = picked
    }
    yield* say()
    // Memory's hooks stay out of agents left out, including hooks an earlier setup put there.
    for (const a of found.filter((a) => !chosen.includes(a))) yield* unwireHooks(a)
    const launches = {
      claude: { node: process.execPath, script: HOOK_SCRIPT },
      other: { node: yield* nodeForHooks(), script: HOOK_SCRIPT }
    }
    const width2 = Math.max(...chosen.map((a) => a.name.length), "skill".length) + 3
    for (const a of chosen) {
      const wired = yield* wireHooks(a, launches)
      if (wired.problem !== undefined) yield* item(`${s.red("✗")} ${a.name.padEnd(width2)}${wired.problem}`)
      else yield* item(`${s.green("✓")} ${a.name.padEnd(width2)}${wired.hooks === undefined ? "skill only" : `${a.plugin === undefined ? "hooks" : "plugin"} in ${tilde(wired.hooks, o.home)}`}`)
      if (a.note !== undefined) yield* item(`  ${" ".repeat(width2)}${s.yellow(a.note)}`)
    }
    if (chosen.length > 0) {
      const skillDirs = skillDirsFor(chosen, dirs)
      const blocked = yield* wireSkills(skillDirs)
      const placed = skillDirs.filter((d) => !blocked.includes(d)).map((d) => tilde(d, o.home))
      if (placed.length > 0) yield* item(`${s.green("✓")} ${"skill".padEnd(width2)}${placed.join(", ")}`)
      for (const d of blocked) yield* item(`${s.yellow("·")} ${"skill".padEnd(width2)}${tilde(d, o.home)} has a skill of yours named singularity; left it alone`)
    }
  }
  // WSL has agents of its own; the ones that run on Windows are set up from Windows.
  if (o.env.WSL_DISTRO_NAME !== undefined) {
    yield* say()
    yield* item(s.dim("This is WSL. For the agents you run on Windows, run this in PowerShell:"))
    yield* item(s.cyan(WINDOWS_INSTALL))
  }

  // 3. The command.
  yield* say(heading(s, 3, "The singularity command"))
  const bin = yield* writeLaunchers(home.root, process.execPath, COMMAND, process.platform)
  let newTerminal = false
  if (!o.path) {
    yield* item(`${s.green("✓")} ${tilde(bin, o.home)} ${s.dim("(not added to PATH)")}`)
  } else {
    const change = yield* addToPath(bin, { home: o.home, shell: o.env.SHELL, platform: process.platform, pathValue: o.env.PATH ?? o.env.Path })
    if (change.state === "already") yield* item(`${s.green("✓")} ${tilde(bin, o.home)}, on your PATH`)
    else if (change.state === "added") {
      newTerminal = true
      yield* item(`${s.green("✓")} ${tilde(bin, o.home)}, on your PATH in new terminals${change.file === undefined ? "" : s.dim(` (${tilde(change.file, o.home)})`)}`)
    } else yield* item(`${s.yellow("·")} ${tilde(bin, o.home)}: add it to your PATH to run ${s.cyan("singularity")} anywhere`)
  }

  // 4. Learning.
  yield* say(heading(s, 4, "Learning"))
  const prefs = yield* readLearn(home.root)
  if (claudeCommand === undefined) {
    yield* item("Memory learns from Claude Code sessions, with Claude Code's model calls.")
    yield* item(`Install Claude Code, then run ${s.cyan("singularity setup")} again to turn learning on.`)
    return yield* done(s, o, chosen, bin, newTerminal)
  }
  for (const line of [
    "Memory keeps each change a Claude Code, Codex or Hermes Agent session commits",
    `with its checks passing, as it is committed. After every ${prefs.every} such changes in a`,
    `repo it can learn on its own, in the background: about ${usd(ROUND_USD)} a round on`,
    `your Claude account, up to a daily limit you choose.`
  ]) yield* item(line)
  if (asking) yield* say()
  const auto = yield* ask("Learn on its own?", (yield* learnIsSet(home.root)) ? prefs.auto : true)
  const limit = o.dailyLimit !== undefined
    ? Math.max(0, o.dailyLimit)
    : auto
    ? yield* askDollars("At most how many dollars a day?", prefs.max_usd_per_day, asking).pipe(Effect.orElseSucceed(() => prefs.max_usd_per_day))
    : prefs.max_usd_per_day
  yield* writeLearn({ ...prefs, auto, max_usd_per_day: limit }, home.root)
  yield* item(auto ? `${s.green("✓")} learning on its own, at most ${usd(limit)} a day` : `${s.dim("·")} learning when you run ${s.cyan("singularity learn")}`)

  const repo = yield* identifyRepo(o.cwd)
  const homes = sessionHomes(dirs, chosen.map((a) => a.id))
  const past = repo === undefined ? [] : yield* pastSessions(repo.root, homes).pipe(Effect.orElseSucceed(() => []))
  if (repo !== undefined && past.length > 0) {
    const name = path.basename(repo.root)
    yield* say()
    yield* item(`This repo, ${s.bold(name)}, has ${pastCount(past.map((p) => p.agent))}.`)
    const read = yield* withSpinner("reading them", storePast(repo.root, homes, home.tenantDir).pipe(Effect.provide(layers), Effect.result), o.interactive)
    if (read._tag === "Failure") {
      yield* item(`${s.red("✗")} couldn't read them (${read.failure.message}); ${s.cyan("singularity learn --past")} tries again`)
      return yield* done(s, o, chosen, bin, newTerminal)
    }
    const n = read.success.stored.length + read.success.existing.length
    if (n === 0) {
      yield* item(`${s.dim("·")} they committed no change with passing checks; memory learns as you work`)
    } else {
      yield* item(`${s.green("✓")} ${n === 1 ? "one change" : `${n} changes`} they committed with passing checks`)
      const { subject, price } = yield* Effect.gen(function*() {
        const subject = yield* (yield* RecordStore).subjectFor(repo)
        return { subject, price: subject === undefined ? 0 : roundUsd(yield* learnState(subject.id)) }
      }).pipe(Effect.provide(layers))
      if (subject !== undefined && !o.yes) {
        const go = yield* ask(`Learn from ${n === 1 ? "it" : `those ${n}`} now? About ${usd(price)}.`, true)
        if (go && !takeLock(home.root)) {
          yield* item(`${s.dim("·")} a learning round is running now; run ${s.cyan("singularity learn")} when it's done`)
        } else if (go) {
          markLock(home.root, subject.id)
          const learned = yield* withSpinner(
            "learning (a minute or two)",
            learnSubject(subject, {
              claude: claudeCommand,
              cwd: path.join(defaultWorkspaces(), "_learner"),
              model: DEFAULT_INDUCE_MODEL,
              effort: DEFAULT_INDUCE_EFFORT,
              every: prefs.every,
              now: true
            }).pipe(Effect.provide(layers), Effect.result, Effect.ensuring(Effect.sync(() => releaseLearning(home.root)))),
            o.interactive
          )
          if (learned._tag === "Success") for (const line of describeOutcome(s, learned.success)) yield* item(line)
          else yield* item(`${s.red("✗")} learning failed (${learned.failure.message}); try ${s.cyan("singularity learn")} later`)
        }
      } else if (n > 0) {
        yield* item(`${s.dim("·")} run ${s.cyan("singularity learn")} in this repo to learn from ${n === 1 ? "it" : "them"}`)
      }
    }
  } else if (repo === undefined) {
    yield* say()
    yield* item(s.dim(`In a repo with past Claude Code sessions, ${"`singularity learn --past`"} starts memory from them.`))
  }

  return yield* done(s, o, chosen, bin, newTerminal)
})

/** The end of setup: what happens now, and the commands to know. */
const done = Effect.fnUntraced(function*(s: Style, o: SetupOptions, chosen: ReadonlyArray<Agent>, bin: string, newTerminal: boolean) {
  const say = (line = "") => Console.log(line)
  const item = (line: string) => Console.log(`     ${line}`)
  yield* say()
  yield* say(`  ${s.green("✓")} ${s.bold("All set.")}`)
  yield* say()
  yield* item("Start a task in a repo memory knows: the agent gets what earlier")
  yield* item("sessions learned there with your first prompt.")
  yield* say()
  const commands: ReadonlyArray<readonly [string, string]> = [
    ["singularity status", "what memory knows, repo by repo"],
    ["singularity recall \"<task>\"", "what a task would be handed"],
    ["singularity learn", "learn from new changes now"],
    ["singularity uninstall", "take it all out (memory stays)"]
  ]
  const w = Math.max(...commands.map(([c]) => c.length)) + 3
  for (const [c, what] of commands) yield* item(`${s.cyan(c.padEnd(w))}${s.dim(what)}`)
  if (newTerminal) {
    yield* say()
    yield* item(s.dim(`Open a new terminal for the ${"`singularity`"} command (or run ${tilde(bin, o.home)}/singularity).`))
  }
  if (chosen.length > 0) yield* item(s.dim("Agents running now get memory from their next start."))
  yield* say()
  return true
})
