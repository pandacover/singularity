/**
 * The free check of the warnings handed over during tasks: replay recorded
 * sessions through the trigger matcher, call by call, as the hook would have
 * run, and see when each warning would have arrived.
 *
 * A warning is never replayed against the runs it was learned from: there it
 * would only be told its own mistake.
 *
 * For each detour a warning is about (its trigger fits the detour, see
 * Build.ts), the warning arrives:
 * - before: at an earlier call (an edit that wrote the bug, before the test
 *   that shows it): this is where it saves turns;
 * - at: at the failing call itself (a bad command): it explains the failure
 *   but can't save the turn; such warnings pay off at task start instead;
 * - never.
 * A firing that comes before no detour it fits is a false alarm.
 */
import type { ToolCall, Trace } from "../traces/index.ts"
import { triggerMismatch } from "../records/Annotate.ts"
import { relativizer } from "../records/Extract.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { eventOfCall, matchTrigger } from "../records/Triggers.ts"
import { causes } from "./Build.ts"
import type { MemoryGraph, Warning } from "./Models.ts"
import { reaches } from "./Models.ts"

export interface WarningReplay {
  readonly warning: string
  readonly lesson: string
  /** Detours in other runs that the warning is about. */
  readonly detours: number
  readonly before: number
  readonly at: number
  /** Tokens those detours cost, where the warning came before them. */
  readonly tokensBefore: number
  readonly falseAlarms: number
}

export interface TriggerReport {
  readonly runs: number
  readonly warnings: ReadonlyArray<WarningReplay>
}

export const replayTriggers = (
  graph: MemoryGraph,
  records: ReadonlyArray<WorkflowRecord>,
  traces: ReadonlyMap<string, Trace>
): TriggerReport => {
  const stats = new Map<string, { w: Warning; detours: number; before: number; at: number; tokensBefore: number; falseAlarms: number }>()
  const withTriggers = graph.warnings.filter((w) => w.trigger !== null)
  for (const w of withTriggers) stats.set(w.id, { w, detours: 0, before: 0, at: 0, tokensBefore: 0, falseAlarms: 0 })
  let runs = 0
  for (const r of records) {
    const trace = traces.get(r.id)
    if (trace === undefined) continue
    runs++
    const relative = relativizer(trace.cwd)
    const calls: ReadonlyArray<ToolCall> = trace.toolCalls.filter((c) => c.agentId === undefined)
    const events = calls.map((c) => eventOfCall(c, relative))
    const event = (c: ToolCall | undefined) => (c === undefined ? undefined : eventOfCall(c, relative))
    for (const w of withTriggers) {
      if (w.evidence.includes(r.id) || !reaches(w.reach, r.subject)) continue
      const s = stats.get(w.id)!
      // The hook warns once a session: at the first call the trigger matches.
      const fired = events.findIndex((e) => matchTrigger(w.trigger!, e))
      const about = r.detours.filter((d) =>
        causes(w.trigger!, d) && triggerMismatch(w.trigger!, calls, d.failed.call, d.fixed.call, event) === undefined
      )
      s.detours += about.length
      for (const d of about) {
        if (fired >= 0 && fired < d.failed.call) {
          s.before++
          s.tokensBefore += d.cost.tokens
        } else if (fired === d.failed.call) {
          s.at++
        }
      }
      if (fired >= 0 && !about.some((d) => fired <= d.failed.call)) s.falseAlarms++
    }
  }
  return {
    runs,
    warnings: [...stats.values()].map((s) => ({
      warning: s.w.id,
      lesson: s.w.lesson,
      detours: s.detours,
      before: s.before,
      at: s.at,
      tokensBefore: s.tokensBefore,
      falseAlarms: s.falseAlarms
    }))
  }
}

export const describeTriggerReport = (r: TriggerReport): string => {
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const lines = [`Replayed ${r.runs} recorded runs through the warnings' triggers (each warning only against runs it wasn't learned from).`, ""]
  for (const w of r.warnings) {
    lines.push(`- ${w.lesson.slice(0, 110)}${w.lesson.length > 110 ? "..." : ""} (${w.warning})`)
    lines.push(
      `  ${w.detours} detours it is about: before the mistake in ${w.before} (${k(w.tokensBefore)} tokens of detour), ` +
        `at the failing call in ${w.at}, never in ${w.detours - w.before - w.at}; ${w.falseAlarms} false alarms`
    )
  }
  return lines.join("\n")
}
