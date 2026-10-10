/**
 * `singularity update`: the latest code, and what setup put in place brought
 * up to date with it, without asking again what setup asked.
 *
 *   1. The code: the clone in `<memory home>/app` fetched and reset to the
 *      latest commit of its branch, as the installer does, and its
 *      dependencies installed again when they changed.
 *   2. Setup, refreshed by the new code (`update --no-fetch`, run as a child
 *      process: this one still runs the old code): memory's hooks in the
 *      agents that have them, Hermes Agent's plugin, the skill where it is,
 *      the `singularity` command. Hook commands, the skill's text and the
 *      launchers change with the code; agents left out stay out, and the
 *      choices in config.json stay as they are. The installer, run again
 *      where memory is set up, does this step too instead of setup.
 *
 * `update --no-fetch` is how one version hands over to the next, so every
 * version keeps it.
 */
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { delimiter } from "node:path"
import { runProcess } from "../eval/Proc.ts"
import { loadHome } from "../local/Home.ts"
import { type Agent, type AgentDirs, agents, join } from "./Agents.ts"
import { lockHeld } from "./Background.ts"
import { binDir, COMMAND, writeLaunchers } from "./Launcher.ts"
import { learnIsSet, readLearn } from "./Preferences.ts"
import { codexTrust } from "./Setup.ts"
import { type SkillState, skillState } from "./Skill.ts"
import { LEARNER_NAMES } from "./Learner.ts"
import { listWords, makeStyle, type Style, tilde, usd, withSpinner } from "./Ui.ts"
import { agentStates, detectAgents, findCommand, findExecutable, HOOK_SCRIPT, nodeForHooks, skillDirsFor, wireHooks, wireSkills } from "./Wiring.ts"

export class UpdateError extends Schema.TaggedError<UpdateError>()("UpdateError", {
  message: Schema.String
}) {}

/** Where the installer puts the code. */
export const appDir = (root: string) => join(root, "app")

/** The installed CLI for daily use, in the code at `app`. */
const cliIn = (app: string, path: Path.Path) => path.join(app, "apps", "cli", "src", "singularity.ts")

/** Whether memory was set up here: setup always writes the command, and uninstall removes it. */
export const isSetUp = Effect.fn("isSetUp")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.exists(path.join(binDir(root), "singularity")).pipe(Effect.orElseSucceed(() => false))
})

export type CodeUpdate =
  | { readonly kind: "current"; readonly commit: string }
  | { readonly kind: "updated"; readonly before: string; readonly after: string; readonly ref: string; readonly subject: string; readonly dependencies: boolean }

/**
 * npm, run through the node this process runs so it never picks up another:
 * the npm next to it (Windows, and nodejs.org's builds) or in its lib
 * (Homebrew, nvm), else the one on PATH.
 */
const npmCommand = Effect.fnUntraced(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.dirname(process.execPath)
  for (const cli of [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (yield* fs.exists(cli).pipe(Effect.orElseSucceed(() => false))) return [process.execPath, cli] as ReadonlyArray<string>
  }
  return yield* findCommand("npm")
})

/**
 * Bring the code in `app` to the latest commit of its branch (`main` when it
 * is on none), and its dependencies with it. Nothing changes when it is
 * current already and its dependencies were installed.
 */
