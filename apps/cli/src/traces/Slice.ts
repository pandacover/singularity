/**
 * Part of a session's log: the prompts, model responses and tool calls
 * between two moments. A session that commits several changes becomes
 * several records, each with the part of the log that led to its commit
 * (workflows/Commits.ts); whoever reads a record's log later reads that part
 * again (records/Segment.ts).
 */
import { DateTime } from "effect"
import type { Trace } from "./Models.ts"

export interface TraceWindow {
  /** Epoch milliseconds, exclusive; undefined from the session's start. */
  readonly from: number | undefined
  /** Epoch milliseconds, inclusive. */
  readonly to: number
}

const millis = (t: DateTime.Utc | undefined): number | undefined => (t === undefined ? undefined : DateTime.toEpochMillis(t))

const inside = (w: TraceWindow, t: number | undefined): t is number => t !== undefined && (w.from === undefined || t > w.from) && t <= w.to

/**
 * The trace's events inside `window`. Its prompts are those typed in the
 * window, led by the one still being worked on when it opened, if the
 * window's first step came before any prompt of its own. The session's
 * running cost covers the whole session, so a part has none.
 */
export const sliceTrace = (trace: Trace, window: TraceWindow): Trace => {
  const prompts = trace.prompts.filter((p) => inside(window, millis(p.timestamp)))
  const toolCalls = trace.toolCalls.filter((c) => inside(window, millis(c.startedAt)))
  const responses = trace.responses.filter((r) => inside(window, millis(r.timestamp)))
  const firstStep = Math.min(...[...toolCalls.map((c) => millis(c.startedAt)!), ...responses.map((r) => millis(r.timestamp)!)])
  const firstPrompt = prompts.length === 0 ? Infinity : millis(prompts[0].timestamp)!
  const ongoing = window.from === undefined || firstStep >= firstPrompt
    ? undefined
    : trace.prompts.filter((p) => {
      const t = millis(p.timestamp)
      return t !== undefined && t <= window.from!
    }).at(-1)
  const times = [
    ...prompts.map((p) => millis(p.timestamp)!),
    ...toolCalls.map((c) => millis(c.startedAt)!),
    ...responses.map((r) => millis(r.timestamp)!)
  ]
  const whole = window.from === undefined && (millis(trace.endedAt) ?? Infinity) <= window.to
  return {
    ...trace,
    prompts: ongoing === undefined ? prompts : [ongoing, ...prompts],
    responses,
    toolCalls,
    apiErrors: whole ? trace.apiErrors : 0,
    costState: whole ? trace.costState : undefined,
    startedAt: times.length === 0 ? undefined : DateTime.makeUnsafe(Math.min(...times)),
    endedAt: times.length === 0 ? undefined : DateTime.makeUnsafe(Math.max(...times))
  }
}
