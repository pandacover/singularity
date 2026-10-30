/**
 * Daily use of local memory, for anyone:
 *
 *     singularity setup [--yes] [--agent ID ...] [--no-path]   set memory up in this machine's coding agents
 *     singularity setup computer-use [--no-claude-desktop]      set computer-use memory up, apart (src/computer/Setup.ts)
 *     singularity status [--json]                              what memory knows, and where it is set up
 *     singularity changes [COMMIT] [--json]                    what memory stored in this repo, or one change in full
 *     singularity visualise [--repo NAME] [--json]             what memory stored, drawn: calendar, latest changes, folders, checks
 *     singularity recall TASK... [--json]                      the past change most like a task here (mid-task too)
 *     singularity store [--repo DIR]                           store what this repo's past sessions committed
 *     singularity update [--no-fetch] [--branch B]             the latest code, and setup brought up to date with it
 *     singularity uninstall [computer-use] [--purge]           take memory out of every agent, or computer use alone
 *
 * Memory is saved scripts (src/scripts/): the changes sessions committed,
 * one picked at task start (or at a file's first edit, or a commit read in
 * git: src/scripts/Hook.ts), and any time an agent runs `recall` (the recall
 * note setup writes tells it so, src/setup/Instructions.ts). There is no
 * learning step and no model call.
 */
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { homedir } from "node:os"
import { identifyRepo } from "../local/Git.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { addGiven, givenPath } from "../scripts/History.ts"
import { startScripts } from "../scripts/Start.ts"
import { AGENT_IDS, type AgentDirs, sessionHomes } from "../setup/Agents.ts"
import { binDir, removeFromPath, removeLaunchers } from "../setup/Launcher.ts"
import { runSetup } from "../setup/Setup.ts"
import { runChanges } from "../setup/Changes.ts"
import { runVisualise } from "../setup/Visualise.ts"
import { runStatus } from "../setup/Status.ts"
import { runRefresh, runUpdate } from "../setup/Update.ts"
import { confirm, makeStyle, plural, tilde, wantsColor, withSpinner } from "../setup/Ui.ts"
import { unwireAll } from "../setup/Wiring.ts"
import { storePast } from "../workflows/Commits.ts"
import { safeId } from "../workflows/Session.ts"
import { runComputerSetup, unwireComputerUse } from "../computer/Setup.ts"
import { homeFlag } from "./Common.ts"

/** A recall asked for in a folder that isn't there. */
export class RecallError extends Schema.TaggedError<RecallError>()("RecallError", {
  message: Schema.String
}) {}

const jsonFlag = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("print it as JSON, for agents and scripts"))

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true

const dirsOf = (): AgentDirs => ({ home: homedir(), env: process.env })

/** The part of memory a command is about, when it isn't coding memory: computer use. */
const part = Argument.Literals("part", ["computer-use"] as const).pipe(
  Argument.optional,
  Argument.withDescription("computer-use: memory for agents that drive a browser, set up or taken out on its own")
)

const setup = Command.make(
  "setup",
  {
    part,
    noClaudeDesktop: Flag.Boolean("no-claude-desktop").pipe(Flag.withDefault(false), Flag.withDescription("computer use: leave Claude desktop's config alone")),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false), Flag.withDescription("take every default and ask nothing")),
    agent: Flag.Literals("agent", AGENT_IDS).pipe(Flag.atLeast(0), Flag.withDescription("only this agent (repeatable; default: every agent found)")),
    noPath: Flag.Boolean("no-path").pipe(Flag.withDefault(false), Flag.withDescription("don't put the singularity command on PATH"))
  },
  Effect.fn(function*(args) {
    if (Option.isSome(args.part)) {
      const done = yield* runComputerSetup({ dirs: dirsOf(), yes: args.yes, desktop: !args.noClaudeDesktop, interactive: interactive() && !args.yes, color: wantsColor() })
      if (!done) process.exitCode = 1
      return
    }
    const ok = yield* runSetup({
      yes: args.yes,
      only: args.agent,
      path: !args.noPath,
      cwd: process.cwd(),
      home: homedir(),
      env: process.env,
      interactive: interactive() && !args.yes,
      color: wantsColor()
    })
    if (!ok) process.exitCode = 1
  })
).pipe(Command.withDescription("set memory up in this machine's coding agents: hooks, skill, recall note, the singularity command; `setup computer-use` sets up memory for browser agents, apart"))

