/**
 * What a run read in code it didn't change, from its tool calls: a range of
 * lines (`Read` with an offset, `sed -n 82,110p`, `head -n 40`) or the lines
 * a search in one file matched (`Grep` with a file's path, `grep -n`). Places
 * (Places.ts: placesOfRead) say which blocks those lines are in: a test
 * helper's class, a function the run wanted to call.
 *
 * Reads of a whole file say nothing about which part mattered, and searches
 * across a directory nothing about which file did; both are left out.
 *
 * Pure: tool calls in, spans out; the lines a span covers in a file's text.
 */
import { posix } from "node:path"
import { segmentKey, splitCommand } from "../records/Shell.ts"
import { SHELL_TOOLS, type ToolCall } from "../traces/index.ts"

export interface ReadSpan {
  /** Relative to the repository. */
  readonly file: string
  /** Lines from 1, inclusive. */
  readonly from?: number
  readonly to?: number
  /** A search: what it matched, as a regular expression. */
  readonly pattern?: string
  readonly flags?: string
}

/** Lines a `Read` without a limit returns. */
const READ_LIMIT = 2000

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined)

/** A file, by its extension: searches given a directory say nothing about which file mattered. */
const looksLikeFile = (p: string) => /\.[A-Za-z0-9]{1,5}$/.test(p) && !/[*?{}[\]]/.test(p)

/** `/c/x` (Git Bash) as `c:/x`; backslashes as slashes. */
const portable = (p: string) => p.replace(/\\/g, "/").replace(/^\/([A-Za-z])\//, "$1:/")

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:\//.test(p)

/** A path as the run meant it: against the directory a `cd` earlier in the line moved to. */
const resolveIn = (dir: string | undefined, file: string): string => {
  const p = portable(file)
  if (isAbsolute(p) || dir === undefined) return p
  return posix.normalize(posix.join(dir, p))
}

/** A grep pattern as a JavaScript regular expression: basic syntax's `\|` and `\(` `\)` as alternation and groups. */
export const grepPattern = (pattern: string, extended: boolean): string =>
  extended ? pattern : pattern.replace(/\\\|/g, "|").replace(/\\\(/g, "(").replace(/\\\)/g, ")")

/** What one shell segment read, if it read part of a file. */
const shellSpans = (ws: ReadonlyArray<string>, key: string, dir: string | undefined): Array<ReadSpan> => {
  const args = ws.slice(1)
  if (key === "sed") {
    // `sed -n 82,110p file` and `sed -n '82,110p' file`.
    if (!args.includes("-n")) return []
    const range = args.map((a) => /^(\d+),(\d+)p$/.exec(a)).find((m) => m !== null)
    if (range == null) return []
    const files = args.filter((a) => !a.startsWith("-") && !/^\d+,\d+p$/.test(a) && looksLikeFile(a))
    return files.map((f) => ({ file: resolveIn(dir, f), from: Number(range[1]), to: Number(range[2]) }))
  }
  if (key === "head") {
    const n = args.map((a, i) => (a === "-n" ? Number(args[i + 1]) : /^-(\d+)$/.test(a) ? Number(a.slice(1)) : NaN)).find((x) => Number.isFinite(x)) ?? 10
    const files = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-n" && looksLikeFile(a))
    return files.map((f) => ({ file: resolveIn(dir, f), from: 1, to: n }))
  }
  if (key === "grep" || key === "egrep" || key === "rg") {
    if (args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive")) return []
    const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("")
    const extended = key !== "grep" || /E/.test(flags)
    const explicit = args.findIndex((a) => a === "-e")
    // Flags that take a value: -A/-B/-C/-m with a separate number.
    const rest = args.filter((a, i) => !a.startsWith("-") && !/^-[ABCm]$/.test(args[i - 1] ?? "") && args[i - 1] !== "-e")
    const pattern = explicit >= 0 ? args[explicit + 1] : rest.shift()
    if (pattern === undefined) return []
    const files = rest.filter(looksLikeFile)
    if (files.length !== 1) return []
    return [{ file: resolveIn(dir, files[0]), pattern: grepPattern(pattern, extended), flags: /i/.test(flags) ? "i" : "" }]
  }
  return []
}

/** The parts of files a tool call read, relative to the repository (`relative` maps the run's absolute paths). */
export const readSpans = (call: ToolCall, relative: (p: string) => string): Array<ReadSpan> => {
  if (call.name === "Read") {
    const file = str(call.input.file_path)
    const offset = num(call.input.offset)
    const limit = num(call.input.limit)
    if (file === undefined || (offset === undefined && limit === undefined)) return []
    const from = Math.max(1, offset ?? 1)
    return [{ file: relative(portable(file)), from, to: from + (limit ?? READ_LIMIT) - 1 }]
  }
  if (call.name === "Grep") {
    const pattern = str(call.input.pattern)
    const path = str(call.input.path)
    // Only lines it printed were read: not file names or counts.
    if (call.input.output_mode !== "content") return []
    if (pattern === undefined || path === undefined || !looksLikeFile(path)) return []
    return [{ file: relative(portable(path)), pattern, flags: call.input["-i"] === true ? "i" : "" }]
  }
  if (SHELL_TOOLS.has(call.name)) {
    const command = str(call.input.command)
    if (command === undefined) return []
    let dir: string | undefined
    const out: Array<ReadSpan> = []
    for (const segment of splitCommand(command)) {
      const key = segmentKey(segment)
      if (key === undefined) continue
      if (key === "cd" || key === "set-location" || key === "pushd") {
        const to = segment.words[1]
        if (to !== undefined) dir = resolveIn(dir, to)
        continue
      }
      // What a piped segment filters is another command's output, not a file.
      if (segment.piped) continue
      out.push(...shellSpans(segment.words, key, dir).map((s) => ({ ...s, file: relative(s.file) })))
    }
    return out
  }
  return []
}

/**
 * A search whose matches fall in more blocks than this looked for where
 * something is used, rather than read what a block holds: it reads no place.
 */
export const MAX_SEARCH_PLACES = 5

/** The lines of a file (from 0) a span covers: its range, or what its search matches. */
export const linesOfSpan = (lines: ReadonlyArray<string>, span: ReadSpan): Array<number> => {
  if (span.pattern !== undefined) {
    let re: RegExp
    try {
      re = new RegExp(span.pattern, span.flags ?? "")
    } catch {
      return []
    }
    return lines.flatMap((l, i) => (re.test(l) ? [i] : []))
  }
  const from = Math.max(1, span.from ?? 1)
  const to = Math.min(lines.length, span.to ?? lines.length)
  const out: Array<number> = []
  for (let i = from; i <= to; i++) out.push(i - 1)
  return out
}
