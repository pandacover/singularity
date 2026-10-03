/**
 * The mechanical part of a workflow record: what a run's log and diff say
 * without any model.
 *
 * - Files changed, from the diff, and files read, from the log.
 * - Every shell command, what it runs, and whether it worked: no error, and
 *   no failure in its output (a pipe into `tail` hides a failed exit status).
 * - Detours: a call that failed, the later call that worked, and what the run
 *   spent in between. A failed command is fixed by a later run of the same
 *   command that works; failed tests by a test run that covers them and
 *   passes; type errors by a typecheck that passes; a failed edit by the next
 *   edit of the same file. Failures on the way (the same tests failing again)
 *   belong to the same detour. Failed reads and searches aren't detours:
 *   looking around is how agents work. A failure that is never fixed isn't
 *   one either; it stays in the commands, marked as failed.
 *
 * Only the main thread counts; subagents run their own conversations.
 */
import type { ToolCall, Trace } from "../traces/index.ts"
import {
  EDIT_TOOLS,
  READ_TOOLS,
  reportsFailure,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  stripAnsi,
  traceModels,
  usageTotal
} from "../traces/index.ts"
import type { CommandRun, Detour, DetourCall, FailureKind, FileChange } from "./Models.ts"
import {
  classifyKey,
  commandKeys,
  isReadOnlyCommand,
  isReadOnlyKey,
  filtersTestNames,
  positionalArgs,
  segmentFor,
  wordChange
} from "./Shell.ts"

export interface Mechanical {
  readonly files: Array<FileChange>
  readonly filesRead: Array<string>
  readonly commands: Array<CommandRun>
  readonly detours: Array<Detour>
  /** Main-thread model responses. */
  readonly turns: number
  /** Main-thread tool calls. */
  readonly toolCalls: number
  readonly models: Array<string>
}

const MAX_COMMAND_CHARS = 500
const MAX_SYMPTOM_LINES = 4
const MAX_SYMPTOM_LINE_CHARS = 200

/** Paths relative to `cwd` (either slash style, any case), with forward slashes. */
export const relativizer = (cwd: string | undefined) => {
  if (cwd === undefined || cwd === "") return (p: string) => p.replace(/\\/g, "/")
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return (p: string) => {
    const s = p.replace(/\\/g, "/")
    return s.toLowerCase().startsWith(root + "/") ? s.slice(root.length + 1) : s
  }
}

