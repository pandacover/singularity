/**
 * The coding agents memory can be set up in, and what each one gets.
 *
 * - Claude Code: the whole memory. Its hooks hand memory over when a task
 *   starts (in two parts, as `workflows-split` was measured), warn when a
 *   known mistake's trigger appears, and record a session that ends with its
 *   change committed and its tests passing, which memory learns from.
 * - Codex has hooks in Claude Code's format: memory is handed over at task
 *   start (in one part), warnings arrive during the task, and a session is
 *   recorded at its end like Claude Code's, its log read as Claude Code's
 *   (traces/Codex.ts).
 * - Hermes Agent gets what Codex gets through a plugin of memory's own, which runs
 *   the same hook script (HermesPlugin.ts): its shell hooks can add text to a
 *   prompt but not to a tool's result, where warnings go. Its sessions are
 *   read from its database (traces/Hermes.ts).
 * - Gemini CLI and Droid have hooks in Claude Code's format: memory is
 *   handed over at task start and warnings arrive during the task. Their
 *   transcripts aren't read, so their sessions aren't recorded.
 * - Cursor and OpenCode have no hook that can add text to a prompt: the skill
 *   lets the agent look memory up when the user asks for it.
 *
 * Every agent gets the skill (Skill.ts). Agents that read the shared
 * `~/.agents/skills` (Codex, Gemini CLI, Cursor, OpenCode, and other agents
 * that follow the Agent Skills standard) find it there.
 *
 * Hook commands: Claude Code's keep the form its measurements ran with (the
 * full path to node, quoted). Other agents run hook commands in whatever
 * shell they use, PowerShell included, where a quoted program path isn't a
 * command; theirs start with a bare `node` when the `node` on PATH is new
 * enough, which every shell runs.
 */
/** Paths with forward slashes, as hook commands and messages use them on every platform. */
export const slashes = (p: string): string => p.replace(/\\/g, "/")

export const AGENT_IDS = ["claude", "codex", "gemini", "droid", "hermes", "cursor", "opencode"] as const
export type AgentId = (typeof AGENT_IDS)[number]

/** What memory does in an agent: hands over and learns from its sessions, hands over, or is there when asked. */
export type Reach = "learns" | "hands-over" | "on-request"

export interface HookHandler {
  readonly type: "command"
  readonly command: string
  readonly timeout: number
  readonly [key: string]: unknown
}

export interface HookEntry {
  readonly matcher?: string
  readonly hooks: ReadonlyArray<HookHandler>
}

/** Event name to its matcher groups, as every agent here keeps them. */
export type HookEvents = Readonly<Record<string, ReadonlyArray<HookEntry>>>

/**
 * Where an agent keeps hooks: a JSON file whose `hooks` key holds the events
 * (`wrapped`: Claude Code's and Gemini CLI's settings, Codex's hooks.json),
 * or whose top level is the events (`events`: Droid's hooks.json).
 */
export interface HookFile {
  readonly file: string
  readonly layout: "wrapped" | "events"
}

export interface AgentDirs {
  /** The user's home directory. */
  readonly home: string
  /** Environment overrides of agents' own directories. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The system whose defaults agents' directories follow (default: this one). */
  readonly platform?: NodeJS.Platform
}

/**
 * Where an agent loads memory's plugin from: a folder of the plugin's own, and
 * the config file whose list of enabled plugins has to name it.
 */
export interface PluginHome {
  readonly dir: string
  readonly config: string
}

export interface Agent {
  readonly id: AgentId
  readonly name: string
  readonly reach: Reach
  /** Its configuration directory: that it exists means the agent has been used here. */
  readonly dir: string
  /** Executables that mean it is installed. */
  readonly commands: ReadonlyArray<string>
  /** Where its hooks go; undefined for agents without hooks memory can use. */
  readonly hooks: HookFile | undefined
  /** Hermes Agent: memory's hooks come as a plugin instead. */
  readonly plugin?: PluginHome
  /** Skill directories it reads that memory's skill goes in (besides the shared one, if it reads that). */
  readonly skillDirs: ReadonlyArray<string>
  /** Whether it reads `~/.agents/skills`. */
  readonly sharedSkills: boolean
  /** One line for the user after setup, when the agent needs something from them. */
  readonly note?: string
}

/** Path parts joined with forward slashes. */
export const join = (...parts: ReadonlyArray<string>): string =>
  slashes(parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""))).join("/"))

const nonEmpty = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s.trim())

/** The shared skills directory of the Agent Skills standard. */
export const sharedSkillsDir = (dirs: AgentDirs) => join(dirs.home, ".agents", "skills")

export const claudeDir = (dirs: AgentDirs) => slashes(nonEmpty(dirs.env.CLAUDE_CONFIG_DIR) ?? join(dirs.home, ".claude"))

