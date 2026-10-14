/**
 * Whether a tool call failed, by the same rules wherever calls are judged:
 * in a record's detours (Extract.ts), and in the tool-call hook, where a known
 * mistake's warning fires (Triggers.ts, handover/HookInput.ts).
 *
 * - The error status the agent records decides, for every call: Claude
 *   Code's `is_error` in a transcript, a PostToolUseFailure event in a hook.
 * - A shell command can fail while its status says it worked: a pipe reports
 *   its last command's status (`npm test 2>&1 | tail -30`), and so does a
 *   line of several commands. Its output then counts only for signs that
 *   can't be mistaken: a checker's own report of failures when the call ran
 *   that check (a test runner's summary for tests; TypeScript's errors for a
 *   typecheck, a build or tests; a linter's count of errors for lint; the
 *   package manager saying the script it ran failed), a traceback, or a shell
 *   saying a command doesn't exist. "1 failed" in a script's own output is
 *   what it printed, not its failure.
 * - What a read or a search prints is never judged: a file or a log may say
 *   anything, and a search that finds nothing exits 1. A call that only looks
 *   around (a read, a search, a command that only reads), or a failed line
 *   whose output names only reading programs as what failed (`tail: cannot
 *   open …`), made no mistake: it starts no detour and fires no warning.
 */
import { READ_TOOLS, SEARCH_TOOLS, SHELL_TOOLS, stripAnsi } from "../traces/index.ts"
import {
  classifyKey,
  commandKeys,
  commandWords,
  isReadOnlyCommand,
  isReadOnlySegment,
  type KeyClass,
  mainSegments,
  programName,
  type Segment,
  segmentKey,
  segmentKeys,
  splitCommand
} from "./Shell.ts"

/** What judging a call needs: the tool, a shell's command line, the result, and the error status recorded. */
export interface CallFacts {
  readonly tool: string
  readonly command: string | undefined
  /** The result, or the error text; undefined when none was recorded. */
  readonly output: string | undefined
  readonly isError: boolean
}

/** Tools that only look around. */
const LOOK_TOOLS = new Set([...READ_TOOLS, ...SEARCH_TOOLS, "LS", "NotebookRead", "WebFetch", "WebSearch", "ToolSearch", "TaskOutput"])

/** Optional `package:task: ` that task runners such as Turbo put before each line. */
const LINE = String.raw`^(?:\S+:\s+)?\s*`

/** What test runners print, in their own form, only when tests failed. */
export const TEST_REPORT = new RegExp(
  [
    String.raw`${LINE}(?:Test Files|Tests)\s+[1-9]\d* failed`,
    String.raw`\(\d+ tests? \|[^)\n]*[1-9]\d* failed\)`,
    String.raw`${LINE}(?:FAIL|×|✗)\s+\S`,
    String.raw`Failed Tests [1-9]`,
    String.raw`${LINE}Tests:\s+[1-9]\d* failed`,
    String.raw`${LINE}[ℹ#] fail [1-9]`,
    String.raw`✖ failing tests`,
    String.raw`${LINE}[1-9]\d* failing\s*$`,
    String.raw`${LINE}not ok \d+`,
    String.raw`^=+ .*\b[1-9]\d* failed\b`,
    String.raw`^FAILED \S`,
    String.raw`^--- FAIL: `,
    String.raw`test result: FAILED`,
    String.raw`plan expected \d+ assertions? but received \d+`,
    String.raw`does not meet (?:\w+ )?threshold`
  ].join("|"),
  "m"
)

/** TypeScript's errors, and its summary in build mode. */
export const TYPE_ERRORS = /\berror TS\d+:|^Found [1-9]\d* errors?\b/m

