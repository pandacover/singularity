/**
 * A compact account of a session for an LLM to read: the agent's messages and
 * each tool call with a short result, in order.
 *
 * Paths under the session's working directory are shown relative to it. Long
 * results keep their head and tail, since test runners print their summary
 * last. If the whole account is still too long, calls from the middle go.
 */
import type { ToolCall, Trace } from "./Models.ts"

export interface CondenseOptions {
  /** Per tool result. Default 300. */
  readonly maxResultChars?: number
  /** Per tool input. Default 400. */
  readonly maxInputChars?: number
  /** Per agent message. Default 400. */
  readonly maxTextChars?: number
  /** For the whole account. Default 40,000. */
  readonly maxChars?: number
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export const condenseTrace = (trace: Trace, options: CondenseOptions = {}): string => {
  const maxResult = options.maxResultChars ?? 300
  const maxInput = options.maxInputChars ?? 400
  const maxText = options.maxTextChars ?? 400
  const maxChars = options.maxChars ?? 40_000
  const relative = relativizer(trace.cwd)
  const calls = new Map(trace.toolCalls.map((c) => [c.id, c]))
  const shown = new Set<string>()

  const events: Array<string> = []
  let n = 0
  const pushCall = (call: ToolCall) => {
    shown.add(call.id)
    n += 1
    const who = call.agentId === undefined ? "" : ` [subagent ${call.agentId}]`
    const input = clip(oneLine(relative(describeInput(call))), maxInput)
    const result = clip(oneLine(relative(describeResult(call))), maxResult)
    events.push(`#${n}${who} ${call.name}${call.isError ? " (error)" : ""}: ${input}\n    -> ${result}`)
  }
  for (const response of trace.responses) {
    const text = oneLine(response.text)
    if (text) {
      const who = response.agentId === undefined ? "agent" : `subagent ${response.agentId}`
      events.push(`[${who}] ${clip(relative(text), maxText)}`)
    }
    for (const id of response.toolCallIds) {
      const call = calls.get(id)
      if (call !== undefined && !shown.has(id)) pushCall(call)
    }
  }
  for (const call of trace.toolCalls) if (!shown.has(call.id)) pushCall(call)
  return fit(events, maxChars)
}

const describeInput = (call: ToolCall): string => {
  const i = call.input
  const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v))
  switch (call.name) {
    case "Bash":
    case "PowerShell":
      return str(i.command)
    case "Read": {
      const range = i.offset !== undefined || i.limit !== undefined ? ` (offset ${str(i.offset)}, limit ${str(i.limit)})` : ""
      return slashes(str(i.file_path)) + range
    }
    case "Edit":
      return `${slashes(str(i.file_path))}: replace ${quote(str(i.old_string))} with ${quote(str(i.new_string))}`
    case "MultiEdit":
      return `${slashes(str(i.file_path))}: ${Array.isArray(i.edits) ? i.edits.length : "?"} edits`
    case "Write":
      return `${slashes(str(i.file_path))} (${str(i.content).length} chars)`
    case "Grep":
      return [quote(str(i.pattern)), i.path === undefined ? "" : `in ${slashes(str(i.path))}`, i.glob === undefined ? "" : `glob ${str(i.glob)}`]
        .filter(Boolean)
        .join(" ")
    case "Glob":
      return [str(i.pattern), i.path === undefined ? "" : `in ${slashes(str(i.path))}`].filter(Boolean).join(" ")
    default:
      return JSON.stringify(i)
  }
}

const describeResult = (call: ToolCall): string => {
  if (call.result === undefined) return "(no result)"
  const text = call.result.replace(ANSI, "")
  if (!call.isError) {
    if (call.name === "Read") return `(${text.split("\n").length} lines)`
    if (call.name === "Edit" || call.name === "MultiEdit" || call.name === "Write") return "ok"
  }
  return text
}

/** Strips the session's working directory from paths, whichever slashes they use. */
const relativizer = (cwd: string | undefined) => {
  if (cwd === undefined || cwd === "") return (s: string) => s
  const variants = [...new Set([cwd, cwd.replace(/\\/g, "/"), cwd.replace(/\//g, "\\")])]
  const pattern = new RegExp(variants.map((v) => escapeRegExp(v) + "[\\\\/]?").join("|"), "gi")
  return (s: string) => s.replace(pattern, "")
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const slashes = (p: string) => p.replace(/\\/g, "/")

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

const quote = (s: string) => JSON.stringify(s.length > 120 ? s.slice(0, 120) + "..." : s)

/** Head and tail of `s`, so test summaries at the end survive. */
const clip = (s: string, max: number): string => {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.4)
  return `${s.slice(0, head)} [...] ${s.slice(s.length - (max - head))}`
}

/** Drops events from the middle until the account fits. */
const fit = (events: ReadonlyArray<string>, maxChars: number): string => {
  const all = events.join("\n")
  if (all.length <= maxChars) return all
  const headBudget = Math.floor(maxChars * 0.4)
  const head: Array<string> = []
  let used = 0
  for (const e of events) {
    if (used + e.length + 1 > headBudget) break
    head.push(e)
    used += e.length + 1
  }
  const tail: Array<string> = []
  used = 0
  for (let i = events.length - 1; i >= head.length; i--) {
    if (used + events[i].length + 1 > maxChars - headBudget) break
    tail.unshift(events[i])
    used += events[i].length + 1
  }
  const dropped = events.length - head.length - tail.length
  return [...head, `... (${dropped} steps omitted) ...`, ...tail].join("\n")
}
