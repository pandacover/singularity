/**
 * The UserPromptSubmit hook for memory v1: at a session's first prompt, hand
 * over the workflows the task needs (Start.ts). Later prompts in the same
 * session are follow-ups and get nothing.
 *
 * Local first: unless `SINGULARITY_SELECTOR` says otherwise (or is `cues`),
 * workflows are picked by memory's cues with no model call, and the blanks
 * the task states are filled in (Cues.ts); memory without cues is picked by
 * words. `SINGULARITY_SELECTOR=off` picks by words alone; `=model` (or `on`,
 * as the measured `workflows` setup sets it) has a model pick, the one
 * `SINGULARITY_SELECTOR_MODEL` names (default sonnet).
 * `SINGULARITY_DRAFTER=on` hands over the change itself, written at task start
 * by `SINGULARITY_DRAFTER_MODEL` (default sonnet; Draft.ts).
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
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
export const DEFAULT_DRAFTER_MODEL = "sonnet"

/** How `SINGULARITY_SELECTOR` has workflows picked: a model call (`on`, `model`), words (`off`), else cues (local first). */
export const pickMode = (setting: string | undefined): "model" | "words" | "cues" =>
  setting === "on" || setting === "model" ? "model" : setting === "off" ? "words" : "cues"

/**
 * How many hooks carry the hand-over (`SINGULARITY_HANDOVER_PARTS`, 1 or 2):
 * Claude Code cuts each hook's text at 10,000 characters on its own, so a
 * second hook doubles the room. Only without a model call, so both hooks
 * compute the same hand-over.
 */
export const handoverParts = (setting: string | undefined, mode: "model" | "words" | "cues"): number =>
  setting === "2" && mode !== "model" ? 2 : 1

/**
 * `part` 1 hands over the first part and keeps the session's state; part 2,
 * from a second hook running alongside, computes the same hand-over without
 * keeping anything and hands over the rest, if there is any. `partsSetting`
 * is how many parts there are (the hook's `--parts=`, else
 * `SINGULARITY_HANDOVER_PARTS`). The output names the event the agent sent
 * (Gemini CLI's is BeforeAgent).
 */
export const userPromptSubmit = (stdin: string, part: 1 | 2 = 1, partsSetting = process.env.SINGULARITY_HANDOVER_PARTS): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.prompt === undefined || input.prompt.trim() === "") return undefined
      const home = yield* loadHome()
      const mode = pickMode(process.env.SINGULARITY_SELECTOR)
      const parts = handoverParts(partsSetting, mode)
      if (part > parts) return undefined
      const session = yield* readSession(home.tenantDir, input.session_id)
      // A follow-up prompt gets nothing; part 2 may find the session part 1 just started for this very prompt.
      if (session !== undefined && (part === 1 || session.prompt !== input.prompt)) return undefined
      const path = yield* Path.Path
      const cues = mode === "cues"
      const selector = mode !== "model"
        ? undefined
        : {
          claude: yield* defaultClaude(),
          cwd: path.join(defaultWorkspaces(), "_learner"),
          model: process.env.SINGULARITY_SELECTOR_MODEL || DEFAULT_SELECTOR_MODEL
        }
      const drafter = process.env.SINGULARITY_DRAFTER !== "on"
        ? undefined
        : {
          claude: yield* defaultClaude(),
          cwd: path.join(defaultWorkspaces(), "_learner"),
          model: process.env.SINGULARITY_DRAFTER_MODEL || DEFAULT_DRAFTER_MODEL
        }
      const stores = Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
      )
      const result = yield* startTask(
        { sessionId: input.session_id, prompt: input.prompt, cwd: input.cwd ?? process.cwd() },
        { tenantDir: home.tenantDir, selector, drafter, cues, parts, persist: part === 1 }
      ).pipe(Effect.provide(stores))
      const text = result.text === undefined ? undefined : result.parts[part - 1]
      if (text === undefined) return undefined
      return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "UserPromptSubmit", additionalContext: text } })
    }).pipe(Effect.provide(NodeServices.layer))
  )