/** ESLint's count of errors, its warning limit, and its error lines. */
const LINT_REPORT = /✖ [1-9]\d* problems? \([1-9]\d* errors?|ESLint found too many warnings|^\s*\d+:\d+\s+error\s/m

/** npm, yarn, pnpm and Turbo saying the script or task they ran failed. */
const SCRIPT_FAILED = /^npm (?:error|ERR!) |^error Command failed with exit code [1-9]|ELIFECYCLE.*Command failed|ERROR\s+run failed: command\s+\S*\s*exited \([1-9]/m

/** Python's traceback, and the line Node prints after a crash. */
const PYTHON_TRACEBACK = /^Traceback \(most recent call last\):/m
const NODE_CRASH = /^Node\.js v\d+\.\d+\.\d+\s*$/m
const TRACEBACK = new RegExp(`${PYTHON_TRACEBACK.source}|${NODE_CRASH.source}`, "m")

/**
 * A shell saying a command doesn't exist, as its own line: bash, sh and a
 * script they run (`bash: x: command not found`, `/usr/bin/bash: line 1: x:
 * …`, `./run.sh: line 3: x: …`, `environment: x: …` for a function bash got
 * from its parent), zsh, cmd, PowerShell 5 and 7 (`x : The term 'x' is not
 * recognized`, `x: The term 'x' …`), and Windows's stand-in for a missing
 * Python. A program that prints such a line inside its own output (a probe
 * echoing `node: $(node --version 2>&1)`, JSON holding a child's stderr)
 * doesn't start the line with a shell.
 */
const NO_SUCH_COMMAND = new RegExp(
  [
    String.raw`^(?:(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)(?:\.exe)?|environment|\S+\.(?:sh|bash)): (?:line \d+: )?[^\s:]+: command not found`,
    String.raw`^zsh: command not found: `,
    String.raw`^'[^'\n]+' is not recognized as an internal or external command`,
    String.raw`^(\S+) ?: The term '\1' is not recognized`,
    String.raw`^Python was not found`
  ].join("|"),
  "m"
)

const PACKAGE_SCRIPT = /^(?:npm|yarn|pnpm|bun|npx|pnpx|bunx) /

/** The kinds of check a command line runs. */
export const checksRun = (keys: ReadonlyArray<string>): Set<KeyClass> => new Set(keys.map(classifyKey))

/**
 * The failure a command's output shows though its status says it worked, if
 * it shows one: what it is, in a few words.
 */
export const hiddenFailure = (command: string, output: string): string | undefined => {
  const text = stripAnsi(output)
  if (TRACEBACK.test(text)) return "a traceback"
  if (NO_SUCH_COMMAND.test(text)) return "a command not found"
  const keys = commandKeys(command)
  const ran = checksRun(keys)
  if (ran.has("test") && TEST_REPORT.test(text)) return "failed tests"
  if ((ran.has("typecheck") || ran.has("build") || ran.has("test")) && TYPE_ERRORS.test(text)) return "type errors"
  if (ran.has("lint") && LINT_REPORT.test(text)) return "lint errors"
  if (keys.some((k) => PACKAGE_SCRIPT.test(k)) && SCRIPT_FAILED.test(text)) return "a script that failed"
  return undefined
}

/** A call that only looks around: a read, a search, or a shell command that only reads. */
export const looksAround = (tool: string, command: string | undefined): boolean =>
  LOOK_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && command !== undefined && isReadOnlyCommand(command))

/** Whether a call failed: its error status, or for a shell command that doesn't only read, a failure its output shows. */
export const callFailed = (c: CallFacts): boolean => {
  if (c.isError) return true
  if (!SHELL_TOOLS.has(c.tool) || c.command === undefined || c.output === undefined) return false
  if (isReadOnlyCommand(c.command)) return false
  return hiddenFailure(c.command, c.output) !== undefined
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whether a failure's output names a program as what failed: `tail: cannot open …`, `bash: python3: command not found`. */
const namesProgram = (output: string, program: string): boolean => {
  if (program === "") return false
  const p = escape(program)
  return new RegExp(String.raw`(?:^|\n)(?:\S*(?:bash|sh|zsh)(?:\.exe)?: (?:line \d+: )?)?${p}(?:\.exe)?: `, "i").test(output) ||
    new RegExp(String.raw`The term '${p}(?:\.exe)?' is not recognized|(?:^|\n)${p}(?:\.exe)? : `, "i").test(output)
}

/** An interpreter by family: `python3` and `py` are Python, `tsx` is Node. */
const familyOf = (s: Segment): string => {
  const program = programName(commandWords(s)[0] ?? "")
  return program === "python3" || program === "py" ? "python" : program === "tsx" || program === "ts-node" ? "node" : program
}

const runsCheck = (s: Segment, checks: ReadonlyArray<KeyClass>) => segmentKeys(s).some((k) => checks.includes(classifyKey(k)))

/**
 * The segments of a failed command line that failed: the ones its output
 * names as failing (`tail: cannot open …`) and the ones whose kind of failure
 * it shows (a Python traceback, Node's crash, failing tests, type errors);
 * when it tells neither, every one that runs something. A failed `cd`
 * stopped what came after it, so naming it names nothing in particular.
 */
export const failedSegments = (
  command: string,
  output: string,
  /** The line's segments, as the caller split it (`mainSegments`); the ones returned are among them. */
  all: ReadonlyArray<Segment> = mainSegments(splitCommand(command))
): Array<Segment> => {
  const segments = all.filter((s) => segmentKey(s) !== undefined)
  const text = stripAnsi(output)
  const named = segments.filter((s) => {
    const program = programName(commandWords(s)[0] ?? "")
    return program !== "cd" && namesProgram(text, program)
  })
  const shown = PYTHON_TRACEBACK.test(text)
    ? segments.filter((s) => familyOf(s) === "python")
    : NODE_CRASH.test(text)
    ? segments.filter((s) => familyOf(s) === "node")
    : TEST_REPORT.test(text)
    ? segments.filter((s) => runsCheck(s, ["test"]))
    : TYPE_ERRORS.test(text)
    ? segments.filter((s) => runsCheck(s, ["typecheck", "build", "test"]))
    : []
  const told = segments.filter((s) => named.includes(s) || shown.includes(s))
  return told.length > 0 ? told : segments
}

/**
 * Whether a call failed at doing something, not at looking around: a
 * mistake. Edits and other tools that fail are; reads and searches aren't;
 * a shell command is when what failed in it runs something.
 */
export const mistakeMade = (c: CallFacts): boolean => {
  if (!callFailed(c) || looksAround(c.tool, c.command)) return false
  if (!SHELL_TOOLS.has(c.tool) || c.command === undefined) return true
  return failedSegments(c.command, c.output ?? "").some((s) => !isReadOnlySegment(s))
}

