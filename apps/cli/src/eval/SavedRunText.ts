/**
 * A saved run as the eval's `scripts` setup hands it over (SavedScripts.ts):
 * its task, its files, the project commands it ran, the mistakes it and other
 * saved runs in its files made, and its diff, file by file, hand-written
 * source first, until the room runs out. Daily use handed a stored change
 * over this way until 2026-10-24, and points to its commit now
 * (scripts/Render.ts); a saved run was never committed, so there is nothing
 * to point to, and runs of this setup stay comparable with earlier ones.
 * Pure.
 */
import type { Detour } from "../records/Models.ts"
import { fileKind, inlineCode, isSnapshot } from "../scripts/Render.ts"

/** The room a hand-over had: Claude Code cuts a hook's text at 10,000 characters. */
export const SAVED_RUN_CHARS = 9800
const MAX_PROMPT_CHARS = 1500
const MAX_MISTAKES = 4

/** Lines a diff chunk adds and removes. */
export const countLines = (chunk: string): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const line of chunk.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

/** Mistakes of shell commands, with the command that then worked. */
export const mistakesToShow = (detours: ReadonlyArray<Detour>): Array<string> => {
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const d of detours) {
    const failed = d.failed.command?.trim()
    if (failed === undefined || failed === "" || failed.includes("\n") || seen.has(failed)) continue
    seen.add(failed)
    const symptom = d.symptom.replace(/\s+/g, " ").trim().slice(0, 200)
    const fixed = d.fixed.command?.trim()
    const then = fixed === undefined || fixed === "" || fixed === failed || fixed.includes("\n") ? "" : ` What worked instead: ${inlineCode(fixed.slice(0, 200))}`
    out.push(`- ${inlineCode(failed.slice(0, 200))} failed: ${symptom}.${then}`)
    if (out.length === MAX_MISTAKES) break
  }
  return out
}

/**
 * At most this share of the saved runs may have touched a file for it to
 * link two of them (`tellingFiles`): a file most runs touch (a test file
 * every change extends, an app's main component) says little about a run.
 */
export const MAX_FILE_SHARE = 0.2

/**
 * Whether a file says something about the runs that changed it: code or a
 * test (not `fileKind` "rest", nor a snapshot) that at most `MAX_FILE_SHARE`
 * of the runs touched, `least` at least. Linking two runs by a file they
 * share (`mistakesNearby`) takes two.
 */
export const tellingFiles = (docs: ReadonlyArray<{ readonly files: ReadonlyArray<string> }>, least = 1): (file: string) => boolean => {
  const changes = new Map<string, number>()
  for (const d of docs) for (const f of new Set(d.files)) changes.set(f, (changes.get(f) ?? 0) + 1)
  const most = Math.max(least, Math.floor(MAX_FILE_SHARE * docs.length))
  return (f) => fileKind(f) !== "rest" && !isSnapshot(f) && (changes.get(f) ?? 0) <= most
}

/**
 * Mistakes other saved runs made, newest first, from those that changed at
 * least one of `files`, not the ones `own` already says. Callers pass only
 * the files that mark a part of the code (`tellingFiles`): through a README
 * most changes edit, one session's failed command reached every later
 * hand-over, and agents ran it.
 */
export const mistakesNearby = (
  files: ReadonlyArray<string>,
  others: ReadonlyArray<{ readonly files: ReadonlyArray<string>; readonly mistakes: ReadonlyArray<string> }>,
  own: ReadonlyArray<string>
): Array<string> => {
  const mine = new Set(files)
  const out: Array<string> = []
  for (const o of others) {
    if (!o.files.some((f) => mine.has(f))) continue
    for (const m of o.mistakes) if (!own.includes(m) && !out.includes(m)) out.push(m)
  }
  return out.slice(0, MAX_MISTAKES)
}

