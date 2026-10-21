/**
 * The hooks for saved scripts. At a prompt that starts a task
 * (UserPromptSubmit; Cycle.ts: a prompt that asks for something, the
 * session's first such or the first since a commit), point to the stored
 * change most like the task, and add the repo's card of check scripts
 * earlier sessions ran (Start.ts). Other prompts get nothing: "yes",
 * "commit and open a PR", and the follow-ups of a task under way. A marker
 * file per session (`<tenant>/scripts/sessions/`) keeps the commit its last
 * task started at; the card's facts are noted next to it (`.facts`,
 * facts/Lookup.ts `givenFactsPath`), so a later task's start brings only
 * facts the session wasn't given. After a tool call that read a stored
 * commit with `git show` or `git log` (History.ts), add what git doesn't
 * show about it. Every hand-over notes its commit for the session (History.ts
 * `givenPath`); a reading skips a commit noted already. A task's start
 * doesn't: a new task may well need the same change again.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Path } from "effect"
import { addGivenFacts, givenFactsPath, readGivenFacts } from "../facts/Lookup.ts"
import { decodeHookInput } from "../handover/HookInput.ts"
import { git } from "../local/Git.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { personText } from "../traces/Prompts.ts"
import { isRequest } from "../traces/Requests.ts"
import { safeId } from "../workflows/Session.ts"
import { commandOf } from "../workflows/StoreTrigger.ts"
import { nextStep, readMarker, writeMarker } from "./Cycle.ts"
import { addGiven, commitsRead, givenPath, outputOf, readGiven } from "./History.ts"
import { commitHandover, startScripts } from "./Start.ts"

export const userPromptSubmit = (stdin: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.prompt === undefined || input.prompt.trim() === "") return undefined
      // What the person wrote, without what the tools around them added; a prompt that asks for nothing starts no task.
      const asked = personText(input.prompt)
      if (!isRequest(asked)) return undefined
      const home = yield* loadHome()
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cwd = input.cwd ?? process.cwd()
      const dir = path.join(home.tenantDir, "scripts", "sessions")
      const marker = path.join(dir, safeId(input.session_id))
      const head = yield* git(cwd, ["rev-parse", "HEAD"]).pipe(Effect.map((s) => s.trim()), Effect.orElseSucceed(() => null))
      const seen = (yield* fs.exists(marker)) ? readMarker(yield* fs.readFileString(marker)) : undefined
      const step = nextStep(seen, head)
      if (step !== "start") {
        if (step === "upgrade" && seen !== undefined) yield* fs.writeFileString(marker, writeMarker({ head, prompt: seen.prompt }))
        return undefined
      }
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(marker, writeMarker({ head, prompt: asked }))
      const facts = givenFactsPath(home.tenantDir, safeId(input.session_id))
      const result = yield* startScripts(
        { sessionId: input.session_id, prompt: asked, cwd },
        { tenantDir: home.tenantDir, pointer: true, facts: { given: readGivenFacts(facts) } }
      ).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
      if (result.picked !== null) addGiven(givenPath(home.tenantDir, safeId(input.session_id)), result.picked.commit)
      addGivenFacts(facts, result.facts)
      if (result.text === undefined) return undefined
      return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "UserPromptSubmit", additionalContext: result.text } })
    }).pipe(Effect.provide(NodeServices.layer))
  )

/**
 * The tool-call hook's hand-over for a call that read past commits with `git
 * show` or `git log` (History.ts `commitsRead`): what git doesn't show about
 * the first one memory stored that the session didn't make and wasn't given
 * (Start.ts `commitHandover`). A call that failed (PostToolUseFailure) read
 * nothing.
 */
export const handOverRead = (stdin: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.hook_event_name === "PostToolUseFailure") return undefined
      const command = commandOf(input.tool_input)
      const read = command === undefined ? undefined : commitsRead(command, outputOf(input.tool_response))
      if (command === undefined || read === undefined) return undefined
      const home = yield* loadHome()
      const given = givenPath(home.tenantDir, safeId(input.session_id))
      const result = yield* commitHandover(
        { sessionId: input.session_id, cwd: input.cwd ?? process.cwd(), command, hashes: read.hashes, revs: read.revs, given: readGiven(given) },
        { tenantDir: home.tenantDir }
      ).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
      if (result.text === undefined || result.picked === null) return undefined
      addGiven(given, result.picked.commit)
      return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PostToolUse", additionalContext: result.text } })
    }).pipe(Effect.provide(NodeServices.layer))
  )
