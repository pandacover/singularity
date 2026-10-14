/**
 * `node src/cli.ts record ...`: build, list and show workflow records.
 */
import { Console, DateTime, Effect, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { lowerPriority } from "../eval/Proc.ts"
import { loadHome } from "../local/Home.ts"
import { describeRecord, recordLine } from "../records/Describe.ts"
import { importRunDirs } from "../records/FromRuns.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { homedir } from "node:os"
import { sessionHomes } from "../setup/Agents.ts"
import { releaseLock, takeLock } from "../setup/Background.ts"
import { findTranscript, parseSession } from "../traces/index.ts"
import { storeCommits } from "../workflows/Commits.ts"
import { homeFlag, recordsLayer } from "./Common.ts"

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
    background: Flag.Boolean("background").pipe(Flag.withDefault(false), Flag.withDescription("as the hooks start it: below normal priority, one run at a time")),
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
      Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)),
      Effect.ensuring(Effect.sync(() => args.background && releaseLock(home.root, "store.lock")))
    )
    const name = result.subject ?? path.basename(cwd)
    for (const id of result.stored) yield* say(`${name}: stored ${id}`)
    const skipped = [...result.skipped].map(([reason, n]) => `${n} ${reason}`).join("; ")
    if (result.examined > 0 || !args.background) {
      yield* say(`${name}: ${result.examined} new commits looked at, ${result.stored.length} stored${skipped === "" ? "" : ` (left out: ${skipped})`}`)
    }
  })
).pipe(Command.withDescription("store the changes sessions committed, one record per commit (the hooks run this on their own)"))

export const recordCommand = Command.make("record").pipe(
  Command.withDescription("workflow records: what finished runs show"),
  Command.withSubcommands([importRuns, commits, list, show])
)
