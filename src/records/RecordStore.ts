/**
 * Storage interface for workflow records and the subjects they're about.
 *
 * One store per tenant. Records are evidence: written once, then only given
 * the model's reading (once) and feedback on the memory the run used. Queries
 * are shaped for a database: callers ask for the records they need by
 * subject, task kind, step or exact key.
 *
 * Implementations are layers: `JsonRecordStore.layer(dir, tenant)` keeps
 * records in JSON files.
 */
import { Context, type Effect } from "effect"
import type { Conflict, StoreError } from "../graph/Errors.ts"
import type { RepoIdentity } from "../local/Git.ts"
import type { RecordExists, RecordNotFound } from "./Errors.ts"
import type { MemoryUse, ModelPart, WorkflowRecord } from "./Models.ts"
import type { Subject } from "./Subjects.ts"

export interface RecordQuery {
  readonly subject?: string | undefined
  readonly outcome?: "success" | "failure" | undefined
  readonly source?: "eval" | "session" | undefined
  /** The task kind the model named, ignoring case. */
  readonly kind?: string | undefined
  /** A step the model named, ignoring case. */
  readonly step?: string | undefined
  /** Text that one of the record's exact keys contains (see Keys.ts). */
  readonly key?: string | undefined
  /** Only records with (true) or without (false) the model's reading. */
  readonly annotated?: boolean | undefined
}

export class RecordStore extends Context.Service<RecordStore, {
  readonly tenant: string

  // --- subjects ---

  subjects(): Effect.Effect<ReadonlyArray<Subject>, StoreError>
  /**
   * The subject `repo` belongs to, recording any new remote, root commit or
   * path. With `create`, a repo no subject matches becomes a new subject;
   * otherwise it gives undefined.
   */
  subjectFor(repo: RepoIdentity, options?: { readonly create?: boolean }): Effect.Effect<Subject | undefined, StoreError>

  // --- records ---

  /** Store a new record. */
  put(record: WorkflowRecord): Effect.Effect<void, RecordExists | StoreError>
  get(id: string): Effect.Effect<WorkflowRecord, RecordNotFound | StoreError>
  has(id: string): Effect.Effect<boolean, StoreError>
  /** Records matching every given field, oldest first. */
  find(query?: RecordQuery): Effect.Effect<ReadonlyArray<WorkflowRecord>, StoreError>
  /** Add the model's reading. A record that has one keeps it, unless `replace`. */
  annotate(
    id: string,
    model: ModelPart,
    options?: { readonly replace?: boolean }
  ): Effect.Effect<WorkflowRecord, RecordNotFound | Conflict | StoreError>
  /** Add feedback on memory the run used, after the record was built. */
  addFeedback(id: string, memory: MemoryUse): Effect.Effect<WorkflowRecord, RecordNotFound | StoreError>
}>()("singularity/records/RecordStore") {}
