/**
 * The PostToolUse and PostToolUseFailure hook for memory v1: after each tool
 * call, warn when a pitfall's exact trigger appears, once per pitfall per
 * session. Runs after every call, so it loads only the file system, never git
 * or a model.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { DateTime, Effect, Layer } from "effect"
import { decodeHookInput, eventOfHook } from "../handover/HookInput.ts"
import { loadHome } from "../local/Home.ts"
import { matchTrigger, type ToolEvent } from "../records/Triggers.ts"
import type { Pitfall } from "./Models.ts"
import { appendFired, logHandover, readFired, readSession } from "./Session.ts"

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** Pitfalls whose trigger this event matches and that haven't fired yet this session. */
export const firing = (triggers: ReadonlyArray<Pitfall>, fired: ReadonlySet<string>, event: ToolEvent): Array<Pitfall> =>
  triggers.filter((p) => p.trigger !== null && !fired.has(p.id) && matchTrigger(p.trigger, event))

export const renderWarning = (pitfalls: ReadonlyArray<Pitfall>): string =>
  [
    "Memory from earlier tasks in this repository: what you just did matches a mistake made before.",
    ...pitfalls.map((p) => `- ${p.text}`)
  ].join("\n")

export const onToolEvent = Effect.fn("workflows.onToolEvent")(function*(tenantDir: string, sessionId: string, event: ToolEvent) {
  const state = yield* readSession(tenantDir, sessionId)
  if (state === undefined || state.triggers.length === 0) return undefined
  const fired = new Set((yield* readFired(tenantDir, sessionId)).map((f) => f.pitfall))
  const now = firing(state.triggers, fired, event)
  if (now.length === 0) return undefined
  const at = DateTime.formatIso(yield* DateTime.now)
  yield* appendFired(tenantDir, sessionId, now.map((p) => ({ pitfall: p.id, at, tool: event.tool })))
  yield* logHandover(tenantDir, {
    at,
    session_id: sessionId,
    moment: "trigger",
    subject: state.subject,
    version: state.version,
    pitfalls: now.map((p) => p.id),
    tool: event.tool,
    command: event.command?.slice(0, 200) ?? null,
    file: event.file ?? null
  })
  return renderWarning(now)
})

/** The hook's stdout: JSON with the warning for the model, or nothing. */
export const postToolUse = (stdin: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined) return undefined
      const home = yield* loadHome()
      const state = yield* readSession(home.tenantDir, input.session_id)
      if (state === undefined) return undefined
      const event = eventOfHook(input, state.repo ?? input.cwd)
      if (event === undefined) return undefined
      const text = yield* onToolEvent(home.tenantDir, input.session_id, event)
      if (text === undefined) return undefined
      const hookEventName = input.hook_event_name === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse"
      return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } })
    }).pipe(Effect.provide(layer))
  )
