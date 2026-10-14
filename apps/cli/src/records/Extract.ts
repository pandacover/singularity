/**
 * The mechanical part of a workflow record: what a run's log and diff say
 * without any model.
 *
 * - Files changed, from the diff, and files read, from the log.
 * - Every shell command, what it runs, and whether it worked, by its error
 *   status and what its output can't hide (Outcome.ts).
 * - Detours: a mistake (a call that failed doing something, Outcome.ts), the
 *   later call that worked, and what the run spent in between. What closes
 *   one depends on what failed. A check (failing tests, type errors) only
 *   when the same check passes later: a test run that covers the failing
 *   tests, a typecheck. Anything else when the same target later runs and
 *   works, even through another command (`python3 build.py`, then `python
 *   build.py`; a check's command with a bad flag, then the same kind of check
 *   another way), or runs again without the old error though something else
 *   fails; a failed edit by the next edit of the same file. Failures on the
 *   way (the same tests failing again) belong to the same detour. Failed
 *   reads and searches aren't detours: looking around is how agents work. A
 *   failure that is never fixed isn't one either; it stays in the commands,
 *   marked as failed.
 *
 * Only the main thread counts; subagents run their own conversations.
 */
import type { ToolCall, Trace } from "../traces/index.ts"
import { EDIT_TOOLS, READ_TOOLS, SHELL_TOOLS, stripAnsi, traceModels, usageTotal } from "../traces/index.ts"
import type { CommandRun, Detour, DetourCall, FailureKind, FileChange } from "./Models.ts"
import { callFailed, checksRun, failedSegments, mistakeMade, TYPE_ERRORS } from "./Outcome.ts"
import {
  classifyKey,
  commandKeys,
  fileTarget,
  filtersTestNames,
  folderKey,
  isReadOnlyCommand,
  isReadOnlySegment,
  keyTargets,
  type Placed,
  placedTargets,
  positionalArgs,
  resolveFolder,
  sameCode,
  samePlace,
  type Segment,
  segmentFolders,
  segmentFor,
  segmentKeys,
  segmentTargets,
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

/** A test snapshot (`.snap`, `__snapshots__/`, node's test runner's `.snapshot`): regenerated, not written. */
export const isSnapshot = (path: string): boolean => path.endsWith(".snap") || path.endsWith(".snapshot") || path.includes("/__snapshots__/")

/** A diff split by file: each file's path and its part of the diff, as lines (the `diff --git` line first). */
export const diffFiles = (diff: string): Array<{ readonly path: string; readonly lines: ReadonlyArray<string> }> => {
  const files: Array<{ path: string; lines: Array<string> }> = []
  for (const chunk of diff.replace(/\r\n?/g, "\n").split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue
    const lines = chunk.split("\n")
    const header = lines[0]
    const at = header.lastIndexOf(" b/")
    files.push({ path: at >= 0 ? header.slice(at + 3) : header.slice("diff --git ".length), lines })
  }
  return files
}

/** Files a diff changes, with line counts. */
export const parseDiff = (diff: string): Array<FileChange> => {
  const files: Array<FileChange> = []
  for (const { path, lines } of diffFiles(diff)) {
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
    files.push({ path, status, added, removed, snapshot: isSnapshot(path) })
  }
  return files
}

/**
 * Failing tests, in what tests print once a run that ran them failed: Vitest
 * and Jest; node's test runner (its summary, a failing test, the list of
 * failures, a plan or a coverage threshold not met); TAP; mocha.
 */
const TEST_FAILURE =
  /Failed Tests \d|\bFAIL\b|\(\d+ tests? \|[^)]*\d+ failed|(?<!\d)[1-9]\d* failed\b|AssertionError|ERR_ASSERTION|Snapshot [`'"].*mismatched|✗|×|^[ℹ#] fail [1-9]|^\s*✖ .*\(\d+(?:\.\d+)?m?s\)\s*$|✖ failing tests|plan expected \d+ assertions?|does not meet (?:\w+ )?threshold|^\s*not ok \d+|^\s*[1-9]\d* failing\s*$/m
const NOT_FOUND =
  /is not recognized as|command not found|No such file|does not exist|Cannot find (module|path)|ENOENT|was not found|not found in file/i
const SYMPTOM_LINE =
  /error|fail|✗|×|AssertionError|Expected|Received|not found|Unknown|Cannot|cannot|Invalid|invalid|denied|Exit code|matches of the string|Snapshot/i
/** Lines that name the cause outright. */
const STRONG_LINE =
  /AssertionError|\bFAIL\b|×|✗|error TS\d+|\w*Error: |not found|not recognized|Unknown (option|command|argument)|Expected a single value|Cannot find|ENOENT|matches of the string|mismatched|(?<!\d)[1-9]\d* failed\b|plan expected \d+ assertions?|does not meet (?:\w+ )?threshold|^\d+:\d+ error /
/** Lines every failing yarn, PowerShell or Node command prints, which say nothing about the cause. */
const GENERIC_LINE =
  /^(error Command failed with exit code \d+\.?|Exit code \d+|info Visit https:\/\/yarnpkg\.com.*|throw new Error\(|throw err;?|\^+|at .*|node:internal.*|\+ .*|At .*char:\d+|.*(CategoryInfo|FullyQualifiedErrorId|NativeCommandError).*|Snapshots? .*(updated|written|passed).*)$/

/**
 * What kind of failure a failed call is. A shell command's is told by what
 * failed in it (`keys`): type errors only from a check, failing tests only
 * from tests; "1 failed" in a script's output is no test failure.
 */
export const failureKind = (call: ToolCall, output: string, keys: ReadonlyArray<string> = []): FailureKind => {
  if (EDIT_TOOLS.has(call.name)) {
    return /matches of the string to replace|String to replace not found/.test(output) ? "edit_mismatch" : "tool_error"
  }
  if (SHELL_TOOLS.has(call.name)) {
    const ran = checksRun(keys)
    if ((ran.has("typecheck") || ran.has("build") || ran.has("test") || ran.has("lint")) && TYPE_ERRORS.test(output)) return "type_error"
    if (ran.has("test") && TEST_FAILURE.test(output)) return "test_failure"
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

/** A segment of a call's line, and the folder it runs in (`segmentFolders`). */
interface Run {
  readonly segment: Segment
  readonly folder: string | undefined
}

interface View {
  readonly index: number
  readonly call: ToolCall
  readonly turn: number
  readonly shell: boolean
  readonly command: string | undefined
  readonly keys: ReadonlyArray<string>
  /** Its segments, where each runs. */
  readonly runs: ReadonlyArray<Run>
  /** What it runs, as targets with their places (`placedTargets`), from the segments that don't only read. */
  readonly targets: ReadonlyArray<Placed>
  /** The text of its segments that run inline code, for telling one script from another. */
  readonly inline: ReadonlyArray<string>
  readonly file: string | undefined
  /** Edits: the folder of the file. */
  readonly fileFolder: string | undefined
  /** It failed (Outcome.ts's `callFailed`). */
  readonly failed: boolean
  /** It failed at doing something, not at looking around (`mistakeMade`). */
  readonly mistake: boolean
  readonly output: string
}

interface Open {
  readonly start: View
  readonly kind: FailureKind
  /** Shell: what failed in it, as keys. */
  readonly keys: ReadonlyArray<string>
  /** Shell: what a fix runs, as targets with their places. */
  readonly targets: ReadonlyArray<Placed>
  /** Shell: where what failed ran. */
  readonly places: ReadonlyArray<string | undefined>
  /** Shell: the text of what failed that runs inline code. */
  readonly inline: ReadonlyArray<string>
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

const unique = <A>(xs: ReadonlyArray<A>): Array<A> => [...new Set(xs)]

const isInline = (t: string) => t.endsWith(" (inline)")

/** Targets with their places, each once. */
const placedOf = (runs: ReadonlyArray<Run>): Array<Placed> => {
  const seen = new Map<string, Placed>()
  for (const r of runs) for (const t of placedTargets(r.segment, r.folder)) seen.set(`${t.target}\u0000${t.place ?? ""}`, t)
  return [...seen.values()]
}

/** The text of the segments that run inline code (`node -e '…'`, `python - <<EOF`). */
const inlineOf = (runs: ReadonlyArray<Run>): Array<string> =>
  runs.filter((r) => segmentTargets(r.segment).some(isInline)).map((r) => r.segment.text)

/** The checks among targets: `check:test`, `check:typecheck`. */
const checkTargets = (targets: ReadonlyArray<Placed>): Array<Placed> => targets.filter((t) => t.target.startsWith("check:"))

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "..." : s)

/**
 * Whether a stored detour still is one by today's rules, as far as the
 * record alone tells, for a record whose log is gone: a failed command that
 * only reads is looking around, and tests or types failing come only from a
 * check. A record whose log is still there is read again whole instead.
 */
export const stillADetour = (d: Detour): boolean => {
  if (d.failed.command !== null && isReadOnlyCommand(d.failed.command)) return false
  const ran = checksRun(d.keys)
  if (d.kind === "test_failure") return ran.has("test")
  if (d.kind === "type_error") return ran.has("typecheck") || ran.has("build") || ran.has("test") || ran.has("lint")
  return true
}

export interface ExtractOptions {
  /** The run succeeded: its checks passed, or its change was committed with its checks passing. */
  readonly succeeded?: boolean | undefined
}

export const extractMechanical = (trace: Trace, diff: string, options: ExtractOptions = {}): Mechanical => {
  const relative = relativizer(trace.cwd)
  const clean = stripCwd(trace.cwd)
  const responses = trace.responses.filter((r) => r.agentId === undefined)
  const turnOf = new Map<string, number>()
  responses.forEach((r, i) => r.toolCallIds.forEach((id) => turnOf.set(id, i)))
  const tokens = responses.map((r) => usageTotal(r.usage))

  // Where commands run: the session's folder, moved by each `cd` in a line. Claude Code takes the shell
  // back to the session's folder when a command leaves it, and a `cd` within it stays inside it.
  const home = trace.cwd === undefined || trace.cwd === "" ? undefined : folderKey(trace.cwd)
  let lastTurn = 0
  const views: Array<View> = trace.toolCalls
    .filter((c) => c.agentId === undefined)
    .map((call, index) => {
      lastTurn = turnOf.get(call.id) ?? lastTurn
      const shell = SHELL_TOOLS.has(call.name)
      const command = shell && typeof call.input.command === "string" ? call.input.command : undefined
      const path = call.input.file_path ?? call.input.notebook_path
      const output = call.result ?? ""
      const facts = { tool: call.name, command, output, isError: call.isError }
      const runs = command === undefined ? [] : segmentFolders(command, home)
      const doing = runs.filter((r) => !isReadOnlySegment(r.segment))
      const slash = typeof path === "string" ? path.replace(/\\/g, "/").lastIndexOf("/") : -1
      return {
        index,
        call,
        turn: lastTurn,
        shell,
        command,
        keys: command === undefined ? [] : commandKeys(command),
        runs,
        targets: placedOf(doing),
        inline: inlineOf(doing),
        file: typeof path === "string" ? relative(path) : undefined,
        fileFolder: typeof path === "string" ? (slash < 0 ? home : resolveFolder(home, path.slice(0, slash + 1))) : undefined,
        failed: call.result !== undefined && callFailed(facts),
        mistake: call.result !== undefined && mistakeMade(facts),
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

  /** The segments of a failed shell call that failed at doing something: those its output tells, else every one that runs something. */
  const failing = (v: View): Array<Run> => {
    if (v.command === undefined) return []
    const told = new Set(failedSegments(v.command, v.output, v.runs.map((r) => r.segment)))
    return v.runs.filter((r) => told.has(r.segment) && !isReadOnlySegment(r.segment))
  }

  /** The runs of a view that run a key of class `cls`, or that `keys` holds. */
  const running = (runs: ReadonlyArray<Run>, test: (key: string) => boolean): Array<Run> =>
    runs.filter((r) => !isReadOnlySegment(r.segment) && segmentKeys(r.segment).some(test))

  const open = (v: View): Open => {
    if (!v.shell) {
      return { start: v, kind: failureKind(v.call, v.output), keys: [], targets: [], places: [], inline: [], stems: [], signature: undefined, failures: 1 }
    }
    const runs = failing(v)
    const all = unique(runs.flatMap((r) => segmentKeys(r.segment)))
    const kind = failureKind(v.call, v.output, all)
    const cls = kind === "type_error" ? "typecheck" : kind === "test_failure" ? "test" : undefined
    const preferred = cls === undefined ? [] : running(runs, (k) => classifyKey(k) === cls)
    const chosen = preferred.length > 0 ? preferred : runs
    return {
      start: v,
      kind,
      keys: preferred.length > 0 ? unique(preferred.flatMap((r) => segmentKeys(r.segment).filter((k) => classifyKey(k) === cls))) : all,
      targets: preferred.length > 0
        ? preferred.flatMap((r) => segmentKeys(r.segment).filter((k) => classifyKey(k) === cls).flatMap(keyTargets).map((target) => ({ target, place: r.folder })))
        : placedOf(runs),
      places: chosen.map((r) => r.folder),
      inline: inlineOf(runs),
      stems: kind === "test_failure" ? failingTestStems(v.output) : [],
      signature: kind === "command_error" || kind === "not_found" ? signatureOf(v.output) : undefined,
      failures: 1
    }
  }

  /** Whether a folder is where the failure was: one of its folders is inside the other, or can't be told. */
  const wherever = (d: Open, folder: string | undefined) => d.places.length === 0 || d.places.some((p) => samePlace(p, folder))

  /**
   * Runs what failed again, by whatever command, in the same place: `python
   * build.py` after `python3 build.py`, any test run after a test command's
   * bad flag, another edit of the file a `sed -i` broke. Inline code counts
   * as the same only when it reads alike: each `node -e` is a script of its
   * own. A run in another folder (a scratch copy of another repo) is another
   * place's, and fixes nothing here.
   */
  const sameTarget = (d: Open, targets: ReadonlyArray<Placed>, inline: ReadonlyArray<string>, placed = true) =>
    targets.some((t) =>
      d.targets.some((o) => o.target === t.target && (!placed || samePlace(o.place, t.place))) &&
      (!isInline(t.target) || d.inline.some((a) => inline.some((b) => sameCode(a, b))))
    )

  /** An edit that worked, of a file a failed command was editing: the same file, in the same folder. */
  const editsTarget = (d: Open, v: View) => {
    if (!EDIT_TOOLS.has(v.call.name) || v.file === undefined) return false
    const target = fileTarget(v.file)
    return d.targets.some((o) => o.target === target && samePlace(o.place, v.fileFolder))
  }

  /** A test run in the same place that covers the failing tests: the whole suite, or their files, not just some test names. */
  const coversFailingTests = (d: Open, v: View) =>
    running(v.runs, (k) => classifyKey(k) === "test").filter((r) => wherever(d, r.folder)).some((r) =>
      segmentKeys(r.segment).filter((k) => classifyKey(k) === "test").some((k) => {
        if (filtersTestNames(r.segment)) return false
        if (d.stems.length === 0) return true
        const args = positionalArgs(r.segment, k)
        // `yarn vitest run $f`: a variable could name the failing file.
        return args.length === 0 || args.some((a) => a.includes("$") || d.stems.some((s) => mentionsStem(a, s)))
      })
    )

  /** A failed call that is the same failure again, still being worked on, wherever it ran. */
  const sameThread = (d: Open, v: View): boolean => {
    if (d.start.shell) {
      if (!v.shell) return false
      const runs = failing(v)
      const keys = unique(runs.flatMap((r) => segmentKeys(r.segment)))
      const kind = failureKind(v.call, v.output, keys)
      if (kind !== d.kind) return false
      if (kind === "test_failure") return keys.some((k) => classifyKey(k) === "test")
      const targets = kind === "type_error"
        ? keys.flatMap(keyTargets).map((target) => ({ target, place: undefined }))
        : placedOf(runs)
      if (!sameTarget(d, targets, inlineOf(runs), false)) return false
      return d.signature === undefined || v.output.includes(d.signature)
    }
    if (EDIT_TOOLS.has(d.start.call.name)) return EDIT_TOOLS.has(v.call.name) && v.file === d.start.file
    return v.call.name === d.start.call.name
  }

  /**
   * What failed ran again in the same place without its old error, though
   * something else failed: a command that ran with a bad flag now runs, and
   * its tests fail; a typecheck passes, and the tests after it fail.
   */
  const fixedThoughFailing = (d: Open, v: View): boolean => {
    if (!d.start.shell || !v.shell || v.turn <= d.start.turn) return false
    if (d.kind === "command_error" || d.kind === "not_found") {
      return d.signature !== undefined && sameTarget(d, v.targets, v.inline) && !v.output.includes(d.signature)
    }
    if (d.kind === "type_error") {
      return running(v.runs, (k) => classifyKey(k) === "typecheck").some((r) => wherever(d, r.folder)) && !TYPE_ERRORS.test(v.output)
    }
    return false
  }

  /**
   * A call that worked and shows the failure is gone, in the same place. A
   * check only by the same check passing: tests by a run that covers them,
   * type errors by a typecheck or the command that showed them. Anything
   * else by what failed running again and working, whatever command runs it:
   * a file a command was editing, by the editor too.
   */
  const resolves = (d: Open, v: View): boolean => {
    if (v.failed || v.call.result === undefined || v.turn <= d.start.turn) return false
    if (d.start.shell) {
      if (editsTarget(d, v)) return true
      if (!v.shell || v.command === undefined) return false
      if (d.kind === "test_failure") return coversFailingTests(d, v)
      if (d.kind === "type_error") {
        return running(v.runs, (k) => classifyKey(k) === "typecheck" || d.keys.includes(k)).some((r) => wherever(d, r.folder))
      }
      return sameTarget(d, v.targets, v.inline)
    }
    if (EDIT_TOOLS.has(d.start.call.name)) return EDIT_TOOLS.has(v.call.name) && v.file === d.start.file
    return v.call.name === d.start.call.name
  }

  const close = (d: Open, fix: View): Detour => {
    let removed: Array<string> = []
    let added: Array<string> = []
    if (d.start.shell && fix.command !== undefined && d.start.command !== undefined) {
      // The same target in both: how the command that failed changed into the one that worked.
      const pair = d.keys.flatMap((k) => fix.keys.filter((f) => keyTargets(f)[0] === keyTargets(k)[0]).map((f) => [k, f] as const))[0]
      const before = pair === undefined ? undefined : segmentFor(d.start.command, pair[0])
      const after = pair === undefined ? undefined : segmentFor(fix.command, pair[1])
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
    // Reads, searches and read-only commands look around; when they fail, nothing was done wrong.
    const fixed = v.mistake
      ? pending.filter((d) => !sameThread(d, v) && fixedThoughFailing(d, v))
      : pending.filter((d) => resolves(d, v))
    for (const d of fixed) detours.push(close(d, v))
    pending = pending.filter((d) => !fixed.includes(d))
    if (v.mistake) {
      const thread = pending.find((d) => sameThread(d, v))
      if (thread !== undefined) thread.failures++
      else pending.push(open(v))
    }
  }
  // The run succeeded, so a failing check it never ran again in full was
  // fixed anyway: by the time of the last check of its kind that passed, in
  // the same place (a scratch copy's tests aren't fixed by this repo's).
  if (options.succeeded === true) {
    for (const d of pending) {
      const checks = checkTargets(d.targets)
      if (checks.length === 0) continue
      const last = views
        .filter((v) => v.index > d.start.index && v.turn > d.start.turn && v.shell && !v.failed && v.call.result !== undefined)
        .filter((v) => checkTargets(v.targets).some((c) => checks.some((o) => o.target === c.target && samePlace(o.place, c.place))))
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