/** Text with every occurrence of `cwd` (either slash style, any case) removed, so output reads in repo terms. */
const stripCwd = (cwd: string | undefined) => {
  if (cwd === undefined || cwd === "") return (s: string) => s
  const variants = [...new Set([cwd, cwd.replace(/\\/g, "/"), cwd.replace(/\//g, "\\")])]
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(variants.map((v) => escape(v) + "[\\\\/]?").join("|"), "gi")
  return (s: string) => s.replace(pattern, "")
}

/** Files a diff changes, with line counts. */
export const parseDiff = (diff: string): Array<FileChange> => {
  const files: Array<FileChange> = []
  for (const chunk of diff.replace(/\r\n?/g, "\n").split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue
    const lines = chunk.split("\n")
    const header = lines[0]
    const at = header.lastIndexOf(" b/")
    const path = at >= 0 ? header.slice(at + 3) : header.slice("diff --git ".length)
    let status: FileChange["status"] = "modified"
    let added = 0
    let removed = 0
    let binary = false
    for (const l of lines.slice(1)) {
      if (l.startsWith("new file mode")) status = "added"
      else if (l.startsWith("deleted file mode")) status = "deleted"
      else if (l.startsWith("rename from")) status = "renamed"
      else if (l.startsWith("GIT binary patch") || l.startsWith("Binary files")) binary = true
      else if (!binary && l.startsWith("+") && !l.startsWith("+++")) added++
      else if (!binary && l.startsWith("-") && !l.startsWith("---")) removed++
    }
    files.push({ path, status, added, removed, snapshot: path.endsWith(".snap") || path.includes("/__snapshots__/") })
  }
  return files
}

const TYPE_ERROR = /\berror TS\d+:/
const TEST_FAILURE =
  /Failed Tests \d|\bFAIL\b|\(\d+ tests? \|[^)]*\d+ failed|(?<!\d)[1-9]\d* failed\b|AssertionError|Snapshot [`'"].*mismatched|✗|×/
const NOT_FOUND =
  /is not recognized as|command not found|No such file|does not exist|Cannot find (module|path)|ENOENT|was not found|not found in file/i
const SYMPTOM_LINE =
  /error|fail|✗|×|AssertionError|Expected|Received|not found|Unknown|Cannot|cannot|Invalid|invalid|denied|Exit code|matches of the string|Snapshot/i
/** Lines that name the cause outright. */
const STRONG_LINE =
  /AssertionError|\bFAIL\b|×|✗|error TS\d+|\w*Error: |not found|not recognized|Unknown (option|command|argument)|Expected a single value|Cannot find|ENOENT|matches of the string|mismatched|(?<!\d)[1-9]\d* failed\b/
/** Lines every failing yarn, PowerShell or Node command prints, which say nothing about the cause. */
const GENERIC_LINE =
  /^(error Command failed with exit code \d+\.?|Exit code \d+|info Visit https:\/\/yarnpkg\.com.*|throw new Error\(|throw err;?|\^+|at .*|node:internal.*|\+ .*|At .*char:\d+|.*(CategoryInfo|FullyQualifiedErrorId|NativeCommandError).*|Snapshots? .*(updated|written|passed).*)$/

export const failureKind = (call: ToolCall, output: string): FailureKind => {
  if (EDIT_TOOLS.has(call.name)) {
    return /matches of the string to replace|String to replace not found/.test(output) ? "edit_mismatch" : "tool_error"
  }
  if (SHELL_TOOLS.has(call.name)) {
    if (TYPE_ERROR.test(output)) return "type_error"
    if (TEST_FAILURE.test(output)) return "test_failure"
    if (NOT_FOUND.test(output)) return "not_found"
    return "command_error"
  }
  return NOT_FOUND.test(output) ? "not_found" : "tool_error"
}

/** The lines of a failure's output that say what went wrong. */
export const symptomOf = (output: string, clean: (s: string) => string = (s) => s): string => {
  const lines = clean(stripAnsi(output)).split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l !== "")
  const telling = lines.filter((l) => SYMPTOM_LINE.test(l))
  const specific = telling.filter((l) => !GENERIC_LINE.test(l))
  const strong = specific.filter((l) => STRONG_LINE.test(l))
  const ranked = [...strong, ...specific.filter((l) => !strong.includes(l))]
  const picked = [...new Set(ranked.length > 0 ? ranked : telling.length > 0 ? telling : lines)].slice(0, MAX_SYMPTOM_LINES)
  return picked.map((l) => (l.length > MAX_SYMPTOM_LINE_CHARS ? l.slice(0, MAX_SYMPTOM_LINE_CHARS) + "..." : l)).join("\n")
}

/** Test files named in a failure's output, as stems (`contextmenu` for `contextmenu.test.tsx`). */
const failingTestStems = (output: string): Array<string> => {
  const stems = new Set<string>()
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    if (!/FAIL|❯|×|✗|failed/.test(line)) continue
    for (const m of line.matchAll(/([\w.-]+)\.(test|spec)\.[cm]?[jt]sx?\b/g)) stems.add(m[1])
  }
  return [...stems]
}

const mentionsStem = (arg: string, stem: string): boolean => {
  const base = arg.replace(/\\/g, "/").split("/").pop() ?? arg
  return base === stem || base.startsWith(`${stem}.`) || arg.includes(`${stem}.test`) || arg.includes(`${stem}.spec`)
}

interface View {
  readonly index: number
  readonly call: ToolCall
  readonly turn: number
  readonly shell: boolean
  readonly command: string | undefined
  readonly keys: ReadonlyArray<string>
  readonly file: string | undefined
  readonly failed: boolean
  readonly output: string
}

interface Open {
  readonly start: View
  readonly kind: FailureKind
  /** Shell: the keys a fix must run again. */
  readonly keys: ReadonlyArray<string>
  /** Test failures: the failing test files' stems. */
  readonly stems: ReadonlyArray<string>
  /** Command errors: the line that says what went wrong, if one does. */
  readonly signature: string | undefined
  failures: number
}

/** The first line of a failure's output that says what went wrong, for telling one failure from another. */
const signatureOf = (output: string): string | undefined =>
  stripAnsi(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 12 && !GENERIC_LINE.test(l) && SYMPTOM_LINE.test(l))

const CHECK_CLASSES = new Set(["test", "typecheck", "lint", "build"])

/** The keys of `keys` that run checks, by class. */
const checkClasses = (keys: ReadonlyArray<string>): Set<string> =>
  new Set(keys.map(classifyKey).filter((c) => CHECK_CLASSES.has(c)))

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "..." : s)

export interface ExtractOptions {
  /** The run succeeded: its checks passed, or its change was committed with passing tests. */
  readonly succeeded?: boolean | undefined
}

export const extractMechanical = (trace: Trace, diff: string, options: ExtractOptions = {}): Mechanical => {
  const relative = relativizer(trace.cwd)
  const clean = stripCwd(trace.cwd)
  const responses = trace.responses.filter((r) => r.agentId === undefined)
  const turnOf = new Map<string, number>()
  responses.forEach((r, i) => r.toolCallIds.forEach((id) => turnOf.set(id, i)))
  const tokens = responses.map((r) => usageTotal(r.usage))

  let lastTurn = 0
  const views: Array<View> = trace.toolCalls
    .filter((c) => c.agentId === undefined)
    .map((call, index) => {
      lastTurn = turnOf.get(call.id) ?? lastTurn
      const shell = SHELL_TOOLS.has(call.name)
      const command = shell && typeof call.input.command === "string" ? call.input.command : undefined
      const path = call.input.file_path ?? call.input.notebook_path
      const output = call.result ?? ""
      return {
        index,
        call,
        turn: lastTurn,
        shell,
        command,
        keys: command === undefined ? [] : commandKeys(command),
        file: typeof path === "string" ? relative(path) : undefined,
        failed: call.result !== undefined && (call.isError || (shell && reportsFailure(output))),
        output
      }
    })

  const describe = (v: View): DetourCall => ({
    call: v.index,
    turn: v.turn,
    tool: v.call.name,
    command: v.command === undefined ? null : clip(clean(v.command), MAX_COMMAND_CHARS),
    file: v.file ?? null
  })

  // Reads, searches and read-only commands look around; when they fail, nothing was done wrong.
  const isTriggerCandidate = (v: View) =>
    v.failed && !READ_TOOLS.has(v.call.name) && !SEARCH_TOOLS.has(v.call.name) &&
    !(v.shell && v.command !== undefined && isReadOnlyCommand(v.command))

  const open = (v: View): Open => {
    const kind = failureKind(v.call, v.output)
    if (!v.shell) return { start: v, kind, keys: [], stems: [], signature: undefined, failures: 1 }
    const runs = v.keys.filter((k) => !isReadOnlyKey(k))
    const ofClass = (cls: string) => runs.filter((k) => classifyKey(k) === cls)
    const preferred = kind === "type_error" ? ofClass("typecheck") : kind === "test_failure" ? ofClass("test") : []
    return {
      start: v,
      kind,
      keys: preferred.length > 0 ? preferred : runs,
      stems: kind === "test_failure" ? failingTestStems(v.output) : [],
      signature: kind === "command_error" || kind === "not_found" ? signatureOf(v.output) : undefined,
      failures: 1
    }
  }

  const sharesKey = (d: Open, v: View) => v.keys.some((k) => d.keys.includes(k))

  /** Runs the same check another way: `npx vitest` after `yarn test:update`. */
  const sameCheck = (d: Open, v: View) => {
    const classes = checkClasses(v.keys)
    return [...checkClasses(d.keys)].some((c) => classes.has(c))
  }

  /** A test run that covers the failing tests: the whole suite, or their files, not just some test names. */
  const coversFailingTests = (d: Open, v: View) =>
    v.keys.filter((k) => classifyKey(k) === "test").some((k) => {
      const seg = segmentFor(v.command!, k)
      if (seg === undefined || filtersTestNames(seg)) return false
      if (d.stems.length === 0) return true
      const args = positionalArgs(seg, k)
      // `yarn vitest run $f`: a variable could name the failing file.
      return args.length === 0 || args.some((a) => a.includes("$") || d.stems.some((s) => mentionsStem(a, s)))
    })

  /** A failed call that is the same failure again, still being worked on. */
  const sameThread = (d: Open, v: View): boolean => {
    if (d.start.shell) {
      if (!v.shell) return false
      const kind = failureKind(v.call, v.output)
      if (kind !== d.kind) return false
      if (kind === "test_failure") return v.keys.some((k) => classifyKey(k) === "test")
      if (!sharesKey(d, v) && !sameCheck(d, v)) return false
      return d.signature === undefined || v.output.includes(d.signature)
    }
    if (EDIT_TOOLS.has(d.start.call.name)) return EDIT_TOOLS.has(v.call.name) && v.file === d.start.file
    return v.call.name === d.start.call.name
  }

  /**
   * The command ran again without its old error, though something else
   * failed: a command that ran with a bad flag now runs, and its tests fail;
   * a typecheck passes, and the tests after it fail.
   */
  const fixedThoughFailing = (d: Open, v: View): boolean => {
    if (!d.start.shell || !v.shell || v.turn <= d.start.turn) return false
    if (d.kind === "command_error" || d.kind === "not_found") {
      return d.signature !== undefined && sharesKey(d, v) && !v.output.includes(d.signature)
    }
    if (d.kind === "type_error") {
      return v.keys.some((k) => classifyKey(k) === "typecheck") && !TYPE_ERROR.test(v.output)
    }
    return false
  }

  /** A call that worked and shows the failure is gone. */
  const resolves = (d: Open, v: View): boolean => {
    if (v.failed || v.call.result === undefined || v.turn <= d.start.turn) return false
    if (d.start.shell) {
      if (!v.shell || v.command === undefined) return false
      if (d.kind === "test_failure") return coversFailingTests(d, v)
      if (d.kind === "type_error" && v.keys.some((k) => classifyKey(k) === "typecheck")) return true
      return sharesKey(d, v) || sameCheck(d, v)
    }
    if (EDIT_TOOLS.has(d.start.call.name)) return EDIT_TOOLS.has(v.call.name) && v.file === d.start.file
    return v.call.name === d.start.call.name
  }

  const close = (d: Open, fix: View): Detour => {
    let removed: Array<string> = []
    let added: Array<string> = []
    if (d.start.shell && fix.command !== undefined && d.start.command !== undefined) {
      const key = fix.keys.find((k) => d.keys.includes(k))
      const before = key === undefined ? undefined : segmentFor(d.start.command, key)
      const after = key === undefined ? undefined : segmentFor(fix.command, key)
      if (before !== undefined && after !== undefined) ({ added, removed } = wordChange(before, after))
    }
    // Edits made in reaction to the failure: after its turn (calls in the same
    // turn were sent before it was seen), and not the fix itself.
    const edited = EDIT_TOOLS.has(d.start.call.name) ? [] : views
      .slice(d.start.index + 1, fix.index)
      .filter((v) => v.turn > d.start.turn && EDIT_TOOLS.has(v.call.name) && !v.failed && v.file !== undefined)
      .map((v) => v.file!)
    let spent = 0
    for (let t = d.start.turn + 1; t <= fix.turn && t < tokens.length; t++) spent += tokens[t]
    return {
      kind: d.kind,
      failed: describe(d.start),
      symptom: symptomOf(d.start.output, clean),
      keys: [...d.keys],
      fixed: describe(fix),
      removed,
      added,
      files_edited: [...new Set(edited)],
      failures: d.failures,
      cost: { tokens: spent, calls: fix.index - d.start.index, turns: fix.turn - d.start.turn }
    }
  }

  const detours: Array<Detour> = []
  let pending: Array<Open> = []
  for (const v of views) {
    const fixed = isTriggerCandidate(v)
      ? pending.filter((d) => !sameThread(d, v) && fixedThoughFailing(d, v))
      : pending.filter((d) => resolves(d, v))
    for (const d of fixed) detours.push(close(d, v))
    pending = pending.filter((d) => !fixed.includes(d))
    if (isTriggerCandidate(v)) {
      const thread = pending.find((d) => sameThread(d, v))
      if (thread !== undefined) thread.failures++
      else pending.push(open(v))
    }
  }
  // The run succeeded, so a failing check it never ran again in full was
  // fixed anyway: by the time of the last check of its kind that passed.
  if (options.succeeded === true) {
    for (const d of pending) {
      const classes = checkClasses(d.keys)
      const last = views
        .filter((v) => v.index > d.start.index && v.turn > d.start.turn && v.shell && !v.failed && v.call.result !== undefined)
        .filter((v) => [...checkClasses(v.keys)].some((c) => classes.has(c)))
        .pop()
      if (last !== undefined) detours.push(close(d, last))
    }
  }
  detours.sort((a, b) => a.failed.call - b.failed.call)

  const commands: Array<CommandRun> = views
    .filter((v) => v.shell && v.command !== undefined)
    .map((v) => ({
      command: clip(clean(v.command!), MAX_COMMAND_CHARS),
      keys: [...v.keys],
      ok: !v.failed,
      error: v.failed ? symptomOf(v.output, clean) : null,
      turn: v.turn
    }))

  const filesRead = [
    ...new Set(views.filter((v) => READ_TOOLS.has(v.call.name) && v.file !== undefined).map((v) => v.file!))
  ]

  return {
    files: parseDiff(diff),
    filesRead,
    commands,
    detours,
    turns: responses.length,
    toolCalls: views.length,
    models: traceModels(trace)
  }
}
