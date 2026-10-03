/**
 * The UserPromptSubmit hook for memory v1: at a session's first prompt, hand
 * over the workflows the task needs (Start.ts). Later prompts in the same
 * session are follow-ups and get nothing.
 *
 * `SINGULARITY_SELECTOR=off` picks workflows by words alone, without the model;
 * `SINGULARITY_SELECTOR_MODEL` picks the model (default sonnet).
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Path } from "effect"
import { defaultClaude } from "../eval/Agent.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { decodeHookInput } from "../handover/HookInput.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import * as JsonWorkflowStore from "./JsonWorkflowStore.ts"
import { readSession } from "./Session.ts"
import { startTask } from "./Start.ts"

export const DEFAULT_SELECTOR_MODEL = "sonnet"

export const userPromptSubmit = (stdin: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.prompt === undefined || input.prompt.trim() === "") return undefined
      const home = yield* loadHome()
      if ((yield* readSession(home.tenantDir, input.session_id)) !== undefined) return undefined
      const path = yield* Path.Path
      const selector = process.env.SINGULARITY_SELECTOR === "off"
        ? undefined
        : {
          claude: yield* defaultClaude(),
          cwd: path.join(defaultWorkspaces(), "_learner"),
          model: process.env.SINGULARITY_SELECTOR_MODEL || DEFAULT_SELECTOR_MODEL
        }
      const stores = Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
      )
      const result = yield* startTask(
        { sessionId: input.session_id, prompt: input.prompt, cwd: input.cwd ?? process.cwd() },
        { tenantDir: home.tenantDir, selector }
      ).pipe(Effect.provide(stores))
      if (result.text === undefined) return undefined
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.text } })
    }).pipe(Effect.provide(NodeServices.layer))
  )
