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
 * doesn't: a new task may well need the same change again. When the person
 * chose a model to pick the change (Pick.ts), Claude Code runs that pick
 * beside the start's hook, in the background (`userPromptPick`).
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Path } from "effect"
import { addGivenFacts, givenFactsPath, readGivenFacts } from "../facts/Lookup.ts"
import { decodeHookInput, type HookInput } from "../handover/HookInput.ts"
import { git } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { personText } from "../traces/Prompts.ts"
import { isRequest } from "../traces/Requests.ts"
import { safeId } from "../workflows/Session.ts"
import { commandOf } from "../workflows/StoreTrigger.ts"
import { nextStep, readMarker, writeMarker } from "./Cycle.ts"
import { addGiven, commitsRead, givenPath, outputOf, readGiven } from "./History.ts"
import { commitHandover, startScripts } from "./Start.ts"

/**
 * Whether a prompt starts a task (Cycle.ts), by a marker of its own per
 * session (`suffix`): the start's hook and the model's pick, running side by
 * side, each keep one and come to the same answer.
 */
const startsTask = Effect.fnUntraced(function*(home: Home, sessionId: string, cwd: string, asked: string, suffix: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(home.tenantDir, "scripts", "sessions")
  const marker = path.join(dir, safeId(sessionId) + suffix)
  const head = yield* git(cwd, ["rev-parse", "HEAD"]).pipe(Effect.map((s) => s.trim()), Effect.orElseSucceed(() => null))
  const seen = (yield* fs.exists(marker)) ? readMarker(yield* fs.readFileString(marker)) : undefined
  const step = nextStep(seen, head)
  if (step !== "start") {
    if (step === "upgrade" && seen !== undefined) yield* fs.writeFileString(marker, writeMarker({ head, prompt: seen.prompt }))
    return false
  }
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(marker, writeMarker({ head, prompt: asked }))
  return true
})

/** What the person wrote, when it asks for something: a prompt that asks for nothing starts no task. */
const askedIn = (input: HookInput | undefined): string | undefined => {
  if (input === undefined || input.prompt === undefined || input.prompt.trim() === "") return undefined
  // What the person wrote, without what the tools around them added.
  const asked = personText(input.prompt)
  return isRequest(asked) ? asked : undefined
}

const output = (input: HookInput, text: string | undefined) =>
  text === undefined ? undefined : JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "UserPromptSubmit", additionalContext: text } })

/**
 * The hook at a task's start. `picksBeside`: Claude Code runs the model's
 * pick (`userPromptPick`) beside this hook, so when the person chose a model
 * (local/Home.ts `Picks`) this one hands over the card alone.
 */
export const userPromptSubmit = (stdin: string, picksBeside = false): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      const asked = askedIn(input)
      if (input === undefined || asked === undefined) return undefined
      const home = yield* loadHome()
      const cwd = input.cwd ?? process.cwd()
      if (!(yield* startsTask(home, input.session_id, cwd, asked, ""))) return undefined
      const facts = givenFactsPath(home.tenantDir, safeId(input.session_id))
      const result = yield* startScripts(
        { sessionId: input.session_id, prompt: asked, cwd },
        { tenantDir: home.tenantDir, pointer: true, facts: { given: readGivenFacts(facts) }, noChange: picksBeside && home.picks !== null }
      ).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
      if (result.picked !== null) addGiven(givenPath(home.tenantDir, safeId(input.session_id)), result.picked.commit)
      addGivenFacts(facts, result.facts)
      return output(input, result.text)
    }).pipe(Effect.provide(NodeServices.layer))
  )

/**
 * The model's pick at a task's start, when the person chose a model: Claude
 * Code runs this hook in the background (setup/Agents.ts, `async`) and hands
 * what it prints to the agent at its next step, so nobody waits the seconds
 * the model takes (Pick.ts). The pointer only; the start's hook gives the
 * card. Nothing when no model was chosen.
 */
export const userPromptPick = (stdin: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      const asked = askedIn(input)
      if (input === undefined || asked === undefined) return undefined
      const home = yield* loadHome()
      if (home.picks === null) return undefined
      const cwd = input.cwd ?? process.cwd()
      if (!(yield* startsTask(home, input.session_id, cwd, asked, ".pick"))) return undefined
      const result = yield* startScripts(
        { sessionId: input.session_id, prompt: asked, cwd },
        { tenantDir: home.tenantDir, pointer: true, pick: { picks: home.picks, cwd: home.root } }
      ).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
      if (result.picked !== null) addGiven(givenPath(home.tenantDir, safeId(input.session_id)), result.picked.commit)
      return output(input, result.text)
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
