/**
 * Daily use of local memory, for anyone:
 *
 *     singularity setup [--yes] [--agent ID ...] [--no-path]   set memory up in this machine's coding agents
 *     singularity status                                       what memory knows, and where it is set up
 *     singularity recall TASK...                               what a task here would be handed
 *     singularity learn [--past] [--all] [--dry-run]           learn from recorded sessions now
 *     singularity uninstall [--purge]                          take memory out of every agent
 *
 * `learn --auto --subject ID` is the background round the session-end hook
 * starts (src/setup/AutoLearn.ts).
 */
import { Console, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { homedir } from "node:os"
import { defaultClaude } from "../eval/Agent.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import type { Subject } from "../records/Subjects.ts"
import { AGENT_IDS, type AgentDirs, sessionHomes } from "../setup/Agents.ts"
import { releaseLock, takeLock } from "../setup/AutoLearn.ts"
import { binDir, removeFromPath, removeLaunchers } from "../setup/Launcher.ts"
import { readLearn } from "../setup/Preferences.ts"
import { describeOutcome, runSetup } from "../setup/Setup.ts"
import { runStatus } from "../setup/Status.ts"
import { confirm, makeStyle, plural, tilde, usd, wantsColor, withSpinner } from "../setup/Ui.ts"
import { unwireAll } from "../setup/Wiring.ts"
import { backfill } from "../workflows/Backfill.ts"
import { DEFAULT_INDUCE_EFFORT, DEFAULT_INDUCE_MODEL } from "../workflows/Induce.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { estimateUsd, learnState, learnSubject, spentToday, waitReason } from "../workflows/Learn.ts"
import { startTask } from "../workflows/Start.ts"
import { homeFlag } from "./Common.ts"

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true

const storesOf = (home: Home, path: Path.Path) =>
  Layer.merge(
    JsonRecordStore.layer(home.tenantDir, home.tenant),
    JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
  )

const dirsOf = (): AgentDirs => ({ home: homedir(), env: process.env })

const setup = Command.make(
  "setup",
  {
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false), Flag.withDescription("take every default and ask nothing (never learns right away)")),
    agent: Flag.Literals("agent", AGENT_IDS).pipe(Flag.atLeast(0), Flag.withDescription("only this agent (repeatable; default: every agent found)")),
    noPath: Flag.Boolean("no-path").pipe(Flag.withDefault(false), Flag.withDescription("don't put the singularity command on PATH"))
  },
  Effect.fn(function*(args) {
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
).pipe(Command.withDescription("set memory up in this machine's coding agents: hooks, skill, the singularity command, learning"))

const status = Command.make(
  "status",
  { home: homeFlag },
  Effect.fn(function*(args) {
    yield* runStatus({ home: homedir(), env: process.env, cwd: process.cwd(), color: wantsColor(), memoryHome: Option.getOrUndefined(args.home) })
  })
).pipe(Command.withDescription("which agents have memory, what it knows in each repo, and how learning goes"))

const recall = Command.make(
  "recall",
  {
    task: Argument.String("task").pipe(Argument.atLeast(1), Argument.withDescription("the task, as it was asked")),
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("the repo (default: here)")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const cwd = path.resolve(Option.getOrElse(args.cwd, () => process.cwd()))
    const result = yield* startTask(
      { sessionId: "recall", prompt: args.task.join(" "), cwd },
      { tenantDir: home.tenantDir, cues: true, persist: false, parts: 1 }
    ).pipe(Effect.provide(storesOf(home, path)))
    if (result.text !== undefined) return yield* Console.log(result.text)
    const repo = yield* identifyRepo(cwd)
    yield* Console.log(
      repo === undefined
        ? `singularity: ${cwd} isn't in a git repository, so memory has nothing for it.`
        : `singularity: memory has nothing for this task in ${path.basename(repo.root)} yet.`
    )
  })
).pipe(Command.withDescription("print what memory would hand a task in this repo (no model call)"))

