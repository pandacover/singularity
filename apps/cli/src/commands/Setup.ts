/**
 * Daily use of local memory, for anyone:
 *
 *     singularity setup [--yes] [--agent ID ...] [--learn-with ID] [--learn-model M] [--no-path]   set memory up in this machine's coding agents
 *     singularity status                                       what memory knows, and where it is set up
 *     singularity recall TASK...                               what a task here would be handed
 *     singularity learn [--past] [--all] [--with ID] [--dry-run]   learn from the changes stored now
 *     singularity uninstall [--purge]                          take memory out of every agent
 *
 * `learn --auto` is the background rounds storing changes asks for, one
 * repo at a time from a queue (src/setup/AutoLearn.ts).
 */
import { Console, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { homedir } from "node:os"
import { claudeCli, MODEL_AGENTS } from "../eval/Llm.ts"
import { lowerPriority } from "../eval/Proc.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import type { Subject } from "../records/Subjects.ts"
import { AGENT_IDS, type AgentDirs, sessionHomes } from "../setup/Agents.ts"
import { learningQueue, lockInfo, markLock, queueLearning, releaseLearning, releaseLock, takeLock, unqueueLearning } from "../setup/Background.ts"
import { binDir, removeFromPath, removeLaunchers } from "../setup/Launcher.ts"
import { LEARNER_NAMES, learnerConfig, LearnerError, resolveLearner, withModelHint } from "../setup/Learner.ts"
import { modelFor, readLearn } from "../setup/Preferences.ts"
import { describeOutcome, runSetup } from "../setup/Setup.ts"
import { runStatus } from "../setup/Status.ts"
import { confirm, makeStyle, plural, tilde, usd, wantsColor, withSpinner } from "../setup/Ui.ts"
import { unwireAll } from "../setup/Wiring.ts"
import { storePast } from "../workflows/Commits.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { budgetReason, learnState, learnSubject, roundUsd, spentToday, waitReason } from "../workflows/Learn.ts"
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
    noPath: Flag.Boolean("no-path").pipe(Flag.withDefault(false), Flag.withDescription("don't put the singularity command on PATH")),
    dailyLimit: Flag.Finite("daily-limit").pipe(Flag.optional, Flag.withDescription("the most learning on its own may spend a day, in dollars (default: asked, or $1)")),
    learnWith: Flag.Literals("learn-with", MODEL_AGENTS).pipe(Flag.optional, Flag.withDescription("the agent whose model learns, on your account with it (default: asked when there are several)")),
    learnModel: Flag.String("learn-model").pipe(Flag.optional, Flag.withDescription("the model it learns with, for Codex or Hermes Agent (default: the one it is set to use, checked)"))
  },
  Effect.fn(function*(args) {
    const ok = yield* runSetup({
      dailyLimit: Option.getOrUndefined(args.dailyLimit),
      learnWith: Option.getOrUndefined(args.learnWith),
      learnModel: Option.getOrUndefined(args.learnModel),
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

/**
 * One queued round, in the background: checked again when its turn comes, so
 * that changes the round before it read aren't read twice, and started only
 * when what the day's limit leaves covers it.
 */
const learnQueued = Effect.fn("learnQueued")(function*(home: Home, subjectId: string) {
  const path = yield* Path.Path
  const stamp = DateTime.formatIso(yield* DateTime.now)
  const log = (line: string) => Console.log(`${stamp} ${subjectId}: ${line}`)
  yield* Effect.gen(function*() {
    const prefs = yield* readLearn(home.root)
    const subject = (yield* (yield* RecordStore).subjects()).find((x) => x.id === subjectId)
    if (subject === undefined) return yield* log("no such repo in memory")
    const state = yield* learnState(subjectId)
    const waiting = waitReason(state, prefs.every, false)
    if (waiting !== undefined) return yield* log(`skipped: ${waiting}`)
    const short = budgetReason(roundUsd(state), yield* spentToday(), prefs.max_usd_per_day)
    if (short !== undefined) return yield* log(`waits: ${short}`)
    const learner = yield* resolveLearner(prefs.with, dirsOf())
    const outcome = yield* learnSubject(subject, { ...learnerConfig(learner, path.join(defaultWorkspaces(), "_learner"), modelFor(prefs, learner.agent)), every: prefs.every }).pipe(
      Effect.mapError((e) => new LearnerError({ message: withModelHint(e.message, learner.agent) }))
    )
    const s = makeStyle(false)
    for (const line of describeOutcome(s, outcome)) yield* log(line.trim())
  }).pipe(
    Effect.provide(storesOf(home, path)),
    Effect.catch((e) => log(`failed: ${"message" in e ? e.message : String(e)}`))
  )
})

/**
 * The background rounds storing changes asks for: the queue, one repo at a
 * time, by whichever run holds the lock. A round asked for just as the run
 * lets go starts here too.
 */
const learnAuto = Effect.fn("learnAuto")(function*(home: Home) {
  yield* lowerPriority
  while (learningQueue(home.root).length > 0 && takeLock(home.root)) {
    yield* Effect.gen(function*() {
      for (let next = learningQueue(home.root)[0]; next !== undefined; next = learningQueue(home.root)[0]) {
        unqueueLearning(home.root, next)
        markLock(home.root, next)
        yield* learnQueued(home, next)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => releaseLock(home.root))))
  }
})

const learn = Command.make(
  "learn",
  {
    past: Flag.Boolean("past").pipe(Flag.withDefault(false), Flag.withDescription("first store the changes this repo's past Claude Code, Codex and Hermes Agent sessions committed (no model call)")),
    all: Flag.Boolean("all").pipe(Flag.withDefault(false), Flag.withDescription("every repo memory has new changes for, not only this one")),
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("the repo (default: here)")),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("say what would be learned, and what it would cost, and stop")),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false), Flag.withDescription("don't ask before spending")),
    auto: Flag.Boolean("auto").pipe(Flag.withDefault(false), Flag.withDescription("the background rounds stored changes ask for: the queue, one repo at a time")),
    subject: Flag.String("subject").pipe(Flag.optional, Flag.withDescription("with --auto: queue this repo's subject id first")),
    with: Flag.Literals("with", MODEL_AGENTS).pipe(Flag.optional, Flag.withDescription("learn with this agent's model this time (default: the one chosen at setup)")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("learn with the claude executable at this path")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    if (args.auto) {
      if (Option.isSome(args.subject)) queueLearning(home.root, args.subject.value)
      return yield* learnAuto(home)
    }
    const s = makeStyle(wantsColor())
    const say = (line: string) => Console.log(`  ${line}`)
    const stores = storesOf(home, path)
    const cwd = path.resolve(Option.getOrElse(args.repo, () => process.cwd()))
    const repo = yield* identifyRepo(cwd)

    if (args.past) {
      if (repo === undefined) return yield* say(`${cwd} isn't in a git repository.`)
      const result = yield* withSpinner(`reading past sessions in ${path.basename(repo.root)}`, storePast(repo.root, sessionHomes(dirsOf()), home.tenantDir), interactive()).pipe(Effect.provide(stores))
      const skipped = [...result.skipped].map(([reason, n]) => `${n} ${reason}`).join("; ")
      const kept = result.stored.length + result.existing.length
      yield* say(`${plural(result.sessions, "past session")}, ${plural(result.examined + result.existing.length, "commit")}: ${plural(kept, "change")} kept${skipped === "" ? "" : s.dim(` (left out: ${skipped})`)}`)
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
        : "No changes stored here yet. Memory keeps the changes Claude Code, Codex and Hermes Agent sessions commit with their checks passing; --past looks through earlier sessions.")
    }
    const prefs = yield* readLearn(home.root)
    const resolved = yield* Effect.result(Option.isSome(args.claude)
      ? Effect.succeed(claudeCli([args.claude.value]))
      : resolveLearner(Option.getOrUndefined(args.with) ?? prefs.with, dirsOf()))
    if (resolved._tag === "Failure") return yield* say(`${s.yellow("·")} Can't learn: ${resolved.failure.message}.`)
    const learner = resolved.success
    const agent = LEARNER_NAMES[learner.agent]
    // A round by hand holds the lock too: one round at a time, whoever starts it.
    if (!args.dryRun && !takeLock(home.root)) {
      const held = lockInfo(home.root)
      return yield* say(`A learning round${held?.subject === undefined ? "" : ` of ${held.subject}`} is running now; try again when it's done (${s.cyan("singularity status")} shows it).`)
    }
    let spent = 0
    yield* Effect.gen(function*() {
      for (const subject of subjects) {
        const state = yield* learnState(subject.id).pipe(Effect.provide(stores))
        const waiting = waitReason(state, prefs.every, true)
        if (waiting !== undefined) {
          yield* say(`${s.dim("·")} ${subject.name}: not yet, ${waiting}`)
          continue
        }
        const changes = state.memory.workflows.length === 0 ? state.records.length : state.unlearned.length
        const estimate = roundUsd(state)
        const what = state.memory.workflows.length === 0 ? "a first memory" : "a learning round"
        if (args.dryRun) {
          yield* say(`${subject.name}: ${what} from ${plural(changes, "change")} with ${agent}, about ${usd(estimate)}`)
          continue
        }
        const go = yield* confirm(`${subject.name}: ${what} from ${plural(changes, "change")} with ${agent}, about ${usd(estimate)}. Go ahead?`, true, interactive() && !args.yes).pipe(Effect.orElseSucceed(() => false))
        if (!go) continue
        markLock(home.root, subject.id)
        const outcome = yield* withSpinner(
          `learning ${subject.name} with ${agent} (a minute or two)`,
          learnSubject(subject, {
            ...learnerConfig(learner, path.join(defaultWorkspaces(), "_learner"), modelFor(prefs, learner.agent)),
            every: prefs.every,
            now: true
          }).pipe(Effect.provide(stores), Effect.mapError((e) => new LearnerError({ message: withModelHint(e.message, learner.agent) }))),
          interactive()
        )
        spent += outcome.costUsd
        yield* say(`${s.bold(subject.name)}`)
        for (const line of describeOutcome(s, outcome)) yield* say(`  ${line}`)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => args.dryRun || releaseLearning(home.root))))
    if (spent > 0) yield* say(s.dim(`spent ${usd(spent)} in all`))
  })
).pipe(Command.withDescription("learn from the changes stored now: a first memory for a repo, or a learning round"))

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