export const updateCode = Effect.fn("updateCode")(function*(app: string, interactive: boolean) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = (args: ReadonlyArray<string>, timeoutS = 120) =>
    runProcess("git", ["-C", app, ...args], { cwd: app, timeoutS, env: process.env }).pipe(Effect.orElseSucceed(() => undefined))
  const out = (args: ReadonlyArray<string>) => git(args).pipe(Effect.map((r) => (r?.exitCode === 0 ? r.stdout.trim() : undefined)))
  const read = (file: string) => fs.readFileString(path.join(app, file)).pipe(Effect.orElseSucceed(() => undefined))

  const before = yield* out(["rev-parse", "HEAD"])
  if (before === undefined) return yield* new UpdateError({ message: `${app} isn't a git checkout of singularity` })
  const branch = yield* out(["rev-parse", "--abbrev-ref", "HEAD"])
  const ref = branch === undefined || branch === "HEAD" ? "main" : branch
  const fetched = yield* withSpinner(`fetching ${ref}`, git(["fetch", "--quiet", "--depth", "1", "origin", ref], 300), interactive)
  if (fetched?.exitCode !== 0) {
    return yield* new UpdateError({ message: `couldn't fetch ${ref}: ${fetched?.stderr.trim().split(/\r?\n/).at(-1) ?? "git didn't run"}` })
  }
  const after = yield* out(["rev-parse", "FETCH_HEAD"])
  if (after === undefined) return yield* new UpdateError({ message: `git fetched ${ref} but didn't say what it got` })
  const installed = (yield* read(path.join("node_modules", ".package-lock.json"))) !== undefined
  if (after === before && installed) return { kind: "current", commit: before } satisfies CodeUpdate

  const lockBefore = yield* read("package-lock.json")
  const reset = yield* git(["reset", "--quiet", "--hard", "FETCH_HEAD"])
  if (reset?.exitCode !== 0) return yield* new UpdateError({ message: `couldn't move ${app} to ${after.slice(0, 7)}: ${reset?.stderr.trim() ?? "git didn't run"}` })
  const dependencies = !installed || (yield* read("package-lock.json")) !== lockBefore
  if (dependencies) {
    const npm = yield* npmCommand()
    if (npm === undefined) return yield* new UpdateError({ message: "npm, which comes with Node.js, isn't next to this node or on PATH" })
    // npm's scripts run with this node first on PATH.
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"
    const env = { ...process.env, [pathKey]: `${path.dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ""}` }
    const installedNow = yield* withSpinner(
      "installing dependencies",
      runProcess(npm[0], [...npm.slice(1), "ci", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error"], { cwd: app, timeoutS: 600, env }),
      interactive
    ).pipe(Effect.orElseSucceed(() => undefined))
    if (installedNow?.exitCode !== 0) {
      return yield* new UpdateError({ message: `npm couldn't install the dependencies (${installedNow?.stderr.trim().split(/\r?\n/).at(-1) ?? "it didn't run"}); run singularity update again` })
    }
  }
  const subject = (yield* out(["log", "-1", "--format=%s", "HEAD"])) ?? ""
  return { kind: "updated", before, after, ref, subject, dependencies } satisfies CodeUpdate
})

/** Run the CLI for daily use in `app` with these arguments, on this terminal; its exit code. */
const runInstalled = Effect.fn("runInstalled")(function*(app: string, args: ReadonlyArray<string>) {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [cliIn(app, path), ...args], {
      cwd: process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    }))
    return Number(yield* handle.exitCode)
  }))
})

export interface UpdateOptions {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly interactive: boolean
  readonly color: boolean
}

/** `singularity update`: the code, then the new code refreshes setup. False when something failed. */
export const runUpdate = Effect.fn("runUpdate")(function*(o: UpdateOptions) {
  const fs = yield* FileSystem.FileSystem
  const s = makeStyle(o.color)
  const item = (line: string) => Console.log(`     ${line}`)
  const memory = yield* loadHome()
  const app = appDir(memory.root)
  yield* Console.log(`\n  ${s.magenta("◆")} ${s.bold("singularity")}  ${s.dim("update")}\n`)
  if (!(yield* fs.exists(join(app, ".git")).pipe(Effect.orElseSucceed(() => false)))) {
    yield* item(`${tilde(app, o.home)} isn't there: singularity wasn't installed by its installer, so there's no code here to update.`)
    yield* item("Run the installer (see the README), or in a clone of the repo, git pull and npm install.")
    return false
  }
  // A round running now reads code and dependencies the update would replace under it.
  for (const lock of ["learn.lock", "store.lock"]) {
    if (lockHeld(memory.root, lock)) {
      yield* item(`${s.yellow("·")} memory is ${lock === "learn.lock" ? "learning" : "storing a change"} in the background now; run ${s.cyan("singularity update")} again when it's done (${s.cyan("singularity status")} shows it).`)
      return false
    }
  }
  const code = yield* updateCode(app, o.interactive)
  if (code.kind === "current") {
    yield* item(`${s.green("✓")} already the latest ${s.dim(`(${code.commit.slice(0, 7)})`)}`)
    yield* Console.log("")
    return true
  }
  yield* item(`${s.green("✓")} ${code.ref} ${code.before.slice(0, 7)} → ${code.after.slice(0, 7)}${code.subject === "" ? "" : s.dim(`  ${code.subject}`)}`)
  if (code.dependencies) yield* item(`${s.green("✓")} dependencies`)
  return (yield* runInstalled(app, ["update", "--no-fetch"])) === 0
})

