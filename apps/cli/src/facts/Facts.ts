/**
 * Facts: what memory knows about working in a repo that git doesn't hold,
 * built from its stored records at store time, one index per repo. Only two
 * kinds, both concrete and checkable:
 *
 * - a trap: a command that failed and the command that then worked, from a
 *   record's detours. Only when what worked was another command, or the same
 *   one run otherwise (`bun run build` first, `--ignoreConfig`, `bun add -d
 *   @types/bun`): a detour closed by editing the repo's code was the agent's
 *   own bug; one closed with an edit tool, or a failing script of the
 *   agent's own (`python - <<EOF`, `node -e`), was its way of editing; a
 *   shell's quoting error (`unexpected EOF while looking for matching`) is
 *   the agent's habit, which recurs whatever a note says. Those are left out
 *   (`trapOf` says why).
 * - a check: how a change was checked before it was committed. The project's
 *   own checks (a test, typecheck, build or lint command of its package) and
 *   scripts run to check (`node "$TEMP/cv2-ui/ui.mjs" …`, a screenshot or
 *   end-to-end script, often outside git), with what the same line set up
 *   before them (`bun run build`, `unset ELECTRON_RUN_AS_NODE`).
 *
 * No style or judgment, and never code: knowledge an agent can act on.
 *
 * A fact is looked up by what it runs (`keys`, Shell.ts) and by the files the
 * changes it came from changed (`files`). The same fact seen in several
 * records is one fact: its `recurrence` is how many records it came from, its
 * text the newest record's (an older wording never outlives a newer one).
 * A trap retires when a later record ran its failing command as it was and it
 * worked; a fact whose script or package script is gone retires at use
 * (Lookup.ts `isLive`, and Index.ts at store time). Retired facts are left
 * out of the index, not marked.
 *
 * Pure: Index.ts reads the records and writes the index; the replay
 * (examples/scripts/replay-facts.ts) builds it the same way.
 */
import { posix } from "node:path"
import type { Detour, WorkflowRecord } from "../records/Models.ts"
import {
  classifyKey,
  commandWords,
  editedFiles,
  filtersTestNames,
  isReadOnlySegment,
  mainSegments,
  programName,
  type Segment,
  segmentKeys,
  splitCommand
} from "../records/Shell.ts"
import { fileKind, isSnapshot } from "../scripts/Render.ts"
import { INDEX_FORMAT } from "./Lookup.ts"

/** The index's format (Lookup.ts `INDEX_FORMAT`): an index of another is built again. */
export const FACTS_FORMAT = INDEX_FORMAT

export type FactKind = "trap" | "check"

export interface Fact {
  /** Stable across builds: its kind and what it is about. */
  readonly id: string
  readonly kind: FactKind
  /** A check of the project's own (its package's test, typecheck, build or lint), not a script run to check. */
  readonly project: boolean
  /** What it runs, as Shell.ts keys it (`bun typecheck`, `node ui.mjs`): looked up by these when a command fails. */
  readonly keys: ReadonlyArray<string>
  /** What it says, as the agent reads it. */
  readonly text: string
  /** Traps: a piece of the failure's text that tells it apart, matched against a failing command's output. */
  readonly signal: string | null
  /** Traps: what worked, each segment as compared (`sameAs`). */
  readonly fixes: ReadonlyArray<string>
  /** How many records it came from. */
  readonly recurrence: number
  /** Their commits, newest first, and their sessions. */
  readonly commits: ReadonlyArray<string>
  readonly sessions: ReadonlyArray<string>
  /** Source and test files those changes changed: looked up by these when the agent first reads one. */
  readonly files: ReadonlyArray<string>
  /** The script it runs, when it runs one: absolute, or relative to the repo's root. Gone, the fact retires. */
  readonly paths: ReadonlyArray<string>
  /** The package's scripts it runs (`bun run typecheck`: `typecheck`). Gone from package.json, the fact retires. */
  readonly package_scripts: ReadonlyArray<string>
  /** When its newest record's change was committed. */
  readonly newest: string
}

export interface FactIndex {
  readonly format: typeof FACTS_FORMAT
  readonly subject: string
  readonly built_at: string
  /** Records it was built from. */
  readonly records: number
  /** Traps left out because a later record ran their failing command as it was, and it worked. */
  readonly retired: number
  /** Strongest first: most records, then newest. */
  readonly facts: ReadonlyArray<Fact>
  /** File → fact ids, and key → fact ids. */
  readonly by_file: Readonly<Record<string, ReadonlyArray<string>>>
  readonly by_key: Readonly<Record<string, ReadonlyArray<string>>>
}

