/**
 * A saved script as the agent reads it at task start: the past task, what it
 * changed (each file as it is called today), the commands that worked, the
 * mistakes it made with what worked instead, and its change, file by file,
 * until the hand-over's room runs out; the rest is named with the command
 * that shows it. Pure: Start.ts reads the record and git.
 */
import type { CommandRun, Detour, FileChange } from "../records/Models.ts"

/** Claude Code cuts a hook's text at 10,000 characters; the hand-over stays under that. */
export const MAX_HANDOVER_CHARS = 9800
const MAX_PROMPT_CHARS = 1500
const MAX_COMMANDS = 8
const MAX_MISTAKES = 4
const MAX_COMMAND_CHARS = 200

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

/** A diff split into one chunk per file, with its path (the `b/` side). */
export const diffChunks = (diff: string): Array<{ path: string; text: string }> =>
  diff.replace(/\r\n?/g, "\n").split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git ")).map((text) => {
    const first = text.split("\n", 1)[0]
    const at = first.lastIndexOf(" b/")
    return { path: at >= 0 ? first.slice(at + 3) : first, text }
  })

export { isSnapshot } from "../records/Extract.ts"

/** A file the script changed, and where it is today. */
export interface FileNow extends FileChange {
  /** Today's path when it was renamed since; null when it no longer exists. Same as `path` otherwise. */
  readonly now: string | null
}

export interface ScriptView {
  readonly prompt: string
  /** The commit that holds it; null for an eval's saved run, which was never committed. */
  readonly commit: string | null
  readonly score: number
  readonly files: ReadonlyArray<FileNow>
  /** Commands worth repeating (`commandsToShow`) and mistakes (`mistakesToShow`), as shown. */
  readonly commands: ReadonlyArray<string>
  readonly mistakes: ReadonlyArray<string>
  /** Mistakes other stored changes made in the files this one changed (`mistakesNearby`). */
  readonly nearby: ReadonlyArray<string>
  /** The change, one chunk per file (`diff --git` onwards), snapshots left out. */
  readonly diff: ReadonlyArray<{ readonly path: string; readonly text: string }>
}

/** Commands that only look (read, list, search, git's views) teach nothing to repeat. */
const LOOKS = /^(cat|ls|dir|head|tail|grep|rg|find|wc|echo|pwd|type|sed -n|git (log|show|diff|status|blame|branch|rev-parse|ls-files))\b/

/** What a project's own tools run: the package manager's scripts, builds, test runners. */
const PROJECT_TOOL = /^(npm|yarn|pnpm|npx|bun|deno|make|cargo|go|gradle|mvn|pytest|tsc|vitest|jest|dotnet|mix|bundle|rake)\b/

/**
 * The project's commands a run used, in the order it first ran each: what it
 * runs (a record's `keys`, as `npm test`, `npm build-docs`), from the
 * commands that worked. Agents chain them in one-off shell lines and scripts,
 * so the line itself is rarely worth repeating; without keys (an eval's saved
 * run), the short single-line commands that change or check something.
 */
export const commandsToShow = (commands: ReadonlyArray<Pick<CommandRun, "command" | "ok"> & { readonly keys?: ReadonlyArray<string> }>): Array<string> => {
  const kept: Array<string> = []
  for (const c of commands) {
    if (!c.ok) continue
    if (c.keys !== undefined) {
      for (const k of c.keys) if (PROJECT_TOOL.test(k) && !kept.includes(k)) kept.push(k)
      continue
    }
    const cmd = c.command.trim()
    if (cmd === "" || cmd.includes("\n") || cmd.length > MAX_COMMAND_CHARS || LOOKS.test(cmd) || /^git (add|commit)\b/.test(cmd)) continue
    if (!kept.includes(cmd)) kept.push(cmd)
  }
  return kept.slice(0, MAX_COMMANDS)
}

/**
 * Mistakes other stored changes made, newest first, from those that changed
 * at least one of `files`: a trap seen once in a part of the code is worth
 * saying whichever change of that part is handed over. Not the ones `own`
 * already says.
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
    const then = fixed === undefined || fixed === "" || fixed === failed || fixed.includes("\n") ? "" : ` What worked instead: \`${fixed.slice(0, 200)}\``
    out.push(`- \`${failed.slice(0, 200)}\` failed: ${symptom}.${then}`)
    if (out.length === MAX_MISTAKES) break
  }
  return out
}

const fileLine = (f: FileNow): string => {
  const counts = `+${f.added} -${f.removed}`
  if (f.now === null) return `- ${f.path} (${counts}; no longer exists)`
  if (f.now !== f.path) return `- ${f.now} (${counts}; was ${f.path} then)`
  return `- ${f.path} (${counts})`
}

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

export const renderScript = (s: ScriptView, budget = MAX_HANDOVER_CHARS): string => {
  const sha = s.commit?.slice(0, 10)
  const prompt = s.prompt.length > MAX_PROMPT_CHARS ? s.prompt.slice(0, MAX_PROMPT_CHARS) + " …" : s.prompt
  const sources = s.files.filter((f) => !f.snapshot)
  const snapshots = s.files.filter((f) => f.snapshot)
  const head = [
    "# A past change in this repository like your task",
    "",
    `An earlier task here asked for something like yours${sha === undefined ? "" : `, and its change was committed as ${sha}`}. ` +
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
  if (s.commands.length > 0) head.push("", "## Project commands it ran, in order", "", s.commands.map((c) => `\`${c}\``).join(", "))
  if (s.mistakes.length > 0) head.push("", "## Mistakes it made", "", ...s.mistakes)
  if (s.nearby.length > 0) head.push("", "## Mistakes other changes to these files made", "", ...s.nearby)
  const intro = head.join("\n")

  // Every file gets a share of the room: files that fit their share whole, the
  // rest their first lines, cut at the same length. A large generated file then
  // can't crowd out the hand-written ones, and every place the change touched
  // is shown; the full change is a git command away.
  const open = "\n\n## Its change\n\n```diff\n"
  const close = "```\n"
  const room = budget - intro.length - open.length - close.length - 300
  const texts = s.diff.map((c) => c.text.replace(/^index .*\n/m, "").replace(/\n*$/, "\n"))
  const cap = shareOf(texts.map((t) => t.length), room)
  const cut: Array<string> = []
  const shown = texts.map((t, i) => {
    if (t.length <= cap) return t
    cut.push(s.diff[i].path)
    const lines = t.slice(0, cap).split("\n").slice(0, -1)
    return lines.join("\n") + `\n… (${t.slice(lines.join("\n").length).split("\n").length - 2} more lines)\n`
  }).filter((t) => cap >= 200 || t.length <= cap)
  let out = intro
  if (shown.length > 0) out += open + shown.join("") + close
  if (cut.length > 0 && sha !== undefined) out += `\nThe whole change: \`git show ${sha}\` (add \`-- <file>\` for one file).\n`
  return out.length <= budget ? out : out.slice(0, budget - 40) + "\n… (cut for room)\n"
}
