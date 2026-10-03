/**
 * Launch Claude Code headless for one run.
 */
import { Effect, FileSystem, Path, Predicate, Schema } from "effect"
import { delimiter } from "node:path"
import type { ProcResult } from "./Proc.ts"
import { runProcess } from "./Proc.ts"
import type { AgentConfig } from "./Suite.ts"

/**
 * Variables a parent Claude Code session sets for its children. Dropping them
 * makes a run behave like a fresh launch from a terminal, wherever the harness
 * itself runs. CLAUDE_EFFORT in particular would silently override the effort.
 */
export const SESSION_VARS: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID"
])

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String
}) {}

export interface AgentRun {
  readonly command: ReadonlyArray<string>
  readonly sessionId: string
  readonly proc: ProcResult
  /** The `--output-format json` result object, if Claude Code printed one. */
  readonly result: Readonly<Record<string, unknown>> | undefined
}

/** The `claude` executable on PATH, resolved to a full path like a shell would. */
export const defaultClaude = Effect.fn("defaultClaude")(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `claude${ext}`)
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return [candidate]
    }
  }
  return yield* new AgentError({ message: "`claude` is not on PATH; pass --claude" })
})

export const buildCommand = (
  claude: ReadonlyArray<string>,
  cfg: AgentConfig,
  sessionId: string,
  appendSystemPromptFile?: string
): Array<string> => {
  const cmd = [
    ...claude,
    "-p",
    "--output-format", "json",
    "--session-id", sessionId,
    "--permission-mode", cfg.permissionMode,
    // Nobody is there to answer a prompt; deny instead of waiting.
    "--permission-prompts", "none",
    // Keep the user's MCP servers out of the runs.
    "--strict-mcp-config"
  ]
  if (cfg.model) cmd.push("--model", cfg.model)
  if (cfg.effort) cmd.push("--effort", cfg.effort)
  if (cfg.maxTurns !== undefined) cmd.push("--max-turns", String(cfg.maxTurns))
  if (cfg.maxBudgetUsd !== undefined) cmd.push("--max-budget-usd", pyNumber(cfg.maxBudgetUsd))
  if (appendSystemPromptFile !== undefined) cmd.push("--append-system-prompt-file", appendSystemPromptFile)
  if (cfg.allowedTools.length > 0) cmd.push("--allowed-tools", cfg.allowedTools.join(","))
  if (cfg.disallowedTools.length > 0) cmd.push("--disallowed-tools", cfg.disallowedTools.join(","))
  return [...cmd, ...cfg.extraArgs]
}

/** Like Python's `str(float)`: 3.0 stays "3.0", as the Python harness passed it. */
const pyNumber = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n))

export const agentEnv = (base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !SESSION_VARS.has(k)) env[k] = v
  }
  // Claude Code's own auto-memory would carry notes from one run to the next
  // and contaminate every setup, so it is always off.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"
  // Our own hooks, if installed for daily work, stay out of measurement runs
  // and out of the model calls memory makes itself (a task-start hook inside
  // the task-start model call would call itself). A suite's env can turn them on.
  env.SINGULARITY_HOOKS = "off"
  return env
}

export const runAgent = Effect.fn("runAgent")(function*(
  command: ReadonlyArray<string>,
  sessionId: string,
  prompt: string,
  cwd: string,
  timeoutS: number,
  extraEnv: Readonly<Record<string, string>> = {}
) {
  // The prompt goes on stdin, which avoids shell quoting problems on Windows.
  const proc = yield* runProcess(command[0], command.slice(1), {
    cwd,
    timeoutS,
    env: { ...agentEnv(), ...extraEnv },
    input: prompt
  })
  return { command, sessionId, proc, result: parseResult(proc.stdout) } satisfies AgentRun
})

/** The result object from `--output-format json`, tolerating stray lines. */
export const parseResult = (stdout: string): Readonly<Record<string, unknown>> | undefined => {
  const candidates = [stdout.trim(), ...stdout.split(/\r?\n/).reverse().map((l) => l.trim())]
  for (const text of candidates) {
    if (!text.startsWith("{")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    if (Predicate.isObject(parsed) && (parsed as Record<string, unknown>).type === "result") {
      return parsed as Record<string, unknown>
    }
  }
  return undefined
}
