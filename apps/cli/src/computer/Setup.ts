/**
 * `singularity setup computer-use`: computer-use memory, set up apart from
 * coding memory, which it never touches.
 *
 * - **Claude Code:** hook entries of its own (src/computer/hook.ts), after
 *   calls of the browser and computer-use tools only
 *   (`mcp__claude-in-chrome__.*`, `mcp__Claude_Browser__.*`,
 *   `mcp__playwright__.*`, `mcp__computer-use__.*`), at a task's start and
 *   at a session's end. The coding hooks and their matcher stay as they are.
 * - **Claude desktop:** memory's browser server (Proxy.ts) registered as
 *   `singularity-browser` (ClaudeDesktop.ts), only while the app is closed:
 *   it writes its config back whole from memory.
 *
 * `singularity uninstall computer-use` takes both out; plain `singularity
 * uninstall` takes them out with everything else. `config.json` remembers
 * that computer use is set up, so `update` brings it up to date.
 */
import { Console, Effect, FileSystem } from "effect"
import { fileURLToPath } from "node:url"
import { type Home, loadHome, saveComputerUse } from "../local/Home.ts"
import { type AgentDirs, claudeDir, type HookEvents, join, slashes } from "../setup/Agents.ts"
import { hooksIn, installHooks, removeHooks } from "../setup/HookFiles.ts"
import { confirm, makeStyle, makeTree, marks, plural, tilde, title, TITLED_ENV } from "../setup/Ui.ts"
import { findCommand } from "../setup/Wiring.ts"
import { configOverridden, desktopRunning, findConfig, registerServer, serverState, unregisterServer } from "./ClaudeDesktop.ts"
import { SERVER_NAME } from "./Proxy.ts"
import { listApps, readIndex } from "./Store.ts"

export const COMPUTER_HOOK = fileURLToPath(new URL("./hook.ts", import.meta.url))
export const SERVER_SCRIPT = fileURLToPath(new URL("./server.ts", import.meta.url))

/** The tools computer-use memory reads, and no other MCP server's. */
export const COMPUTER_MATCHER = "mcp__claude-in-chrome__.*|mcp__Claude_Browser__.*|mcp__playwright__.*|mcp__computer-use__.*"

/** Whether a hook command is computer-use memory's, from wherever it was installed. */
export const isComputerHookCommand = (command: string): boolean =>
  /\/src\/computer\/hook\.ts["']?\s+(?:post-tool-use|user-prompt-submit|session-end)\b/.test(slashes(command))

/** Seconds: a hand-over reads two small files; storing runs in the background. */
const TOOL_TIMEOUT_S = 15
const START_TIMEOUT_S = 30
const END_TIMEOUT_S = 30

/** Claude Code's hook entries for computer use, in the form its coding hooks use (the full path to node, quoted). */
export const computerHookEvents = (node: string, script: string = COMPUTER_HOOK): HookEvents => {
  const c = (event: string) => `"${slashes(node)}" "${slashes(script)}" ${event}`
  return {
    PostToolUse: [{ matcher: COMPUTER_MATCHER, hooks: [{ type: "command", command: c("post-tool-use"), timeout: TOOL_TIMEOUT_S }] }],
    PostToolUseFailure: [{ matcher: COMPUTER_MATCHER, hooks: [{ type: "command", command: c("post-tool-use"), timeout: TOOL_TIMEOUT_S }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: c("user-prompt-submit"), timeout: START_TIMEOUT_S }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: c("session-end"), timeout: END_TIMEOUT_S }] }]
  }
}

const claudeSettings = (dirs: AgentDirs) => ({ file: join(claudeDir(dirs), "settings.json"), layout: "wrapped" as const })

export type DesktopResult =
  | { readonly kind: "added" | "updated" | "current"; readonly file: string; readonly others: ReadonlyArray<string> }
  | { readonly kind: "foreign"; readonly file: string }
  | { readonly kind: "running"; readonly file: string }
  | { readonly kind: "missing" }
  | { readonly kind: "skipped" }
  | { readonly kind: "failed"; readonly file: string; readonly problem: string }

export interface ComputerWired {
  readonly claude: { readonly file: string } | { readonly problem: string } | { readonly absent: true }
  readonly desktop: DesktopResult
}

export interface WireOptions {
  readonly dirs: AgentDirs
  readonly home: Home
  /** Register the server in Claude desktop. */
  readonly desktop: boolean
  /** Whether Claude desktop is running (asked of the system when not given). */
  readonly running?: boolean
}