const describeLearning = Effect.fnUntraced(function*(root: string, s: Style) {
  if (!(yield* learnIsSet(root))) return `${s.yellow("·")} learning isn't set up: ${s.cyan("singularity setup")} sets it up`
  const prefs = yield* readLearn(root)
  const through = prefs.with === undefined ? "" : ` with ${LEARNER_NAMES[prefs.with]}`
  return prefs.auto
    ? `${s.green("✓")} learning on its own${through}, at most ${usd(prefs.max_usd_per_day)} a day`
    : `${s.dim("·")} learning when you run ${s.cyan("singularity learn")}${through}`
})

/**
 * What setup put in place, made current with the code that runs this: hooks
 * and plugins where they are, the skill where it is, the command if it was
 * written. Asks nothing but Codex's trust in hooks whose command changed.
 */
export const runRefresh = Effect.fn("runRefresh")(function*(o: UpdateOptions) {
  const s = makeStyle(o.color)
  const item = (line: string) => Console.log(`     ${line}`)
  const memory = yield* loadHome()
  const dirs: AgentDirs = { home: o.home, env: o.env }
  if (!(yield* isSetUp(memory.root))) {
    yield* item(`Memory isn't set up here yet: run ${s.cyan("singularity setup")}.`)
    return false
  }
  const states = yield* agentStates(yield* detectAgents(dirs, (c) => findExecutable(c, o.env).pipe(Effect.map((p) => p !== undefined))), dirs)
  const hooked = states.filter((st) => st.hookEvents.length > 0).map((st) => st.agent)
  const launches = {
    claude: { node: process.execPath, script: HOOK_SCRIPT },
    other: { node: yield* nodeForHooks(), script: HOOK_SCRIPT }
  }
  const width = Math.max(...hooked.map((a) => a.name.length), "skill".length) + 3
  let ok = true
  for (const a of hooked) {
    const wired = yield* wireHooks(a, launches)
    if (wired.problem !== undefined) {
      ok = false
      yield* item(`${s.red("✗")} ${a.name.padEnd(width)}${wired.problem}`)
      continue
    }
    yield* item(`${s.green("✓")} ${a.name.padEnd(width)}${a.plugin === undefined ? "hooks" : "plugin"} in ${tilde(wired.hooks ?? a.dir, o.home)}`)
    const note = a.id === "codex" ? yield* codexTrust(o, o.interactive) : undefined
    if (note !== undefined) yield* item(`  ${" ".repeat(width)}${note.startsWith("✓") ? s.green(note) : s.yellow(note)}`)
  }
  // The skill where setup put it, and nowhere else.
  const placed: Array<string> = []
  for (const dir of skillDirsFor(agents(dirs), dirs)) {
    const state = yield* skillState(dir).pipe(Effect.orElseSucceed((): SkillState => "missing"))
    if (state === "current" || state === "outdated") placed.push(dir)
  }
  const blocked = yield* wireSkills(placed)
  const kept = placed.filter((d) => !blocked.includes(d))
  if (kept.length > 0) yield* item(`${s.green("✓")} ${"skill".padEnd(width)}${kept.map((d) => tilde(d, o.home)).join(", ")}`)
  yield* writeLaunchers(memory.root, process.execPath, COMMAND, process.platform)
  yield* item(`${s.green("✓")} the singularity command`)
  yield* item(yield* describeLearning(memory.root, s))

  const leftOut: ReadonlyArray<Agent> = states
    .filter((st) => st.found && st.hookEvents.length === 0 && !st.skill)
    .map((st) => st.agent)
  if (leftOut.length > 0) {
    yield* item(s.dim(`${listWords(leftOut.map((a) => a.name))} ${leftOut.length === 1 ? "is" : "are"} here without memory; ${"`singularity setup`"} sets ${leftOut.length === 1 ? "it" : "them"} up`))
  }
  yield* Console.log("")
  yield* Console.log(`  ${ok ? s.green("✓") : s.yellow("·")} ${s.bold(ok ? "Up to date." : "Updated, with the problem above.")} ${s.dim("Your choices stay as they were; singularity setup changes them.")}`)
  if (hooked.length > 0) yield* item(s.dim("Agents running now get the new memory from their next start."))
  yield* Console.log("")
  return ok
})
