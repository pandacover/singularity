/**
 * A stored change as the agent reads it: its commit, what it was for in a
 * line, and its files as they are called today; and what git doesn't show
 * about it: what the person asked, when the commit message says too little
 * (records/Task.ts `askedShown`), and the project commands its session ran.
 *
 * - At a task's start, the pointer alone (`renderPointer`).
 * - When the agent reads the commit with `git show` or `git log`
 *   (History.ts), what git doesn't show (`renderBehind`).
 * - `singularity recall` and `singularity changes <commit>`: both
 *   (`renderFull`).
 *
 * Never its diff: git has it, and the agent reads the files as they are now
 * anyway. Never the mistakes sessions made: in real memory most were a test
 * run that failed mid-change or a scratch script of one session, and other
 * changes' were more than half of what reading a commit added (2026-10-24).
 * A file rewritten since says so on its line (Fresh.ts). Pure: Start.ts
 * reads the record and git.
 */
import type { CommandRun, FileChange } from "../records/Models.ts"
import { askedShown, changeTitle } from "../records/Task.ts"

/** Claude Code cuts a hook's text at 10,000 characters; a hand-over stays under that. */
export const MAX_HANDOVER_CHARS = 9800
const MAX_PROMPT_CHARS = 1500
const MAX_COMMANDS = 8
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
  /** Its code moved to another file, or was rewritten since. */
  readonly fate?: FileFate | undefined
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
 * What a changed file is: hand-written source, a test, or the rest (docs,
 * examples, fixtures, snapshots, config). By path alone:
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

/** A file as a hand-over names it: where it is today, and what became of its change since. */
const fileLine = (f: FileNow): string => {
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
 * The pointer's lines: its commit, the first line of its name (`line`: its
 * commit message, or its task when the message says too little:
 * records/Task.ts `changeTitle`), how to read its change (`more`: whether
 * memory adds what git doesn't show when the agent does), and the files it
 * changed as they are called today.
 */
const pointer = (p: PointerView, more: boolean): { readonly lines: Array<string>; readonly line: string } => {
  const sha = p.commit.slice(0, 10)
  const first = changeTitle(p).trim().split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? ""
  const line = first.length > MAX_LINE_CHARS ? first.slice(0, MAX_LINE_CHARS - 1) + "…" : first
  const sources = p.files.filter((f) => !f.snapshot)
  const snapshots = p.files.length - sources.length
  const lines = [
    "# A past change in this repository like your task",
    "",
    `An earlier task here asked for something like yours, committed as ${sha}: "${line}". ` +
    "Names, values and details of your task differ, and it may need more or less than that one did.",
    "",
    `\`git show ${sha}\` shows its change (add \`-- <file>\` for one file)${more ? "; memory then adds what git doesn't show about it" : ""}.`,
    "",
    "Files it changed:",
    "",
    ...sources.slice(0, MAX_POINTER_FILES).map(fileLine)
  ]
  if (sources.length > MAX_POINTER_FILES) lines.push(`- and ${sources.length - MAX_POINTER_FILES} more`)
  if (snapshots > 0) lines.push(`- ${snapshots === 1 ? "1 snapshot" : `${snapshots} snapshots`} it regenerated`)
  return { lines, line }
}

/**
 * A stored change as a task's start hands it over: its commit, the first
 * line of its name, and the files it changed as they are called today. No
 * diff: `git show` has it, and reading that commit brings what git doesn't
 * show about it (History.ts).
 */
export const renderPointer = (p: PointerView): string => pointer(p, true).lines.join("\n") + "\n"

/** What git doesn't show about a stored change, as sections: what the person asked, if shown, and the project commands. */
const notInGit = (asked: string | undefined, commands: ReadonlyArray<string>): Array<string> => {
  const out: Array<string> = []
  if (asked !== undefined) out.push("", "## What it was asked", "", asked.length > MAX_PROMPT_CHARS ? asked.slice(0, MAX_PROMPT_CHARS) + " …" : asked)
  if (commands.length > 0) out.push("", "## Project commands it ran, in order", "", commands.map((c) => inlineCode(c)).join(", "))
  return out
}

const within = (text: string, budget: number): string => (text.length <= budget ? text : text.slice(0, budget - 40) + "\n… (cut for room)\n")

/** A stored change in full: the pointer, and the project commands its session ran (`commandsToShow`, the ones still live). */
export interface FullView extends PointerView {
  readonly commands: ReadonlyArray<string>
}

/**
 * A stored change in full, as `singularity recall` hands it over and
 * `singularity changes <commit>` shows it: the pointer, then what git doesn't
 * show about it. What the person asked isn't said again when the pointer's
 * line already holds all of it.
 */
export const renderFull = (v: FullView, budget = MAX_HANDOVER_CHARS): string => {
  const { lines, line } = pointer(v, false)
  const asked = askedShown(v)
  return within([...lines, ...notInGit(asked === line ? undefined : asked, v.commands)].join("\n") + "\n", budget)
}

/** A stored change as the agent reads it beside its commit, which it just read in git (History.ts). */
export interface BehindView {
  readonly commit: string
  readonly prompt: string
  /** Its commit message (records/Task.ts): what the person asked is shown only when the message says too little. */
  readonly message?: string | undefined
  readonly commands: ReadonlyArray<string>
}

/**
 * What git doesn't show about a commit the agent just read with `git show`
 * or `git log` (Start.ts `commitHandover`): what the person asked, when its
 * commit message says too little (else git has what it was for), and the
 * project commands its session ran. Not its diff or its files: the agent has
 * them. Undefined when memory knows neither.
 */
export const renderBehind = (b: BehindView, budget = MAX_HANDOVER_CHARS): string | undefined => {
  const asked = askedShown(b)
  const what = [...(asked === undefined ? [] : ["what it was asked"]), ...(b.commands.length > 0 ? ["the project commands it ran"] : [])]
  if (what.length === 0) return undefined
  const sha = b.commit.slice(0, 10)
  const head = [`# What git doesn't show about ${sha}`, "", `Memory kept the session that made ${sha}, which you just read in git: ${what.join(" and ")}.`]
  return within([...head, ...notInGit(asked, b.commands)].join("\n") + "\n", budget)
}