/** Put computer use in place; what went where. Nothing on screen. */
export const wireComputerUse = Effect.fn("wireComputerUse")(function*(o: WireOptions) {
  const fs = yield* FileSystem.FileSystem
  const dir = claudeDir(o.dirs)
  const hasClaude = (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) || (yield* findCommand("claude", o.dirs.env)) !== undefined
  const target = claudeSettings(o.dirs)
  const claude: ComputerWired["claude"] = !hasClaude
    ? { absent: true }
    : yield* installHooks(target, computerHookEvents(process.execPath), isComputerHookCommand).pipe(
      Effect.as({ file: target.file }),
      Effect.catch((e) => Effect.succeed({ problem: `${target.file} ${e.message}` }))
    )

  let desktop: DesktopResult = { kind: "skipped" }
  if (o.desktop) {
    const file = yield* findConfig(o.dirs)
    if (file === undefined) desktop = { kind: "missing" }
    else {
      const state = yield* serverState(file)
      const running = o.running ?? (state.state === "foreign" || configOverridden(o.dirs) ? false : yield* desktopRunning())
      const launch = { node: process.execPath, script: SERVER_SCRIPT, home: o.home.root }
      // While the app is open its config isn't touched; an entry that is current already needs nothing.
      const would = state.state === "foreign" ? "foreign" : yield* registerServer(file, launch, false).pipe(Effect.orElseSucceed(() => "added" as const))
      if (would === "foreign") desktop = { kind: "foreign", file }
      else if (would === "current") desktop = { kind: "current", file, others: state.others }
      else if (running) desktop = { kind: "running", file }
      else {
        desktop = yield* registerServer(file, launch).pipe(
          Effect.map((kind): DesktopResult => (kind === "foreign" ? { kind, file } : { kind, file, others: state.others })),
          Effect.catch((e) => Effect.succeed<DesktopResult>({ kind: "failed", file, problem: e.message }))
        )
      }
    }
  }
  yield* saveComputerUse(o.home, true)
  return { claude, desktop } satisfies ComputerWired
})

/** Take computer use out of Claude Code and Claude desktop; the files changed. */
export const unwireComputerUse = Effect.fn("unwireComputerUse")(function*(dirs: AgentDirs, home: Home | undefined, running?: boolean) {
  const changed: Array<string> = []
  const target = claudeSettings(dirs)
  if (yield* removeHooks(target, isComputerHookCommand).pipe(Effect.orElseSucceed(() => false))) changed.push(target.file)
  let desktopRunningNow = false
  const file = yield* findConfig(dirs)
  if (file !== undefined && (yield* serverState(file)).state === "ours") {
    desktopRunningNow = running ?? (configOverridden(dirs) ? false : yield* desktopRunning())
    if (!desktopRunningNow && (yield* unregisterServer(file).pipe(Effect.orElseSucceed(() => false)))) changed.push(file)
  }
  if (home !== undefined && home.computerUse) yield* saveComputerUse(home, false)
  return { changed, desktopFile: file, desktopRunning: desktopRunningNow }
})

export interface ComputerState {
  readonly set_up: boolean
  /** Events of Claude Code's settings computer use's hooks are on. */
  readonly claude_hooks: ReadonlyArray<string>
  readonly desktop: { readonly config: string | null; readonly server: "ours" | "missing" | "foreign" | "no app"; readonly others: ReadonlyArray<string> }
  readonly apps: ReadonlyArray<{ readonly app: string; readonly sessions: number; readonly screens: number; readonly routes: number; readonly rules: number; readonly left_out: Readonly<Record<string, number>> }>
}

/** What computer use has, for status. */
export const computerState = Effect.fn("computerState")(function*(dirs: AgentDirs, home: Home) {
  const hooks = yield* hooksIn(claudeSettings(dirs), isComputerHookCommand)
  const file = yield* findConfig(dirs)
  const server = file === undefined ? { state: "no app" as const, others: [] as ReadonlyArray<string> } : yield* serverState(file)
  const apps: Array<ComputerState["apps"][number]> = []
  for (const app of yield* listApps(home.tenantDir)) {
    const index = yield* readIndex(home.tenantDir, app)
    if (index === undefined) continue
    apps.push({
      app,
      sessions: index.sessions.length,
      screens: Object.values(index.screens).filter((s) => s.worked_in > 0).length,
      routes: index.routes.length,
      rules: index.rules.length,
      left_out: index.left_out
    })
  }
  return {
    set_up: home.computerUse || hooks.length > 0 || server.state === "ours",
    claude_hooks: hooks,
    desktop: { config: file ?? null, server: server.state, others: server.others },
    apps
  } satisfies ComputerState
})

export interface ComputerSetupOptions {
  readonly dirs: AgentDirs
  readonly yes: boolean
  readonly desktop: boolean
  readonly interactive: boolean
  readonly color: boolean
}

