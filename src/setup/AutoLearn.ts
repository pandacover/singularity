/**
 * Learning on its own: after the session-end hook records a session, a
 * background `singularity learn --auto` starts when the user turned it on,
 * the repo has enough new sessions, today's learning stayed under the daily
 * limit, and no other round is running.
 *
 * The hook returns at once and the round outlives it, so it is a detached
 * process (node's own spawn: effect/process children end with their scope).
 * It writes to `<home>/learn.log` and holds `<home>/learn.lock` while it
 * runs, so two sessions ending together start one round.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Path } from "effect"
import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { learnState, spentToday, waitReason } from "../workflows/Learn.ts"
import { readLearn } from "./Preferences.ts"

/** The CLI, next to this directory. */
export const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url))

/** A lock older than this belongs to a round that died. */
const STALE_LOCK_MS = 60 * 60 * 1000

const lockFile = (root: string) => join(root, "learn.lock")

/** Whether a round is running now. */
export const lockHeld = (root: string): boolean => {
  const file = lockFile(root)
  if (!existsSync(file)) return false
  try {
    return Date.now() - statSync(file).mtimeMs < STALE_LOCK_MS
  } catch {
    return false
  }
}

/** Take the lock for this process; false if another round holds it. */
export const takeLock = (root: string): boolean => {
  const file = lockFile(root)
  if (lockHeld(root)) return false
  try {
    rmSync(file, { force: true })
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", { flag: "wx" })
    return true
  } catch {
    return false
  }
}

export const releaseLock = (root: string): void => {
  try {
    const held = JSON.parse(readFileSync(lockFile(root), "utf-8")) as { pid?: unknown }
    if (held.pid === process.pid) rmSync(lockFile(root), { force: true })
  } catch {
    // Not ours, or gone already.
  }
}

/** Start `singularity <args>` in the background, its output appended to `<home>/learn.log`. */
export const startInBackground = (root: string, args: ReadonlyArray<string>): void => {
  const log = openSync(join(root, "learn.log"), "a")
  try {
    const child = spawn(process.execPath, [CLI, ...args], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      // The round's own model calls turn memory's hooks off themselves (Agent.ts).
      env: process.env
    })
    child.unref()
  } finally {
    closeSync(log)
  }
}

/**
 * After a session of `subject` was recorded: start a learning round if it is
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
