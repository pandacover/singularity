/**
 * The hook door of the memory layer's step and end calls for web sessions
 * (src/layer/Api.ts): what the hook entry point (src/workflows/hook.ts) runs
 * after every browser call of a session the web reader handed memory to, and
 * at its end. Loads only what a step needs.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Path } from "effect"
import { decodeHookInput } from "../handover/HookInput.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { webEnd } from "./End.ts"
import { webStep } from "./Step.ts"

const fsLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** After a browser call: pointers and warnings for the agent, as the hook's JSON, or nothing. */
export const webPostToolUse = (stdin: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.tool_name === undefined) return undefined
      const home = yield* loadHome()
      const path = yield* Path.Path
      const text = yield* webStep(
        { sessionId: input.session_id, tool: input.tool_name, toolInput: input.tool_input ?? {}, response: input.tool_response, error: input.error },
        home.tenantDir
      ).pipe(Effect.provide(JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)))
      if (text === undefined) return undefined
      return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PostToolUse", additionalContext: text } })
    }).pipe(Effect.provide(fsLayer))
  )

/**
 * At the session's end: a record with how it went unknown. Whoever knows the
 * outcome (an eval's check, the user) calls the layer's end with it, and the
 * record is written again with it.
 */
export const webSessionEnd = (stdin: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.transcript_path === undefined || input.transcript_path === null) return
      const home = yield* loadHome()
      yield* webEnd({ sessionId: input.session_id, transcript: input.transcript_path, outcome: { success: null, feedback: null } }, home.tenantDir, home.tenant)
    }).pipe(Effect.provide(NodeServices.layer))
  )
