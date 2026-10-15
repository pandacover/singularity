/**
 * The hooks for saved scripts. At a session's first prompt (UserPromptSubmit),
 * hand over the stored change most like the task (Start.ts). Later prompts in
 * the same session are follow-ups and get nothing; a marker file per session
 * (`<tenant>/scripts/sessions/`) says the first prompt was seen. When the
 * first prompt got nothing, the session watches files instead (Watch.ts):
 * after the tool call that first edits one of them (PostToolUse), hand over
 * a stored change to that file.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Path } from "effect"
import { rmSync, writeFileSync } from "node:fs"
import { decodeHookInput } from "../handover/HookInput.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { safeId } from "../workflows/Session.ts"
import { fileHandover, startScripts } from "./Start.ts"
import { type Call, sweepWatches, takeWatch, type Watch, watchDir, watchPath } from "./Watch.ts"

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
        { tenantDir: home.tenantDir, watch: true }
      ).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
      sweepWatches(home.root)
      if (result.watch !== undefined) {
        const watch: Watch = { root: result.watch.root, tenant: home.tenant, tenant_dir: home.tenantDir, prompt: input.prompt, files: result.watch.files }
        yield* fs.makeDirectory(watchDir(home.root), { recursive: true })
        yield* fs.writeFileString(watchPath(home.root, input.session_id), JSON.stringify(watch) + "\n")
      }
      if (result.text === undefined) return undefined
      return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "UserPromptSubmit", additionalContext: result.text } })
    }).pipe(Effect.provide(NodeServices.layer))
  )

/**
 * The tool-call hook's hand-over for a call that edited `edited`, a file the
 * session watches (Watch.ts `editedFile`). The watch is taken first, so a
 * call at the same time finds none; it ends with a hand-over, and otherwise
 * goes on watching its other files.
 */
export const handOverFile = async (
  found: { readonly path: string; readonly watch: Watch; readonly call: Call },
  edited: string
): Promise<string | undefined> => {
  const taken = takeWatch(found.path)
  if (taken === undefined) return undefined
  const { watch, call } = found
  let text: string | undefined
  try {
    const result = await Effect.runPromise(
      fileHandover(
        {
          sessionId: typeof call.session_id === "string" ? call.session_id : "",
          prompt: watch.prompt,
          cwd: watch.root,
          file: edited,
          ids: watch.files[edited] ?? []
        },
        { tenantDir: watch.tenant_dir }
      ).pipe(Effect.provide(JsonRecordStore.layer(watch.tenant_dir, watch.tenant)), Effect.provide(NodeServices.layer))
    )
    text = result.text
  } finally {
    // Nothing handed over for this file: watch the others.
    const rest = Object.fromEntries(Object.entries(watch.files).filter(([f]) => f !== edited))
    if (text === undefined && Object.keys(rest).length > 0) writeFileSync(found.path, JSON.stringify({ ...watch, files: rest }) + "\n")
    rmSync(taken, { force: true })
  }
  if (text === undefined) return undefined
  const hookEventName = typeof call.hook_event_name === "string" ? call.hook_event_name : "PostToolUse"
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } })
}
