/**
 * Storage interface for memory v1 of one tenant.
 *
 * A linear history of committed versions starting at 0 (empty). A build or a
 * refinement is proposed as a candidate holding the whole memory it would
 * make (memory is small), with what checked it; then it is committed or
 * rejected. Rejected candidates are kept with the reason, so later
 * refinements can avoid proposing them again (the Procedural Graphs paper's
 * rejection memory).
 *
 * Implementations are layers: `JsonWorkflowStore.layer(dir, tenant)`.
 */
import { Context, type Effect, Schema } from "effect"
import type { CandidateNotFound, Conflict, StoreError } from "../graph/Errors.ts"
import { WorkflowMemory } from "./Models.ts"

/** How well a memory fits the runs it is checked against (Replay.ts). */
export const ReplayNumbers = Schema.Struct({
  /** Runs replayed, and the places their edits went. */
  runs: Schema.Int,
  edited: Schema.Int,
  /** Of those, at a place the hand-over would have shown. */
  shown_and_edited: Schema.Int,
  /** Places it would have shown that the run left alone. */
  shown_unused: Schema.Int,
  /** Workflows it would have handed over in total. */
  workflows: Schema.Int
})
export type ReplayNumbers = typeof ReplayNumbers.Type

export const GateReport = Schema.Struct({
  /** What the mechanical checks found and dropped. */
  problems: Schema.Array(Schema.String),
  replay: Schema.NullOr(ReplayNumbers)
})
export type GateReport = typeof GateReport.Type

export const WorkflowCandidate = Schema.Struct({
  id: Schema.String,
  base_version: Schema.Int,
  memory: WorkflowMemory,
  /** Why the model proposed it, in its words. */
  rationale: Schema.String,
  /** The records it learned from. */
  records: Schema.Array(Schema.String),
  model: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Number),
  report: Schema.NullOr(GateReport),
  status: Schema.Literals(["pending", "committed", "rejected"]),
  reason: Schema.String,
  committed_version: Schema.NullOr(Schema.Int),
  created_at: Schema.String
})
export type WorkflowCandidate = typeof WorkflowCandidate.Type

/** undefined: the head; a number: that committed version; a string: that candidate's memory. */
export type At = number | string | undefined

export interface ProposeOptions {
  readonly baseVersion?: number | undefined
  readonly rationale: string
  readonly records: ReadonlyArray<string>
  readonly model?: string | undefined
  readonly costUsd?: number | undefined
  readonly report?: GateReport | undefined
}

export class WorkflowStore extends Context.Service<WorkflowStore, {
  readonly tenant: string
  head(): Effect.Effect<number, StoreError>
  memory(at?: At): Effect.Effect<WorkflowMemory, StoreError | CandidateNotFound>
  propose(memory: WorkflowMemory, options: ProposeOptions): Effect.Effect<WorkflowCandidate, StoreError>
  /** Make a pending candidate the head. Fails with Conflict if the head moved or it isn't pending. */
  commit(candidateId: string): Effect.Effect<number, StoreError | CandidateNotFound | Conflict>
  reject(candidateId: string, reason: string): Effect.Effect<void, StoreError | CandidateNotFound | Conflict>
  candidates(status?: WorkflowCandidate["status"]): Effect.Effect<ReadonlyArray<WorkflowCandidate>, StoreError>
}>()("singularity/workflows/WorkflowStore") {}
