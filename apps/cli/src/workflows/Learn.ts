/**
 * Learning in daily use, repository by repository: the records of a repo's
 * sessions' changes become its workflows, written with cues so a task starting there
 * is handed them without a model call. The first time, memory is built from
 * the records (`workflows build`, then `workflows cues`); after that, every
 * few new changes, a learning round revises it and keeps the revision only
 * if, replayed over the changes, it fits them at least as well (`workflows
 * evolve`). One candidate per round, so a round is one version.
 *
 * Memory keeps every repo's workflows in one store, but induction reads one
 * repo at a time: a repo is learned alone and merged back, and other repos'
 * memory stays as it was. An id a repo's revision shares with another repo's
 * workflow or pitfall gets the repo's id appended, so each repo's graph stays
 * its own (Start.ts's forSubject keeps edges by workflow id).
 */
import { DateTime, Effect, FileSystem } from "effect"
import type { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import type { Subject } from "../records/Subjects.ts"
import { writeCues } from "./CueWriter.ts"
import { gatherEvidence } from "./Evidence.ts"
import { handedTexts, passes, refine, replay } from "./Evolve.ts"
import { withSnapshots } from "./Finish.ts"
import { type InduceConfig, induce } from "./Induce.ts"
import { END, START, type WorkflowMemory } from "./Models.ts"
import { forSubject } from "./Start.ts"
import { type WorkflowCandidate, WorkflowStore } from "./WorkflowStore.ts"

/** A first build needs two changes: a place counts only where two runs edited it. */
export const MIN_FIRST = 2

/** New changes a learning round waits for, by default. */
export const DEFAULT_EVERY = 3

/**
 * `revised` (memory of `subject` alone) in place of that subject's memory in
 * `full`. Other subjects' workflows, places, pitfalls and edges are kept as
 * they are; the revision's ids that another subject uses get the subject's
 * id appended.
 */
export const mergeSubject = (full: WorkflowMemory, subject: string, revised: WorkflowMemory): WorkflowMemory => {
  const otherWorkflows = full.workflows.filter((w) => w.subject !== subject)
  const otherPitfalls = full.pitfalls.filter((p) => p.subject !== subject)
  const unique = (taken: ReadonlySet<string>) => (id: string) => {
    if (!taken.has(id)) return id
    for (let n = 1; ; n++) {
      const next = n === 1 ? `${id}-${subject}` : `${id}-${subject}-${n}`
      if (!taken.has(next)) return next
    }
  }
  const workflowId = unique(new Set(otherWorkflows.map((w) => w.id)))
  const pitfallId = unique(new Set(otherPitfalls.map((p) => p.id)))
  const wid = new Map(revised.workflows.map((w) => [w.id, workflowId(w.id)]))
  const pid = new Map(revised.pitfalls.map((p) => [p.id, pitfallId(p.id)]))
  const node = (id: string) => (id === START || id === END ? id : wid.get(id))
  const others = new Set(otherWorkflows.map((w) => w.id))
  const otherNode = (id: string) => id === START || id === END || others.has(id)
  return {
    ...full,
    places: [...full.places.filter((p) => p.subject !== subject), ...revised.places.map((p) => ({ ...p, subject }))],
    workflows: [
      ...otherWorkflows,
      ...revised.workflows.map((w) => ({
        ...w,
        id: wid.get(w.id)!,
        subject,
        pitfalls: w.pitfalls.map((p) => pid.get(p) ?? p)
      }))
    ],
    pitfalls: [...otherPitfalls, ...revised.pitfalls.map((p) => ({ ...p, id: pid.get(p.id)!, subject }))],
    edges: [
      // Another subject's edge touches its own workflows; an edge from start to end touches none and goes.
      ...full.edges.filter((e) => otherNode(e.from) && otherNode(e.to) && (others.has(e.from) || others.has(e.to))),
      ...revised.edges.flatMap((e) => {
        const from = node(e.from)
        const to = node(e.to)
        return from === undefined || to === undefined ? [] : [{ ...e, from, to }]
      })
    ]
  }
}

export interface LearnConfig extends InduceConfig {
  /** New changes a learning round waits for. */
  readonly every: number
  /** Learn even with fewer new changes than `every` (at least one). */
  readonly now?: boolean | undefined
}

export type LearnOutcome =
  | {
    readonly kind: "learned"
    readonly subject: string
    readonly version: number
    /** A first build, or a learning round. */
    readonly round: "build" | "evolve"
    readonly workflows: ReadonlyArray<string>
    readonly pitfalls: number
    readonly sessions: number
    readonly costUsd: number
  }
  | { readonly kind: "kept"; readonly subject: string; readonly reason: string; readonly costUsd: number }
  | { readonly kind: "waiting"; readonly subject: string; readonly reason: string; readonly costUsd: 0 }

/** Where a subject's learning stands: its successful records, and what memory made of them. */
export interface LearnState {
  readonly records: ReadonlyArray<WorkflowRecord>
  /** Records a committed version learned from. */
  readonly learned: ReadonlyArray<WorkflowRecord>
  /** The others: a learning round reads them. */
  readonly unlearned: ReadonlyArray<WorkflowRecord>
  /**
   * Records no round has read yet, committed or rejected: what starts a
   * round, so that a round memory rejected isn't paid for again until new
   * changes arrive.
   */
  readonly fresh: ReadonlyArray<WorkflowRecord>
  readonly memory: WorkflowMemory
}

export const learnState = Effect.fn("learnState")(function*(subject: string) {
  const store = yield* WorkflowStore
  const records = yield* (yield* RecordStore).find({ subject, outcome: "success" })
  const candidates = yield* store.candidates()
  const learnedIds = new Set(candidates.filter((c) => c.status === "committed").flatMap((c) => c.records))
  // A round that was rejected isn't tried again until a new change arrives.
  const seen = new Set(candidates.filter((c) => c.status !== "pending").flatMap((c) => c.records))
  return {
    records,
    learned: records.filter((r) => learnedIds.has(r.id)),
    unlearned: records.filter((r) => !learnedIds.has(r.id)),
    fresh: records.filter((r) => !seen.has(r.id)),
    memory: forSubject(yield* store.memory(), subject)
  } satisfies LearnState
})

/** Why a subject waits, or undefined when it has enough to learn from. */
export const waitReason = (state: LearnState, every: number, now: boolean): string | undefined => {
  const first = state.memory.workflows.length === 0
  if (first) {
    if (state.fresh.length === 0) return state.records.length === 0 ? "no changes stored yet" : "nothing new since the last try"
    if (state.records.length < MIN_FIRST) return `${state.records.length} of ${MIN_FIRST} changes stored for a first build`
    return undefined
  }
  const need = now ? 1 : every
  if (state.fresh.length < need) return `${state.fresh.length} of ${need} new changes stored`
  return undefined
}

/** Learn one subject: a first build, or a learning round when enough new changes arrived. */
export const learnSubject = Effect.fn("learnSubject")(function*(subject: Subject, config: LearnConfig) {
  const store = yield* WorkflowStore
  const state = yield* learnState(subject.id)
  const waiting = waitReason(state, config.every, config.now === true)
  if (waiting !== undefined) return { kind: "waiting", subject: subject.id, reason: waiting, costUsd: 0 } satisfies LearnOutcome
  // The model runs in a directory of its own, which a fresh machine doesn't have yet.
  yield* (yield* FileSystem.FileSystem).makeDirectory(config.cwd, { recursive: true }).pipe(Effect.ignore)
  const baseVersion = yield* store.head()
  const full = yield* store.memory()
  const first = state.memory.workflows.length === 0

  const propose = (memory: WorkflowMemory, records: ReadonlyArray<string>, rationale: string, costUsd: number) =>
    store.propose(mergeSubject(full, subject.id, memory), { baseVersion, rationale, records, model: config.model, costUsd, report: { problems: [], replay: null } })

  if (first) {
    const evidence = yield* gatherEvidence(state.records, {})
    const induced = yield* induce(config, evidence, store.tenant)
    const built = withSnapshots(induced.memory, evidence.runs)
    const records = evidence.runs.map((r) => r.record)
    if (built.workflows.length === 0) {
      const candidate = yield* propose(built, records, induced.rationale, induced.costUsd)
      yield* store.reject(candidate.id, "no workflows")
      return { kind: "kept", subject: subject.id, reason: "the changes showed no workflow to keep yet", costUsd: induced.costUsd } satisfies LearnOutcome
    }
    const cued = yield* writeCues(config, built, evidence.runs)
    const costUsd = induced.costUsd + cued.costUsd
    const candidate = yield* propose(cued.memory, records, induced.rationale, costUsd)
    const version = yield* store.commit(candidate.id)
    return {
      kind: "learned",
      subject: subject.id,
      version,
      round: "build",
      workflows: cued.memory.workflows.map((w) => w.name),
      pitfalls: cued.memory.pitfalls.length,
      sessions: records.length,
      costUsd
    } satisfies LearnOutcome
  }

  // A learning round, as `workflows evolve` does it, on this subject's memory alone.
  const evidence = yield* gatherEvidence(state.unlearned, {})
  const before = yield* gatherEvidence(state.learned, {})
  const current = state.memory
  const rejected: ReadonlyArray<WorkflowCandidate> = (yield* store.candidates("rejected"))
    .map((c) => ({ ...c, memory: forSubject(c.memory, subject.id) }))
    .filter((c) => c.memory.workflows.length > 0)
  const refined = yield* refine(
    config,
    "cues",
    current,
    evidence,
    new Map(state.unlearned.map((r) => [r.id, r])),
    rejected,
    { repo: undefined, texts: yield* handedTexts(state.unlearned) }
  )
  const runs = [...before.runs, ...evidence.runs]
  const cued = yield* writeCues(config, withSnapshots(refined.memory, runs), runs)
  const revision = cued.memory
  const now = yield* replay(current, runs, "cues")
  const then = yield* replay(revision, runs, "cues")
  const verdict = passes(then, now)
  const costUsd = refined.costUsd + cued.costUsd
  const records = [...state.learned.map((r) => r.id), ...state.unlearned.map((r) => r.id)]
  const candidate = yield* propose(revision, records, refined.rationale, costUsd)
  if (!verdict.commit) {
    yield* store.reject(candidate.id, verdict.reason)
    return { kind: "kept", subject: subject.id, reason: `kept the memory it had: the revision ${verdict.reason}`, costUsd } satisfies LearnOutcome
  }
  const version = yield* store.commit(candidate.id)
  return {
    kind: "learned",
    subject: subject.id,
    version,
    round: "evolve",
    workflows: revision.workflows.map((w) => w.name),
    pitfalls: revision.pitfalls.length,
    sessions: state.unlearned.length,
    costUsd
  } satisfies LearnOutcome
})

/** What learning cost since the start of today (local time), from the candidates it proposed. */
export const spentToday = Effect.fn("spentToday")(function*() {
  const candidates = yield* (yield* WorkflowStore).candidates()
  const now = new Date(DateTime.toEpochMillis(yield* DateTime.now))
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return candidates
    .filter((c) => Date.parse(c.created_at) >= midnight)
    .reduce((sum, c) => sum + (c.cost_usd ?? 0), 0)
})

/** A rough price for learning from `changes` changes: what the eval memories cost to build and revise. */
export const estimateUsd = (changes: number): number => 0.1 + 0.05 * changes
