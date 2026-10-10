/**
 * `node src/cli.ts memory ...`: build the memory graph from the records, and look at it.
 */
import { Console, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defaultClaude } from "../eval/Agent.ts"
import { lowerPriority } from "../eval/Proc.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { DEFAULT_SELECTOR_MODEL } from "../eval/StepSelector.ts"
import { loadHome } from "../local/Home.ts"
import { describeMemory, describeReplay } from "../memory/Describe.ts"
import * as JsonMemoryStore from "../memory/JsonMemoryStore.ts"
import { MemoryStore } from "../memory/MemoryStore.ts"
import { loadTraces, mergeRecords } from "../memory/Merge.ts"
import { describeTriggerReport, replayTriggers } from "../memory/TriggerReplay.ts"
import { replay } from "../memory/Replay.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { homeFlag, recordsLayer } from "./Common.ts"

/** The memory store of the home's tenant. */
export const memoryLayer = (home: Option.Option<string>) =>
  Layer.unwrap(
    loadHome(Option.getOrUndefined(home)).pipe(
      Effect.map((h) => JsonMemoryStore.layer(`${h.tenantDir}/memory`, h.tenant))
    )
  )

const bothLayers = (home: Option.Option<string>) => Layer.merge(recordsLayer(home), memoryLayer(home))

const build = Command.make(
  "build",
  {
    conditions: Flag.Boolean("conditions").pipe(
      Flag.withDefault(false),
      Flag.withDescription("have a model write the conditions of optional steps and decide which near-identical steps are one (a few cents)")
    ),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_SELECTOR_MODEL)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("build and check, but don't store")),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false), Flag.withDescription("show every replayed task")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    yield* lowerPriority
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let model = undefined
    if (args.conditions) {
      const cwd = path.join(defaultWorkspaces(), "_learner")
      yield* fs.makeDirectory(cwd, { recursive: true })
      model = { claude: Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude(), cwd, model: args.model }
    }
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const result = yield* mergeRecords({
      memoryDir: path.join(home.tenantDir, "memory"),
      conditions: model,
      closeCalls: model,
      dryRun: args.dryRun
    })
    const g = result.graph
    yield* Console.log(`${g.kinds.length} task kinds, ${g.steps.length} steps, ${g.warnings.length} warnings; ${result.changed} items changed`)
    yield* Console.log(describeReplay(result.report, args.verbose))
    if (result.costUsd > 0) yield* Console.log(`model calls: ${result.costUsd.toFixed(3)}`)
    if (args.dryRun) return yield* Console.log(`dry run: ${result.verdict.commit ? "would commit" : `would reject: ${result.verdict.reason}`}`)
    if (result.candidate === undefined) return yield* Console.log("nothing changed")
    yield* Console.log(
      result.verdict.commit
        ? `committed ${result.candidate} as version ${result.version}`
        : `rejected ${result.candidate}: ${result.verdict.reason}`
    )
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("merge the records into the memory graph; a replay check commits or rejects it"))

const show = Command.make(
  "show",
  {
    at: Argument.String("at").pipe(Argument.optional, Argument.withDescription("a version number or candidate id (default: the head)")),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const memory = yield* MemoryStore
    const at = Option.match(args.at, { onNone: () => undefined, onSome: (a) => (/^\d+$/.test(a) ? Number(a) : a) })
    const g = yield* memory.graph(at)
    yield* Console.log(args.json ? JSON.stringify(g, null, 2) : describeMemory(g, at ?? (yield* memory.head())))
  }, (effect, args) => Effect.provide(effect, memoryLayer(args.home)))
).pipe(Command.withDescription("print the memory graph"))

const candidates = Command.make(
  "candidates",
  { home: homeFlag },
  Effect.fn(function*(_args) {
    for (const c of yield* (yield* MemoryStore).candidates()) {
      const r = c.replay
      const nums = r === null ? "" : ` (extra ${r.extra}, unasked ${r.unasked}, missing ${r.missing}, warned ${r.warned}/${r.detours})`
      yield* Console.log(
        `${c.id} ${c.status.padEnd(9)} base ${c.base_version}${c.committed_version === null ? "" : ` -> ${c.committed_version}`}` +
          ` ${c.created_at}${nums}${c.reason ? `: ${c.reason}` : ""}`
      )
    }
  }, (effect, args) => Effect.provide(effect, memoryLayer(args.home)))
).pipe(Command.withDescription("list proposed builds and what became of them"))

const replayCommand = Command.make(
  "replay",
  {
    at: Argument.String("at").pipe(Argument.optional, Argument.withDescription("a version number or candidate id (default: the head)")),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const at = Option.match(args.at, { onNone: () => undefined, onSome: (a) => (/^\d+$/.test(a) ? Number(a) : a) })
    const g = yield* (yield* MemoryStore).graph(at)
    yield* Console.log(describeReplay(replay(g, yield* (yield* RecordStore).find()), args.verbose))
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("check a version of the graph against every past task"))

const triggers = Command.make(
  "triggers",
  {
    at: Argument.String("at").pipe(Argument.optional, Argument.withDescription("a version number or candidate id (default: the head)")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const at = Option.match(args.at, { onNone: () => undefined, onSome: (a) => (/^d+$/.test(a) ? Number(a) : a) })
    const g = yield* (yield* MemoryStore).graph(at)
    const records = yield* (yield* RecordStore).find()
    yield* Console.log(describeTriggerReport(replayTriggers(g, records, yield* loadTraces(records))))
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("replay recorded runs through the warnings' triggers: would each have arrived before its mistake?"))

export const memoryCommand = Command.make("memory").pipe(
  Command.withDescription("the memory graph: task kinds, steps and warnings built from the records"),
  Command.withSubcommands([build, show, candidates, replayCommand, triggers])
)
