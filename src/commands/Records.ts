/**
 * `singularity record ...`: build, list and show workflow records.
 */
import { Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defaultClaude } from "../eval/Agent.ts"
import { lowerPriority } from "../eval/Proc.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { annotateRecord, DEFAULT_READER_EFFORT, DEFAULT_READER_MODEL, unread } from "../records/Annotate.ts"
import { recordSession } from "../handover/SessionEnd.ts"
import { loadHome } from "../local/Home.ts"
import { describeRecord, recordLine } from "../records/Describe.ts"
import { importRunDirs } from "../records/FromRuns.ts"
import { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { ReportError } from "../eval/Report.ts"
import { findTranscript, parseSession } from "../traces/index.ts"
import { homeFlag, recordsLayer } from "./Common.ts"
import { memoryLayer } from "./Memory.ts"

const encodeRecord = Schema.encodeEffect(WorkflowRecord)

const importRuns = Command.make(
  "import",
  {
    dirs: Argument.String("dirs").pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription("eval run output dirs (each with results.jsonl)")
    ),
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("the repo, if a run's workspace no longer exists")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const result = yield* importRunDirs(args.dirs, {
      repo: Option.getOrUndefined(args.repo),
      onRecord: (id, line) => Console.error(`added ${id} (${line.setup} ${line.task_id})`)
    })
    yield* Console.log(`${result.added} records added, ${result.existing} already there, ${result.skipped} runs skipped`)
  }, (effect, args) => Effect.provide(effect, recordsLayer(args.home)))
).pipe(Command.withDescription("build records from eval runs"))

const list = Command.make(
  "list",
  {
    subject: Flag.String("subject").pipe(Flag.optional, Flag.withDescription("only this subject (repo)")),
    kind: Flag.String("kind").pipe(Flag.optional, Flag.withDescription("only this task kind")),
    step: Flag.String("step").pipe(Flag.optional, Flag.withDescription("only records with this step")),
    key: Flag.String("key").pipe(Flag.optional, Flag.withDescription("only records with a command, file or error containing this")),
    unannotated: Flag.Boolean("unannotated").pipe(Flag.withDefault(false), Flag.withDescription("only records without the model's reading")),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const store = yield* RecordStore
    const records = yield* store.find({
      subject: Option.getOrUndefined(args.subject),
      kind: Option.getOrUndefined(args.kind),
      step: Option.getOrUndefined(args.step),
      key: Option.getOrUndefined(args.key),
      annotated: args.unannotated ? false : undefined
    })
    if (args.json) {
      const encoded = yield* Effect.forEach(records, (r) => encodeRecord(r))
      return yield* Console.log(JSON.stringify(encoded, null, 2))
    }
    for (const r of records) yield* Console.log(recordLine(r))
    yield* Console.error(`${records.length} records`)
  }, (effect, args) => Effect.provide(effect, recordsLayer(args.home)))
).pipe(Command.withDescription("list records"))

const show = Command.make(
  "show",
  {
    id: Argument.String("id").pipe(Argument.withDescription("record id")),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const record = yield* (yield* RecordStore).get(args.id)
    yield* Console.log(args.json ? JSON.stringify(yield* encodeRecord(record), null, 2) : describeRecord(record))
  }, (effect, args) => Effect.provide(effect, recordsLayer(args.home)))
).pipe(Command.withDescription("show a record"))

const annotate = Command.make(
  "annotate",
  {
    ids: Argument.String("ids").pipe(Argument.variadic({ min: 0 }), Argument.withDescription("records to read (default: --all)")),
    all: Flag.Boolean("all").pipe(Flag.withDefault(false), Flag.withDescription("every successful record without a reading")),
    perTask: Flag.Int("per-task").pipe(Flag.optional, Flag.withDescription("with --all: at most this many records per eval task")),
    limit: Flag.Int("limit").pipe(Flag.optional, Flag.withDescription("read at most this many records")),
    replace: Flag.Boolean("replace").pipe(Flag.withDefault(false), Flag.withDescription("read records again that have a reading")),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_READER_MODEL)),
    effort: Flag.String("effort").pipe(Flag.withDefault(DEFAULT_READER_EFFORT)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("list the records, call no model")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    yield* lowerPriority
    const store = yield* RecordStore
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const chosen = args.ids.length > 0
      ? yield* Effect.forEach(args.ids, (id) => store.get(id))
      : args.all
      ? unread(yield* store.find({ outcome: "success" }), Option.getOrUndefined(args.perTask))
      : []
    if (chosen.length === 0) return yield* Console.error("nothing to read: pass record ids or --all")
    const todo = Option.match(args.limit, { onNone: () => chosen, onSome: (n) => chosen.slice(0, n) })
    if (args.dryRun) {
      for (const r of todo) yield* Console.log(recordLine(r))
      return yield* Console.error(`${todo.length} records would be read with ${args.model} (${args.effort} effort)`)
    }
    const claude = Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude()
    const cwd = path.join(defaultWorkspaces(), "_learner")
    yield* fs.makeDirectory(cwd, { recursive: true })
    const config = { claude, cwd, model: args.model, effort: args.effort }
    let spent = 0
    for (const [i, r] of todo.entries()) {
      const result = yield* Effect.result(annotateRecord(config, r.id, { replace: args.replace }))
      if (result._tag === "Failure") {
        yield* Console.error(`[${i + 1}/${todo.length}] ${r.id}: failed: ${result.failure.message}`)
        continue
      }
      const m = result.success.model!
      spent += m.cost_usd ?? 0
      yield* Console.error(
        `[${i + 1}/${todo.length}] ${r.id}: ${m.kind.name}; ${m.steps.length} steps, ${m.lessons.length} lessons, ` +
          `${m.dropped.length} claims dropped, $${(m.cost_usd ?? 0).toFixed(3)}`
      )
    }
    yield* Console.log(`read ${todo.length} records for $${spent.toFixed(2)}`)
  }, (effect, args) => Effect.provide(effect, recordsLayer(args.home)))
).pipe(Command.withDescription("add the model's reading to records: kind, steps, landmarks, lessons (checked against the code)"))

const session = Command.make(
  "session",
  {
    session: Argument.String("session").pipe(Argument.withDescription("a session id or transcript path")),
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("the repo it ran in (default: the session's own)")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const fs = yield* FileSystem.FileSystem
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const isFile = yield* fs.exists(args.session)
    const transcript = isFile ? args.session : yield* findTranscript(args.session)
    if (transcript === undefined) return yield* new ReportError({ message: `no transcript for ${args.session}` })
    const sessionId = transcript.replace(/\\/g, "/").split("/").pop()!.replace(/\.jsonl$/, "")
    const trace = yield* parseSession(transcript)
    const cwd = Option.getOrElse(args.cwd, () => trace.cwd ?? ".")
    const outcome = yield* recordSession({ sessionId, transcript, cwd }, home.tenantDir)
    yield* Console.log(outcome.record === undefined ? `not recorded: ${outcome.reason}` : `${outcome.reason}: ${outcome.record}`)
  }, (effect, args) => Effect.provide(effect, Layer.merge(recordsLayer(args.home), memoryLayer(args.home))))
).pipe(Command.withDescription("record a finished session, if it committed a change and its tests pass"))

export const recordCommand = Command.make("record").pipe(
  Command.withDescription("workflow records: what finished runs show"),
  Command.withSubcommands([importRuns, session, list, show, annotate])
)