/** The setup screen: what goes where, and what the person does next. Whether it all went in. */
export const runComputerSetup = Effect.fn("runComputerSetup")(function*(o: ComputerSetupOptions) {
  const s = makeStyle(o.color)
  const m = marks(s)
  const tree = makeTree(s)
  const user = o.dirs.home
  const home = yield* loadHome()
  if (o.dirs.env[TITLED_ENV] === undefined) yield* Console.log(title(s, "computer use"))
  yield* tree.section("Computer use")
  yield* tree.text("Memory for agents that drive a browser: the routes past sessions took to the")
  yield* tree.text("screens they worked on, and the fields there that start set. Coding memory is untouched.")

  let running = false
  if (o.desktop) {
    const file = yield* findConfig(o.dirs)
    if (file !== undefined && !configOverridden(o.dirs) && (yield* serverState(file)).state !== "ours") {
      running = yield* desktopRunning()
      if (running && o.interactive) {
        yield* tree.pause
        yield* confirm("Claude desktop is open. Quit it fully (from the tray too), then continue?", true, true).pipe(Effect.orElseSucceed(() => false))
        running = yield* desktopRunning()
      }
    }
  }
  const wired = yield* wireComputerUse({ dirs: o.dirs, home, desktop: o.desktop, running })
  let ok = true

  if ("file" in wired.claude) {
    yield* tree.item(m.ok("Claude Code", `hooks for browser and computer-use tools in ${tilde(wired.claude.file, user)}`))
  } else if ("problem" in wired.claude) {
    ok = false
    yield* tree.item(m.fail(`Claude Code: ${wired.claude.problem}`))
  } else yield* tree.item(m.skip("Claude Code isn't here"))

  const d = wired.desktop
  switch (d.kind) {
    case "added":
    case "updated":
    case "current":
      yield* tree.item(m.ok("Claude desktop", `${SERVER_NAME} ${d.kind === "current" ? "registered" : d.kind} in ${tilde(d.file, user)}`))
      yield* tree.note(s.dim("its browser tools are Playwright's, through memory; start the app again to load them"))
      for (const other of d.others) yield* tree.note(m.warn(`an older server named "${other}" is registered too; setup left it as it is`))
      break
    case "running":
      ok = false
      yield* tree.item(m.warn(`Claude desktop is open, so its config wasn't changed: quit it fully and run ${s.cyan("singularity setup computer-use")} again`))
      break
    case "foreign":
      ok = false
      yield* tree.item(m.warn(`Claude desktop has a server named "${SERVER_NAME}" that isn't memory's; left as it is`))
      break
    case "failed":
      ok = false
      yield* tree.item(m.fail(`Claude desktop: ${tilde(d.file, user)} ${d.problem}`))
      break
    case "missing":
      yield* tree.item(m.skip("Claude desktop isn't here"))
      break
    case "skipped":
      yield* tree.item(m.skip("Claude desktop left out (--no-claude-desktop)"))
      break
  }
  yield* tree.close
  yield* Console.log(`\n  ${s.dim("Memory starts with your next browser session. What it keeps:")} ${s.cyan("singularity status")}`)
  yield* Console.log(`  ${s.dim("Take it out again:")} ${s.cyan("singularity uninstall computer-use")}\n`)
  return ok
})

/** The status lines for computer use. */
export const renderComputerStatus = (c: ComputerState, o: { readonly color: boolean }): Array<string> => {
  const s = makeStyle(o.color)
  const out = [`\n  ${s.bold("Computer use")}`]
  if (!c.set_up) {
    out.push(`    ${s.dim("not set up")}  ${s.dim("·")} ${s.cyan("singularity setup computer-use")}`)
    return out
  }
  out.push(c.claude_hooks.length > 0 ? `    ${s.green("✓")} Claude Code     ${s.dim("hooks for browser and computer-use tools")}` : `    ${s.yellow("!")} Claude Code     ${s.dim("hooks missing: run singularity setup computer-use")}`)
  if (c.desktop.server === "ours") out.push(`    ${s.green("✓")} Claude desktop  ${s.dim(`${SERVER_NAME} registered`)}`)
  else if (c.desktop.server === "missing") out.push(`    ${s.yellow("!")} Claude desktop  ${s.dim(`${SERVER_NAME} not registered (the app may have rewritten its config): quit it and run singularity setup computer-use`)}`)
  else if (c.desktop.server === "foreign") out.push(`    ${s.yellow("!")} Claude desktop  ${s.dim(`a server named ${SERVER_NAME} isn't memory's`)}`)
  for (const other of c.desktop.others) out.push(`    ${" ".repeat(18)}${s.dim(`also registered: "${other}" (not set up by singularity setup)`)}`)
  if (c.apps.length === 0) out.push(`    ${s.dim("no apps yet: memory starts with a browser session")}`)
  const w = Math.max(0, ...c.apps.map((a) => a.app.length)) + 3
  for (const a of c.apps) {
    out.push(`    ${a.app.padEnd(w)}${plural(a.sessions, "session")}, ${plural(a.screens, "screen")} worked on, ${plural(a.routes, "route")}${a.rules === 0 ? "" : `, ${plural(a.rules, "rule")}`}`)
    const left = Object.entries(a.left_out)
    if (left.length > 0) out.push(`    ${" ".repeat(w)}${s.dim(`left out: ${left.map(([why, n]) => `${n} ${why}`).join("; ")}`)}`)
  }
  return out
}

/** Bring computer use up to date with the code installed now, when it was set up: for `update`. */
export const refreshComputerUse = Effect.fn("refreshComputerUse")(function*(dirs: AgentDirs) {
  const home = yield* loadHome()
  if (!home.computerUse) return undefined
  return yield* wireComputerUse({ dirs, home, desktop: true })
})
