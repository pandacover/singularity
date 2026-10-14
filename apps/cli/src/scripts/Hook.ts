/**
 * The UserPromptSubmit hook for saved scripts: at a session's first prompt,
 * hand over the stored change most like the task (Start.ts). Later prompts in
 * the same session are follow-ups and get nothing; a marker file per session
 * (`<tenant>/scripts/sessions/`) says the first prompt was seen.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Path } from "effect"
import { decodeHookInput } from "../handover/HookInput.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { safeId } from "../workflows/Session.ts"
import { startScripts } from "./Start.ts"

export const userPromptSubmit = (stdin: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.prompt === undefined || input.prompt.trim() === "") return undefined
      const home = yield* loadHome()
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = path.join(home.tenantDir, "scripts", "sessions")
      const marker = path.join(dir, safeId(input.session_id))
      if (yield* fs.exists(marker)) return undefined
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(marker, input.prompt)
      const result = yield* startScripts(
        { sessionId: input.session_id, prompt: input.prompt, cwd: input.cwd ?? process.cwd() },
        { tenantDir: home.tenantDir }
      ).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
      if (result.text === undefined) return undefined
      return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "UserPromptSubmit", additionalContext: result.text } })
    }).pipe(Effect.provide(NodeServices.layer))
  )
