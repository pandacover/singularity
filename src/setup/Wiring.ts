/**
 * Putting memory into an agent and taking it out again: its hooks
 * (HookFiles.ts) and the skill (Skill.ts), with nothing on screen. Setup,
 * status and uninstall use these.
 */
import { Effect, FileSystem, Path } from "effect"
import { delimiter } from "node:path"
import { fileURLToPath } from "node:url"
import { commandOfShim } from "../eval/Agent.ts"
import { runProcess } from "../eval/Proc.ts"
import {
  type Agent,
  type AgentDirs,
  agents,
  droidHookFiles,
  type HookFile,
  hookEvents,
  type Launch,
  sharedSkillsDir
} from "./Agents.ts"
import { hasOtherHooks, hooksIn, installHooks, removeHooks } from "./HookFiles.ts"
import { installSkill, removeSkill, type SkillState, skillState } from "./Skill.ts"

/** Memory v1's hook entry point. */
export const HOOK_SCRIPT = fileURLToPath(new URL("../workflows/hook.ts", import.meta.url))

/** The oldest node the code runs on: it strips TypeScript's types itself. */
export const MIN_NODE_MAJOR = 24

/**
 * WSL puts Windows' PATH after its own, under /mnt/: what is found there is a
 * Windows program, whose settings live in the Windows home, not this one.
 */
export const isWindowsFromWsl = (dir: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): boolean =>
  platform === "linux" && env.WSL_DISTRO_NAME !== undefined && /^\/mnt\/[a-z]\//i.test(dir.replace(/\/*$/, "/"))