/** Environment variables a path may name, for finding scripts on disk. */
export type Env = Readonly<Record<string, string | undefined>>

/** When a record's change was committed, as far as the record says. */
export const whenOf = (r: WorkflowRecord): string => r.run.segment?.to ?? r.run.started_at ?? r.created_at

const MAX_SEGMENT_CHARS = 200
const MAX_SYMPTOM_CHARS = 160
const MAX_FIXES = 3

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

/** A segment as shown: without the time limit before it or the redirections after it. */
export const showSegment = (s: Segment): string =>
  clip(
    s.text
      .replace(/^\s*g?timeout\s+(?:-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/, "")
      .replace(/(?:\s+(?:\d|&)?>>?\s*(?:&\d|\S+))+\s*$/, "")
      .replace(/\s+/g, " ")
      .trim(),
    MAX_SEGMENT_CHARS
  )

/** A segment as compared: its words from the program on, without time limits and redirections. */
export const sameAs = (s: Segment) => commandWords(s).join(" ")

/** Interpreters a script is run with. `bun x.ts` runs a file too; `bun test` doesn't. */
const SCRIPT_RUNNERS = new Set(["node", "python", "python3", "py", "bun", "deno", "tsx", "ts-node", "bash", "sh", "pwsh", "powershell"])
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|tsx|py|sh|ps1)$/i
const INLINE = new Set(["-", "-e", "-c", "-p", "--eval", "--print", "-Command"])

/** The script a segment runs (`node "$TEMP/cv2-ui/ui.mjs" …`: `$TEMP/cv2-ui/ui.mjs`), as typed; undefined for inline code or none. */
export const scriptOf = (s: Segment): string | undefined => {
  const ws = commandWords(s)
  if (!SCRIPT_RUNNERS.has(programName(ws[0] ?? ""))) return undefined
  for (const w of ws.slice(1)) {
    if (INLINE.has(w)) return undefined
    if (w.startsWith("-")) continue
    return SCRIPT_FILE.test(w) ? w : undefined
  }
  return undefined
}

/** Inline code: `python - <<EOF`, `node -e`, the agent's own one-off scripts. */
const isInline = (s: Segment) => {
  const ws = commandWords(s)
  return SCRIPT_RUNNERS.has(programName(ws[0] ?? "")) && ws.slice(1).some((w) => INLINE.has(w))
}

/** A segment that only sets the shell up for the next: `unset X`, `export X=1`, `X=1`. */
const isSetup = (s: Segment) => {
  const ws = s.words
  const first = (ws[0] ?? "").toLowerCase()
  return first === "unset" || first === "export" || (ws.length > 0 && ws.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)))
}

/** An edit of files: `sed -i`, inline code that writes, a heredoc into a file. */
const isEdit = (s: Segment) => editedFiles(s).length > 0 || isInline(s) || /^(?:cat|tee)\b[^|]*>/.test(s.text.trim()) || /^cat\s*>/.test(s.text.trim())

const CHECK_CLASSES = new Set(["test", "typecheck", "build", "lint"])
/** A check script by its name: a test, a screenshot, an end-to-end run, a smoke test. */
const CHECK_NAME = /test|check|smoke|e2e|shot|screen|snap|(?:^|[-_.])ui(?:$|[-_.])|verify|regress|drive|probe|proof|bench|lint|validate/i
/** A script that edits, by its name: no check, whatever else it says. */
const EDIT_NAME = /edit|fix|patch|apply|splice|rewrite|replace|update|tools?(?:$|[-_.])/i

/** The package scripts a segment runs: `bun run typecheck`, `npm run build`, `npm test`. */
export const packageScripts = (s: Segment): Array<string> => {
  const ws = commandWords(s)
  const program = programName(ws[0] ?? "")
  if (!["npm", "yarn", "pnpm", "bun"].includes(program)) return []
  const args = ws.slice(1).filter((w) => !w.startsWith("-"))
  if (args[0] === "run" || args[0] === "run-script") return args[1] === undefined ? [] : [args[1]]
  if (program === "npm" && ["test", "start", "stop", "restart"].includes(args[0] ?? "")) return [args[0]]
  return []
}

/**
 * A path as typed in a command, made a path on this machine: environment
 * variables (`$TEMP`, `${TEMP}`, `%TEMP%`), `~`, Git Bash's `/tmp` and drives
 * (`/c/…`), and a relative path from the folder its segment ran in.
 * Undefined when that can't be told.
 */
