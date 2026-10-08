/**
 * Storage interface for the memory graph of one tenant.
 *
 * Versioned like the graph store: a linear history of committed versions
 * starting at 0 (empty); a build is proposed as a candidate (edits against a
 * base version, with the replay report that judged it), then committed or
 * rejected. Rejected candidates are kept, with the reason.
 *
 * Reads are query-shaped for a database: the kinds and warnings a subject may
 * get, items by id, and any item's evidence. `at` reads a past version or a
 * candidate instead of the head.
 *
 * Implementations are layers: `JsonMemoryStore.layer(dir, tenant)`.
 */
import { Context, type Effect, Schema } from "effect"
import type { CandidateNotFound, Conflict, StoreError } from "../graph/Errors.ts"
import type { GraphEdits, Item, Kind, MemoryGraph, Step, Warning } from "./Models.ts"
import { GraphEdits as GraphEditsSchema } from "./Models.ts"

/** The replay numbers a candidate was judged by (see Replay.ts). */
export const ReplaySummary = Schema.Struct({
  tasks: Schema.Int,
  wrong_kind: Schema.Int,
  extra: Schema.Int,
  unasked: Schema.Int,
  missing: Schema.Int,
  detours: Schema.Int,
  warned: Schema.Int,
  /** Older candidates didn't count them. */
  false_alarms: Schema.optionalKey(Schema.Int)
})
export type ReplaySummary = typeof ReplaySummary.Type

export const MemoryCandidate = Schema.Struct({
  id: Schema.String,
  base_version: Schema.Int,
  edits: GraphEditsSchema,
  rationale: Schema.String,
  /** The records the build used. */
  records: Schema.Array(Schema.String),
  replay: Schema.NullOr(ReplaySummary),
  status: Schema.Literals(["pending", "committed", "rejected"]),
  reason: Schema.String,
  committed_version: Schema.NullOr(Schema.Int),
  created_at: Schema.String
})
export type MemoryCandidate = typeof MemoryCandidate.Type

/** undefined: the head; a number: that committed version; a string: that candidate's view. */
export type At = number | string | undefined

export interface ProposeOptions {
  readonly baseVersion?: number | undefined
  readonly rationale: string
  readonly records: ReadonlyArray<string>
  readonly replay?: ReplaySummary | undefined
}

export class MemoryStore extends Context.Service<MemoryStore, {
  readonly tenant: string
  head(): Effect.Effect<number, StoreError>
  /** The whole graph: for building and checking, not for handing over. */
  graph(at?: At): Effect.Effect<MemoryGraph, StoreError | CandidateNotFound>
  /** The kinds `subject` may get (by reach). `tools`: what the subject's repo uses. */
  kinds(subject: string, options?: { readonly at?: At; readonly tools?: ReadonlySet<string> }): Effect.Effect<ReadonlyArray<Kind>, StoreError | CandidateNotFound>
  /** The warnings `subject` may get. */
  warnings(subject: string, options?: { readonly at?: At; readonly tools?: ReadonlySet<string> }): Effect.Effect<ReadonlyArray<Warning>, StoreError | CandidateNotFound>
  /** Steps by id; missing ids are left out. */
  steps(ids: Iterable<string>, at?: At): Effect.Effect<ReadonlyArray<Step>, StoreError | CandidateNotFound>
  item(id: string, at?: At): Effect.Effect<Item | undefined, StoreError | CandidateNotFound>

  propose(edits: GraphEdits, options: ProposeOptions): Effect.Effect<MemoryCandidate, StoreError>
  /** Make a pending candidate the head. Fails with Conflict if the head moved or it isn't pending. */
  commit(candidateId: string): Effect.Effect<number, StoreError | CandidateNotFound | Conflict>
  reject(candidateId: string, reason: string): Effect.Effect<void, StoreError | CandidateNotFound | Conflict>
  candidates(status?: MemoryCandidate["status"]): Effect.Effect<ReadonlyArray<MemoryCandidate>, StoreError>
}>()("singularity/memory/MemoryStore") {}
