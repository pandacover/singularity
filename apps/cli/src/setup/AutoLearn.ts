/**
 * Learning on its own: after memory stores a change, the repo gets a learning
 * round when the user turned it on, the repo has enough new changes, and what
 * today's limit leaves covers the round's estimate.
 *
 * Rounds go one at a time. A round asked for while another runs waits in the
 * queue, each repo once, and the running one takes it next, checking it again
 * then: what the round before read isn't read twice (Background.ts). The
 * rounds run in a detached `singularity learn --auto`, which outlives what
 * started it, writes to `<home>/learn.log` and holds `<home>/learn.lock`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer, Path } from "effect"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { budgetReason, learnState, roundUsd, spentToday, waitReason } from "../workflows/Learn.ts"
import { learningQueue, lockHeld, queueLearning, startInBackground } from "./Background.ts"
import { readLearn } from "./Preferences.ts"

export { CLI, lockHeld, releaseLock, startInBackground, takeLock } from "./Background.ts"

/**
 * After a change of `subject` was stored: ask for a learning round if it is
 * time for one, and start the rounds unless they are running. Eval runs turn
 * this off (`SINGULARITY_AUTOLEARN=off`): a measurement never pays for
 * learning.
 */
export const afterRecord = (subject: string): Promise<"started" | "queued" | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      if (process.env.SINGULARITY_AUTOLEARN === "off") return undefined
      const home = yield* loadHome()
      const prefs = yield* readLearn(home.root)
      if (!prefs.auto) return undefined
      const path = yield* Path.Path
      const stores = Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
      )
      const ready = yield* Effect.gen(function*() {
        const state = yield* learnState(subject)
        if (waitReason(state, prefs.every, false) !== undefined) return false
        return budgetReason(roundUsd(state), yield* spentToday(), prefs.max_usd_per_day) === undefined
      }).pipe(Effect.provide(stores))
      if (ready) queueLearning(home.root, subject)
      // Rounds left in the queue by a run that died start here too.
      if (learningQueue(home.root).length === 0) return undefined
      if (lockHeld(home.root)) return ready ? "queued" : undefined
      startInBackground(home.root, ["learn", "--auto"])
      return ready ? "started" : undefined
    }).pipe(Effect.provide(NodeServices.layer))
  )
