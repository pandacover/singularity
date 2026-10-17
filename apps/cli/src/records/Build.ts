/**
 * Build a workflow record from a finished run: its log, its diff and how it
 * ended. No model is involved; `Annotate.ts` adds the model's reading later.
 *
 * A failed run keeps only its verifiable mistakes: detours (a failure and the
 * fix the run found) and the commands that failed. What it changed or read,
 * and where, isn't evidence of how the task gets done.
 *
 * Its task is what the person wrote (traces/Prompts.ts), never the notices
 * and other text the tools around them sent, and of that, the prompt that
 * asked for something (Task.ts), with the commit message when there is one.
 */
import { isRequest } from "../traces/Requests.ts"
import { personPrompts, personTask, type Trace } from "../traces/index.ts"
import { extractMechanical } from "./Extract.ts"
import type { Check, MemoryUse, RunInfo, WorkflowRecord } from "./Models.ts"
import { RECORD_FORMAT } from "./Models.ts"
import { spotsOfDiff } from "./Spots.ts"
import { taskOf } from "./Task.ts"

/**
 * A record as its task's person wrote it, led by the prompt that asked:
 * records stored before the filters kept the notices and other text tools
 * sent (Prompts.ts), and took the first prompt for the task even when it was
 * "yes" (Task.ts). Applied wherever stored records are read; the stored
 * files stay as they were.
 */
export const withPersonTask = (r: WorkflowRecord): WorkflowRecord => {
  const person = personTask([r.task.prompt, ...r.task.followups])
  const task = taskOf([person.prompt, ...person.followups].filter((p) => p !== ""))
  return { ...r, task: r.task.message === undefined ? task : { ...task, message: r.task.message } }
}

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
  /** The change's commit message (Task.ts `changeMessage`), for a committed change. */
  readonly message?: string | undefined
  /** What was asked when no prompt of `trace` asks for anything: the session's last prompt that did, before it. */
  readonly asked?: string | undefined
}

export const buildRecord = (input: BuildInput): WorkflowRecord => {
  const success = input.outcome === "success"
  const m = extractMechanical(input.trace, input.diff, { succeeded: success })
  // What the person wrote: notices and other text the tools sent are no part of the task (Prompts.ts).
  const prompts = personPrompts(input.trace.prompts).map((p) => p.text)
  const chosen = taskOf(prompts)
  const task = !isRequest(chosen.prompt) && input.asked !== undefined ? { prompt: input.asked, followups: prompts } : chosen
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
    task: input.message === undefined || input.message === "" ? task : { ...task, message: input.message },
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