/** Codex's home: `CODEX_HOME`, else `~/.codex`. */
export const codexHome = (dirs: AgentDirs) => slashes(nonEmpty(dirs.env.CODEX_HOME) ?? join(dirs.home, ".codex"))

/**
 * Hermes Agent's home, as its `get_hermes_home` finds it: `HERMES_HOME`, else
 * `%LOCALAPPDATA%\hermes` on Windows and `~/.hermes` elsewhere (with
 * `HERMES_DATA_DIR_SUFFIX` after either).
 */
export const hermesHome = (dirs: AgentDirs) => {
  const set = nonEmpty(dirs.env.HERMES_HOME)
  if (set !== undefined) return slashes(set.replace(/^~(?=$|[\\/])/, dirs.home))
  const name = `hermes${dirs.env.HERMES_DATA_DIR_SUFFIX ?? ""}`
  return (dirs.platform ?? process.platform) === "win32"
    ? join(nonEmpty(dirs.env.LOCALAPPDATA) ?? join(dirs.home, "AppData", "Local"), name)
    : join(dirs.home, `.${name}`)
}

export const agents = (dirs: AgentDirs): ReadonlyArray<Agent> => {
  const claude = claudeDir(dirs)
  const codex = codexHome(dirs)
  const gemini = join(dirs.home, ".gemini")
  const factory = join(dirs.home, ".factory")
  const hermes = hermesHome(dirs)
  const xdg = slashes(nonEmpty(dirs.env.XDG_CONFIG_HOME) ?? join(dirs.home, ".config"))
  return [
    {
      id: "claude",
      name: "Claude Code",
      reach: "learns",
      dir: claude,
      commands: ["claude"],
      hooks: { file: join(claude, "settings.json"), layout: "wrapped" },
      skillDirs: [join(claude, "skills")],
      sharedSkills: false
    },
    {
      id: "codex",
      name: "Codex",
      reach: "learns",
      dir: codex,
      commands: ["codex"],
      hooks: { file: join(codex, "hooks.json"), layout: "wrapped" },
      skillDirs: [],
      sharedSkills: true,
      note: "Codex runs new hooks only once you trust them: open Codex and type /hooks."
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      reach: "hands-over",
      dir: gemini,
      commands: ["gemini"],
      hooks: { file: join(gemini, "settings.json"), layout: "wrapped" },
      skillDirs: [],
      sharedSkills: true
    },
    {
      id: "droid",
      name: "Droid",
      reach: "hands-over",
      dir: factory,
      commands: ["droid"],
      // Or its settings.json (droidHookFiles).
      hooks: { file: join(factory, "hooks.json"), layout: "events" },
      skillDirs: [join(factory, "skills")],
      sharedSkills: false
    },
    {
      id: "hermes",
      name: "Hermes Agent",
      reach: "learns",
      dir: hermes,
      // Only its home says it is here: a `hermes` on PATH may be the JavaScript engine of that name.
      commands: [],
      hooks: undefined,
      plugin: { dir: join(hermes, "plugins", "singularity"), config: join(hermes, "config.yaml") },
      // It reads its own skills folder, not the shared one.
      skillDirs: [join(hermes, "skills")],
      sharedSkills: false
    },
    {
      id: "cursor",
      name: "Cursor",
      reach: "on-request",
      dir: join(dirs.home, ".cursor"),
      commands: ["cursor-agent", "cursor"],
      hooks: undefined,
      skillDirs: [],
      sharedSkills: true
    },
    {
      id: "opencode",
      name: "OpenCode",
      reach: "on-request",
      dir: join(xdg, "opencode"),
      commands: ["opencode"],
      hooks: undefined,
      skillDirs: [],
      sharedSkills: true
    }
  ]
}

/** The agents memory learns from: those whose sessions it can read. */
export const LEARNS_FROM = ["claude", "codex", "hermes"] as const

/** Where the agents memory learns from keep their sessions: those of `ids`, or all of them. */
export const sessionHomes = (dirs: AgentDirs, ids: ReadonlyArray<AgentId> = LEARNS_FROM) => ({
  claude: ids.includes("claude") ? claudeDir(dirs) : undefined,
  codex: ids.includes("codex") ? codexHome(dirs) : undefined,
  hermes: ids.includes("hermes") ? hermesHome(dirs) : undefined
})

/**
 * Droid's hook files, in the order to use them: its hooks.json when there is
 * one; otherwise, when the user keeps hooks under the `hooks` key of its
 * settings.json, that file, since Droid reads those only while hooks.json is
 * absent; otherwise a new hooks.json.
 */
