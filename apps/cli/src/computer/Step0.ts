/**
 * Step 0's logging hook in Claude Code's settings, and what it saw
 * (step0-hook.ts). From the repo only (`node src/cli.ts computer-use step0
 * on|off|report`): the daily `singularity` command never offers it.
 */
import { Effect, FileSystem, Path } from "effect"
import { fileURLToPath } from "node:url"
import { type AgentDirs, claudeDir, join, slashes } from "../setup/Agents.ts"
import { hooksIn, installHooks, removeHooks } from "../setup/HookFiles.ts"

export const STEP0_SCRIPT = fileURLToPath(new URL("./step0-hook.ts", import.meta.url))

/** Step 0's own hook command, wherever it was installed from. */
export const isStep0Command = (command: string): boolean => /\/src\/computer\/step0-hook\.ts["']?/.test(slashes(command))

const settingsOf = (dirs: AgentDirs) => ({ file: join(claudeDir(dirs), "settings.json"), layout: "wrapped" as const })

const entry = () => [{
  matcher: "mcp__.*",
  hooks: [{ type: "command" as const, command: `"${slashes(process.execPath)}" "${slashes(STEP0_SCRIPT)}"`, timeout: 15 }]
}]

/** Put the logging hook in Claude Code's settings; the file. */
export const step0On = Effect.fn("step0On")(function*(dirs: AgentDirs) {
  const target = settingsOf(dirs)
  yield* installHooks(target, { PostToolUse: entry(), PostToolUseFailure: entry() }, isStep0Command)
  return target.file
})

/** Take it out; whether it was there. */
export const step0Off = Effect.fn("step0Off")(function*(dirs: AgentDirs) {
  return yield* removeHooks(settingsOf(dirs), isStep0Command)
})

export const step0IsOn = (dirs: AgentDirs) => hooksIn(settingsOf(dirs), isStep0Command).pipe(Effect.map((events) => events.length > 0))

interface Line {
  readonly tool?: string
  readonly event?: string
  readonly session_id?: string
  readonly transcript_path?: string
  readonly stdin_bytes?: number
  readonly answer_chars?: number
  readonly answer_kind?: string
  readonly has_image?: boolean
  readonly url?: string | null
  readonly refs_playwright?: number
  readonly refs_underscore?: number
  readonly roles?: number
  readonly checked?: number
  readonly click_at_point?: boolean
  readonly click_by_ref?: boolean
  readonly hook_ms?: number
}

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]
}

/** What the logging hook saw, per tool: the lines of a plain-text report. */
export const step0Report = Effect.fn("step0Report")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(root, "step0")
  const text = yield* fs.readFileString(path.join(dir, "calls.jsonl")).pipe(Effect.orElseSucceed(() => ""))
  const lines: Array<Line> = []
  for (const l of text.split(/\r?\n/)) {
    if (l.trim() === "") continue
    try {
      lines.push(JSON.parse(l) as Line)
    } catch {
      // A line cut short by a crash.
    }
  }
  if (lines.length === 0) return [`No calls logged yet in ${dir}.`]
  const out = [`${lines.length} MCP calls in ${new Set(lines.map((l) => l.session_id)).size} session(s); samples in ${path.join(dir, "samples")}`, ""]
  const byTool = new Map<string, Array<Line>>()
  for (const l of lines) byTool.set(l.tool ?? "?", [...(byTool.get(l.tool ?? "?") ?? []), l])
  for (const [tool, ls] of [...byTool].sort((a, b) => b[1].length - a[1].length)) {
    const n = (f: (l: Line) => boolean) => ls.filter(f).length
    out.push(
      `${tool}: ${ls.length} call(s) (${n((l) => l.event === "PostToolUseFailure")} failed), input median ${median(ls.map((l) => l.stdin_bytes ?? 0))} bytes, answer median ${median(ls.map((l) => l.answer_chars ?? 0))} chars (${[...new Set(ls.map((l) => l.answer_kind))].join("/")}), hook median ${median(ls.map((l) => l.hook_ms ?? 0))} ms`,
      `  images ${n((l) => l.has_image === true)} · address ${n((l) => typeof l.url === "string")} · refs ${n((l) => (l.refs_playwright ?? 0) + (l.refs_underscore ?? 0) > 0)} · controls with roles ${n((l) => (l.roles ?? 0) > 0)} · field states ${n((l) => (l.checked ?? 0) > 0)} · clicks at a point ${n((l) => l.click_at_point === true)} · by ref ${n((l) => l.click_by_ref === true)}`
    )
  }
  const logs = [...new Set(lines.map((l) => l.transcript_path).filter((p): p is string => typeof p === "string"))]
  out.push("", "Session logs:", ...logs.map((p) => `  ${p}`))
  return out
})