/** The background round the session-end hook starts: one subject, within the lock and the day's limit. */
const learnAuto = Effect.fn("learnAuto")(function*(home: Home, subjectId: string) {
  const path = yield* Path.Path
  const stamp = DateTime.formatIso(yield* DateTime.now)
  const log = (line: string) => Console.log(`${stamp} ${subjectId}: ${line}`)
  if (!takeLock(home.root)) return yield* log("another round is running")
  yield* Effect.gen(function*() {
    const prefs = yield* readLearn(home.root)
    const spent = yield* spentToday()
    if (spent >= prefs.max_usd_per_day) return yield* log(`today's limit is spent (${usd(spent)} of ${usd(prefs.max_usd_per_day)})`)
    const subject = (yield* (yield* RecordStore).subjects()).find((x) => x.id === subjectId)
    if (subject === undefined) return yield* log("no such repo in memory")
    const outcome = yield* learnSubject(subject, {
      claude: yield* defaultClaude(),
      cwd: path.join(defaultWorkspaces(), "_learner"),
      model: DEFAULT_INDUCE_MODEL,
      effort: DEFAULT_INDUCE_EFFORT,
      every: prefs.every
    })
    const s = makeStyle(false)
    for (const line of describeOutcome(s, outcome)) yield* log(line.trim())
  }).pipe(
    Effect.provide(storesOf(home, path)),
    Effect.catch((e) => log(`failed: ${"message" in e ? e.message : String(e)}`)),
    Effect.ensuring(Effect.sync(() => releaseLock(home.root)))
  )
})

const learn = Command.make(
  "learn",
  {
    past: Flag.Boolean("past").pipe(Flag.withDefault(false), Flag.withDescription("first record this repo's past Claude Code, Codex and Hermes Agent sessions (no model call)")),
    all: Flag.Boolean("all").pipe(Flag.withDefault(false), Flag.withDescription("every repo memory has new sessions for, not only this one")),
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("the repo (default: here)")),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("say what would be learned, and what it would cost, and stop")),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false), Flag.withDescription("don't ask before spending")),
    auto: Flag.Boolean("auto").pipe(Flag.withDefault(false), Flag.withDescription("the background round after a session (with --subject)")),
    subject: Flag.String("subject").pipe(Flag.optional, Flag.withDescription("with --auto: the repo's subject id")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    if (args.auto) {
      if (Option.isNone(args.subject)) return yield* Console.error("learn --auto needs --subject")
      return yield* learnAuto(home, args.subject.value)
    }
    const s = makeStyle(wantsColor())
    const say = (line: string) => Console.log(`  ${line}`)
    const stores = storesOf(home, path)
    const cwd = path.resolve(Option.getOrElse(args.repo, () => process.cwd()))
    const repo = yield* identifyRepo(cwd)

    if (args.past) {
      if (repo === undefined) return yield* say(`${cwd} isn't in a git repository.`)
      const result = yield* withSpinner(`reading past sessions in ${path.basename(repo.root)}`, backfill(repo.root, sessionHomes(dirsOf()), home.tenantDir), interactive()).pipe(Effect.provide(stores))
      const skipped = [...result.skipped].map(([reason, n]) => `${n} ${reason}`).join("; ")
      yield* say(`${plural(result.sessions, "past session")}: ${result.recorded.length} recorded${skipped === "" ? "" : s.dim(` (${skipped})`)}`)
    }

    const subjects: ReadonlyArray<Subject> = yield* Effect.gen(function*() {
      const store = yield* RecordStore
      if (args.all) return yield* store.subjects()
      if (repo === undefined) return []
      const subject = yield* store.subjectFor(repo)
      return subject === undefined ? [] : [subject]
    }).pipe(Effect.provide(stores))
    if (subjects.length === 0) {
      return yield* say(repo === undefined && !args.all
        ? `${cwd} isn't in a git repository; pass --repo, or --all for every repo memory knows.`
        : "No sessions recorded here yet. Memory records Claude Code, Codex and Hermes Agent sessions that commit a change with passing tests; --past looks through earlier ones.")
    }
    const prefs = yield* readLearn(home.root)
    let spent = 0
    for (const subject of subjects) {
      const state = yield* learnState(subject.id).pipe(Effect.provide(stores))
      const waiting = waitReason(state, prefs.every, true)
      if (waiting !== undefined) {
        yield* say(`${s.dim("·")} ${subject.name}: not yet, ${waiting}`)
        continue
      }
      const sessions = state.memory.workflows.length === 0 ? state.records.length : state.unlearned.length
      const estimate = estimateUsd(sessions)
      const what = state.memory.workflows.length === 0 ? "a first memory" : "a learning round"
      if (args.dryRun) {
        yield* say(`${subject.name}: ${what} from ${plural(sessions, "session")}, about ${usd(estimate)}`)
        continue
      }
      const go = yield* confirm(`${subject.name}: ${what} from ${plural(sessions, "session")}, about ${usd(estimate)}. Go ahead?`, true, interactive() && !args.yes).pipe(Effect.orElseSucceed(() => false))
      if (!go) continue
      const claude = Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude()
      const outcome = yield* withSpinner(
        `learning ${subject.name} (a minute or two)`,
        learnSubject(subject, {
          claude,
          cwd: path.join(defaultWorkspaces(), "_learner"),
          model: DEFAULT_INDUCE_MODEL,
          effort: DEFAULT_INDUCE_EFFORT,
          every: prefs.every,
          now: true
        }).pipe(Effect.provide(stores)),
        interactive()
      )
      spent += outcome.costUsd
      yield* say(`${s.bold(subject.name)}`)
      for (const line of describeOutcome(s, outcome)) yield* say(`  ${line}`)
    }
    if (spent > 0) yield* say(s.dim(`spent ${usd(spent)} in all`))
  })
).pipe(Command.withDescription("learn from recorded sessions now: a first memory for a repo, or a learning round"))

