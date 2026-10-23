/**
 * `singularity setup`: everything local memory needs, in one go, saying what
 * each step means as it happens, in the layout of Ui.ts.
 *
 *   1. The machine: only what is missing (git).
 *   2. Your agents: memory's hooks where the agent has them, the skill
 *      everywhere, and the recall note in the instruction file of the
 *      agents whose file is known (Agents.ts says what each agent gets).
 *   3. The `singularity` command, on PATH for new terminals (said at the end).
 *   4. This repo: in a repo with past sessions, the changes they committed.
 *
 * Running it again updates everything in place. `--yes` takes every default
 * and asks nothing. There is no learning step; in Claude Code a model may
 * pick the past change at a task's start, the person says which (`askPicks`).
 */
import { Console, Effect, FileSystem, Path } from "effect"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome, type Picks, savePath, savePicks } from "../local/Home.ts"
import { CLAUDE_MODELS, DEFAULT_MODEL } from "../scripts/Pick.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { storePast } from "../workflows/Commits.ts"
import { type PastSession, pastSessions } from "../workflows/Transcripts.ts"
import { type Agent, type AgentDirs, type AgentId, CODEX_TRUST_NOTE, type Reach, sessionHomes } from "./Agents.ts"
import { codexHooks, trustCodexHooks } from "./CodexHooks.ts"
import { addToPath, COMMAND, type PathChange, pathOffLimits, writeLaunchers } from "./Launcher.ts"
import { askChoice, askMany, askText, confirm, listWords, makeStyle, makeTree, marks, plural, type Style, tilde, title, TITLED_ENV, type Tree, withSpinner } from "./Ui.ts"
import { agentStates, detectAgents, findCommand, findExecutable, HOOK_SCRIPT, MIN_NODE_MAJOR, nodeForHooks, skillDirsFor, unwireHooks, unwireNote, versionOf, wireHooks, wireNote, wireSkills } from "./Wiring.ts"

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
}

export const INTRO = [
  "Coding agents start every session from zero. singularity remembers how",
  "tasks get done in your repos and hands that to the next agent."
]

/** The Windows installer, for WSL users whose agents run on Windows. */
export const WINDOWS_INSTALL = "irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex"

