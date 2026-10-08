/**
 * Effort metrics for a parsed trace.
 */
import { platform } from "node:os"
import { posix, win32 } from "node:path"
import type { Trace, Usage } from "./Models.ts"
import { traceAgentIds, traceUsage, traceWallTime, usageToJson } from "./Models.ts"

export const READ_TOOLS = new Set(["Read"])
export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"])
export const SEARCH_TOOLS = new Set(["Glob", "Grep"])

/**
 * Shell commands that probably write files: in-place sed/perl, redirection
 * into a file, tee, PowerShell's writers, and scripts that open files for
 * writing. A heuristic; the run's diff is the ground truth for what changed.
 */
export const SHELL_WRITE = new RegExp(
  [
    String.raw`\b(sed|perl)\s+(-\w+\s+)*-[a-zA-Z]*i`,
    String.raw`[^0-9&>]>>?\s*(?!&|/dev/null|\$null|nul\b)[\w./\\~"'$-]`,
    String.raw`\btee\b`,
    String.raw`\b(Set-Content|Add-Content|Out-File)\b`,
    String.raw`\bwrite_text\(|\.writeFileSync\(|open\([^)]*['"][wa]`
  ].join("|"),
  "i"
)

export interface TraceMetrics {
  readonly apiCalls: number
  /** Summed over logged responses (main thread and subagents). Excludes side calls such as WebFetch summarization. */
  readonly usage: Usage
  readonly toolCalls: number
  readonly toolErrors: number
  /** Calls per tool, most used first. */
  readonly tools: ReadonlyArray<readonly [string, number]>
  readonly shellCommands: number
  /** Shell commands that look like they write files (see SHELL_WRITE). */
  readonly shellWrites: number
  readonly searches: number
  readonly reads: number
  readonly uniqueFilesRead: number
  /** Through edit tools only. Edits made in the shell show up in shellWrites. */
  readonly filesEdited: ReadonlyArray<string>
  readonly subagents: number
  readonly apiErrors: number
  readonly wallTimeS: number | undefined
}

/** Reads of a file that was already read: a rough signal of wasted effort. */
export const repeatReads = (m: TraceMetrics): number => m.reads - m.uniqueFilesRead

export const traceMetrics = (trace: Trace): TraceMetrics => {
  const calls = trace.toolCalls
  const readPaths = calls.filter((c) => READ_TOOLS.has(c.name)).map((c) => normPath(c.input.file_path))
  const edited = new Set(
    calls.filter((c) => EDIT_TOOLS.has(c.name)).map((c) => normPath(c.input.file_path || c.input.notebook_path))
  )
  return {
    apiCalls: trace.responses.length,
    usage: traceUsage(trace),
    toolCalls: calls.length,
    toolErrors: calls.filter((c) => c.isError).length,
    tools: mostCommon(calls.map((c) => c.name)),
    shellCommands: calls.filter((c) => SHELL_TOOLS.has(c.name)).length,
    shellWrites: calls.filter((c) => SHELL_TOOLS.has(c.name) && SHELL_WRITE.test(String(c.input.command ?? ""))).length,
    searches: calls.filter((c) => SEARCH_TOOLS.has(c.name)).length,
    reads: readPaths.length,
    uniqueFilesRead: new Set(readPaths).size,
    filesEdited: [...edited].filter((p) => p !== "").sort(),
    subagents: traceAgentIds(trace).length,
    apiErrors: trace.apiErrors,
    wallTimeS: traceWallTime(trace)
  }
}

/** The JSON shape stored in run records (same keys and order as the Python version). */
export const metricsToJson = (m: TraceMetrics) => ({
  api_calls: m.apiCalls,
  usage: usageToJson(m.usage),
  tool_calls: m.toolCalls,
  tool_errors: m.toolErrors,
  tools: Object.fromEntries(m.tools),
  shell_commands: m.shellCommands,
  shell_writes: m.shellWrites,
  searches: m.searches,
  reads: m.reads,
  unique_files_read: m.uniqueFilesRead,
  repeat_reads: repeatReads(m),
  files_edited: m.filesEdited,
  subagents: m.subagents,
  api_errors: m.apiErrors,
  wall_time_s: m.wallTimeS ?? null
})

/** Like Python's `Counter(...).most_common()`: by count descending, ties in first-seen order. */
const mostCommon = (names: ReadonlyArray<string>): Array<[string, number]> => {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

/** Like Python's `os.path.normcase(os.path.normpath(p))`, so the same file counts once. */
const normPath = (value: unknown): string => {
  if (typeof value !== "string" || value === "") return ""
  if (platform() === "win32") return stripTrailingSep(win32.normalize(value)).toLowerCase()
  return stripTrailingSep(posix.normalize(value))
}

const stripTrailingSep = (p: string): string => (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p)
