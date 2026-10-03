/**
 * The workflow record: what one finished run shows, kept as evidence.
 *
 * One record per run, built once the run counts as successful, and not
 * changed afterwards except to add the model's reading of it (`model`, once)
 * and feedback on the memory it was given. Failed runs get a record with only
 * their verifiable mistakes. The memory graph is built from records and points
 * back to them.
 *
 * Parts:
 * - `run`: where and how it ran (subject, commits, cost, outcome, and a
 *   pointer to its log, which stays where the run happened);
 * - `task`: what it was asked;
 * - `files`, `files_read`, `commands`, `detours`, `checks`: the mechanical
 *   part, read from the log and the diff without any model;
 * - `memory`: for runs that were given memory, what each piece was;
 * - `model`: a model's reading (task kind, steps, landmarks, lessons), every
 *   claim checked against the code and the run before it is kept.
 *
 * Persisted as JSON with snake_case keys, like everything else on disk here.
 */
import { Schema } from "effect"
import { Trigger } from "./Triggers.ts"

export const RECORD_FORMAT = 1

export const FileChange = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  added: Schema.Int,
  removed: Schema.Int,
  /** A test snapshot (`.snap`, `__snapshots__/`): regenerated, not written. */
  snapshot: Schema.Boolean
})
export type FileChange = typeof FileChange.Type

export const CommandRun = Schema.Struct({
  command: Schema.String,
  /** What it runs (see Shell.ts): `yarn test:update`, `git diff`. */
  keys: Schema.Array(Schema.String),
  ok: Schema.Boolean,
  /** Why it failed, from its output. */
  error: Schema.NullOr(Schema.String),
  /** The model response (turn) that ran it, from 0. */
  turn: Schema.Int
})
export type CommandRun = typeof CommandRun.Type

export const FailureKind = Schema.Literals(["test_failure", "type_error", "command_error", "edit_mismatch", "not_found", "tool_error"])
export type FailureKind = typeof FailureKind.Type

/** One end of a detour: a tool call. */
export const DetourCall = Schema.Struct({
  /** Index among the run's main-thread tool calls, from 0. */
  call: Schema.Int,
  turn: Schema.Int,
  tool: Schema.String,
  /** Shell calls: the command line. */
  command: Schema.NullOr(Schema.String),
  /** Edits and reads: the file. */
  file: Schema.NullOr(Schema.String)
})
export type DetourCall = typeof DetourCall.Type

/**
 * A mistake and its fix: a call that failed, the call that finally worked,
 * and what the run spent in between.
 */
export const Detour = Schema.Struct({
  kind: FailureKind,
  failed: DetourCall,
  /** What the failure said. */
  symptom: Schema.String,
  /** Shell failures: what the failing command runs. */
  keys: Schema.Array(Schema.String),
  fixed: DetourCall,
  /** How the command changed between the two: words dropped and added. */
  removed: Schema.Array(Schema.String),
  added: Schema.Array(Schema.String),
  /** Files edited between the failure and the fix. */
  files_edited: Schema.Array(Schema.String),
  /** Failing calls in this detour, the first one included. */
  failures: Schema.Int,
  /** Tokens of the turns after the failure, up to and including the fix's. */
  cost: Schema.Struct({ tokens: Schema.Int, calls: Schema.Int, turns: Schema.Int })
})
export type Detour = typeof Detour.Type

/** A command that decided the run's outcome: an eval's checks, or a session's last tests. */
export const Check = Schema.Struct({
  command: Schema.String,
  ok: Schema.Boolean,
  exit_code: Schema.NullOr(Schema.Int)
})
export type Check = typeof Check.Type

/** A piece of memory the run was given, and what became of it. */
export const MemoryItem = Schema.Struct({
  id: Schema.String,
  /** "route", "step", "warning", or an eval setup's kind of memory ("saved-solution", "graph-step"). */
  kind: Schema.String,
  moment: Schema.Literals(["start", "trigger"]),
  /**
   * followed: the run did what it said (a step's files were touched, a
   * warning's mistake wasn't made); ignored: it made the mistake anyway or
   * skipped the step; unknown: can't tell from the log.
   */
  outcome: Schema.Literals(["followed", "ignored", "unknown"]),
  note: Schema.NullOr(Schema.String)
})
export type MemoryItem = typeof MemoryItem.Type

export const MemoryUse = Schema.Struct({
  /** The memory setup (eval runs) or "hooks". */
  setup: Schema.String,
  /** The memory graph's version, when the run got memory from it. */
  version: Schema.NullOr(Schema.Int),
  items: Schema.Array(MemoryItem)
})
export type MemoryUse = typeof MemoryUse.Type

