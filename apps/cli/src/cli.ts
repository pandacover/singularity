/**
 * The whole command line, run from the repo. The `singularity` command setup
 * installs is src/singularity.ts, with only the commands for daily use:
 *
 *     singularity setup [--yes] [--agent ID ...] [--no-path]    set memory up in this machine's coding agents
 *     singularity status | recall TASK... | learn --past | update | uninstall [--purge]
 *
 * This one has those too, and, for measuring memory (and for memory's own
 * background work, src/setup/Background.ts):
 *
 *     node src/cli.ts eval run SUITE.toml [--setup no-memory] [--reps N] [--task ID ...]
 *     node src/cli.ts eval run SUITE.toml --setup scripts|saved-scripts|saved-scripts-top2 --memory DIR [--frozen]
 *     node src/cli.ts eval learn SUITE.toml RESULTS... --setup saved-scripts --memory DIR [--task ID ...]
 *     node src/cli.ts eval inject SUITE.toml --setup SETUP --memory DIR [--task ID ...]
 *     node src/cli.ts eval report RESULTS... [--compare [--baseline SETUP]]
 *     node src/cli.ts traces SESSION [--json]
 *     node src/cli.ts record import RUN_DIRS... | commits | list | show ID
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, FileSystem, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { recordCommand } from "./commands/Records.ts"
import { setupCommands } from "./commands/Setup.ts"
import { buildCommand, defaultClaude } from "./eval/Agent.ts"
import { learnFrom } from "./eval/Learn.ts"
import { makeSetup } from "./eval/Memory.ts"
import { lowerPriority } from "./eval/Proc.ts"
import { pyFixed } from "./eval/PyFormat.ts"
import { VERSION } from "./setup/Status.ts"
import type { RunRecord } from "./eval/Report.ts"
import { compare, field, loadRecords, ReportError, summarize } from "./eval/Report.ts"
import { defaultWorkspaces, runSuite } from "./eval/Runner.ts"
import { SETUPS } from "./eval/Setups.ts"
import { loadSuite, suiteTask } from "./eval/Suite.ts"
import { makeWorkspace, resolveRef } from "./eval/Workspace.ts"
import type { Trace, TraceMetrics } from "./traces/index.ts"
import {
  findTranscript,
  metricsToJson,
  parseSession,
  repeatReads,
  traceMetrics,
  traceModels,
  usageTotal
} from "./traces/index.ts"

const tasksFlag = Flag.String("task").pipe(
  Flag.atLeast(0),
  Flag.withDescription("only this task (repeatable)")
)

const workspacesFlag = Flag.String("workspaces").pipe(
  Flag.withDefault(defaultWorkspaces()),
  Flag.withDescription("where repo clones live")
)

const claudeFlag = Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable"))

/** Setups that keep memory, fed by the harness after each run. */
const PREPARED_SETUPS = SETUPS.filter((s) => s !== "no-memory")

const run = Command.make(
  "run",
  {
    suite: Argument.String("suite").pipe(Argument.withDescription("suite TOML file")),
    setup: Flag.Literals("setup", SETUPS).pipe(Flag.withDefault("no-memory")),
    memory: Flag.String("memory").pipe(
      Flag.optional,
      Flag.withDescription("memory store for setups that keep memory (e.g. saved-scripts)")
    ),
    frozen: Flag.Boolean("frozen").pipe(
      Flag.withDefault(false),
      Flag.withDescription("read memory but don't add to it (for measurement runs)")
    ),
    reps: Flag.Int("reps").pipe(Flag.withDefault(1), Flag.withDescription("runs per task")),
    firstRep: Flag.Int("first-rep").pipe(
      Flag.withDefault(0),
      Flag.withDescription("number of the first pass, when adding passes to an existing --out dir")
    ),
    tasks: tasksFlag,
    out: Flag.String("out").pipe(Flag.optional, Flag.withDescription("output dir (default runs/<suite>/<time>-<setup>)")),
    workspaces: workspacesFlag,
    claude: claudeFlag,
    priority: Flag.Literals("priority", ["below-normal", "normal"]).pipe(
      Flag.withDefault("below-normal"),
      Flag.withDescription("below-normal keeps the machine usable during runs; normal when nothing else needs it")
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("resolve tasks and print the agent command without running")
    )
  },
  Effect.fn(function*(args) {
    // Children inherit it: the agent, its tool calls and hooks, the checks.
    if (args.priority === "below-normal") yield* lowerPriority
    const path = yield* Path.Path
    const suite = yield* loadSuite(args.suite)
    const claude = Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude()
    const setup = yield* makeSetup(args.setup, Option.getOrUndefined(args.memory), args.frozen)

    if (args.dryRun) {
      const ws = makeWorkspace(suite.repo, path.join(args.workspaces, suite.name), suite.keep)
      yield* Console.log(`repo       ${suite.repo}\nworkspace  ${ws.path}`)
      const tasks = args.tasks.length ? yield* Effect.forEach(args.tasks, (id) => suiteTask(suite, id)) : suite.tasks
      for (const t of tasks) {
        const sha = yield* resolveRef(ws, t.base)
        yield* Console.log(`task       ${t.id} @ ${sha.slice(0, 12)}  checks: ${t.checks.length}`)
      }
      yield* Console.log("command    " + buildCommand(claude, suite.agent, "<session-id>").join(" "))
      return
    }

    const out = Option.getOrElse(args.out, () => path.join("runs", suite.name, `${localStamp()}-${setup.name}`))
    yield* Console.error(`writing to ${out}`)
    const records = yield* runSuite(suite, setup, out, claude, {
      workspaces: args.workspaces,
      reps: args.reps,
      firstRep: args.firstRep,
      taskIds: args.tasks,
      onRecord: progress
    })
    yield* Console.log("")
    yield* Console.log(summarize(records))
  })
).pipe(Command.withDescription("run a suite"))

