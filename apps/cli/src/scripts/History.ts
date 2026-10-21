/**
 * The hand-over mid-task, by commit, as the tool-call hook sees it: when an
 * agent reads a past commit with `git show` or `git log`, memory adds what
 * git doesn't show about it (Start.ts `commitHandover`): the request that
 * asked for it, the project commands its session ran, and the mistakes it
 * made. Agents read the change before theirs this way unprompted: in the
 * note test of 2026-10-17 (examples/scripts/RESULTS.md), the first command of
 * every session that added a rule like an earlier one was `git show` of that
 * earlier rule's commit, under either recall note. The diff they read is
 * git's; the rest is memory's.
 *
 * Plain node: the hook runs after every call. A call reads a
 * change when it runs `git show`, or `git log` printing a diff or a stat (a
 * list of subjects only is a look around). Which commits it read: the ones
 * its output heads with `commit <hash>`, else the lines it starts with a hash
 * (`--oneline`, `--format=%H`), else the ones its command names: hashes of 7
 * or more hex characters and HEAD-relative revisions (`HEAD~2`, `@~1`, which
 * Start.ts resolves), not a file read at a commit (`<commit>:<path>`) or a
 * reflog entry (`HEAD@{1}`). A command continued over lines (`\` or
 * PowerShell's backtick at a line's end) reads as one line. More than two
 * commits listed is a survey (`git log -5 --stat`), not a reading: nothing.
 *
 * Mid-task, a session is given a commit once, whichever moment gave it first
 * (a task's start, a reading, `recall`):
 * `<tenant>/scripts/sessions/<id>.given`, one commit per line, next to the
 * session's marker (Cycle.ts). Its own commits it isn't given by a reading
 * at all (Start.ts).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { commandOf } from "../workflows/StoreTrigger.ts"

/** `git <sub>`, git's own options before it included (`git -C repo --no-pager log`), and not `git show-ref`. */
const gitRuns = (sub: string) => new RegExp(String.raw`\bgit(?:\.exe)?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?|-[pP]))*\s+${sub}(?![\w-])`)
const SHOW = gitRuns("show")
const LOG = gitRuns("log")

/** An output holding a change: a diff, or a stat's summary line. */
const CHANGE = /^diff --git |^ \d+ files? changed\b/m

/** More commits than this listed at once is a survey of the history, not a reading of a change. */
export const MAX_READ = 2

/** Every string in a value: a tool's output, in whichever shape the agent sends it. */
const stringsIn = (value: unknown, out: Array<string> = []): Array<string> => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out)
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) stringsIn(v, out)
  return out
}

/** A tool call's output as text: Claude Code's `{ stdout, stderr }`, a plain string, or anything holding strings. */
export const outputOf = (toolResponse: unknown): string => stringsIn(toolResponse).join("\n")

/** A hash as git prints and agents type it: 7 to 40 hex characters, a digit among them (so not a word like "defaced"). */
const isHash = (s: string) => /^[0-9a-f]{7,40}$/i.test(s) && /\d/.test(s)

const hashesOf = (text: string, line: RegExp): Array<string> => {
  const found: Array<string> = []
  for (const m of text.matchAll(line)) {
    const hash = m[1].toLowerCase()
    if (isHash(hash) && !found.includes(hash)) found.push(hash)
  }
  return found
}

/**
 * The commits an output lists, in order: the ones it heads with `commit
 * <hash>` (git's default format), or when it has none, the lines it starts
 * with a hash (`--oneline`, `--format=%H`), after a graph's `*` and `|` too.
 * Diff and stat lines start otherwise (`diff`, `index`, `+`, `-`, a space),
 * and so does an indented commit message. Headed commits win: in `git log
 * --oneline -5; git show HEAD~1`, the reading is the one `git show` heads.
 */
export const listedCommits = (output: string): Array<string> => {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n")
  const headed = hashesOf(plain, /^(?:[*|][*|\\/ ]*)?commit ([0-9a-f]{7,40})(?=\s|$)/gim)
  return headed.length > 0 ? headed : hashesOf(plain, /^(?:[*|][*|\\/ ]*)?([0-9a-f]{7,40})(?=\s|$)/gim)
}

/**
 * The hashes and HEAD-relative revisions (`HEAD~2`, or `@~2`: `@` is git's
 * short name for HEAD) a command names, leaving out file reads at a commit
 * (`<commit>:<path>`), reflog entries (`HEAD@{1}`) and upstreams (`@{u}`).
 */
export const namedCommits = (command: string): { readonly hashes: Array<string>; readonly revs: Array<string> } => {
  const hashes: Array<string> = []
  for (const m of command.matchAll(/(?<![\w./-])([0-9a-f]{7,40})(?![\w:/-])/gi)) {
    const hash = m[1].toLowerCase()
    if (isHash(hash) && !hashes.includes(hash)) hashes.push(hash)
  }
  const revs: Array<string> = []
  for (const m of command.matchAll(/(?<![\w./-])((?:HEAD|@)(?:[~^]\d*)*)(?![\w:/@{-])/g)) {
    if (!revs.includes(m[1])) revs.push(m[1])
  }
  return { hashes, revs }
}

/**
 * The commits a call that ran `command` and printed `output` read, as hashes
 * (whole or a prefix) and revisions to resolve; undefined when it read none,
 * or surveyed more than `MAX_READ`.
 */
export const commitsRead = (
  command: string,
  output: string
): { readonly hashes: ReadonlyArray<string>; readonly revs: ReadonlyArray<string> } | undefined => {
  // A command continued over lines (`git \` then `log -1 --stat` on the next) is one line.
  const line = command.replace(/[\\`]\r?\n/g, " ")
  if (!SHOW.test(line) && !(LOG.test(line) && CHANGE.test(output.replace(/\r\n?/g, "\n")))) return undefined
  const listed = listedCommits(output)
  if (listed.length > MAX_READ) return undefined
  if (listed.length > 0) return { hashes: listed, revs: [] }
  // Nothing listed (`git show HEAD~2 -- file | tail -30`): what the command names.
  const named = namedCommits(line)
  return named.hashes.length + named.revs.length === 0 ? undefined : named
}

/**
 * Whether a tool-call hook's input is of a call that read commits
 * (`commitsRead`), checked with JSON.parse alone: most `git log` calls list
 * subjects, and the hand-over's modules take a while to load (Hook.ts
 * `handOverRead`, which reads the input again, with its schema).
 */
export const readsCommits = (stdin: string): boolean => {
  let call: { readonly hook_event_name?: unknown; readonly tool_input?: unknown; readonly tool_response?: unknown }
  try {
    call = JSON.parse(stdin)
  } catch {
    return false
  }
  if (typeof call !== "object" || call === null || call.hook_event_name === "PostToolUseFailure") return false
  const command = commandOf(call.tool_input)
  return command !== undefined && commitsRead(command, outputOf(call.tool_response)) !== undefined
}

/** Where a session's given commits are kept. */
export const givenPath = (tenantDir: string, safeSessionId: string) => join(tenantDir, "scripts", "sessions", `${safeSessionId}.given`)

/** The commits a session was given, by any moment. */
export const readGiven = (path: string): Array<string> =>
  existsSync(path) ? readFileSync(path, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "") : []

/** Note that a session was given `commit`, once. */
export const addGiven = (path: string, commit: string): void => {
  if (readGiven(path).includes(commit)) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${commit}\n`)
}