/** A fact about the codebase that several kinds of task can use, with strings that prove it. */
export const Landmark = Schema.Struct({
  fact: Schema.String,
  file: Schema.String,
  /** Exact strings in that file: identifiers, keys, labels. Each must be there for the fact to be kept. */
  anchors: Schema.Array(Schema.String)
})
export type Landmark = typeof Landmark.Type

export const StepOrigin = Schema.Literals(["asked", "needed", "chosen"])
export type StepOrigin = typeof StepOrigin.Type

/** One step of the run's path, as the model named it. */
export const RecordStep = Schema.Struct({
  /** General words, the same across tasks that share the step ("list the shortcut in the help dialog"). */
  name: Schema.String,
  purpose: Schema.String,
  /** asked: the task asked for it; needed: the change required it though the task didn't say; chosen: the agent's own extra. */
  origin: StepOrigin,
  files: Schema.Array(Schema.String),
  /** The command that checked it, if one did. */
  check: Schema.NullOr(Schema.String),
  landmarks: Schema.Array(Landmark)
})
export type RecordStep = typeof RecordStep.Type

/** What a detour teaches, in general words, and when to say it. */
export const Lesson = Schema.Struct({
  /** Index into the record's detours. */
  detour: Schema.Int,
  lesson: Schema.String,
  /** The step it happened in (a step name). */
  step: Schema.NullOr(Schema.String),
  trigger: Schema.NullOr(Trigger)
})
export type Lesson = typeof Lesson.Type

export const FalseLead = Schema.Struct({
  what: Schema.String,
  file: Schema.NullOr(Schema.String),
  anchors: Schema.Array(Schema.String)
})
export type FalseLead = typeof FalseLead.Type

export const ModelPart = Schema.Struct({
  model: Schema.String,
  created_at: Schema.String,
  cost_usd: Schema.NullOr(Schema.Number),
  kind: Schema.Struct({ name: Schema.String, description: Schema.String }),
  /** What the task asked for and ruled out, in its own terms. */
  asked: Schema.Array(Schema.String),
  ruled_out: Schema.Array(Schema.String),
  /** Values that belong to this task only (the feature's name, the key): not to be carried to other tasks. */
  values: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  steps: Schema.Array(RecordStep),
  lessons: Schema.Array(Lesson),
  false_leads: Schema.Array(FalseLead),
  /** Which test files cover what. */
  tests: Schema.Array(Schema.Struct({ file: Schema.String, covers: Schema.String })),
  /** Claims the model made that didn't hold against the code or the run, and why. */
  dropped: Schema.Array(Schema.String)
})
export type ModelPart = typeof ModelPart.Type

export const RunInfo = Schema.Struct({
  source: Schema.Literals(["eval", "session"]),
  session_id: Schema.String,
  /** The run's own log, where the run happened. */
  log: Schema.String,
  /** Eval runs: the output directory and the run in it. */
  run_dir: Schema.NullOr(Schema.String),
  run_id: Schema.NullOr(Schema.String),
  setup: Schema.NullOr(Schema.String),
  task_id: Schema.NullOr(Schema.String),
  /** The working directory it ran in. */
  repo: Schema.NullOr(Schema.String),
  base_commit: Schema.NullOr(Schema.String),
  /** Sessions: the commit that holds the change. */
  head_commit: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["success", "failure"]),
  started_at: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Number),
  tokens: Schema.NullOr(Schema.Int),
  turns: Schema.Int,
  tool_calls: Schema.Int,
  models: Schema.Array(Schema.String)
})
export type RunInfo = typeof RunInfo.Type

export const WorkflowRecord = Schema.Struct({
  format: Schema.Literal(RECORD_FORMAT),
  id: Schema.String,
  tenant: Schema.String,
  /** The repo it's about (see Subjects). */
  subject: Schema.String,
  created_at: Schema.String,
  run: RunInfo,
  task: Schema.Struct({ prompt: Schema.String, followups: Schema.Array(Schema.String) }),
  files: Schema.Array(FileChange),
  files_read: Schema.Array(Schema.String),
  commands: Schema.Array(CommandRun),
  detours: Schema.Array(Detour),
  checks: Schema.Array(Check),
  memory: Schema.NullOr(MemoryUse),
  model: Schema.NullOr(ModelPart)
})
export type WorkflowRecord = typeof WorkflowRecord.Type

/** Source files the run changed: snapshots aside. */
export const sourceFiles = (r: WorkflowRecord): Array<string> => r.files.filter((f) => !f.snapshot).map((f) => f.path)
