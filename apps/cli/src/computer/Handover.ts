/**
 * What memory hands over after a computer-use call, with Effect's files:
 * for the Claude desktop proxy (Proxy.ts) and the replay. The decisions are
 * HandoverCore.ts's, which the hook uses without Effect (HookRun.ts). Each
 * session's file says what it was handed (Store.ts `Given`).
 */
import { Effect } from "effect"
import type { Observation } from "./Calls.ts"
import { afterCall, appsNamedIn, cardsAtStart, handOverWith } from "./HandoverCore.ts"
import type { AppIndex } from "./Model.ts"
import { readGiven, readIndex, readSalt, readWords, writeGiven } from "./Store.ts"

export { handoverOff } from "./HandoverCore.ts"

/** The card and notes due after a call, joined; undefined for nothing. `yaml` is the screen it showed, read as text. */
export const handOverAfter = Effect.fn("computer.handOverAfter")(function*(
  tenantDir: string,
  session: string,
  observations: ReadonlyArray<Observation>,
  yaml: string | undefined
) {
  const before = yield* readGiven(tenantDir, session)
  const salt = yield* readSalt(tenantDir)
  const call = afterCall(before, observations, yaml, salt)
  const index = call.host === undefined || !call.acted ? undefined : yield* readIndex(tenantDir, call.host)
  const { given, texts } = handOverWith(call, index, salt, yaml)
  // The session's file also says it used these tools: written at its first call.
  if (JSON.stringify(given) !== JSON.stringify(before) || before.host === undefined) yield* writeGiven(tenantDir, session, given)
  return texts.length === 0 ? undefined : texts.join("\n\n")
})

/** The card at a task's start, when the prompt names an app memory knows (its address or a learned word); once a session. */
export const handOverAtStart = Effect.fn("computer.handOverAtStart")(function*(tenantDir: string, session: string, prompt: string) {
  const hosts = appsNamedIn(prompt, yield* readSalt(tenantDir), yield* readWords(tenantDir))
  if (hosts.length === 0) return undefined
  const indexes: Array<AppIndex> = []
  for (const host of hosts) {
    const index = yield* readIndex(tenantDir, host)
    if (index !== undefined) indexes.push(index)
  }
  if (indexes.length === 0) return undefined
  const before = yield* readGiven(tenantDir, session)
  const { given, texts } = cardsAtStart(before, indexes)
  if (given !== before) yield* writeGiven(tenantDir, session, given)
  return texts.length === 0 ? undefined : texts.join("\n\n")
})