const learn = Command.make(
  "learn",
  {
    suite: Argument.String("suite").pipe(Argument.withDescription("suite TOML file")),
    results: Argument.String("results").pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription("results.jsonl files or run output dirs")
    ),
    setup: Flag.Literals("setup", PREPARED_SETUPS),
    memory: Flag.String("memory").pipe(Flag.withDescription("memory store to add to")),
    tasks: tasksFlag
  },
  Effect.fn(function*(args) {
    yield* lowerPriority
    const suite = yield* loadSuite(args.suite)
    const setup = yield* makeSetup(args.setup, args.memory, false)
    const n = yield* learnFrom(setup, suite, args.results, args.tasks, (outcome, i, total) =>
      Console.error(`[${i}/${total}] learned from ${outcome.task.id} (${outcome.trace?.sessionId ?? "no transcript"})`))
    yield* Console.log(`fed ${n} runs into ${args.setup} memory at ${args.memory}`)
  })
).pipe(Command.withDescription("feed finished runs into a memory setup"))

const inject = Command.make(
  "inject",
  {
    suite: Argument.String("suite").pipe(Argument.withDescription("suite TOML file")),
    setup: Flag.Literals("setup", PREPARED_SETUPS),
    memory: Flag.String("memory").pipe(Flag.withDescription("memory store to read")),
    tasks: tasksFlag,
    workspaces: workspacesFlag
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const suite = yield* loadSuite(args.suite)
    const setup = yield* makeSetup(args.setup, args.memory, true)
    const tasks = args.tasks.length ? yield* Effect.forEach(args.tasks, (id) => suiteTask(suite, id)) : suite.tasks
    for (const task of tasks) {
      const injection = yield* setup.beforeRun(task, path.join(args.workspaces, suite.name))
      const text = injection.systemPrompt ?? ""
      const spent = injection.spent === undefined ? "" : `, selection cost $${injection.spent.costUsd.toFixed(4)}`
      yield* Console.log(`=== ${task.id}: ${text.length} chars (about ${Math.round(text.length / 4)} tokens)${spent}`)
      yield* Console.log(JSON.stringify(injection.info))
      if (text) yield* Console.log(`\n${text}`)
    }
  })
).pipe(Command.withDescription("show what a setup would hand the agent for each task, without running it"))

const report = Command.make(
  "report",
  {
    results: Argument.String("results").pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription("results.jsonl files or run output dirs")
    ),
    compare: Flag.Boolean("compare").pipe(
      Flag.withDefault(false),
      Flag.withDescription("each memory setup against a baseline, split into exact repeats and similar tasks")
    ),
    baseline: Flag.String("baseline").pipe(
      Flag.withDefault("no-memory"),
      Flag.withDescription("the setup --compare measures against")
    )
  },
  Effect.fn(function*(args) {
    const records = yield* loadRecords(args.results)
    const text = args.compare
      ? yield* Effect.try({
        try: () => compare(records, args.baseline),
        catch: (e) => (e instanceof ReportError ? e : new ReportError({ message: String(e) }))
      })
      : summarize(records)
    yield* Console.log(text)
  })
).pipe(Command.withDescription("summarize results"))

