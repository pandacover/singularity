/**
 * The hand-over mid-task, by file, as the tool-call hook sees it: plain node,
 * the hook's input read with JSON.parse alone, since the hook runs after
 * every call and almost every call ends at the first check.
 *
 * At a session's first prompt, when nothing was handed over, the hook
 * (Hook.ts) writes the files to watch for the session, each with the stored
 * changes to it, best first (Start.ts `ScriptsStart.watch`):
 *
 *     <home>/watch/<session id>.json
 *
 * After each tool call of that session, `editedFile` says whether the call
 * edited a watched file: an edit tool's file (Claude Code's Edit, Write,
 * MultiEdit and NotebookEdit; Gemini CLI's replace and write_file; Droid's
 * Create; Hermes Agent's patch and write_file), a patch's files (Codex's and
 * Droid's apply_patch), or for a shell command (agents edit with sed and
 * scripts too), a watched file the command names that git now sees changed.
 * The first such edit hands over (Hook.ts `handOverFile`, which takes the
 * watch first, so two calls at once can't both) and ends the watch: one
 * hand-over a session. A session's watch also ends with it (`endWatch`), and
 * one left by a session that never ended is swept a day later
 * (`sweepWatches`).
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

export interface Watch {
  /** The repo's root: watched paths are relative to it, with forward slashes. */
  readonly root: string
  readonly tenant: string
  readonly tenant_dir: string
  /** The task, as its first prompt asked it. */
  readonly prompt: string
  /** Each watched file, with the stored changes to it to hand over, best first. */
  readonly files: Readonly<Record<string, ReadonlyArray<string>>>
}

/** What a tool-call hook is sent, in any agent's shape: the fields read here. */
export interface Call {
  readonly session_id?: unknown
  readonly hook_event_name?: unknown
  readonly cwd?: unknown
  readonly tool_name?: unknown
  readonly tool_input?: unknown
}

/** A session id as a file name, as workflows/Session.ts `safeId` makes one. */
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_")

export const watchDir = (home: string) => join(home, "watch")
export const watchPath = (home: string, sessionId: string) => join(watchDir(home), `${safeId(sessionId)}.json`)

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isWatch = (w: unknown): w is Watch => {
  if (typeof w !== "object" || w === null) return false
  const { root, tenant, tenant_dir, prompt, files } = w as Record<string, unknown>
  return typeof root === "string" && typeof tenant === "string" && typeof tenant_dir === "string" && typeof prompt === "string" &&
    typeof files === "object" && files !== null &&
    Object.values(files).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))
}

/** A hook's session id, read without parsing the whole input. */
const SESSION = /"session_id"\s*:\s*"([^"\\]+)"/

/** The watch of the session a hook's input is from, and the call, when it has one. */
export const watchOf = (home: string, stdin: string): { readonly path: string; readonly watch: Watch; readonly call: Call } | undefined => {
  const id = SESSION.exec(stdin)?.[1]
  if (id === undefined) return undefined
  const path = watchPath(home, id)
  if (!existsSync(path)) return undefined
  const watch = parse(readFileSync(path, "utf-8"))
  const call = parse(stdin)
  if (!isWatch(watch) || typeof call !== "object" || call === null) return undefined
  return { path, watch, call: call as Call }
}

/** Tools that only read: a path they're given isn't an edit. */
const READS = /^(Read|Glob|Grep|LS|View|read_file|read_many_files|list_directory|glob|search_file_content|grep)$/

/** A patch's files: apply_patch's `*** Update File:` and `*** Add File:` lines, and a diff's `+++ b/` ones. */
const patchedFiles = (text: string): Array<string> =>
  [...text.matchAll(/^(?:\*\*\* (?:Update|Add) File: (.+?)|\+\+\+ b\/(.+?))\s*$/gm)].map((m) => m[1] ?? m[2])

/** Every string in a value. */
const stringsIn = (value: unknown, out: Array<string> = []): Array<string> => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out)
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) stringsIn(v, out)
  return out
}

/** The watched files among `paths` that git sees changed (or new) in the work tree; none when git can't say. */
const changedNow = (root: string, paths: ReadonlyArray<string>): Set<string> => {
  try {
    const out = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true
    })
    const changed = new Set<string>()
    const fields = out.split("\0")
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]
      if (f.length < 4) continue
      changed.add(f.slice(3))
      // A rename's or copy's entry is followed by its old path.
      if (f[0] === "R" || f[0] === "C") i++
    }
    return changed
  } catch {
    return new Set()
  }
}

/** The watched file a tool call edited, if any (the first, in the watch's order, when it edited several). */
export const editedFile = (call: Call, watch: Watch): string | undefined => {
  const input = call.tool_input
  if (typeof input !== "object" || input === null) return undefined
  const fields = input as Record<string, unknown>
  const files = Object.keys(watch.files)
  const cwd = typeof call.cwd === "string" && call.cwd !== "" ? call.cwd : watch.root
  const inRepo = (p: string): string | undefined => {
    const rel = relative(watch.root, resolve(cwd, p)).replace(/\\/g, "/")
    return rel === "" || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel
  }
  const first = (paths: ReadonlyArray<string>) => {
    const mine = new Set(paths.flatMap((p) => inRepo(p) ?? []))
    return files.find((f) => mine.has(f))
  }
  const tool = typeof call.tool_name === "string" ? call.tool_name : ""
  if (READS.test(tool)) return undefined
  // An edit tool's file.
  const path = [fields.file_path, fields.path, fields.notebook_path, fields.absolute_path].find((p) => typeof p === "string" && p !== "")
  if (typeof path === "string") {
    const hit = first([path])
    if (hit !== undefined) return hit
  }
  // A patch, wherever the tool keeps it.
  const strings = stringsIn(fields)
  const patched = strings.filter((s) => s.includes("*** Begin Patch") || s.includes("\n+++ b/")).flatMap(patchedFiles)
  if (patched.length > 0) return first(patched)
  // A shell command: a watched file it names, that git sees changed now.
  const command = fields.command ?? fields.cmd
  const line = typeof command === "string" ? command : Array.isArray(command) ? command.filter((w) => typeof w === "string").join(" ") : undefined
  if (line === undefined) return undefined
  const named = files.filter((f) => line.includes(basename(f)))
  if (named.length === 0) return undefined
  const changed = changedNow(watch.root, named)
  return named.find((f) => changed.has(f))
}

/** Take a session's watch for a hand-over, so that no other call does too: the path it's at now, or undefined when another call took it first. */
export const takeWatch = (path: string): string | undefined => {
  const taken = `${path}.taken`
  try {
    renameSync(path, taken)
    return taken
  } catch {
    return undefined
  }
}

/** End the watch of the session a hook's input is from (session end). */
export const endWatch = (home: string, stdin: string): void => {
  const id = SESSION.exec(stdin)?.[1]
  if (id !== undefined) rmSync(watchPath(home, id), { force: true })
}

/** Watches older than a day: a session that ended without saying so. */
export const sweepWatches = (home: string, now = Date.now()): void => {
  const dir = watchDir(home)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > 24 * 60 * 60 * 1000) rmSync(path, { force: true })
    } catch {
      // Gone already.
    }
  }
}
