/**
 * Learning a web app's memory, on the same schedule as code in daily use
 * (src/workflows/Learn.ts): a first build from two sessions, then a round
 * every three new ones. A round induces from all the app's sessions,
 * revising the current memory (Induce.ts), writes cues for picking without a
 * model (src/workflows/CueWriter.ts, shared with code), and keeps the
 * revision only if, replayed over the sessions, it fits them at least as
 * well: places it would have shown that sessions used, minus places it would
 * have shown that they didn't.
 *
 *     <tenant dir>/web/learned/<subject>.json   the sessions memory has learned from
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { writeFileWhole } from "../local/Files.ts"
import { type CuesConfig, writeCues } from "../workflows/CueWriter.ts"
import { cueChoice, hasCues } from "../workflows/Cues.ts"
import type { RunEvidence } from "../workflows/Evidence.ts"
import type { InduceConfig } from "../workflows/Induce.ts"
import { mergeSubject } from "../workflows/Learn.ts"
import type { WorkflowMemory } from "../workflows/Models.ts"
import { wordChoice } from "../workflows/Select.ts"
import { forSubject } from "../workflows/Start.ts"
import { type ReplayNumbers, WorkflowStore } from "../workflows/WorkflowStore.ts"
import { induceWeb, taskOf, webEvidence } from "./Induce.ts"
import { type WebRecord, webDir, webRecords } from "./Records.ts"

export const WEB_MIN_FIRST = 2
export const WEB_EVERY = 3

const Learned = Schema.Struct({ records: Schema.Array(Schema.String) })

const learnedFile = (tenantDir: string, subject: string, path: Path.Path) => path.join(webDir(tenantDir, path), "learned", `${subject}.json`)

const readLearned = Effect.fn("web.readLearned")(function*(tenantDir: string, subject: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = learnedFile(tenantDir, subject, path)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<string>
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Learned))(yield* fs.readFileString(file))
  return Option.isSome(decoded) ? [...decoded.value.records] : []
})

const writeLearned = Effect.fn("web.writeLearned")(function*(tenantDir: string, subject: string, records: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = learnedFile(tenantDir, subject, path)
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileWhole(fs, file, JSON.stringify({ records: [...records].sort() }, null, 2) + "\n")
})

/** Replay: for each session, the places memory would have shown its task, against the places it used. */
export const replayWeb = (memory: WorkflowMemory, records: ReadonlyArray<WebRecord>): ReplayNumbers => {
  let edited = 0
  let shownUsed = 0
  let shownUnused = 0
  let workflows = 0
  for (const r of records) {
    const used = new Set(r.actions.filter((a) => !a.failed && a.place !== null).map((a) => a.place!))
    edited += used.size
    const chosen = hasCues(memory) ? cueChoice(memory, r.prompt) : wordChoice(memory, r.prompt)
    workflows += chosen.length
    const shown = new Set(chosen.flatMap((c) => c.workflow.steps.flatMap((s, i) => (c.skip.includes(i + 1) || s.place === null ? [] : [s.place]))))
    for (const p of shown) {
      if (used.has(p)) shownUsed++
      else shownUnused++
    }
  }
  return { runs: records.length, edited, shown_and_edited: shownUsed, shown_unused: shownUnused, workflows }
}

const score = (n: ReplayNumbers) => n.shown_and_edited - n.shown_unused

/** The sessions as the cue writer reads them: each task's request and its own values. */
const seedsOf = (records: ReadonlyArray<WebRecord>): Array<RunEvidence> =>
  records.map((r) => ({ record: r.id, subject: r.subject, task: taskOf(r), prompt: r.prompt, values: r.values }) as unknown as RunEvidence)

export type WebLearnOutcome =
  | { readonly kind: "waiting"; readonly subject: string; readonly reason: string }
  | {
    readonly kind: "committed" | "rejected" | "empty"
    readonly subject: string
    readonly version: number | null
    readonly reason: string
    readonly costUsd: number
    readonly sessions: number
    readonly problems: ReadonlyArray<string>
  }

export interface WebLearnConfig extends InduceConfig {
  readonly every?: number | undefined
  /** Learn even with fewer new sessions than `every` (at least one). */
  readonly now?: boolean | undefined
}

/** A learning round for one web app, when it is time. */
export const learnWebSubject = Effect.fn("learnWebSubject")(function*(subject: string, config: WebLearnConfig, tenantDir: string) {
  const store = yield* WorkflowStore
  const records = yield* webRecords(tenantDir, subject)
  const learned = new Set(yield* readLearned(tenantDir, subject))
  const fresh = records.filter((r) => !learned.has(r.id))
  const full = yield* store.memory()
  const current = forSubject(full, subject)
  const hasMemory = current.workflows.length > 0 || current.pitfalls.length > 0
  const every = config.every ?? WEB_EVERY
  if (fresh.length === 0) return { kind: "waiting", subject, reason: "nothing new since the last round" } satisfies WebLearnOutcome
  if (!hasMemory && records.length < WEB_MIN_FIRST) return { kind: "waiting", subject, reason: `${records.length} of ${WEB_MIN_FIRST} sessions recorded for a first build` } satisfies WebLearnOutcome
  if (hasMemory && fresh.length < every && config.now !== true) return { kind: "waiting", subject, reason: `${fresh.length} of ${every} new sessions recorded` } satisfies WebLearnOutcome

  const evidence = webEvidence(subject, records)
  const induced = yield* induceWeb(config, evidence, store.tenant, hasMemory ? current : undefined)
  let costUsd = induced.costUsd
  let problems = [...induced.problems]
  if (induced.memory.workflows.length === 0 && induced.memory.pitfalls.length === 0) {
    yield* writeLearned(tenantDir, subject, records.map((r) => r.id))
    return { kind: "empty", subject, version: null, reason: "the sessions showed nothing to keep yet", costUsd, sessions: records.length, problems } satisfies WebLearnOutcome
  }
  let candidate = induced.memory
  if (candidate.workflows.length > 0) {
    const cuesConfig: CuesConfig = { claude: config.claude, cwd: config.cwd, model: config.model, effort: config.effort }
    const cues = yield* writeCues(cuesConfig, candidate, seedsOf(records))
    costUsd += cues.costUsd
    problems = [...problems, ...cues.problems.map((p) => `cues: ${p}`)]
    candidate = cues.memory
  }
  const now = replayWeb(current, records)
  const next = replayWeb(candidate, records)
  const keep = !hasMemory || score(next) >= score(now)
  const reason = !hasMemory
    ? "first build"
    : keep
    ? `fits the sessions at least as well (${score(next)} against ${score(now)})`
    : `fits the sessions worse (${score(next)} against ${score(now)})`
  const merged = mergeSubject(full, subject, candidate)
  const proposed = yield* store.propose(merged, {
    rationale: induced.rationale,
    records: records.map((r) => r.id),
    model: config.model,
    costUsd,
    report: { problems, replay: next }
  })
  let version: number | null = null
  if (keep) version = yield* store.commit(proposed.id)
  else yield* store.reject(proposed.id, reason)
  yield* writeLearned(tenantDir, subject, records.map((r) => r.id))
  return { kind: keep ? "committed" : "rejected", subject, version, reason, costUsd, sessions: records.length, problems } satisfies WebLearnOutcome
})