export const resolvePath = (typed: string, env: Env, folder: string | undefined): string | undefined => {
  let p = typed.trim().replace(/^["']+|["']+$/g, "")
  const named = (name: string) => env[name] ?? env[name.toUpperCase()] ?? Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1]
  let unknown = false
  p = p.replace(/\$\{(\w+)\}|\$(\w+)|%(\w+)%/g, (_, a: string | undefined, b: string | undefined, c: string | undefined) => {
    const value = named(a ?? b ?? c ?? "")
    if (value === undefined) unknown = true
    return value ?? ""
  })
  if (unknown || /[`$]|\$\(/.test(p)) return undefined
  const home = named("HOME") ?? named("USERPROFILE")
  if (p.startsWith("~")) {
    if (home === undefined) return undefined
    p = home + p.slice(1)
  }
  const temp = named("TEMP") ?? named("TMPDIR")
  if (/^\/tmp(?:\/|$)/.test(p)) {
    if (temp === undefined) return undefined
    p = temp + p.slice(4)
  }
  const key = pathKey(p)
  if (/^[A-Z]:\//.test(key) || key.startsWith("/")) return key
  return folder === undefined ? undefined : pathKey(`${folder}/${p}`)
}

/**
 * A path as Shell.ts `folderKey` makes it (forward slashes, Git Bash's
 * drives as Windows writes them, `.` and `..` worked out), its case kept:
 * a file on a case-sensitive disk is found only by its own name. Compare
 * them in lower case.
 */
export const pathKey = (path: string): string => {
  const p = path.trim().replace(/^["']+|["']+$/g, "").replace(/\\/g, "/").replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:")
  const drive = /^[a-zA-Z]:/.exec(p)?.[0].toUpperCase()
  const parts: Array<string> = []
  for (const part of (drive === undefined ? p : p.slice(2)).split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  const body = parts.join("/")
  return drive !== undefined ? `${drive}/${body}` : p.startsWith("/") ? `/${body}` : body
}

/** A path under the repo's root as a repo path; others stay absolute. */
const inRepo = (path: string, root: string | null): string => {
  if (root === null) return path
  const r = pathKey(root)
  return path.toLowerCase().startsWith(r.toLowerCase() + "/") ? path.slice(r.length + 1) : path
}

/** What a record ran that a fact is about, with where it ran. */
interface Ran {
  readonly segment: Segment
  readonly folder: string | undefined
  readonly line: ReadonlyArray<{ readonly segment: Segment; readonly folder: string | undefined }>
}

/** Programs that move the shell to another folder. */
const MOVES_TO = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"])

/**
 * A command's segments that run something, each with the folder it ran in:
 * `cwd`, moved by each `cd` before it, through environment variables too
 * (`cd "$TEMP/cu-e2e"`). Records keep commands with their session's folder
 * taken out, so a bare `cd` (once `cd "<repo>"`) is the repo.
 */
const runsOf = (command: string, cwd: string | null, env: Env): Array<Ran> => {
  const root = cwd === null ? undefined : pathKey(cwd)
  let folder = root
  const line: Array<{ readonly segment: Segment; readonly folder: string | undefined }> = []
  for (const segment of mainSegments(splitCommand(command))) {
    line.push({ segment, folder })
    const ws = commandWords(segment)
    if (MOVES_TO.has(programName(ws[0] ?? ""))) {
      const to = ws.slice(1).find((w) => !w.startsWith("-"))
      folder = to === undefined ? root : resolvePath(to, env, folder)
    }
  }
  return line.map((x) => ({ ...x, line }))
}

/** A key that names a program: not a PowerShell string, a variable or a function's definition (`$test`, `t(){`). */
const isRealKey = (k: string) => /^[a-z0-9][\w.+@-]*(?: [^\s$()"'=]+)*$/i.test(k)

/** The project's own tools: a check of its package runs through one of them. */
const PROJECT_TOOL = /^(?:npm|yarn|pnpm|npx|pnpx|bun|bunx|deno|make|cargo|go|gradle|mvn|pytest|tsc|vitest|jest|dotnet|mix|bundle|rake|turbo|nx|eslint|prettier|ruff|mypy|pyright|(?:python3?|py) -m)\b/

/** Whether a folder is in the repo, or can't be told. */
const inside = (folder: string | undefined, cwd: string | null) => {
  if (folder === undefined || cwd === null) return true
  const root = pathKey(cwd).toLowerCase()
  const here = folder.toLowerCase()
  return here === root || here.startsWith(root + "/")
}

/** The script a run runs, found on this machine: its path, repo-relative when it is in the repo. */
const scriptPath = (r: Ran, record: WorkflowRecord, env: Env): Array<string> => {
  const typed = scriptOf(r.segment)
  const path = typed === undefined ? undefined : resolvePath(typed, env, r.folder)
  return path === undefined ? [] : [inRepo(path, record.run.repo)]
}

/**
 * The script files a command line names, run or not (`cat ui.mjs`, `cp
 * ui.mjs shots.mjs`), where they can be told: as facts name them. For the
 * replay: an agent reuses a harness by reading it as often as by running it.
 */
export const scriptsNamed = (command: string, cwd: string | null, env: Env): Array<string> =>
  runsOf(command, cwd, env).flatMap((r) =>
    r.segment.words.filter((w) => SCRIPT_FILE.test(w)).flatMap((w) => {
      const path = resolvePath(w, env, r.folder)
      return path === undefined ? [] : [cwd === null ? path : inRepo(path, cwd)]
    })
  )

/** The script files a command line runs, where they can be told: as facts name them (`Fact.paths`), from the repo `cwd`. */
export const scriptsRun = (command: string, cwd: string | null, env: Env): Array<string> =>
  runsOf(command, cwd, env).flatMap((r) => {
    const typed = scriptOf(r.segment)
    const path = typed === undefined ? undefined : resolvePath(typed, env, r.folder)
    return path === undefined ? [] : [cwd === null ? path : inRepo(path, cwd)]
  })

/** What one record says, before records are merged. */
interface Seen {
  readonly id: string
  readonly kind: FactKind
  readonly project: boolean
  readonly keys: ReadonlyArray<string>
  readonly text: string
  readonly signal: string | null
  readonly paths: ReadonlyArray<string>
  readonly package_scripts: ReadonlyArray<string>
  /** Traps: the failing command as compared (`sameAs`), and the fixes, for retiring it. */
  readonly failed?: string | undefined
  readonly fixes?: ReadonlyArray<string> | undefined
}

/** Why a detour is no trap; the replay counts them. */
export type NoTrap = "not a command" | "fixed another way" | "failing tests" | "inline code" | "shell syntax" | "code fix" | "no other command"

/** A shell's own error about the line's quoting: the agent's habit, not the repo's. */
const SHELL_SYNTAX = /unexpected EOF while looking for matching|syntax error near unexpected token|syntax error: unexpected end of file|is missing the terminator|Missing closing '\}'/i

const isPathy = (w: string) => /[\\/]/.test(w) || /\d/.test(w)

/**
 * The part of a failure's first line that tells it apart from others: the
 * longest stretch of it without paths, numbers or positions (`Cannot find
 * module 'bun:test' or its corresponding type declarations.` from
 * `test/chat.test.ts(1,51): error TS2307: Cannot find module …`).
 */
export const signalOf = (symptom: string): string | null => {
  const line = symptom.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? ""
  let best = ""
  let run: Array<string> = []
  const flush = () => {
    const text = run.join(" ").replace(/^[\s:;,.()[\]-]+|[\s:;,([-]+$/g, "")
    if (text.length > best.length) best = text
    run = []
  }
  for (const w of line.split(/\s+/)) {
    if (isPathy(w)) flush()
    else run.push(w)
  }
  flush()
  return best.length >= 8 && !GENERIC_SIGNAL.test(best) ? clip(best, 80) : null
}

/** What any failure says (`Exit code 1`, `Command failed with exit code 2`): it tells no failure apart. */
const GENERIC_SIGNAL = /^(?:exit code|error|fatal|failed|command failed(?: with exit code)?|process exited with code|non-zero exit status)\.?$/i

/**
 * The trap a detour shows, or why it shows none: what failed and what then
 * worked, when what worked was another command (or the same one run
 * otherwise) and the repo's code wasn't edited in between.
 */
export const trapOf = (record: WorkflowRecord, d: Detour, env: Env): Seen | NoTrap => {
  if (d.failed.command === null || d.failed.command.trim() === "") return "not a command"
  if (d.fixed.command === null || d.fixed.command.trim() === "") return "fixed another way"
  // Tests that fail are the code's; what makes them pass is a change to it.
  if (d.kind === "test_failure") return "failing tests"
  const failedRuns = runsOf(d.failed.command, record.run.repo, env).filter((r) => !isReadOnlySegment(r.segment))
  const failing = failedRuns.filter((r) => segmentKeys(r.segment).some((k) => d.keys.includes(k) && isRealKey(k)))
  const telling = failing.filter((r) => !isInline(r.segment) && !isEdit(r.segment))
  if (telling.length === 0) return "inline code"
  if (SHELL_SYNTAX.test(d.symptom)) return "shell syntax"
  // The repo's own files edited on the way: the agent fixed its code, not how it ran it.
  if (d.files_edited.some((f) => !/^(?:[a-zA-Z]:|\/)/.test(f))) return "code fix"
  const before = new Set(failedRuns.map((r) => sameAs(r.segment)))
  // What the line that worked ran that the failing one didn't: not an edit, not git, and not a check of
  // another kind than the one that failed (running the tests alone fixes nothing).
  const fixes = runsOf(d.fixed.command, record.run.repo, env).filter((r) => {
    if (!(!isReadOnlySegment(r.segment) || isSetup(r.segment)) || isEdit(r.segment) || before.has(sameAs(r.segment))) return false
    const keys = segmentKeys(r.segment)
    if (keys.some((k) => k === "git" || k.startsWith("git "))) return false
    return !keys.some((k) => ["test", "typecheck"].includes(classifyKey(k)) && !d.keys.includes(k))
  })
  if (fixes.length === 0) return "no other command"
  const keys = [...new Set(telling.flatMap((r) => segmentKeys(r.segment)).filter((k) => d.keys.includes(k) && isRealKey(k)))]
  const signal = signalOf(d.symptom)
  const symptom = clip((d.symptom.split("\n").find((l) => l.trim() !== "") ?? "").replace(/\s+/g, " ").trim(), MAX_SYMPTOM_CHARS)
  const shown = fixes.slice(0, MAX_FIXES).map((r) => `\`${showSegment(r.segment)}\``)
  const main = telling[telling.length - 1]
  const text = `\`${showSegment(main.segment)}\` failed: ${symptom}. What worked: ${shown.join(", then ")}${fixes.length > MAX_FIXES ? ", …" : ""}.`
  return {
    id: `trap:${[...keys].sort().join("+")}:${(signal ?? symptom).toLowerCase().replace(/\s+/g, " ").slice(0, 60)}`,
    kind: "trap",
    project: false,
    keys,
    text,
    signal,
    paths: telling.flatMap((r) => scriptPath(r, record, env)),
    package_scripts: [...new Set(telling.flatMap((r) => packageScripts(r.segment)))],
    failed: sameAs(main.segment),
    fixes: fixes.map((r) => sameAs(r.segment))
  }
}

/**
 * How a record's change was checked: each project check it ran that worked
 * (the whole suite or some of it, not a run of tests picked by name), and
 * each check script, with what its line set up before it.
 */
export const checksOf = (record: WorkflowRecord, env: Env): Array<Seen> => {
  const project = new Map<string, Seen>()
  const scripts = new Map<string, Seen>()
  for (const c of record.commands) {
    if (!c.ok) continue
    for (const r of runsOf(c.command, record.run.repo, env)) {
      // A segment the record cut short (`…`) can't be shown or run as it was.
      if (isReadOnlySegment(r.segment) || isEdit(r.segment) || r.segment.text.endsWith("...")) continue
      const keys = segmentKeys(r.segment)
      const script = scriptOf(r.segment)
      if (script !== undefined) {
        const name = posix.basename(script.replace(/\\/g, "/")).replace(SCRIPT_FILE, "")
        if (!CHECK_NAME.test(name) || EDIT_NAME.test(name)) continue
        // What the line did before it to set it up: a build, an environment variable.
        const at = r.line.findIndex((x) => x.segment === r.segment)
        const setup = r.line.slice(0, at).filter((x) =>
          isSetup(x.segment) || (!isReadOnlySegment(x.segment) && !isEdit(x.segment) && segmentKeys(x.segment).some((k) => CHECK_CLASSES.has(classifyKey(k))))
        )
        const shown = [...setup.map((x) => showSegment(x.segment)), showSegment(r.segment)]
        const key = keys[0] ?? script
        // A script is the file it runs: sessions name theirs alike (`shots.mjs` in three folders), and one
        // name for all would make them one fact. By its name only when where it is can't be told.
        const paths = scriptPath(r, record, env)
        const id = `check:${paths[0]?.toLowerCase() ?? key}`
        // The last run of a script in a record is the one its change was checked with.
        scripts.set(id, {
          id,
          kind: "check",
          project: false,
          keys: [key],
          text: `\`${shown.join("; ")}\``,
          signal: null,
          paths,
          package_scripts: [...new Set(setup.flatMap((x) => packageScripts(x.segment)))]
        })
        continue
      }
      // The project's checks run in the repo: a check of another repo the session worked in isn't this one's.
      if (filtersTestNames(r.segment) || !inside(r.folder, record.run.repo)) continue
      for (const key of keys) {
        if (!CHECK_CLASSES.has(classifyKey(key)) || !PROJECT_TOOL.test(key)) continue
        const text = `\`${showSegment(r.segment)}\``
        const had = project.get(key)
        // The plainest way the record ran it: the shortest.
        if (had !== undefined && had.text.length <= text.length) continue
        project.set(key, { id: `check:${key}`, kind: "check", project: true, keys: [key], text, signal: null, paths: [], package_scripts: packageScripts(r.segment) })
      }
    }
  }
  return [...project.values(), ...scripts.values()]
}

/** Source and test files a record changed: what a fact from it is looked up by. */
const telling = (r: WorkflowRecord) => r.files.filter((f) => !f.snapshot && !isSnapshot(f.path) && fileKind(f.path) !== "rest").map((f) => f.path)

/** Every fact the records say, newest wording per fact; traps a later record ran as they were left out. */
export const buildFacts = (
  records: ReadonlyArray<WorkflowRecord>,
  options: { readonly subject: string; readonly env: Env; readonly now: string }
): FactIndex => {
  const ordered = [...records].filter((r) => r.run.outcome === "success").sort((a, b) => whenOf(a).localeCompare(whenOf(b)))
  interface Merged {
    seen: Seen
    records: Array<WorkflowRecord>
  }
  const merged = new Map<string, Merged>()
  for (const r of ordered) {
    const seen = [
      ...r.detours.map((d) => trapOf(r, d, options.env)).filter((t): t is Seen => typeof t !== "string"),
      ...checksOf(r, options.env)
    ]
    const once = new Map(seen.map((s) => [s.id, s] as const))
    for (const s of once.values()) {
      const m = merged.get(s.id)
      if (m === undefined) merged.set(s.id, { seen: s, records: [r] })
      else {
        m.seen = s
        m.records.push(r)
      }
    }
  }
  // A trap retires once a later record ran its failing command as it was, without the fix, and it worked.
  const retired = new Set<string>()
  for (const [id, m] of merged) {
    if (m.seen.kind !== "trap" || m.seen.failed === undefined) continue
    const last = m.records[m.records.length - 1]
    const later = ordered.slice(ordered.indexOf(last) + 1)
    const fixes = new Set(m.seen.fixes ?? [])
    const ranAsIs = later.some((r) =>
      r.commands.some((c) => {
        if (!c.ok) return false
        const line = mainSegments(splitCommand(c.command)).map(sameAs)
        return line.includes(m.seen.failed!) && !line.some((s) => fixes.has(s))
      })
    )
    if (ranAsIs) retired.add(id)
  }
  const facts: Array<Fact> = [...merged.entries()]
    .filter(([id]) => !retired.has(id))
    .map(([id, m]): Fact => {
      const newest = [...m.records].reverse()
      return {
        id,
        kind: m.seen.kind,
        project: m.seen.project,
        keys: m.seen.keys,
        text: m.seen.text,
        signal: m.seen.signal,
        fixes: m.seen.fixes ?? [],
        recurrence: m.records.length,
        commits: [...new Set(newest.flatMap((r) => (r.run.head_commit === null ? [] : [r.run.head_commit])))],
        sessions: [...new Set(newest.map((r) => r.run.session_id))],
        files: [...new Set(m.records.flatMap(telling))].sort(),
        paths: m.seen.paths,
        package_scripts: m.seen.package_scripts,
        newest: whenOf(newest[0])
      }
    })
    .sort((a, b) => b.recurrence - a.recurrence || b.newest.localeCompare(a.newest) || a.id.localeCompare(b.id))
  const byFile: Record<string, Array<string>> = {}
  const byKey: Record<string, Array<string>> = {}
  for (const f of facts) {
    for (const file of f.files) (byFile[file] ??= []).push(f.id)
    for (const key of f.keys) (byKey[key] ??= []).push(f.id)
  }
  return { format: FACTS_FORMAT, subject: options.subject, built_at: options.now, records: ordered.length, retired: retired.size, facts, by_file: byFile, by_key: byKey }
}
