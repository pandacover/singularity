/**
 * Learning a web app's memory, on the same schedule as code in daily use
 * (src/workflows/Learn.ts): a first build from two sessions, then a round
 * every three new ones; and a round right after a session that failed with
 * feedback, whatever the count, because what the manager said is a rule the
 * next task should already have. A round induces from all the app's
 * sessions, revising the current memory (Induce.ts), writes cues for picking
 * without a model (src/workflows/CueWriter.ts, shared with code), and keeps
 * the revision only if, replayed over the sessions, it fits them at least as
 * well: places it would have shown that sessions used, minus places it would
 * have shown that they didn't.
 *
 * The replay judges workflows; it can't judge rules. So when it turns a
 * revision down, the revision's rules are kept anyway, with the workflows as
 * they were. The notes on fields that start set (Presets.ts) are written
 * again from all the sessions at every round, without a model.
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
import type { Pitfall, WorkflowMemory } from "../workflows/Models.ts"
import { wordChoice } from "../workflows/Select.ts"
import { forSubject } from "../workflows/Start.ts"
import { type ReplayNumbers, WorkflowStore } from "../workflows/WorkflowStore.ts"
import { induceWeb, taskOf, webEvidence } from "./Induce.ts"
import { presetNotes } from "./Presets.ts"
import { type WebRecord, webDir, webRecords } from "./Records.ts"
import { isPresetNote } from "./Session.ts"

export const WEB_MIN_FIRST = 2
export const WEB_EVERY = 3

const failedWithFeedback = (r: WebRecord) => r.success === false && r.feedback !== null && r.feedback.trim() !== ""

/** Why a round isn't due yet, or undefined when it is. */
export const webLearnWait = (records: ReadonlyArray<WebRecord>, learned: ReadonlySet<string>, hasMemory: boolean, every: number, now: boolean): string | undefined => {
  const fresh = records.filter((r) => !learned.has(r.id))
  if (fresh.length === 0) return "nothing new since the last round"
  if (fresh.some(failedWithFeedback)) return undefined
  if (!hasMemory && records.length < WEB_MIN_FIRST) return `${records.length} of ${WEB_MIN_FIRST} sessions recorded for a first build`
  if (hasMemory && fresh.length < every && !now) return `${fresh.length} of ${every} new sessions recorded`
  return undefined
}

/** The revision's rules over the current ones (same id: the revision's), then the notes on fields. */
const withRules = (rules: ReadonlyArray<Pitfall>, current: ReadonlyArray<Pitfall>, presets: ReadonlyArray<Pitfall>): Array<Pitfall> => {
  const ids = new Set(rules.map((p) => p.id))
  return [...rules, ...current.filter((p) => !isPresetNote(p) && !ids.has(p.id)), ...presets]
}

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
    /** `rules-only`: the revision's workflows were turned down, its rules kept. */
    readonly kind: "committed" | "rejected" | "rules-only" | "empty"
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
  const full = yield* store.memory()
  const current = forSubject(full, subject)
  const hasMemory = current.workflows.length > 0 || current.pitfalls.length > 0
  const wait = webLearnWait(records, learned, hasMemory, config.every ?? WEB_EVERY, config.now === true)
  if (wait !== undefined) return { kind: "waiting", subject, reason: wait } satisfies WebLearnOutcome

  const evidence = webEvidence(subject, records)
  const induced = yield* induceWeb(config, evidence, store.tenant, hasMemory ? current : undefined)
  let costUsd = induced.costUsd
  let problems = [...induced.problems]
  const rules = induced.memory.pitfalls.filter((p) => !isPresetNote(p))
  const presets = presetNotes(subject, records)
  if (induced.memory.workflows.length === 0 && rules.length === 0 && presets.length === 0) {
    yield* writeLearned(tenantDir, subject, records.map((r) => r.id))
    return { kind: "empty", subject, version: null, reason: "the sessions showed nothing to keep yet", costUsd, sessions: records.length, problems } satisfies WebLearnOutcome
  }
  let candidate: WorkflowMemory = { ...induced.memory, pitfalls: [...rules, ...presets] }
  if (candidate.workflows.length > 0) {
    const cuesConfig: CuesConfig = { cli: config.cli, cwd: config.cwd, model: config.model, effort: config.effort }
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
  else {
    yield* store.reject(proposed.id, reason)
    // The workflows stay as they were; the rules and the notes on fields are kept.
    const pitfalls = withRules(rules, current.pitfalls, presets)
    if (JSON.stringify(pitfalls) !== JSON.stringify(current.pitfalls)) {
      const rulesOnly = yield* store.propose(mergeSubject(full, subject, { ...current, pitfalls }), {
        rationale: `Rules only, from a revision whose workflows fit the sessions worse. ${induced.rationale}`,
        records: records.map((r) => r.id),
        model: config.model,
        costUsd: 0,
        report: { problems, replay: now }
      })
      version = yield* store.commit(rulesOnly.id)
    }
  }
  yield* writeLearned(tenantDir, subject, records.map((r) => r.id))
  return { kind: keep ? "committed" : version !== null ? "rules-only" : "rejected", subject, version, reason, costUsd, sessions: records.length, problems } satisfies WebLearnOutcome
})
