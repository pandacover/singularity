/**
 * Memory's server in Claude desktop's config (Proxy.ts, server.ts): found,
 * added, checked and taken out, with the rest of the file as it was.
 *
 * Where the config is, in this order (`SINGULARITY_CLAUDE_DESKTOP_CONFIG`
 * overrides it, which tests and try-install use):
 *
 * - Windows: `%APPDATA%\Claude` (the installer's app); `%LOCALAPPDATA%\Claude-Data\claude_<package>`
 *   (the Microsoft Store app, which moved its data out of its package on
 *   2026-10-20 on the machine this was written on, leaving a
 *   `.user-data-left` marker); the Store package's own
 *   `LocalCache\Roaming\Claude`.
 * - macOS: `~/Library/Application Support/Claude`. Linux: `~/.config/Claude`.
 *
 * The first that holds a config wins; with none, the first folder that is
 * there, for a config setup makes. The app keeps its config in memory and
 * writes it back whole, so setup changes it only while the app is closed.
 */
import { Effect, FileSystem, Path, Predicate } from "effect"
import { runProcess } from "../eval/Proc.ts"
import { type AgentDirs, join, slashes } from "../setup/Agents.ts"
import { readJsonFile, writeJsonFile } from "../setup/HookFiles.ts"
import { SERVER_NAME } from "./Proxy.ts"

export const CONFIG_ENV = "SINGULARITY_CLAUDE_DESKTOP_CONFIG"
const FILE = "claude_desktop_config.json"

type Json = Record<string, unknown>

/** Whether the config was named by `SINGULARITY_CLAUDE_DESKTOP_CONFIG`: a file the app doesn't read, so its running doesn't matter. */
export const configOverridden = (dirs: AgentDirs): boolean => (dirs.env[CONFIG_ENV] ?? "").trim() !== ""

/** Where Claude desktop's config may be, in the order it is looked for. */
export const configCandidates = Effect.fn("desktop.configCandidates")(function*(dirs: AgentDirs) {
  const fs = yield* FileSystem.FileSystem
  const set = dirs.env[CONFIG_ENV]
  if (set !== undefined && set.trim() !== "") return [slashes(set.trim())]
  const platform = dirs.platform ?? process.platform
  if (platform === "darwin") return [join(dirs.home, "Library", "Application Support", "Claude", FILE)]
  if (platform !== "win32") return [join(dirs.env.XDG_CONFIG_HOME ?? join(dirs.home, ".config"), "Claude", FILE)]
  const roaming = dirs.env.APPDATA ?? join(dirs.home, "AppData", "Roaming")
  const local = dirs.env.LOCALAPPDATA ?? join(dirs.home, "AppData", "Local")
  const inside = (dir: string, prefix: string) =>
    fs.readDirectory(dir).pipe(
      Effect.map((names) => names.filter((n) => n.toLowerCase().startsWith(prefix)).sort().map((n) => join(dir, n))),
      Effect.orElseSucceed(() => [] as Array<string>)
    )
  const data = (yield* inside(join(local, "Claude-Data"), "claude_")).map((d) => join(d, FILE))
  const packaged = (yield* inside(join(local, "Packages"), "claude_")).map((d) => join(d, "LocalCache", "Roaming", "Claude", FILE))
  return [join(roaming, "Claude", FILE), ...data, ...packaged]
})

/** The config to use: the first that exists, else the first whose folder the app uses; undefined when Claude desktop isn't here. */
export const findConfig = Effect.fn("desktop.findConfig")(function*(dirs: AgentDirs) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const candidates = yield* configCandidates(dirs)
  const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
  for (const c of candidates) if (yield* exists(c)) return c
  if (dirs.env[CONFIG_ENV] !== undefined && dirs.env[CONFIG_ENV]!.trim() !== "") return candidates[0]
  for (const c of candidates) {
    const dir = path.dirname(c)
    // A folder the app left (its data moved elsewhere) isn't where it reads.
    if ((yield* exists(dir)) && !(yield* exists(path.join(dir, ".user-data-left")))) return c
  }
  return undefined
})

