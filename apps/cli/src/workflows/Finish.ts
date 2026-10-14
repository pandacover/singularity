/**
 * The finish: after its last edit, a run checks its work. Runs handed the
 * workflows' checks one by one (and a workflow of "run the tests, run the
 * typecheck, review the snapshots") spent a turn on each, then another
 * reading snapshot diffs to see whether the changes were expected. Runs
 * handed the list of snapshot files a past run regenerated didn't read them.
 *
 * So memory folds the finish into one command: the checks of the workflows a
 * task gets, in one line, the formatters first and the tests last, and says
 * which snapshot files earlier runs of those workflows regenerated. Both are
 * learned from runs: the checks by the inducing model from the commands runs
 * passed, the snapshot files mechanically from their diffs (every run a
 * workflow was learned from regenerated them). No model call at task start.
 *
 * Agents run that command as it is given, so it is checked first against the
 * repo the task starts in (`checkCommands`): a line that calls a script its
 * package.json doesn't have, names a file it doesn't have, or runs a package
 * manager its lockfile doesn't name is left out, and so is a check another
 * line already runs (npm runs `pretest` before `test`); a test runner that
 * would wait for changes in a terminal is told to run once, and the lines run
 * in the order the repo's own scripts run them. A repo without a package.json
 * can't be checked yet: it gets no command.
 *
 * A finishing workflow (one with no step at a place, leading only to the
 * end, with checks) is that finish: it isn't handed over as steps, its checks
 * and pitfalls go into the one command's section.
 */
import { Effect, Option, Schema } from "effect"
import { classifyKey, commandKeys, commandWords, mainSegments, programName, type Segment, splitCommand } from "../records/Shell.ts"
import type { RunEvidence } from "./Evidence.ts"
import { type CodeSource, pathExists, textAt } from "./Locate.ts"
import { END, type Workflow, type WorkflowMemory } from "./Models.ts"

/** Memory that keeps what its workflows' checks rewrite hands over the finish as one command. */
export const hasFinish = (m: WorkflowMemory): boolean => m.workflows.some((w) => w.snapshots !== undefined)

/**
 * A workflow that only checks: no step at a place, edges only to the end, and
 * commands to run. Not a kind's workflow (Common.ts): its steps carry what
 * tasks of the kind had to find out, so they are handed over; its checks
 * still go into the one command.
 */
export const isFinishing = (m: WorkflowMemory, w: Workflow): boolean =>
  w.kind === undefined &&
  w.checks.length > 0 &&
  w.steps.every((s) => s.place === null) &&
  m.edges.some((e) => e.from === w.id) &&
  m.edges.filter((e) => e.from === w.id).every((e) => e.to === END)

/** Formatters and linters first (they change files), then the typecheck, builds, tests, the rest. */
const ORDER = ["lint", "typecheck", "build", "test", "other", "install"] as const

const rank = (command: string): number => {
  const kinds = commandKeys(command).map(classifyKey)
  const ranks = kinds.map((k) => ORDER.indexOf(k)).filter((i) => i >= 0)
  return ranks.length === 0 ? ORDER.indexOf("other") : Math.min(...ranks)
}

export type Manager = "npm" | "yarn" | "pnpm" | "bun"

/** What a finish's commands are checked against: the repo the task starts in. */
export interface RepoFacts {
  /** Its package.json's scripts; undefined when it has no package.json memory can read, and no command can be checked. */
  readonly scripts: Readonly<Record<string, string>> | undefined
  /** The package manager its lockfile names, when exactly one does. */
  readonly manager: Manager | undefined
  /** Of the paths the commands need (`namedPaths`), those it has. */
  readonly paths: ReadonlySet<string>
}

/** Lockfiles, and the package manager each says a repo uses. */
const LOCKFILES: ReadonlyArray<readonly [string, Manager]> = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"]
]

