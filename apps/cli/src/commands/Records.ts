/**
 * `singularity record ...`: build, list and show workflow records.
 */
import { Console, DateTime, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defaultClaude } from "../eval/Agent.ts"
import { lowerPriority } from "../eval/Proc.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { annotateRecord, DEFAULT_READER_EFFORT, DEFAULT_READER_MODEL, unread } from "../records/Annotate.ts"
import { recordSession } from "../handover/SessionEnd.ts"
import { loadHome } from "../local/Home.ts"
import { describeRecord, recordLine } from "../records/Describe.ts"
import { importRunDirs } from "../records/FromRuns.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { ReportError } from "../eval/Report.ts"
import { homedir } from "node:os"
import { sessionHomes } from "../setup/Agents.ts"
import { afterRecord } from "../setup/AutoLearn.ts"
import { releaseLock, takeLock } from "../setup/Background.ts"
import { findTranscript, parseSession } from "../traces/index.ts"
import { storeCommits } from "../workflows/Commits.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
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
    tasks: Flag.String("task").pipe(Flag.atLeast(0), Flag.withDescription("only runs of this eval task (repeatable)")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const result = yield* importRunDirs(args.dirs, {
      repo: Option.getOrUndefined(args.repo),
      taskIds: args.tasks,
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

/** How long a background run waits for another to finish before giving up (the next moment looks again). */
const STORE_WAIT_MS = 120_000

const commits = Command.make(
  "commits",
  {
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("a checkout of the repo (default: where the session ran, else here)")),
    session: Flag.String("session").pipe(Flag.optional, Flag.withDescription("the session a hook ran for: its commits are looked at again")),
    transcript: Flag.String("transcript").pipe(Flag.optional, Flag.withDescription("that session's log (default: found by its id)")),
    days: Flag.Int("days").pipe(Flag.withDefault(7), Flag.withDescription("look at the commits of the last N days")),
    all: Flag.Boolean("all").pipe(Flag.withDefault(false), Flag.withDescription("every commit the sessions still on disk made, looked at again")),
    background: Flag.Boolean("background").pipe(Flag.withDefault(false), Flag.withDescription("as the hooks start it: below normal priority, one run at a time, then learning if it is time")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const session = yield* Effect.gen(function*() {
      if (Option.isNone(args.session)) return undefined
      const transcript = Option.isSome(args.transcript) ? args.transcript.value : yield* findTranscript(args.session.value)
      return transcript === undefined ? undefined : { sessionId: args.session.value, transcript }
    })
    // Where the session ran, when its hook didn't say: its log does.
    const cwd = Option.isSome(args.cwd)
      ? path.resolve(args.cwd.value)
      : session === undefined
      ? process.cwd()
      : yield* parseSession(session.transcript).pipe(Effect.map((t) => t.cwd ?? process.cwd()), Effect.orElseSucceed(() => process.cwd()))
    const stamp = args.background ? `${DateTime.formatIso(yield* DateTime.now)} ` : ""
    const say = (line: string) => Console.log(`${stamp}${line}`)
    if (args.background) {
      yield* lowerPriority
      let waited = 0
      while (!takeLock(home.root, "store.lock")) {
        if (waited >= STORE_WAIT_MS) return yield* say(`${cwd}: another run is still storing; the next one looks again`)
        yield* Effect.sleep("500 millis")
        waited += 500
      }
    }
    const since = args.all ? undefined : DateTime.toEpochMillis(yield* DateTime.now) - args.days * 24 * 3600 * 1000
    const result = yield* storeCommits(cwd, sessionHomes({ home: homedir(), env: process.env }), home.tenantDir, { since, session, again: args.all }).pipe(
      Effect.provide(Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
      )),
      Effect.ensuring(Effect.sync(() => args.background && releaseLock(home.root, "store.lock")))
    )
    const name = result.subject ?? path.basename(cwd)
    for (const id of result.stored) yield* say(`${name}: stored ${id}`)
    const skipped = [...result.skipped].map(([reason, n]) => `${n} ${reason}`).join("; ")
    if (result.examined > 0 || !args.background) {
      yield* say(`${name}: ${result.examined} new commits looked at, ${result.stored.length} stored${skipped === "" ? "" : ` (left out: ${skipped})`}`)
    }
    if (args.background && result.subject !== undefined && result.stored.length > 0) {
      if (yield* Effect.promise(() => afterRecord(result.subject!))) yield* say(`${name}: started a learning round`)
    }
  })
).pipe(Command.withDescription("store the changes sessions committed, one record per commit (the hooks run this on their own)"))

export const recordCommand = Command.make("record").pipe(
  Command.withDescription("workflow records: what finished runs show"),
  Command.withSubcommands([importRuns, session, commits, list, show, annotate])
)