/** Whether a server entry is memory's: it runs src/computer/server.ts from some checkout. */
export const isOurServer = (entry: unknown): boolean =>
  Predicate.isObject(entry) && Array.isArray((entry as Json).args) &&
  ((entry as Json).args as Array<unknown>).some((a) => Predicate.isString(a) && /\/src\/computer\/server\.ts$/.test(slashes(a)))

/** Other entries that look like singularity's (an older hand-test server): named for the user, never touched. */
export const otherSingularityServers = (servers: Json): Array<string> =>
  Object.entries(servers).filter(([name, entry]) => !isOurServer(entry) && (/singularity/i.test(name) || /singularity/i.test(JSON.stringify(entry)))).map(([name]) => name)

const serversOf = (json: Json): Json => (Predicate.isObject(json.mcpServers) ? (json.mcpServers as Json) : {})

export type ServerState = "ours" | "missing" | "foreign"

export const serverState = Effect.fn("desktop.serverState")(function*(file: string) {
  const json = yield* readJsonFile(file).pipe(Effect.orElseSucceed(() => ({}) as Json))
  const entry = serversOf(json)[SERVER_NAME]
  return { state: (entry === undefined ? "missing" : isOurServer(entry) ? "ours" : "foreign") as ServerState, others: otherSingularityServers(serversOf(json)) }
})

export interface ServerLaunch {
  readonly node: string
  readonly script: string
  /** The memory home the server uses. */
  readonly home: string
}

/**
 * Add memory's server, or bring it up to date; `foreign` when an entry of
 * that name isn't memory's (left alone). With `write` false, only what it
 * would do.
 */
export const registerServer = Effect.fn("desktop.registerServer")(function*(file: string, launch: ServerLaunch, write = true) {
  const json = yield* readJsonFile(file)
  const servers = serversOf(json)
  const existing = servers[SERVER_NAME]
  if (existing !== undefined && !isOurServer(existing)) return "foreign" as const
  const entry = { command: slashes(launch.node), args: [slashes(launch.script)], env: { SINGULARITY_HOME: slashes(launch.home) } }
  if (JSON.stringify(existing) === JSON.stringify(entry)) return "current" as const
  if (write) yield* writeJsonFile(file, { ...json, mcpServers: { ...servers, [SERVER_NAME]: entry } }, true)
  return existing === undefined ? "added" as const : "updated" as const
})

/** Take memory's server out; whether it was there. */
export const unregisterServer = Effect.fn("desktop.unregisterServer")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return false
  const json = yield* readJsonFile(file)
  const servers = serversOf(json)
  if (!isOurServer(servers[SERVER_NAME])) return false
  const { [SERVER_NAME]: _ours, ...rest } = servers
  yield* writeJsonFile(file, { ...json, mcpServers: rest })
  return true
})

/**
 * Whether Claude desktop is running. On Windows Claude Code's command is
 * `claude.exe` too, so the app is told by where it runs from: the Store's
 * `WindowsApps\Claude_…` or the installer's `AnthropicClaude`.
 */
export const desktopRunning = Effect.fn("desktop.running")(function*() {
  const ask = (command: string, args: ReadonlyArray<string>) =>
    runProcess(command, args, { cwd: process.cwd(), timeoutS: 20, env: process.env }).pipe(
      Effect.map((r) => (r.exitCode === 0 ? r.stdout : "")),
      Effect.orElseSucceed(() => "")
    )
  if (process.platform === "win32") {
    const out = yield* ask("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { $_.ExecutablePath }"])
    return /\\WindowsApps\\Claude_|\\AnthropicClaude\\/i.test(out)
  }
  if (process.platform === "darwin") return (yield* ask("pgrep", ["-f", "Claude.app/Contents/MacOS/Claude"])).trim() !== ""
  return (yield* ask("pgrep", ["-x", "claude-desktop"])).trim() !== ""
})
