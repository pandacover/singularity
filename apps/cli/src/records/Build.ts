/**
 * Build a workflow record from a finished run: its log, its diff and how it
 * ended. No model is involved; `Annotate.ts` adds the model's reading later.
 *
 * A failed run keeps only its verifiable mistakes: detours (a failure and the
 * fix the run found) and the commands that failed. What it changed or read,
 * and where, isn't evidence of how the task gets done.
 */
import type { Trace } from "../traces/index.ts"
import { extractMechanical } from "./Extract.ts"
import type { Check, MemoryUse, RunInfo, WorkflowRecord } from "./Models.ts"
import { RECORD_FORMAT } from "./Models.ts"
import { spotsOfDiff } from "./Spots.ts"

/** One record per session: the subject, then the start of the session id. */
export const recordId = (subject: string, sessionId: string): string => `${subject}-${sessionId.slice(0, 8)}`

/** One record per commit, for sessions in daily use: the subject, then the start of the commit's hash (longer than a session's, so the two never meet). */
export const commitRecordId = (subject: string, commit: string): string => `${subject}-${commit.slice(0, 12)}`

export interface BuildInput {
  readonly tenant: string
  readonly subject: string
  readonly trace: Trace
  /** The run's change, as a git diff. */
  readonly diff: string
  readonly outcome: "success" | "failure"
  readonly checks: ReadonlyArray<Check>
  readonly memory: MemoryUse | null
  /** Where the run came from; turns, tool calls and models come from the log. */
  readonly run: Omit<RunInfo, "outcome" | "turns" | "tool_calls" | "models" | "session_id">
  readonly createdAt: string
  /** The record's id, when it isn't the session's (a commit's: commitRecordId). */
  readonly id?: string | undefined
}

export const buildRecord = (input: BuildInput): WorkflowRecord => {
  const success = input.outcome === "success"
  const m = extractMechanical(input.trace, input.diff, { succeeded: success })
  const [first, ...rest] = input.trace.prompts.map((p) => p.text.trim())
  return {
    format: RECORD_FORMAT,
    id: input.id ?? recordId(input.subject, input.trace.sessionId),
    tenant: input.tenant,
    subject: input.subject,
    created_at: input.createdAt,
    run: {
      ...input.run,
      session_id: input.trace.sessionId,
      outcome: input.outcome,
      turns: m.turns,
      tool_calls: m.toolCalls,
      models: m.models
    },
    task: { prompt: first ?? "", followups: rest },
    files: success ? m.files : [],
    spots: success ? spotsOfDiff(input.diff) : [],
    files_read: success ? m.filesRead : [],
    commands: success ? m.commands : m.commands.filter((c) => !c.ok),
    detours: m.detours,
    checks: [...input.checks],
    memory: input.memory,
    model: null
  }
}
