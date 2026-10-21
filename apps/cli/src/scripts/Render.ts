/**
 * A stored change as the agent reads it. At a task's start, a pointer
 * (`renderPointer`): its commit, what it was for in a line, and its files as
 * they are called today, no diff; git has the diff, and the agent reads the
 * files as they are now anyway. In full (`renderScript`, for `singularity
 * changes` and `recall`): the past task, its files, the commands that worked,
 * the mistakes it made with what worked instead, and its change, file by
 * file, hand-written source first, until the room runs out; the rest is named
 * with the command that shows it. A file rewritten since says so instead of
 * showing its change. Pure: Start.ts reads the record and git.
 */
import type { CommandRun, Detour, FileChange } from "../records/Models.ts"
import { taskShown } from "../records/Task.ts"
import { isRequest } from "../traces/Requests.ts"

/** Claude Code cuts a hook's text at 10,000 characters; the hand-over stays under that. */
export const MAX_HANDOVER_CHARS = 9800
const MAX_PROMPT_CHARS = 1500
const MAX_COMMANDS = 8
const MAX_MISTAKES = 4
const MAX_COMMAND_CHARS = 200

/**
 * `text` as inline code, which a command with backticks in it (PowerShell's
 * escapes, a shell's substitutions) would break: fenced with one backtick
 * more than its longest run of them, and spaced off one at either end
 * (CommonMark).
 */
export const inlineCode = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(longest + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

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

/** What became of a file's change since, when it isn't simply there (Fresh.ts). */
export type FileFate =
  | { readonly kind: "moved"; readonly to: string }
  | { readonly kind: "stale"; readonly last: { readonly hash: string; readonly title: string } | null }

/** A file the script changed, and where it is today. */
export interface FileNow extends FileChange {
  /** Today's path when it was renamed since; null when it no longer exists. Same as `path` otherwise. */
  readonly now: string | null
  /** Its code moved to another file, or was rewritten since (its chunk is then left out). */
  readonly fate?: FileFate | undefined
}

export interface ScriptView {
  readonly prompt: string
  /** Its commit message (records/Task.ts), shown as its task when the prompt asked for nothing. */
  readonly message?: string | undefined
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
 * already says. Callers pass only the files that mark a part of the code
 * (Search.ts `tellingFiles`): through a README most changes edit, one
 * session's failed command reached every later hand-over, and agents ran it.
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
    const then = fixed === undefined || fixed === "" || fixed === failed || fixed.includes("\n") ? "" : ` What worked instead: ${inlineCode(fixed.slice(0, 200))}`
    out.push(`- ${inlineCode(failed.slice(0, 200))} failed: ${symptom}.${then}`)
    if (out.length === MAX_MISTAKES) break
  }
  return out
}

const fileLine = (f: FileNow): string => {
  const counts = `+${f.added} -${f.removed}`
  if (f.fate?.kind === "moved") return `- ${f.path} (${counts}; its code is in ${f.fate.to} now)`
  if (f.fate?.kind === "stale") {
    const since = f.fate.last === null ? "it has changed since" : `it has changed since, last in ${f.fate.last.hash} "${f.fate.last.title}"`
    return `- ${f.now ?? f.path} (${counts}; ${since}: its change isn't shown, read the file as it is now)`
  }
  if (f.now === null) return `- ${f.path} (${counts}; no longer exists)`
  if (f.now !== f.path) return `- ${f.now} (${counts}; was ${f.path} then)`
  return `- ${f.path} (${counts})`
}

/**
 * What a changed file is, for who gets the room first: hand-written source,
 * then tests, then the rest (docs, examples, fixtures, snapshots, config).
 * By path alone:
 * - rest: under a doc(s)/, example(s)/, fixture(s)/, snapshot(s)/ or
 *   __snapshots__/ folder; prose (.md, .mdx, .txt, .rst, .adoc); config and
 *   data (.json, .yml, .yaml, .toml, .ini, .lock, .cfg, .xml, .csv, .snap);
 *   a dotfile or a file in a dot-folder (.github/, .eslintrc);
 * - test: under a test(s)/, __tests__/ or spec(s)/ folder, or named
 *   *.test.*, *.spec.*, test_*.py, *_test.go or *_test.py;
 * - source: everything else.
 * Rest wins over test, so test fixtures are rest.
 */