const evalCommand = Command.make("eval").pipe(
  Command.withDescription("evaluate memory setups on a task suite"),
  Command.withSubcommands([run, learn, inject, report])
)

const traces = Command.make(
  "traces",
  {
    session: Argument.String("session").pipe(Argument.withDescription("path to a transcript .jsonl, or a session id")),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("print metrics as JSON"))
  },
  Effect.fn(function*(args) {
    const fs = yield* FileSystem.FileSystem
    const isFile = yield* fs.stat(args.session).pipe(
      Effect.map((s) => s.type === "File"),
      Effect.orElseSucceed(() => false)
    )
    const transcript = isFile ? args.session : yield* findTranscript(args.session)
    if (transcript === undefined) {
      return yield* new ReportError({ message: `no transcript file or session id ${JSON.stringify(args.session)}` })
    }
    const trace = yield* parseSession(transcript)
    const m = traceMetrics(trace)
    yield* Console.log(
      args.json
        ? JSON.stringify({ session_id: trace.sessionId, path: trace.path, ...metricsToJson(m) }, null, 2)
        : formatSummary(trace, m)
    )
  })
).pipe(Command.withDescription("summarize a Claude Code session"))

const progress = (r: RunRecord, i: number, total: number) => {
  const outcome = r.success === true ? "pass" : r.success === false ? "FAIL" : "-"
  const cost = typeof r.cost_usd === "number" ? `$${pyFixed(r.cost_usd, 2)}` : "$?"
  const calls = field(r, "trace", "tool_calls") ?? "?"
  const wall = typeof r.wall_time_s === "number" ? `${pyFixed(r.wall_time_s, 0)}s` : "?"
  return Console.error(
    `[${i}/${total}] ${r.setup} ${r.task_id} r${r.rep}  ${outcome}  ${cost}  ${wall}  ${calls} tool calls  (${r.status})`
  )
}

const formatSummary = (trace: Trace, m: TraceMetrics): string => {
  const u = m.usage
  const n = (x: number) => pyFixed(x, 0, true)
  const lines = [
    `session  ${trace.sessionId}  (${traceModels(trace).join(", ") || "no responses"}; Claude Code ${trace.version ?? "?"})`,
    `cwd      ${trace.cwd ?? "?"}`,
    `prompts  ${trace.prompts.length}   api calls ${m.apiCalls}` +
    (m.apiErrors ? ` (${m.apiErrors} failed)` : "") +
    `   subagents ${m.subagents}   wall ${duration(m.wallTimeS)}`,
    `tokens   input ${n(u.input_tokens)}  output ${n(u.output_tokens)}  cache write ${n(u.cache_creation_input_tokens)}` +
    `  cache read ${n(u.cache_read_input_tokens)}  total ${n(usageTotal(u))}`
  ]
  const cost = trace.costState?.totalCostUSD
  if (typeof cost === "number") {
    lines.push(`cost     $${pyFixed(cost, 2)} (Claude Code's running total, incl. side calls)`)
  }
  const tools = m.tools.map(([k, v]) => `${k} ${v}`).join(", ")
  lines.push(`tools    ${m.toolCalls} calls (${m.toolErrors} failed)` + (tools ? `: ${tools}` : ""))
  lines.push(
    `files    ${m.reads} reads of ${m.uniqueFilesRead} files (${repeatReads(m)} repeats), ${m.filesEdited.length} edited`
  )
  return lines.join("\n")
}

const duration = (seconds: number | undefined): string => {
  if (seconds === undefined) return "?"
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const s = total % 60
  return minutes ? `${minutes}m ${String(s).padStart(2, "0")}s` : `${s}s`
}

/** Local time as YYYYMMDD-HHMMSS, for default output directory names. */
const localStamp = (): string => {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// Exit quietly when the reader goes away early, e.g. `... | head`.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0)
  throw e
})

/** Expected failures (a bad suite, a missing file) get one line and exit code 2, not a stack trace. */
const reportError = (e: { readonly message: string }) =>
  Console.error(`error: ${e.message}`).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 2))))

Command.make("singularity").pipe(
  Command.withDescription("procedural memory for coding agents"),
  Command.withSubcommands([...setupCommands, evalCommand, traces, recordCommand]),
  Command.run({ version: VERSION }),
  Effect.catchTags({
    SuiteError: reportError,
    WorkspaceError: reportError,
    MemoryError: reportError,
    ReportError: reportError,
    AgentError: reportError,
    PlatformError: reportError,
    StoreError: reportError,
    HomeError: reportError,
    RecallError: reportError,
    UpdateError: reportError,
    RecordNotFound: reportError
  }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
