/**
 * A record's own part of its session's log: the whole log, or for a commit's
 * record (`run.segment`), the part from the session's previous commit to this
 * one (traces/Slice.ts). Whatever reads a record's log again reads this.
 */
import { Effect } from "effect"
import { parseSession, sliceTrace, type Trace, type TraceWindow } from "../traces/index.ts"
import type { WorkflowRecord } from "./Models.ts"

/** The record's window on its log, if it is part of one. */
export const windowOf = (r: WorkflowRecord): TraceWindow | undefined => {
  const s = r.run.segment
  if (s === undefined) return undefined
  const to = Date.parse(s.to)
  const from = s.from === null ? undefined : Date.parse(s.from)
  if (Number.isNaN(to) || (from !== undefined && Number.isNaN(from))) return undefined
  return { from, to }
}

/** The record's part of a parsed log. */
export const ownPart = (r: WorkflowRecord, trace: Trace): Trace => {
  const w = windowOf(r)
  return w === undefined ? trace : sliceTrace(trace, w)
}

/** The record's part of its log, read from disk. */
export const recordTrace = Effect.fn("recordTrace")(function*(r: WorkflowRecord) {
  return ownPart(r, yield* parseSession(r.run.log))
})
