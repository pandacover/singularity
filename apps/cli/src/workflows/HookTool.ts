/**
 * The PostToolUse and PostToolUseFailure hook for memory v1: after each tool
 * call, warn when a pitfall's exact trigger appears, once per pitfall per
 * session. Runs after every call, so it loads only the file system, never git
 * or a model.
 *
 * Other agents' hooks send their own tool names (Gemini CLI's
 * `run_shell_command`, Droid's `Execute`); they are read as Claude Code's,
 * which triggers are written against.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { DateTime, Effect, Layer } from "effect"
import { decodeHookInput, eventOfHook, type HookInput } from "../handover/HookInput.ts"
import { loadHome } from "../local/Home.ts"
import { matchTrigger, type ToolEvent } from "../records/Triggers.ts"
import type { Pitfall } from "./Models.ts"
import { appendFired, logHandover, readFired, readSession } from "./Session.ts"

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** Other agents' shell and edit tools, by Claude Code's names. */
const CLAUDE_NAMES: Readonly<Record<string, string>> = {
  run_shell_command: "Bash",
  Execute: "Bash",
  exec_command: "Bash",
  replace: "Edit",
  write_file: "Write",
  Create: "Write"
}

/** A tool call another agent reports, as Claude Code would: its name, a command as one line, an edit's new text. */
export const asClaudeCall = (input: HookInput): HookInput => {
  const name = input.tool_name === undefined ? undefined : CLAUDE_NAMES[input.tool_name] ?? input.tool_name
  const args = input.tool_input
  if (name === undefined || args === undefined) return input
  const command = args.command ?? args.cmd
  return {
    ...input,
    tool_name: name,
    tool_input: {
      ...args,
      ...(command === undefined ? {} : { command: Array.isArray(command) ? command.join(" ") : command }),
      ...(args.new_string === undefined && args.new_str !== undefined ? { new_string: args.new_str } : {})
    }
  }
}

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
      const decoded = decodeHookInput(stdin)
      if (decoded === undefined) return undefined
      const input = asClaudeCall(decoded)
      const home = yield* loadHome()
      const state = yield* readSession(home.tenantDir, input.session_id)
      if (state === undefined) return undefined
      const event = eventOfHook(input, state.repo ?? input.cwd)
      if (event === undefined) return undefined
      const text = yield* onToolEvent(home.tenantDir, input.session_id, event)
      if (text === undefined) return undefined
      const hookEventName = input.hook_event_name ?? "PostToolUse"
      return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } })
    }).pipe(Effect.provide(layer))
  )
