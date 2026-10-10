/**
 * The UserPromptSubmit hook: at a session's first prompt, hand over the
 * route and warnings for the task (TaskStart.ts). Later prompts in the same
 * session are follow-ups and get nothing.
 *
 * `SINGULARITY_SELECTOR=off` skips the model that confirms the route (word
 * search alone then decides, on a clear match); `SINGULARITY_SELECTOR_MODEL`
 * picks it (default sonnet).
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer, Path } from "effect"
import { defaultClaude } from "../eval/Agent.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { DEFAULT_SELECTOR_MODEL } from "../eval/StepSelector.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonMemoryStore from "../memory/JsonMemoryStore.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { decodeHookInput } from "./HookInput.ts"
import { readSession } from "./Session.ts"
import { taskStart } from "./TaskStart.ts"

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
        JsonMemoryStore.layer(path.join(home.tenantDir, "memory"), home.tenant)
      )
      const result = yield* taskStart(
        { sessionId: input.session_id, prompt: input.prompt, cwd: input.cwd ?? process.cwd() },
        { tenantDir: home.tenantDir, selector }
      ).pipe(Effect.provide(stores))
      if (result.text === undefined) return undefined
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.text } })
    }).pipe(Effect.provide(NodeServices.layer))
  )