const MANAGERS: ReadonlySet<string> = new Set(["npm", "yarn", "pnpm", "bun"])
/** npm's names for running a script: `npm test` runs `test`. */
const NPM_SCRIPTS: Readonly<Record<string, string>> = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" }
/** yarn's and pnpm's own commands: `yarn install` installs, whatever the scripts are called. */
const OWN_COMMANDS: ReadonlySet<string> = new Set([
  "add", "audit", "autoclean", "bin", "cache", "check", "config", "create", "dedupe", "dlx", "exec", "explain", "fetch",
  "generate-lock-entry", "global", "help", "i", "import", "info", "init", "install", "licenses", "link", "list", "ls", "login",
  "logout", "node", "outdated", "owner", "pack", "patch", "plugin", "policy", "prune", "publish", "rebuild", "recursive", "remove",
  "rm", "root", "set", "store", "tag", "team", "unlink", "unplug", "up", "update", "upgrade", "upgrade-interactive", "version",
  "versions", "why", "workspace", "workspaces"
])
/** Programs packages install that yarn and pnpm run by name (`yarn vitest`); any other name they run is a script. */
const PROGRAMS: ReadonlySet<string> = new Set([
  "vitest", "jest", "mocha", "ava", "c8", "nyc", "tsc", "tsx", "ts-node", "eslint", "prettier", "biome", "oxlint", "stylelint",
  "markdownlint", "markdownlint-cli2", "playwright", "cypress", "turbo", "nx", "lerna", "vite", "next", "webpack", "rollup", "esbuild", "node"
])
/** Flags that send a command to another package or directory, whose scripts and files aren't the ones checked. */
const ELSEWHERE = /^(-w|--workspace|--workspaces|-ws|--prefix|-C|--cwd|--dir|--filter|-F|-r|--recursive|-g|--global)(=|$)/
/** Programs that run code given on their command line (`node -e`), which names no file. */
const INTERPRETERS: ReadonlySet<string> = new Set(["node", "python", "python3", "py", "ruby", "perl", "php", "bash", "sh", "pwsh", "powershell", "deno", "bun"])
const INLINE = /^(-e|-c|-p|--eval|--print|-command)$/i
/** Test runners that wait for changes unless told to run once, and the words that tell them. */
const VITEST = /(^|\s)vitest(\s|$)/
const RUNS_ONCE = /(^|\s)(run|--run|--watch=false)(\s|$)|--watch\s+false/

/** What a segment runs; `at` is where its words (`commandWords`) name it, and what follows is passed to it. */
export type Call =
  | { readonly kind: "script"; readonly manager: Manager; readonly name: string; readonly at: number }
  | { readonly kind: "program"; readonly manager: Manager | undefined; readonly name: string; readonly at: number }
  | { readonly kind: "elsewhere" }

/** What a segment runs, as the repo's scripts see it: one of them, a program (`npx tsc`), or something in another package. */
export const callOf = (segment: Segment, scripts: Readonly<Record<string, string>>): Call => {
  const ws = commandWords(segment)
  const program = programName(ws[0] ?? "")
  const end = ws.includes("--") ? ws.indexOf("--") : ws.length
  // The words a package manager reads itself, before any `--`, that aren't flags.
  const plain = ws.map((w, i) => ({ w, i })).filter(({ w, i }) => i > 0 && i < end && !w.startsWith("-"))
  const [sub, next] = plain
  if (program === "npx" || program === "pnpx" || program === "bunx") {
    const manager = program === "pnpx" ? "pnpm" : program === "bunx" ? "bun" : "npm"
    return sub === undefined ? { kind: "program", manager, name: program, at: 0 } : { kind: "program", manager, name: programName(sub.w), at: sub.i }
  }
  if (!MANAGERS.has(program)) return { kind: "program", manager: undefined, name: program, at: 0 }
  const manager = program as Manager
  if (ws.slice(1, end).some((w) => ELSEWHERE.test(w))) return { kind: "elsewhere" }
  const itself: Call = { kind: "program", manager, name: program, at: 0 }
  if (sub === undefined) return itself
  if (sub.w === "run" || sub.w === "run-script") return next === undefined ? itself : { kind: "script", manager, name: next.w, at: next.i }
  if (manager === "npm") return NPM_SCRIPTS[sub.w] === undefined ? itself : { kind: "script", manager, name: NPM_SCRIPTS[sub.w], at: sub.i }
  // bun runs scripts with `bun run` only: `bun test` is its own test runner.
  if (manager === "bun" || OWN_COMMANDS.has(sub.w)) return itself
  if (scripts[sub.w] !== undefined || !PROGRAMS.has(sub.w)) return { kind: "script", manager, name: sub.w, at: sub.i }
  return { kind: "program", manager, name: sub.w, at: sub.i }
}