/** An executable on PATH, as a shell would find it (with PATHEXT on Windows); in WSL, not Windows' own. */
export const findExecutable = Effect.fn("findExecutable")(function*(name: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d !== "" && !isWindowsFromWsl(d, env))) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`)
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate
    }
  }
  return undefined
})

/** Claude Code's command on PATH: its program, or for npm's `claude.cmd` what that runs (Agent.ts). */
export const findClaude = Effect.fn("findClaude")(function*(env: Readonly<Record<string, string | undefined>> = process.env) {
  const found = yield* findExecutable("claude", env)
  if (found === undefined) return undefined
  if (!/\.(?:cmd|bat)$/i.test(found)) return [found] as ReadonlyArray<string>
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return commandOfShim(yield* fs.readFileString(found).pipe(Effect.orElseSucceed(() => "")), path.dirname(found)) ?? [found]
})

/** The first line a command prints for `--version`, or undefined if it doesn't run. */
export const versionOf = (command: string, args: ReadonlyArray<string> = ["--version"]) =>
  runProcess(command, args, { cwd: process.cwd(), timeoutS: 20, env: process.env }).pipe(
    Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim().split(/\r?\n/)[0]?.trim() : undefined)),
    Effect.orElseSucceed(() => undefined)
  )

/**
 * How other agents' hooks start node. On Windows, a bare `node` when the one
 * on PATH is new enough (an agent may run hooks in PowerShell, where a quoted
 * program path isn't a command), else the full path this process runs.
 * Elsewhere hooks run in sh, so always the full path: the node setup runs
 * with, which may be singularity's own and is never too old.
 */
export const nodeForHooks = Effect.fn("nodeForHooks")(function*() {
  if (process.platform !== "win32") return process.execPath
  const version = yield* versionOf("node", ["-p", "process.versions.node"])
  const major = Number(version?.split(".")[0])
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR ? "node" : process.execPath
})

export interface Found {
  readonly agent: Agent
  /** Its directory exists or its command is on PATH. */
  readonly found: boolean
}

/** Every agent memory knows, and whether it is on this machine. */
export const detectAgents = Effect.fn("detectAgents")(function*(dirs: AgentDirs, onPath: (command: string) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>) {
  const fs = yield* FileSystem.FileSystem
  const out: Array<Found> = []
  for (const agent of agents(dirs)) {
    let found = yield* fs.exists(agent.dir).pipe(Effect.orElseSucceed(() => false))
    for (const command of agent.commands) if (!found) found = yield* onPath(command)
    out.push({ agent, found })
  }
  return out
})

/** The hook files an agent may hold memory's hooks in. */
export const hookFiles = (agent: Agent): ReadonlyArray<HookFile> =>
  agent.hooks === undefined ? [] : agent.id === "droid" ? droidHookFiles(agent.dir) : [agent.hooks]

/** Where setup puts an agent's hooks: for Droid, settings.json when the user's own hooks live there and hooks.json doesn't exist. */
export const hookTarget = Effect.fn("hookTarget")(function*(agent: Agent) {
  if (agent.hooks === undefined) return undefined
  if (agent.id !== "droid") return agent.hooks
  const fs = yield* FileSystem.FileSystem
  const [hooksJson, settings] = droidHookFiles(agent.dir)
  if (yield* fs.exists(hooksJson.file).pipe(Effect.orElseSucceed(() => false))) return hooksJson
  return (yield* hasOtherHooks(settings)) ? settings : hooksJson
})

/** The skill directories memory's skill goes in for these agents (the shared one once). */
export const skillDirsFor = (chosen: ReadonlyArray<Agent>, dirs: AgentDirs): ReadonlyArray<string> => [
  ...new Set([...chosen.flatMap((a) => a.skillDirs), ...(chosen.some((a) => a.sharedSkills) ? [sharedSkillsDir(dirs)] : [])])
]

export interface Wired {
  readonly agent: Agent
  /** The file its hooks went in. */
  readonly hooks: string | undefined
  /** Why its hooks couldn't go in, if they couldn't. */
  readonly problem: string | undefined
}

/** Add memory's hooks to an agent; the file, or the problem. */
export const wireHooks = Effect.fn("wireHooks")(function*(agent: Agent, launches: { readonly claude: Launch; readonly other: Launch }) {
  const target = yield* hookTarget(agent)
  if (target === undefined) return { agent, hooks: undefined, problem: undefined } satisfies Wired
  // Memory's hooks from an earlier setup (another checkout, or v0) may sit in the other file Droid can use.
  for (const other of hookFiles(agent).filter((f) => f.file !== target.file)) yield* removeHooks(other).pipe(Effect.ignore)
  return yield* installHooks(target, hookEvents(agent.id, launches.claude, launches.other)).pipe(
    Effect.as({ agent, hooks: target.file, problem: undefined } satisfies Wired),
    Effect.catch((e) => Effect.succeed({ agent, hooks: undefined, problem: `${target.file} ${e.message}` } satisfies Wired))
  )
})

/** Write the skill into each directory; those where a skill of the user's own has the name. */
export const wireSkills = Effect.fn("wireSkills")(function*(skillDirs: ReadonlyArray<string>) {
  const blocked: Array<string> = []
  for (const dir of skillDirs) {
    const state = yield* installSkill(dir).pipe(Effect.orElseSucceed((): SkillState => "foreign"))
    if (state === "foreign") blocked.push(dir)
  }
  return blocked
})

export interface AgentState {
  readonly agent: Agent
  readonly found: boolean
  /** Events memory's hooks are on, and the file. */
  readonly hookEvents: ReadonlyArray<string>
  readonly hookFile: string | undefined
  /** Whether the skill is where this agent reads it. */
  readonly skill: boolean
}

/** What memory has in each agent. */
export const agentStates = Effect.fn("agentStates")(function*(found: ReadonlyArray<Found>, dirs: AgentDirs) {
  const out: Array<AgentState> = []
  for (const { agent, found: present } of found) {
    let events: ReadonlyArray<string> = []
    let file: string | undefined
    for (const f of hookFiles(agent)) {
      const on = yield* hooksIn(f)
      if (on.length > 0) {
        events = on
        file = f.file
        break
      }
    }
    let skill = false
    for (const dir of [...agent.skillDirs, ...(agent.sharedSkills ? [sharedSkillsDir(dirs)] : [])]) {
      const state = yield* skillState(dir).pipe(Effect.orElseSucceed((): SkillState => "missing"))
      if (state === "current" || state === "outdated") skill = true
    }
    out.push({ agent, found: present, hookEvents: events, hookFile: file, skill })
  }
  return out
})

/** Take memory out of every agent: hooks from every file they may be in, the skill from every directory. */
export const unwireAll = Effect.fn("unwireAll")(function*(dirs: AgentDirs) {
  const hookFilesChanged: Array<string> = []
  const skillDirs: Array<string> = []
  const all = agents(dirs)
  for (const agent of all) {
    for (const f of hookFiles(agent)) if (yield* removeHooks(f).pipe(Effect.orElseSucceed(() => false))) hookFilesChanged.push(f.file)
  }
  for (const dir of skillDirsFor(all, dirs)) if (yield* removeSkill(dir).pipe(Effect.orElseSucceed(() => false))) skillDirs.push(dir)
  return { hookFiles: hookFilesChanged, skillDirs }
})
