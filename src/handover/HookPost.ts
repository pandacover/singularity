/**
 * The PostToolUse and PostToolUseFailure hook: match the call against the
 * session's warning triggers. Runs after every tool call, so it loads only
 * the file system, never git or a model.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Layer } from "effect"
import { loadHome } from "../local/Home.ts"
import { decodeHookInput, eventOfHook } from "./HookInput.ts"
import { onToolEvent } from "./OnTool.ts"
import { readSession } from "./Session.ts"

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

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
