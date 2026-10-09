/**
 * The "new job" benchmark (src/web/Bench.ts):
 *
 *     node src/cli.ts web-bench run --runner RUNNER.cmd --out DIR --condition none|memory|guide|awm|memory-frozen
 *         [--phase learn --phase test ...] [--chore L01 ...] [--model sonnet] [--home DIR] [--handover FILE]
 *     node src/cli.ts web-bench guide --runner RUNNER.cmd --out FILE      the onboarding guide as a static hand-over
 *     node src/cli.ts web-bench awm --runner RUNNER.cmd --results DIR --out FILE   AWM's workflows from runs without memory
 */
import { Effect, Option, Path } from "effect"
import { Command, Flag } from "effect/cli"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { lowerPriority } from "../eval/Proc.ts"
import { awmHandover } from "../web/Awm.ts"
import { type Condition, runBench, runner } from "../web/Bench.ts"
import { choresOfReveal, loadRows, report } from "../web/Report.ts"

const DEFAULT_CLAUDE = "C:/singularity-workspaces/tools/claude-pinned/claude.exe"

const runnerFlag = Flag.String("runner").pipe(Flag.withDescription("the benchmark's runner launcher"))

const run = Command.make(
  "run",
  {
    runner: runnerFlag,
    out: Flag.String("out").pipe(Flag.withDescription("results directory")),
    condition: Flag.Literals("condition", ["none", "memory", "guide", "awm", "memory-frozen"]),
    phase: Flag.String("phase").pipe(Flag.atLeast(0)),
    chore: Flag.String("chore").pipe(Flag.atLeast(0)),
    model: Flag.String("model").pipe(Flag.withDefault("sonnet")),
    effort: Flag.String("effort").pipe(Flag.withDefault("medium")),
    claude: Flag.String("claude").pipe(Flag.withDefault(DEFAULT_CLAUDE)),
    home: Flag.String("home").pipe(Flag.optional),
    handover: Flag.String("handover").pipe(Flag.optional),
    setup: Flag.String("setup").pipe(Flag.optional),
    maxTurns: Flag.Int("max-turns").pipe(Flag.withDefault(80)),
    maxBudget: Flag.Finite("max-budget-usd").pipe(Flag.withDefault(2)),
    timeout: Flag.Int("timeout-s").pipe(Flag.withDefault(1200))
  },
  Effect.fn(function*(args) {
    yield* lowerPriority
    const path = yield* Path.Path
    yield* runBench({
      runner: args.runner,
      out: args.out,
      condition: args.condition as Condition,
      phases: args.phase.length > 0 ? args.phase : ["learn", "test", "update"],
      chores: args.chore.length > 0 ? args.chore : undefined,
      claude: args.claude,
      model: args.model,
      effort: args.effort,
      home: Option.getOrUndefined(args.home),
      handover: Option.getOrUndefined(args.handover),
      setup: Option.getOrUndefined(args.setup),
      learner: { model: "sonnet", effort: "high", cwd: path.join(defaultWorkspaces(), "_learner") },
      maxTurns: args.maxTurns,
      maxBudgetUsd: args.maxBudget,
      timeoutS: args.timeout
    })
  })
).pipe(Command.withDescription("run the benchmark's chores under one condition"))

const guide = Command.make(
  "guide",
  { runner: runnerFlag, out: Flag.String("out") },
  Effect.fn(function*(args) {
    const g = runner(args.runner, ["guide"])
    const fs = yield* (yield* Effect.promise(() => import("effect"))).FileSystem.FileSystem
    yield* fs.writeFileString(args.out, JSON.stringify({ all: `The company's onboarding guide for new staff:\n\n${String(g.guide ?? "")}` }, null, 2) + "\n")
    yield* Effect.sync(() => console.log(`wrote ${args.out} (${String(g.guide ?? "").length} characters)`))
  })
).pipe(Command.withDescription("the onboarding guide, as a static hand-over file"))

const awm = Command.make(
  "awm",
  {
    runner: runnerFlag,
    results: Flag.String("results").pipe(Flag.withDescription("results directory of runs without memory (their learn phase)")),
    out: Flag.String("out"),
    claude: Flag.String("claude").pipe(Flag.withDefault(DEFAULT_CLAUDE))
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const written = yield* awmHandover({ results: args.results, out: args.out, claude: [args.claude], cwd: path.join(defaultWorkspaces(), "_learner"), model: "sonnet", effort: "high" })
    yield* Effect.sync(() => console.log(`wrote ${args.out}: ${written.apps} apps, $${written.costUsd.toFixed(3)}`))
  })
).pipe(Command.withDescription("Agent Workflow Memory's workflows, induced from successful runs without memory"))

const reportCmd = Command.make(
  "report",
  {
    results: Flag.String("results").pipe(Flag.atLeast(1), Flag.withDescription("results directories, one per condition")),
    reveal: Flag.String("reveal").pipe(Flag.withDescription("the runner's reveal, saved as JSON after the runs")),
    memory: Flag.String("memory-setup").pipe(Flag.withDefault("memory")),
    none: Flag.String("none-setup").pipe(Flag.withDefault("none")),
    out: Flag.String("out")
  },
  Effect.fn(function*(args) {
    const fs = yield* (yield* Effect.promise(() => import("effect"))).FileSystem.FileSystem
    const rows = yield* loadRows(args.results)
    const reveal = JSON.parse(yield* fs.readFileString(args.reveal)) as unknown
    const text = report(rows, choresOfReveal(reveal), { memory: args.memory, none: args.none })
    yield* fs.writeFileString(args.out, text)
    yield* Effect.sync(() => console.log(`wrote ${args.out}: ${rows.length} runs`))
  })
).pipe(Command.withDescription("the benchmark's report, harm first"))

export const webBenchCommand = Command.make("web-bench").pipe(
  Command.withDescription("the computer-use benchmark \"a new job\""),
  Command.withSubcommands([run, guide, awm, reportCmd])
)