/** What memory does in an agent, by how far it reaches there. */
export const REACH: Record<Reach, string> = {
  "stores": "memory at task start, stores its changes",
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

/** The note under an agent: done ("✓ ...", said dimly) or still to do. */
const noteLine = (s: Style, note: string) => (note.startsWith("✓") ? s.dim(note.slice(1).trim()) : marks(s).warn(note))

export const runSetup = Effect.fn("runSetup")(function*(o: SetupOptions) {
  const s = makeStyle(o.color)
  const M = marks(s)
  const T = makeTree(s)
  const path = yield* Path.Path
  const say = (line = "") => Console.log(line)
  const asking = o.interactive && !o.yes

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
  const layers = JsonRecordStore.layer(home.tenantDir, home.tenant)

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
    for (const a of leftOut) {
      yield* unwireHooks(a)
      yield* unwireNote(a)
    }
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
      yield* noteLines(s, T, chosen, o.home)
    }
    if (chosen.some((a) => a.id === "claude")) {
      if (asking) yield* T.pause
      yield* picksLine(s, T, yield* askPicks(home, asking))
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
  const onPath: PathChange | undefined = o.path && !pathOffLimits(o.env)
    ? yield* addToPath(bin, { home: o.home, shell: o.env.SHELL, platform: process.platform, pathValue: o.env.PATH ?? o.env.Path })
    : undefined
  // Update keeps the command on PATH unless the person said --no-path here.
  yield* savePath(home, o.path)
  const end = () => done(s, T, o, chosen, bin, onPath)

  // 4. This repo's past sessions.
  const repo = yield* identifyRepo(o.cwd)
  const homes = sessionHomes(dirs, chosen.map((a) => a.id))
  const past = repo === undefined ? [] : yield* pastSessions(repo.root, homes).pipe(Effect.orElseSucceed(() => []))
  if (repo === undefined || past.length === 0) return yield* end()
  yield* T.section(`This repo  ${s.dim(path.basename(repo.root))}`)
  const read = yield* withSpinner(`reading ${pastCount(past.map((p) => p.agent))}`, storePast(repo.root, homes, home.tenantDir).pipe(Effect.provide(layers), Effect.result), o.interactive)
  if (read._tag === "Failure") {
    yield* T.item(M.fail(`couldn't read its past sessions (${read.failure.message}); ${s.cyan("singularity store")} tries again`))
    return yield* end()
  }
  const n = read.success.stored.length + read.success.existing.length
  if (n === 0) {
    yield* T.item(M.skip(`its ${pastCount(past.map((p) => p.agent))} committed no change; memory stores changes as you work`))
    return yield* end()
  }
  yield* T.item(M.ok(`${n === 1 ? "one change" : `${n} changes`} committed`, `from ${pastCount(past.map((p) => p.agent))}`))
  return yield* end()
})

/**
 * Put the recall note in the chosen agents' instruction files, and say where:
 * how an agent knows it can run `singularity recall` mid-task.
 */
export const noteLines = Effect.fnUntraced(function*(s: Style, T: Tree, chosen: ReadonlyArray<Agent>, home: string) {
  const M = marks(s)
  const files: Array<string> = []
  for (const a of chosen) {
    const wired = yield* wireNote(a)
    if (wired.problem !== undefined) yield* T.item(M.warn(`recall note not added: ${wired.problem}`))
    else if (wired.file !== undefined && !files.includes(wired.file)) files.push(wired.file)
  }
  if (files.length > 0) yield* T.item(M.ok("recall note", `in ${files.map((f) => tilde(f, home)).join(", ")}`))
})

/**
 * Who picks the past change at a task's start in Claude Code (local/Home.ts
 * `Picks`): one of Claude's models, the cheapest suggested, or memory's word
 * search. Asked each time setup runs, the answer before as the default (the
 * cheapest model the first time), and saved in config.json.
 */
export const askPicks = Effect.fnUntraced(function*(home: Home, asking: boolean) {
  const words = "words" as const
  const OTHER = "(another model)"
  const initial = home.picks === null && (yield* configHasPicks(home)) ? words : home.picks?.model ?? DEFAULT_MODEL
  const known = CLAUDE_MODELS.some((m) => m.model === initial) || initial === words
  const choice = yield* askChoice(
    "Let a model pick the past change at each task start? It reads the task the way you meant it, in the background.",
    [
      ...CLAUDE_MODELS.map((m) => ({ title: `Yes, ${m.title}`, description: m.description, value: m.model as string })),
      ...(known ? [] : [{ title: `Yes, ${initial}`, description: "the model you chose before", value: initial }]),
      { title: "Yes, another model", description: "type its name, as claude --model takes it", value: OTHER as string },
      { title: "No, match by words", description: "free, but misses tasks put in other words", value: words as string }
    ],
    initial,
    asking
  )
  const model = choice === OTHER ? yield* askText("Which model?", known ? DEFAULT_MODEL : initial, asking) : choice
  const picks: Picks | null = model === words ? null : { agent: "claude", model: model === "" ? DEFAULT_MODEL : model }
  yield* savePicks(home, picks)
  return picks
})

/** Whether config.json says who picks, a choice of words included (`"picks": null`), or setup never asked. */
const configHasPicks = Effect.fnUntraced(function*(home: Home) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(path.join(home.root, "config.json")).pipe(Effect.orElseSucceed(() => ""))
  return /"picks"\s*:/.test(text)
})

/** The line under the agents saying who picks. */
const picksLine = (s: Style, T: Tree, picks: Picks | null) => {
  const M = marks(s)
  const model = CLAUDE_MODELS.find((m) => m.model === picks?.model)?.title ?? picks?.model
  return picks === null
    ? T.item(M.skip("word search picks the past change at a task's start"))
    : T.item(M.ok(`${model} picks the past change`, "at a task's start in Claude Code, in the background"))
}

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
  onPath: PathChange | undefined
) {
  const M = marks(s)
  const ready = chosen.length > 0
  yield* T.head(`${ready ? s.green("✓") : s.yellow("!")} ${s.bold(ready ? "Ready" : "Not set up in any agent")}${ready ? `  ${s.dim("agents running now get memory from their next start")}` : ""}`)
  if (onPath === undefined) yield* T.item(s.dim(`the singularity command is ${tilde(bin, o.home)}/singularity`))
  else if (onPath.state === "added") yield* T.item(s.dim("open a new terminal for the singularity command"))
  else if (onPath.state === "failed") yield* T.item(M.warn(`add ${tilde(bin, o.home)} to your PATH to run singularity anywhere`))
  yield* T.section("Commands")
  const commands: ReadonlyArray<readonly [string, string]> = [
    ["singularity status", "what memory knows, repo by repo"],
    ["singularity visualise", "what it stored here, drawn"],
    ["singularity recall \"<what>\"", "the past change most like it"],
    ["singularity store", "store what past sessions here committed"],
    ["singularity update", "get the latest version"],
    ["singularity uninstall", "take it all out (memory stays)"]
  ]
  const w = Math.max(...commands.map(([c]) => c.length)) + 3
  for (const [c, what] of commands) yield* T.item(`${s.cyan(c.padEnd(w))}${s.dim(what)}`)
  yield* T.close
  yield* Console.log("")
  return true
})