export const fileKind = (path: string): "source" | "test" | "rest" => {
  const p = path.replace(/\\/g, "/").toLowerCase()
  if (
    /(^|\/)(docs?|examples?|fixtures?|snapshots?|__snapshots__)\//.test(p) ||
    /\.(md|mdx|markdown|txt|rst|adoc|json|jsonc|ya?ml|toml|ini|lock|cfg|xml|csv|snap)$/.test(p) ||
    /(^|\/)\./.test(p)
  ) return "rest"
  if (/(^|\/)(tests?|__tests__|specs?)\//.test(p) || /\.(test|spec)\.[^/]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.(go|py)$/.test(p)) {
    return "test"
  }
  return "source"
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

export const renderScript = (s: ScriptView, budget = MAX_HANDOVER_CHARS): string => {
  const sha = s.commit?.slice(0, 10)
  // When no prompt asked for it ("yes", "commit and open a PR"), its commit message says what it was for.
  const asked = taskShown(s)
  const prompt = asked.length > MAX_PROMPT_CHARS ? asked.slice(0, MAX_PROMPT_CHARS) + " …" : asked
  const sources = s.files.filter((f) => !f.snapshot)
  const snapshots = s.files.filter((f) => f.snapshot)
  const committed = sha === undefined ? "" : `, and its change was committed as ${sha}`
  const head = [
    "# A past change in this repository like your task",
    "",
    `An earlier task here asked for something like yours${committed}. ` +
    "Use it as a worked example where it applies: names, values and details of your task differ, " +
    "and your task may need more or less than it did.",
    "",
    asked === s.prompt ? "## Its task" : "## Its task, as its commit message says",
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
  // file line; the change is a git command away. Files rewritten or deleted
  // since (Fresh.ts), their code nowhere else, aren't shown at all: their
  // change would mislead.
  const open = "\n\n## Its change\n\n```diff\n"
  const close = "```\n"
  let room = budget - intro.length - open.length - close.length - 300
  const stale = new Set(s.files.filter((f) => f.fate?.kind === "stale" || (f.now === null && f.fate === undefined)).map((f) => f.path))
  const chunks = s.diff.filter((c) => !stale.has(c.path)).map((c) => ({
    path: c.path,
    kind: fileKind(c.path),
    text: c.text.replace(/^index .*\n/m, "").replace(/\n*$/, "\n")
  }))
  const cut: Array<string> = []
  const left: Array<string> = []
  const shown: Array<string> = []
  const groups = KINDS.map((kind) => chunks.filter((c) => c.kind === kind))
  for (const these of groups) {
    const cap = shareOf(these.map((c) => c.text.length), Math.max(0, room))
    for (const c of these) {
      if (c.text.length <= cap) {
        shown.push(c.text)
        room -= c.text.length
      } else if (cap < MIN_SHOWN) {
        left.push(c.path)
      } else {
        cut.push(c.path)
        const lines = c.text.slice(0, cap).split("\n").slice(0, -1).join("\n")
        const part = lines + `\n… (${c.text.slice(lines.length).split("\n").length - 2} more lines)\n`
        shown.push(part)
        room -= part.length
      }
    }
  }
  let out = intro
  if (shown.length > 0) out += open + shown.join("") + close
  if (sha !== undefined) {
    if (left.length > 0) {
      const named = left.length > 8 ? `${left.slice(0, 8).join(", ")} and ${left.length - 8} more` : left.join(", ")
      out += `\nNot shown for room: ${named} (\`git show ${sha} -- <file>\`).\n`
    }
    if (cut.length > 0) out += `\nThe whole change: \`git show ${sha}\` (add \`-- <file>\` for one file).\n`
  }
  return out.length <= budget ? out : out.slice(0, budget - 40) + "\n… (cut for room)\n"
}

/** A stored change as a task's start points to it: what it was for, its commit, its files as they are today. */
export interface PointerView {
  readonly prompt: string
  readonly message?: string | undefined
  readonly commit: string
  readonly files: ReadonlyArray<FileNow>
}

/** Files named in a pointer; a change of sixty translation files names the rest by count. */
const MAX_POINTER_FILES = 12
const MAX_LINE_CHARS = 200

/** A file as a pointer names it: no word of a change shown or not, since none is. */
const pointerFileLine = (f: FileNow): string => {
  const counts = `+${f.added} -${f.removed}`
  if (f.fate?.kind === "moved") return `- ${f.path} (${counts}; its code is in ${f.fate.to} now)`
  if (f.fate?.kind === "stale") {
    const last = f.fate.last === null ? "" : `, last in ${f.fate.last.hash} "${f.fate.last.title}"`
    return `- ${f.now ?? f.path} (${counts}; it has changed since${last})`
  }
  if (f.now === null) return `- ${f.path} (${counts}; no longer exists)`
  if (f.now !== f.path) return `- ${f.now} (${counts}; was ${f.path} then)`
  return `- ${f.path} (${counts})`
}

/**
 * A stored change as a task's start hands it over: its commit, the first
 * line of what it was for (its task, or its commit message when the prompt
 * asked for nothing), and the files it changed as they are called today.
 * No diff: `git show` has it, and reading that commit brings what git
 * doesn't show about it (History.ts).
 */
export const renderPointer = (p: PointerView): string => {
  const sha = p.commit.slice(0, 10)
  const first = taskShown(p).trim().split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? ""
  const line = first.length > MAX_LINE_CHARS ? first.slice(0, MAX_LINE_CHARS - 1) + "…" : first
  const sources = p.files.filter((f) => !f.snapshot)
  const snapshots = p.files.length - sources.length
  const out = [
    "# A past change in this repository like your task",
    "",
    `An earlier task here asked for something like yours, committed as ${sha}: "${line}". ` +
    "Names, values and details of your task differ, and it may need more or less than that one did.",
    "",
    `\`git show ${sha}\` shows its change (add \`-- <file>\` for one file); memory then adds what git doesn't show about it.`,
    "",
    "Files it changed:",
    "",
    ...sources.slice(0, MAX_POINTER_FILES).map(pointerFileLine)
  ]
  if (sources.length > MAX_POINTER_FILES) out.push(`- and ${sources.length - MAX_POINTER_FILES} more`)
  if (snapshots > 0) out.push(`- ${snapshots === 1 ? "1 snapshot" : `${snapshots} snapshots`} it regenerated`)
  return out.join("\n") + "\n"
}

/** A stored change as the agent reads it beside its commit, which it just read in git (History.ts). */
export interface BehindView {
  readonly commit: string
  readonly prompt: string
  readonly commands: ReadonlyArray<string>
  readonly mistakes: ReadonlyArray<string>
  readonly nearby: ReadonlyArray<string>
}

/**
 * What git doesn't show about a commit the agent just read with `git show`
 * or `git log` (Start.ts `commitHandover`): the request that asked for it,
 * when one did (else its commit message was its task, and git has that), the
 * project commands its session ran, and the mistakes it and other changes to
 * its files made. Not its diff or its files: the agent has them. Undefined
 * when memory knows none of these.
 */
export const renderBehind = (b: BehindView, budget = MAX_HANDOVER_CHARS): string | undefined => {
  const asked = isRequest(b.prompt) ? b.prompt.trim() : undefined
  const what = [
    ...(asked === undefined ? [] : ["what it was asked"]),
    ...(b.commands.length > 0 ? ["the project commands it ran"] : []),
    ...(b.mistakes.length > 0 ? ["the mistakes it made"] : []),
    ...(b.nearby.length > 0 ? ["mistakes other changes to its files made"] : [])
  ]
  if (what.length === 0) return undefined
  const sha = b.commit.slice(0, 10)
  const list = what.length === 1 ? what[0] : `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}`
  const out = [`# What git doesn't show about ${sha}`, "", `Memory kept the session that made ${sha}, which you just read in git: ${list}.`]
  if (asked !== undefined) out.push("", "## What it was asked", "", asked.length > MAX_PROMPT_CHARS ? asked.slice(0, MAX_PROMPT_CHARS) + " …" : asked)
  if (b.commands.length > 0) out.push("", "## Project commands it ran, in order", "", b.commands.map((c) => inlineCode(c)).join(", "))
  if (b.mistakes.length > 0) out.push("", "## Mistakes it made", "", ...b.mistakes)
  if (b.nearby.length > 0) out.push("", "## Mistakes other changes to its files made", "", ...b.nearby)
  const text = out.join("\n") + "\n"
  return text.length <= budget ? text : text.slice(0, budget - 40) + "\n… (cut for room)\n"
}