const status = Command.make(
  "status",
  { home: homeFlag, json: jsonFlag },
  Effect.fn(function*(args) {
    yield* runStatus({ home: homedir(), env: process.env, cwd: process.cwd(), color: wantsColor(), json: args.json, memoryHome: Option.getOrUndefined(args.home) })
  })
).pipe(Command.withDescription("which agents have memory, and what it stored in each repo"))

const changes = Command.make(
  "changes",
  {
    change: Argument.String("commit").pipe(Argument.optional, Argument.withDescription("one change to print in full: its commit (4 characters or more) or record id")),
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("the repo: a name status shows, or a folder in it (default: here)")),
    home: homeFlag,
    json: jsonFlag
  },
  Effect.fn(function*(args) {
    yield* runChanges({
      cwd: process.cwd(),
      change: Option.getOrUndefined(args.change),
      repo: Option.getOrUndefined(args.repo),
      memoryHome: Option.getOrUndefined(args.home),
      color: wantsColor(),
      json: args.json
    })
  })
).pipe(Command.withDescription("list the changes memory stored in this repo, newest first, or print one as an agent would read it"))

const visualise = Command.make(
  "visualise",
  {
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("the repo: a name status shows, or a folder in it (default: here; every repo when memory knows none here)")),
    home: homeFlag,
    json: jsonFlag
  },
  Effect.fn(function*(args) {
    yield* runVisualise({
      cwd: process.cwd(),
      repo: Option.getOrUndefined(args.repo),
      memoryHome: Option.getOrUndefined(args.home),
      color: wantsColor(),
      json: args.json,
      width: process.stdout.columns ?? (Number(process.env.COLUMNS) || 80)
    })
  })
).pipe(Command.withDescription("draw what memory stored in this repo: when changes were committed, the latest, the folders it knows, checks, hand-overs"))

const recall = Command.make(
  "recall",
  {
    task: Argument.String("task").pipe(Argument.atLeast(1), Argument.withDescription("the task, or what you are about to do mid-task")),
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("the repo (default: here)")),
    home: homeFlag,
    json: jsonFlag
  },
  Effect.fn(function*(args) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const cwd = path.resolve(Option.getOrElse(args.cwd, () => process.cwd()))
    const info = yield* fs.stat(cwd).pipe(Effect.option)
    if (Option.isNone(info) || info.value.type !== "Directory") {
      return yield* new RecallError({ message: `${cwd} ${Option.isNone(info) ? "doesn't exist" : "isn't a directory"}` })
    }
    const result = yield* startScripts(
      { sessionId: "recall", prompt: args.task.join(" "), cwd },
      { tenantDir: home.tenantDir, persist: false, query: true }
    ).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
    // An agent's session (Claude Code tells its commands which) now has this change: reading its commit in git
    // next (`recall "…"; git show HEAD~1`) brings nothing more (scripts/History.ts).
    const session = process.env.CLAUDE_CODE_SESSION_ID
    if (result.picked !== null && session !== undefined && session !== "") addGiven(givenPath(home.tenantDir, safeId(session)), result.picked.commit)
    const repo = yield* identifyRepo(cwd)
    if (args.json) {
      return yield* Console.log(JSON.stringify(
        {
          repo: repo === undefined ? null : { name: path.basename(repo.root), root: repo.root },
          handed_over: result.text !== undefined,
          text: result.text ?? null,
          picked: result.picked,
          score: result.score
        },
        null,
        2
      ))
    }
    if (result.text !== undefined) return yield* Console.log(result.text)
    yield* Console.log(
      repo === undefined
        ? `singularity: ${cwd} isn't in a git repository, so memory has nothing for it.`
        : `singularity: memory has nothing for this task in ${path.basename(repo.root)} yet.`
    )
  })
).pipe(Command.withDescription("print the past change in this repo most like a task, or say there is none (no model call)"))

const store = Command.make(
  "store",
  {
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("the repo (default: here)")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const s = makeStyle(wantsColor())
    const say = (line: string) => Console.log(`  ${line}`)
    const cwd = path.resolve(Option.getOrElse(args.repo, () => process.cwd()))
    const repo = yield* identifyRepo(cwd)
    if (repo === undefined) return yield* say(`${cwd} isn't in a git repository.`)
    const result = yield* withSpinner(`reading past sessions in ${path.basename(repo.root)}`, storePast(repo.root, sessionHomes(dirsOf()), home.tenantDir), interactive()).pipe(
      Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant))
    )
    const skipped = [...result.skipped].map(([reason, n]) => `${n} ${reason}`).join("; ")
    const kept = result.stored.length + result.existing.length
    yield* say(`${plural(result.sessions, "past session")}, ${plural(result.examined + result.existing.length, "commit")}: ${plural(kept, "change")} kept${skipped === "" ? "" : s.dim(` (left out: ${skipped})`)}`)
  })
).pipe(Command.withDescription("store the changes this repo's past Claude Code, Codex and Hermes Agent sessions committed (no model call)"))