/** What a segment passes the script or program it runs: `yarn test:app --update` passes `--update`. */
const passedBy = (segment: Segment, call: Call): string => (call.kind === "elsewhere" ? "" : commandWords(segment).slice(call.at + 1).join(" "))

/** A path as checked: forward slashes, no `./` before it or `/` after it. */
const pathKey = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "")

/** A word that names a file or directory: a path with a slash, or a name with an extension (`install.sh`). */
const isPath = (w: string): boolean =>
  w !== "" && !w.startsWith("@") && !/[*?$`{}<>|]|:\/\//.test(w) && !/^\d+(\.\d+)*$/.test(w) &&
  (/[\\/]/.test(w) || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(w))

/**
 * What a segment needs the repo to have: the files and directories it names,
 * its program too when it is run by its path (`./gradlew`), and the
 * configuration its program can't run without (`tsc` with no files given
 * reads a tsconfig.json: in the directory it runs in, or the project `-p`
 * names).
 */
const neededBy = (segment: Segment): Array<string> => {
  const ws = commandWords(segment)
  const program = programName(ws[0] ?? "")
  const named: Array<string> = /[\\/]/.test(ws[0] ?? "") ? [ws[0]] : []
  if (INTERPRETERS.has(program) && ws.slice(1).some((w) => INLINE.test(w))) return named.map(pathKey)
  for (const w of ws.slice(1)) {
    const value = w.startsWith("-") ? (w.includes("=") ? w.slice(w.indexOf("=") + 1) : undefined) : w
    if (value !== undefined && isPath(value)) named.push(value)
  }
  const tsc = ws.findIndex((w) => programName(w) === "tsc")
  if (tsc >= 0) {
    const rest = ws.slice(tsc + 1)
    const project = rest.findIndex((w) => /^(-p|--project|-b|--build)$/.test(w))
    const given = project >= 0 ? rest[project + 1] : undefined
    if (given !== undefined && !given.startsWith("-")) named.push(/\.json$/i.test(given) ? given : `${given}/tsconfig.json`)
    else if (!rest.some((w) => !w.startsWith("-") && /\.[cm]?tsx?$/.test(w))) named.push("tsconfig.json")
  }
  return named.map(pathKey).map((p) => (p === "" || p === "." ? "." : p.replace(/^\.\//, "")))
}

/** The paths a command line needs the repo to have, checked into `RepoFacts.paths`. */
export const namedPaths = (line: string): Array<string> => mainSegments(splitCommand(line)).flatMap(neededBy)

/**
 * The scripts a script runs, itself first, and the programs it runs, with
 * what each is passed (a script that calls another passes its own words on:
 * `yarn test:app --watch=false` runs `vitest --watch=false`). With npm,
 * `pre<name>` runs before it.
 */
const expand = (
  scripts: Readonly<Record<string, string>>,
  name: string,
  npm: boolean,
  seen: Set<string> = new Set()
): { readonly names: Array<string>; readonly programs: Array<string> } => {
  const names: Array<string> = []
  const programs: Array<string> = []
  if (seen.has(name)) return { names, programs }
  seen.add(name)
  names.push(name)
  for (const body of [npm ? scripts[`pre${name}`] : undefined, scripts[name]]) {
    if (body === undefined) continue
    for (const segment of mainSegments(splitCommand(body))) {
      const call = callOf(segment, scripts)
      if (call.kind === "script" && scripts[call.name] !== undefined) {
        const more = expand(scripts, call.name, call.manager === "npm", seen)
        const passed = passedBy(segment, call)
        names.push(...more.names)
        programs.push(...more.programs.map((p) => (passed === "" ? p : `${p} ${passed}`)))
      } else {
        programs.push(commandWords(segment).join(" "))
      }
    }
  }
  return { names, programs }
}

/** Pairs of scripts the repo runs in order: a script that runs `a` then `b` says `a` comes first. */
const declaredOrder = (scripts: Readonly<Record<string, string>>): Array<readonly [string, string]> =>
  Object.values(scripts).flatMap((body) => {
    const called = mainSegments(splitCommand(body)).flatMap((s) => {
      const call = callOf(s, scripts)
      return call.kind === "script" ? [call.name] : []
    })
    return called.flatMap((a, i) => called.slice(i + 1).filter((b) => b !== a).map((b) => [a, b] as const))
  })

/** Check runners a script that runs them on everything makes a call of its own redundant. */
const SUITE_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "eslint", "tsc"])
/** Commands that change the directory the rest of a line runs in. */
const MOVES: ReadonlySet<string> = new Set(["cd", "pushd", "chdir", "set-location", "sl"])

interface Checked {
  readonly text: string
  readonly calls: ReadonlyArray<{ readonly segment: Segment; readonly call: Call }>
}

/**
 * The commands of a finish as they can run in the repo: the lines that fit
 * it (their scripts, files and package manager are the repo's), without
 * those another line already runs, test runners told to run once, in the
 * order the repo's scripts run them. Empty when the repo can't be checked.
 */
export const checkCommands = (lines: ReadonlyArray<string>, repo: RepoFacts): Array<string> => {
  const scripts = repo.scripts
  if (scripts === undefined) return []
  const fits = (segment: Segment, call: Call): boolean => {
    if (call.kind === "elsewhere") return false
    // A line that moves elsewhere first runs where nothing here is checked.
    if (MOVES.has(programName(commandWords(segment)[0] ?? ""))) return false
    if (call.kind === "script" && scripts[call.name] === undefined) return false
    // npm and npx come with Node; yarn, pnpm and bun only where the repo uses them.
    if (call.manager !== undefined && call.manager !== "npm" && repo.manager !== undefined && call.manager !== repo.manager) return false
    return neededBy(segment).every((p) => repo.paths.has(p))
  }
  const kept: Array<Checked> = []
  for (const text of lines) {
    const calls = mainSegments(splitCommand(text)).map((segment) => ({ segment, call: callOf(segment, scripts) }))
    if (calls.length > 0 && calls.every(({ segment, call }) => fits(segment, call))) kept.push({ text, calls })
  }

  // What each line runs beyond its own scripts: their pre-scripts, the scripts they call, the programs in them.
  const runsOf = (l: Checked) =>
    l.calls.flatMap(({ call }) => {
      if (call.kind !== "script") return []
      const e = expand(scripts, call.name, call.manager === "npm")
      return [{ names: e.names.slice(1), programs: e.programs }]
    })
  const ownScripts = (l: Checked) => l.calls.flatMap(({ call }) => (call.kind === "script" ? [call.name] : []))
  const onlyScripts = (l: Checked) => l.calls.every(({ call }) => call.kind === "script")
  const redundant = (l: Checked, others: ReadonlyArray<Checked>, before: ReadonlyArray<Checked>): boolean => {
    const mine = ownScripts(l)
    // The same scripts as a line before it, or scripts another line runs as part of its own.
    if (onlyScripts(l) && before.some((o) => onlyScripts(o) && ownScripts(o).join("\n") === mine.join("\n"))) return true
    if (onlyScripts(l) && mine.every((name) => others.some((o) => runsOf(o).some((r) => r.names.includes(name))))) return true
    // A check runner's own call, where a script runs it on everything.
    const single = l.calls.length === 1 ? l.calls[0].call : undefined
    if (single?.kind !== "program" || !SUITE_RUNNERS.has(single.name)) return false
    const runner = new RegExp(`(^|\\s|/)${single.name}(\\s|$)`)
    return others.some((o) => runsOf(o).some((r) => r.programs.some((p) => runner.test(p))))
  }
  // One at a time, so of two lines that each run the other's scripts, one stays.
  for (let i = 0; i < kept.length;) {
    if (redundant(kept[i], kept.filter((_, j) => j !== i), kept.slice(0, i))) kept.splice(i, 1)
    else i++
  }

  // Test runners that wait for changes run once: in a terminal (Codex's, Hermes Agent's) they would never return.
  const texts = kept.map((l) => {
    let text = l.text
    let from = 0
    for (const { segment, call } of l.calls) {
      const at = text.indexOf(segment.text, from)
      if (at < 0) continue
      from = at + segment.text.length
      const ws = commandWords(segment)
      const passed = passedBy(segment, call)
      let flag: string | undefined
      if (call.kind === "script" && !RUNS_ONCE.test(passed)) {
        const e = expand(scripts, call.name, call.manager === "npm")
        if (e.programs.some((p) => VITEST.test(p) && !RUNS_ONCE.test(p))) flag = call.manager === "npm" && !ws.includes("--") ? " -- --watch=false" : " --watch=false"
      } else if (call.kind === "program" && call.name === "vitest" && !RUNS_ONCE.test(passed)) {
        flag = " --run"
      }
      if (flag === undefined) continue
      text = text.slice(0, from) + flag + text.slice(from)
      from += flag.length
    }
    return { text, scripts: ownScripts(l) }
  })

  // The order the repo's own scripts run them in.
  const pairs = declaredOrder(scripts)
  for (let pass = 0; pass < 20; pass++) {
    let moved = false
    for (const [a, b] of pairs) {
      const ia = texts.findIndex((t) => t.scripts.includes(a))
      const ib = texts.findIndex((t) => t.scripts.includes(b))
      if (ia >= 0 && ib >= 0 && ia > ib) {
        const [x] = texts.splice(ia, 1)
        texts.splice(ib, 0, x)
        moved = true
      }
    }
    if (!moved) break
  }
  return texts.map((t) => t.text)
}

export const PackageJson = Schema.fromJsonString(Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }))

/** The repo the task starts in, as the commands `lines` are checked against it, read from `source`. */
export const repoFacts = Effect.fn("repoFacts")(function*(source: CodeSource, lines: ReadonlyArray<string>) {
  const text = yield* textAt(source, "package.json")
  const pkg = text === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(PackageJson)(text))
  const managers = new Set<Manager>()
  for (const [file, manager] of LOCKFILES) if (yield* pathExists(source, file)) managers.add(manager)
  const paths = new Set<string>()
  for (const p of new Set(lines.flatMap(namedPaths))) if (p === "." || (yield* pathExists(source, p))) paths.add(p)
  return {
    scripts: pkg === undefined ? undefined : pkg.scripts ?? {},
    manager: managers.size === 1 ? [...managers][0] : undefined,
    paths
  } satisfies RepoFacts
})

export interface Finish {
  /**
   * One line that runs every check, `;`-separated so each runs whatever the
   * one before it did, in Bash and PowerShell alike; undefined when none of
   * the checks can run as given in the repo.
   */
  readonly command: string | undefined
  /** Snapshot files earlier runs of these workflows regenerated. */
  readonly snapshots: ReadonlyArray<string>
  /** The finishing workflows folded into it. */
  readonly folded: ReadonlyArray<string>
}

/**
 * The finish of a task given these workflows, in the order given, its
 * commands checked against `repo` when given; undefined when none of the
 * workflows has a check.
 */
export const finishOf = (m: WorkflowMemory, chosen: ReadonlyArray<Workflow>, repo?: RepoFacts): Finish | undefined => {
  const seen = new Set<string>()
  const checks: Array<string> = []
  for (const w of chosen) {
    for (const c of w.checks) {
      const line = c.trim().replace(/\s+/g, " ")
      if (line === "" || seen.has(line)) continue
      seen.add(line)
      checks.push(line)
    }
  }
  if (checks.length === 0) return undefined
  const ordered = checks.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c)
  const commands = repo === undefined ? ordered : checkCommands(ordered, repo)
  const snapshots = [...new Set(chosen.flatMap((w) => w.snapshots ?? []))].sort()
  // With snapshots to expect, the same call lists what changed.
  const command = commands.length === 0 ? undefined : [...commands, ...(snapshots.length > 0 ? ["git status --short"] : [])].join("; ")
  return { command, snapshots, folded: chosen.filter((w) => isFinishing(m, w)).map((w) => w.id) }
}

/**
 * What each workflow's checks rewrite: the snapshot files that every run it
 * was learned from (at least two of `runs`) regenerated. Every workflow gets
 * the key, empty when the runs don't agree or are too few.
 */
export const withSnapshots = (m: WorkflowMemory, runs: ReadonlyArray<RunEvidence>): WorkflowMemory => {
  const byRecord = new Map(runs.map((r) => [r.record, r]))
  return {
    ...m,
    workflows: m.workflows.map((w) => {
      const own = w.evidence.flatMap((id) => byRecord.get(id) ?? [])
      if (own.length < 2) return { ...w, snapshots: [] }
      const [first, ...rest] = own.map((r) => new Set(r.snapshots))
      const always = [...first].filter((s) => rest.every((x) => x.has(s))).sort()
      return { ...w, snapshots: always }
    })
  }
}
