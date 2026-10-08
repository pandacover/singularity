/**
 * During a task: after each tool call, warn when a warning's exact trigger
 * appears, once per warning per session. Runs locally against the warnings
 * kept at task start; nothing is asked of a model or a server.
 */
import { DateTime, Effect } from "effect"
import type { Warning } from "../memory/Models.ts"
import type { ToolEvent } from "../records/Triggers.ts"
import { matchTrigger } from "../records/Triggers.ts"
import { appendFired, logHandover, readFired, readSession } from "./Session.ts"

/** Warnings whose trigger this event matches and that haven't fired yet this session. */
export const firing = (triggers: ReadonlyArray<Warning>, fired: ReadonlySet<string>, event: ToolEvent): Array<Warning> =>
  triggers.filter((w) => w.trigger !== null && !fired.has(w.id) && matchTrigger(w.trigger, event))

export const renderWarning = (warnings: ReadonlyArray<Warning>): string =>
  [
    "Memory from earlier tasks in this repository: what you just did matches a mistake made before.",
    ...warnings.map((w) => `- ${w.lesson}`)
  ].join("\n")

/** The text to hand the agent after this tool call, if a warning fires; records that it did. */
export const onToolEvent = Effect.fn("onToolEvent")(function*(tenantDir: string, sessionId: string, event: ToolEvent) {
  const state = yield* readSession(tenantDir, sessionId)
  if (state === undefined || state.triggers.length === 0) return undefined
  const fired = new Set((yield* readFired(tenantDir, sessionId)).map((f) => f.warning))
  const now = firing(state.triggers, fired, event)
  if (now.length === 0) return undefined
  const at = DateTime.formatIso(yield* DateTime.now)
  yield* appendFired(tenantDir, sessionId, now.map((w) => ({ warning: w.id, at, tool: event.tool })))
  yield* logHandover(tenantDir, {
    at,
    session_id: sessionId,
    moment: "trigger",
    subject: state.subject,
    version: state.version,
    warnings: now.map((w) => w.id),
    tool: event.tool,
    command: event.command?.slice(0, 200) ?? null,
    file: event.file ?? null
  })
  return renderWarning(now)
})