export interface SavedRunView {
  readonly prompt: string
  /** The files it changed, with the lines each change adds and removes; snapshots are named, never shown. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly added: number; readonly removed: number; readonly snapshot: boolean }>
  /** Commands worth repeating (scripts/Render.ts `commandsToShow`) and mistakes (`mistakesToShow`), as shown. */
  readonly commands: ReadonlyArray<string>
  readonly mistakes: ReadonlyArray<string>
  /** Mistakes other saved runs made in the files this one changed (`mistakesNearby`). */
  readonly nearby: ReadonlyArray<string>
  /** The change, one chunk per file (`diff --git` onwards), snapshots left out. */
  readonly diff: ReadonlyArray<{ readonly path: string; readonly text: string }>
}

const KINDS = ["source", "test", "rest"] as const

/** Below this, a file's share of the room shows too little of it to help: its file line says it all. */
const MIN_SHOWN = 200

/** The largest length each of `sizes` may keep so that together they fit in `room`. */
export const shareOf = (sizes: ReadonlyArray<number>, room: number): number => {
  if (sizes.reduce((a, b) => a + b, 0) <= room) return Math.max(0, ...sizes)
  let lo = 0
  let hi = Math.max(0, ...sizes)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (sizes.reduce((a, x) => a + Math.min(x, mid), 0) <= room) lo = mid
    else hi = mid - 1
  }
  return lo
}

const fileLine = (f: SavedRunView["files"][number]): string => `- ${f.path} (+${f.added} -${f.removed})`

export const renderSavedRun = (s: SavedRunView, budget = SAVED_RUN_CHARS): string => {
  const prompt = s.prompt.length > MAX_PROMPT_CHARS ? s.prompt.slice(0, MAX_PROMPT_CHARS) + " …" : s.prompt
  const sources = s.files.filter((f) => !f.snapshot)
  const snapshots = s.files.filter((f) => f.snapshot)
  const head = [
    "# A past change in this repository like your task",
    "",
    "An earlier task here asked for something like yours. " +
    "Use it as a worked example where it applies: names, values and details of your task differ, " +
    "and your task may need more or less than it did.",
    "",
    "## Its task",
    "",
    prompt.trim(),
    "",
    "## Files it changed",
    "",
    ...sources.map(fileLine)
  ]
  if (snapshots.length > 0) head.push("", "Snapshots it regenerated:", "", ...snapshots.map(fileLine))
  if (s.commands.length > 0) head.push("", "## Project commands it ran, in order", "", s.commands.map((c) => inlineCode(c)).join(", "))
  if (s.mistakes.length > 0) head.push("", "## Mistakes it made", "", ...s.mistakes)
  if (s.nearby.length > 0) head.push("", "## Mistakes other changes to these files made", "", ...s.nearby)
  const intro = head.join("\n")

  // Hand-written source gets the room first: whole when it fits, else each
  // source file an equal share (`shareOf`), cut at the same length, so one
  // large file can't crowd out the others. Tests share what's left, then docs,
  // examples and config (`fileKind`). A file left too little shows only its
  // file line.
  const open = "\n\n## Its change\n\n```diff\n"
  const close = "```\n"
  let room = budget - intro.length - open.length - close.length - 300
  const chunks = s.diff.map((c) => ({
    path: c.path,
    kind: fileKind(c.path),
    text: c.text.replace(/^index .*\n/m, "").replace(/\n*$/, "\n")
  }))
  const shown: Array<string> = []
  for (const kind of KINDS) {
    const these = chunks.filter((c) => c.kind === kind)
    const cap = shareOf(these.map((c) => c.text.length), Math.max(0, room))
    for (const c of these) {
      if (c.text.length <= cap) {
        shown.push(c.text)
        room -= c.text.length
      } else if (cap >= MIN_SHOWN) {
        const lines = c.text.slice(0, cap).split("\n").slice(0, -1).join("\n")
        const part = lines + `\n… (${c.text.slice(lines.length).split("\n").length - 2} more lines)\n`
        shown.push(part)
        room -= part.length
      }
    }
  }
  const out = shown.length > 0 ? intro + open + shown.join("") + close : intro
  return out.length <= budget ? out : out.slice(0, budget - 40) + "\n… (cut for room)\n"
}