export const droidHookFiles = (dir: string): ReadonlyArray<HookFile> => [
  { file: join(dir, "hooks.json"), layout: "events" },
  { file: join(dir, "settings.json"), layout: "wrapped" }
]

/** Claude Code's tool calls that can trip a pitfall's trigger: shell commands and edits. */
export const CLAUDE_TOOLS = "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit"

export interface Launch {
  /** How the hook's command line starts node: a quoted full path, or a bare `node`. */
  readonly node: string
  /** The hook script, src/workflows/hook.ts. */
  readonly script: string
}

/** `"C:/Program Files/nodejs/node.exe" "C:/.../hook.ts" session-end`: the form Claude Code's measured runs used. */
const quotedCommand = (launch: Launch, args: string) => `"${slashes(launch.node)}" "${slashes(launch.script)}" ${args}`

/** `node "C:/.../hook.ts" post-tool-use`, which sh, bash, cmd and PowerShell all run. */
const bareCommand = (launch: Launch, args: string) =>
  launch.node === "node" ? `node "${slashes(launch.script)}" ${args}` : quotedCommand(launch, args)

/** Seconds a hand-over may take: no model call is made, but a large repo's git and files take a moment. */
const START_TIMEOUT_S = 90
const TOOL_TIMEOUT_S = 15
const END_TIMEOUT_S = 30

/** The hook events memory adds to an agent's hooks. */
export const hookEvents = (id: AgentId, claudeLaunch: Launch, otherLaunch: Launch): HookEvents => {
  const c = (args: string) => quotedCommand(claudeLaunch, args)
  const o = (args: string) => bareCommand(otherLaunch, args)
  switch (id) {
    case "claude":
      return {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: c("user-prompt-submit --parts=2"), timeout: START_TIMEOUT_S }] },
          { hooks: [{ type: "command", command: c("user-prompt-submit-2 --parts=2"), timeout: START_TIMEOUT_S }] }
        ],
        PostToolUse: [{ matcher: CLAUDE_TOOLS, hooks: [{ type: "command", command: c("post-tool-use"), timeout: TOOL_TIMEOUT_S }] }],
        PostToolUseFailure: [{ matcher: CLAUDE_TOOLS, hooks: [{ type: "command", command: c("post-tool-use"), timeout: TOOL_TIMEOUT_S }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: c("session-end"), timeout: END_TIMEOUT_S }] }]
      }
    case "codex":
      return {
        UserPromptSubmit: [{
          hooks: [{
            type: "command",
            command: o("user-prompt-submit"),
            timeout: START_TIMEOUT_S,
            statusMessage: "Checking singularity memory",
            // Codex shortens hook text over about 2,500 tokens; a hand-over is up to 9,800 characters.
            additionalContextLimit: 4000
          }]
        }],
        PostToolUse: [{ matcher: "Bash|apply_patch", hooks: [{ type: "command", command: o("post-tool-use"), timeout: TOOL_TIMEOUT_S }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: o("session-end"), timeout: END_TIMEOUT_S }] }]
      }
    case "gemini":
      // Gemini CLI counts hook timeouts in milliseconds.
      return {
        BeforeAgent: [{
          hooks: [{
            type: "command",
            name: "singularity-handover",
            description: "Hands over what memory learned for this task",
            command: o("user-prompt-submit"),
            timeout: START_TIMEOUT_S * 1000
          }]
        }],
        AfterTool: [{
          matcher: "run_shell_command|replace|write_file",
          hooks: [{
            type: "command",
            name: "singularity-warnings",
            description: "Warns when a mistake made before is about to happen again",
            command: o("post-tool-use"),
            timeout: TOOL_TIMEOUT_S * 1000
          }]
        }]
      }
    case "droid":
      return {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: o("user-prompt-submit"), timeout: START_TIMEOUT_S }] }],
        PostToolUse: [{ matcher: "Execute|Edit|Create|ApplyPatch", hooks: [{ type: "command", command: o("post-tool-use"), timeout: TOOL_TIMEOUT_S }] }]
      }
    case "hermes":
    case "cursor":
    case "opencode":
      return {}
  }
}

/**
 * Whether a hook command runs memory's hook script, from wherever it was
 * installed (v1's `src/workflows/hook.ts`, or v0's `src/hook.ts`).
 */
export const isMemoryHookCommand = (command: string): boolean =>
  /\/src\/(?:workflows\/)?hook\.ts["']?\s+(?:user-prompt-submit|post-tool-use|session-end)\b/.test(slashes(command))

/** Whether a hook command runs v0's hook script, which setup replaces with v1's. */
export const isV0HookCommand = (command: string): boolean =>
  /\/src\/hook\.ts["']?\s+(?:user-prompt-submit|post-tool-use|session-end)\b/.test(slashes(command))
