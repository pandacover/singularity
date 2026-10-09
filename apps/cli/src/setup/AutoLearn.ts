/**
 * Learning on its own: after memory stores a session's change, a background
 * `singularity learn --auto` starts when the user turned it on, the repo has
 * enough new changes, today's learning stayed under the daily limit, and no
 * other round is running.
 *
 * The round outlives what started it, so it is a detached process
 * (Background.ts). It writes to `<home>/learn.log` and holds
 * `<home>/learn.lock` while it runs, so two changes stored together start one
 * round.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Path } from "effect"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { learnState, spentToday, waitReason } from "../workflows/Learn.ts"
import { lockHeld, startInBackground } from "./Background.ts"
import { readLearn } from "./Preferences.ts"

export { CLI, lockHeld, releaseLock, startInBackground, takeLock } from "./Background.ts"

/**
 * After a change of `subject` was stored: start a learning round if it is
 * time for one. Eval runs turn this off (`SINGULARITY_AUTOLEARN=off`): a
 * measurement never pays for learning.
 */
export const afterRecord = (subject: string): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function*() {
      if (process.env.SINGULARITY_AUTOLEARN === "off") return false
      const home = yield* loadHome()
      const prefs = yield* readLearn(home.root)
      if (!prefs.auto || lockHeld(home.root)) return false
      const path = yield* Path.Path
      const stores = Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
      )
      const ready = yield* Effect.gen(function*() {
        if (waitReason(yield* learnState(subject), prefs.every, false) !== undefined) return false
        return (yield* spentToday()) < prefs.max_usd_per_day
      }).pipe(Effect.provide(stores))
      if (!ready) return false
      startInBackground(home.root, ["learn", "--auto", "--subject", subject])
      return true
    }).pipe(Effect.provide(NodeServices.layer))
  )