const update = Command.make(
  "update",
  {
    noFetch: Flag.Boolean("no-fetch").pipe(Flag.withDefault(false), Flag.withDescription("don't fetch: bring what setup put in place up to date with the code installed now")),
    branch: Flag.String("branch").pipe(
      Flag.optional,
      Flag.withDescription("put the installed code on this branch, to try it for real; later updates stay on it, and --branch main goes back")
    )
  },
  Effect.fn(function*(args) {
    const branch = Option.getOrUndefined(args.branch)
    if (branch !== undefined && args.noFetch) {
      yield* Console.error("update: --branch fetches that branch, so it doesn't go with --no-fetch.")
      process.exitCode = 2
      return
    }
    const options = { home: homedir(), env: process.env, interactive: interactive(), color: wantsColor(), branch }
    const ok = yield* (args.noFetch ? runRefresh(options) : runUpdate(options))
    if (!ok) process.exitCode = 1
  })
).pipe(Command.withDescription("update singularity to the latest code and bring its hooks, skill, recall note and command up to date, asking nothing setup asked"))

const uninstall = Command.make(
  "uninstall",
  {
    part,
    purge: Flag.Boolean("purge").pipe(Flag.withDefault(false), Flag.withDescription("also delete the memory home: records and the installed code")),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false), Flag.withDescription("don't ask before deleting memory"))
  },
  Effect.fn(function*(args) {
    const fs = yield* FileSystem.FileSystem
    const s = makeStyle(wantsColor())
    const say = (line: string) => Console.log(`  ${line}`)
    const home = yield* loadHome()
    const user = homedir()
    // Computer use: its hooks and Claude desktop's server, alone or with everything else.
    const computer = yield* unwireComputerUse(dirsOf(), home)
    for (const f of computer.changed) yield* say(`${s.green("✓")} computer use taken out of ${tilde(f, user)}`)
    if (computer.desktopRunning) yield* say(`${s.yellow("!")} Claude desktop is open, so its server stays registered: quit it and run ${s.cyan("singularity uninstall computer-use")} again`)
    if (Option.isSome(args.part)) {
      if (computer.changed.length === 0 && !computer.desktopRunning) yield* say(s.dim("Computer use wasn't set up."))
      return yield* say(s.dim(`What it stored stays in ${tilde(home.root, user)}; coding memory is untouched.`))
    }
    const removed = yield* unwireAll(dirsOf())
    for (const f of removed.hookFiles) yield* say(`${s.green("✓")} hooks taken out of ${tilde(f, user)}`)
    for (const d of removed.plugins) yield* say(`${s.green("✓")} plugin ${tilde(d, user)} removed`)
    for (const d of removed.skillDirs) yield* say(`${s.green("✓")} skill taken out of ${tilde(d, user)}`)
    for (const f of removed.noteFiles) yield* say(`${s.green("✓")} recall note taken out of ${tilde(f, user)}`)
    const bin = binDir(home.root)
    if (yield* removeFromPath(bin, { home: user, platform: process.platform })) yield* say(`${s.green("✓")} ${tilde(bin, user)} taken off your PATH`)
    yield* removeLaunchers(home.root)
    yield* say(`${s.green("✓")} the singularity command removed`)
    if (!args.purge) {
      return yield* say(s.dim(`Memory stays in ${tilde(home.root, user)}; \`singularity uninstall --purge\` deletes it too.`))
    }
    const sure = args.yes || (yield* confirm(`Delete ${tilde(home.root, user)}: every change memory stored?`, false, interactive()).pipe(Effect.orElseSucceed(() => false)))
    if (!sure) return yield* say(s.dim(`Memory kept in ${tilde(home.root, user)}.`))
    yield* fs.remove(home.root, { recursive: true, force: true })
    yield* say(`${s.green("✓")} ${tilde(home.root, user)} deleted`)
  })
).pipe(Command.withDescription("take memory out of every agent and remove the singularity command (memory stays unless --purge); `uninstall computer-use` takes out computer use alone"))

export const setupCommands = [setup, status, changes, visualise, recall, store, update, uninstall] as const
