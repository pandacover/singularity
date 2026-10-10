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
import { codexTrust, REACH } from "./Setup.ts"
import { type SkillState, skillState } from "./Skill.ts"
import { LEARNER_NAMES } from "./Learner.ts"
import { listWords, makeStyle, makeTree, marks, type Style, tilde, title, TITLED_ENV, usd, withSpinner } from "./Ui.ts"
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
      // The title is on screen: the new code goes on below it.
      env: { ...process.env, [TITLED_ENV]: "1" },
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
  const M = marks(s)
  const T = makeTree(s)
  const memory = yield* loadHome()
  const app = appDir(memory.root)
  const stop = T.close.pipe(Effect.andThen(Console.log("")), Effect.as(false))
  yield* Console.log(title(s, "updating"))
  yield* T.section("Download")
  if (!(yield* fs.exists(join(app, ".git")).pipe(Effect.orElseSucceed(() => false)))) {
    yield* T.item(M.fail(`${tilde(app, o.home)} isn't there: singularity wasn't installed by its installer, so there's no code to update.`))
    yield* T.note("Run the installer (see the README), or in a clone of the repo, git pull and npm install.")
    return yield* stop
  }
  // A round running now reads code and dependencies the update would replace under it.
  for (const lock of ["learn.lock", "store.lock"]) {
    if (lockHeld(memory.root, lock)) {
      yield* T.item(M.warn(`memory is ${lock === "learn.lock" ? "learning" : "storing a change"} in the background now; nothing changed`))
      yield* T.note(`run ${s.cyan("singularity update")} again when ${s.cyan("singularity status")} shows it done`)
      return yield* stop
    }
  }
  const code = yield* updateCode(app, o.interactive)
  if (code.kind === "current") {
    yield* T.item(M.ok("code", `${code.commit.slice(0, 7)}, already the latest`))
    yield* T.head(`${s.green("✓")} ${s.bold("Up to date")}`)
    yield* T.close
    yield* Console.log("")
    return true
  }
  yield* T.item(M.ok("code", `${code.ref} · ${code.before.slice(0, 7)} → ${code.after.slice(0, 7)}${code.subject === "" ? "" : `  ${code.subject}`}`))
  if (code.dependencies) yield* T.item(M.ok("dependencies"))
  yield* T.close
  return (yield* runInstalled(app, ["update", "--no-fetch"])) === 0
})

const describeLearning = Effect.fnUntraced(function*(root: string, s: Style) {
  const M = marks(s)
  if (!(yield* learnIsSet(root))) return M.warn(`not set up: ${s.cyan("singularity setup")} sets it up`)
  const prefs = yield* readLearn(root)
  const through = prefs.with === undefined ? "" : ` with ${LEARNER_NAMES[prefs.with]}`
  return prefs.auto
    ? M.ok(`on its own${through}, up to ${usd(prefs.max_usd_per_day)} a day`)
    : M.skip(`when you run singularity learn${through}`)
})

/**
 * What setup put in place, made current with the code that runs this: hooks
 * and plugins where they are, the skill where it is, the command if it was
 * written. Asks nothing but Codex's trust in hooks whose command changed.
 */
export const runRefresh = Effect.fn("runRefresh")(function*(o: UpdateOptions) {
  const s = makeStyle(o.color)
  const M = marks(s)
  const T = makeTree(s)
  const memory = yield* loadHome()
  const dirs: AgentDirs = { home: o.home, env: o.env }
  if (o.env[TITLED_ENV] === undefined) yield* Console.log(title(s, "updating"))
  yield* T.section("Your agents")
  if (!(yield* isSetUp(memory.root))) {
    yield* T.item(M.warn(`Memory isn't set up here yet: run ${s.cyan("singularity setup")}.`))
    yield* T.close
    yield* Console.log("")
    return false
  }
  const states = yield* agentStates(yield* detectAgents(dirs, (c) => findExecutable(c, o.env).pipe(Effect.map((p) => p !== undefined))), dirs)
  const launches = {
    claude: { node: process.execPath, script: HOOK_SCRIPT },
    other: { node: yield* nodeForHooks(), script: HOOK_SCRIPT }
  }
  // Agents with memory: hooks (or Hermes Agent's plugin), or the skill when that is all they get.
  const withMemory = states.filter((st) => st.hookEvents.length > 0 || (st.agent.hooks === undefined && st.agent.plugin === undefined && st.skill))
  const width = Math.max(...withMemory.map((st) => st.agent.name.length))
  let ok = true
  for (const { agent: a, hookEvents } of withMemory) {
    if (hookEvents.length > 0) {
      const wired = yield* wireHooks(a, launches)
      if (wired.problem !== undefined) {
        ok = false
        yield* T.item(M.fail(`${a.name}  ${wired.problem}`))
        continue
      }
    }
    // Codex's question, if it asks one, comes before Codex's line, so the answer goes under it.
    if (a.id === "codex" && o.interactive) yield* T.pause
    const note = a.id === "codex" && hookEvents.length > 0 ? yield* codexTrust(o, o.interactive) : undefined
    yield* T.item(M.ok(a.name.padEnd(width), REACH[a.reach]))
    if (note !== undefined) yield* T.note(note.startsWith("✓") ? s.dim(note.slice(1).trim()) : M.warn(note))
  }
  // The skill where setup put it, and nowhere else.
  const placed: Array<string> = []
  for (const dir of skillDirsFor(agents(dirs), dirs)) {
    const state = yield* skillState(dir).pipe(Effect.orElseSucceed((): SkillState => "missing"))
    if (state === "current" || state === "outdated") placed.push(dir)
  }
  for (const d of yield* wireSkills(placed)) yield* T.item(M.warn(`${tilde(d, o.home)} has a skill of yours named singularity; left it alone`))
  yield* writeLaunchers(memory.root, process.execPath, COMMAND, process.platform)
  const leftOut: ReadonlyArray<Agent> = states
    .filter((st) => st.found && st.hookEvents.length === 0 && !st.skill)
    .map((st) => st.agent)
  if (leftOut.length > 0) {
    yield* T.item(M.skip(`${listWords(leftOut.map((a) => a.name))}: no memory · singularity setup adds ${leftOut.length === 1 ? "it" : "them"}`))
  }

  yield* T.section("Learning")
  yield* T.item(yield* describeLearning(memory.root, s))

  yield* T.head(ok
    ? `${s.green("✓")} ${s.bold("Up to date")}${withMemory.length > 0 ? `  ${s.dim("agents running now get it at their next start")}` : ""}`
    : `${s.yellow("!")} ${s.bold("Updated, with the problem above")}`)
  yield* T.item(s.dim("your answers stay as they were; singularity setup changes them"))
  yield* T.close
  yield* Console.log("")
  return ok
})
