/**
 * What memory does in the background, after a hook returned: storing a
 * commit's record (`record commits`) and learning (`learn --auto`). A hook
 * starts the CLI as a detached process (node's own spawn: effect/process
 * children end with their scope), with its output appended to a log in the
 * memory home. A lock file keeps two runs of one kind from overlapping.
 *
 * Plain node, no Effect: a hook loads this on its way out.
 */
import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** The CLI, next to this directory. */
export const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url))

/** A lock older than this belongs to a run that died. */
const STALE_LOCK_MS = 60 * 60 * 1000

const lockFile = (root: string, name: string) => join(root, name)

/** Whether a run holds the lock now. */
export const lockHeld = (root: string, name = "learn.lock"): boolean => {
  const file = lockFile(root, name)
  if (!existsSync(file)) return false
  try {
    return Date.now() - statSync(file).mtimeMs < STALE_LOCK_MS
  } catch {
    return false
  }
}

/** Take the lock for this process; false if another run holds it. */
export const takeLock = (root: string, name = "learn.lock"): boolean => {
  const file = lockFile(root, name)
  if (lockHeld(root, name)) return false
  try {
    rmSync(file, { force: true })
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", { flag: "wx" })
    return true
  } catch {
    return false
  }
}

export const releaseLock = (root: string, name = "learn.lock"): void => {
  try {
    const held = JSON.parse(readFileSync(lockFile(root, name), "utf-8")) as { pid?: unknown }
    if (held.pid === process.pid) rmSync(lockFile(root, name), { force: true })
  } catch {
    // Not ours, or gone already.
  }
}

/** Start `singularity <args>` in the background, its output appended to `<home>/<log>`. */
export const startInBackground = (root: string, args: ReadonlyArray<string>, log = "learn.log"): void => {
  const out = openSync(join(root, log), "a")
  try {
    const child = spawn(process.execPath, [CLI, ...args], {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      // The run's own model calls turn memory's hooks off themselves (Agent.ts).
      env: process.env
    })
    child.unref()
  } finally {
    closeSync(out)
  }
}