const uninstall = Command.make(
  "uninstall",
  {
    purge: Flag.Boolean("purge").pipe(Flag.withDefault(false), Flag.withDescription("also delete the memory home: records, workflows and the installed code")),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false), Flag.withDescription("don't ask before deleting memory"))
  },
  Effect.fn(function*(args) {
    const fs = yield* FileSystem.FileSystem
    const s = makeStyle(wantsColor())
    const say = (line: string) => Console.log(`  ${line}`)
    const home = yield* loadHome()
    const user = homedir()
    const removed = yield* unwireAll(dirsOf())
    for (const f of removed.hookFiles) yield* say(`${s.green("✓")} hooks taken out of ${tilde(f, user)}`)
    for (const d of removed.plugins) yield* say(`${s.green("✓")} plugin ${tilde(d, user)} removed`)
    for (const d of removed.skillDirs) yield* say(`${s.green("✓")} skill taken out of ${tilde(d, user)}`)
    const bin = binDir(home.root)
    if (yield* removeFromPath(bin, { home: user, platform: process.platform })) yield* say(`${s.green("✓")} ${tilde(bin, user)} taken off your PATH`)
    yield* removeLaunchers(home.root)
    yield* say(`${s.green("✓")} the singularity command removed`)
    if (!args.purge) {
      return yield* say(s.dim(`Memory stays in ${tilde(home.root, user)}; \`singularity uninstall --purge\` deletes it too.`))
    }
    const sure = args.yes || (yield* confirm(`Delete ${tilde(home.root, user)}: every record and workflow memory has?`, false, interactive()).pipe(Effect.orElseSucceed(() => false)))
    if (!sure) return yield* say(s.dim(`Memory kept in ${tilde(home.root, user)}.`))
    yield* fs.remove(home.root, { recursive: true, force: true })
    yield* say(`${s.green("✓")} ${tilde(home.root, user)} deleted`)
  })
).pipe(Command.withDescription("take memory out of every agent and remove the singularity command (memory stays unless --purge)"))

export const setupCommands = [setup, status, recall, learn, uninstall] as const
