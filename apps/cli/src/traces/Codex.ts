/**
 * Codex session logs ("rollouts"), read as Claude Code's: memory learns from
 * a Codex session the way it learns from a Claude Code one.
 *
 * Codex writes one JSONL file per session to
 * `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl` (and
 * moves old ones to `archived_sessions/`). Each line is
 * `{timestamp, type, payload}`:
 *
 * - "session_meta": the session's id, directory and Codex version (first line).
 * - "turn_context": the model and directory of a turn.
 * - "response_item": what went to and came from the model: messages, tool
 *   calls (`function_call`, `custom_tool_call`, `local_shell_call`) and their
 *   outputs, matched by `call_id`.
 * - "event_msg": among others, `token_count` after each model response, with
 *   its usage, and `item_completed` with the user's own messages.
 *
 * Tool calls take Claude Code's names, as hooks read them (HookTool.ts): shell
 * commands (`shell`, `shell_command`, `exec_command`) are Bash, a patch is a
 * Write per file added and an Edit per hunk changed (ApplyPatch.ts), and the
 * calls a code-mode script makes (`exec`) are read out of it (JsLiteral.ts).
 * A shell's output says its exit code; a nonzero one makes the call an error.
 */
import { DateTime, Predicate } from "effect"
import { patchEdits } from "./ApplyPatch.ts"
import { type Json, num, obj, parseJson, sortByTime, str, timeSpan, timestamp } from "./Json.ts"
import { scriptCalls } from "./JsLiteral.ts"
import type { Prompt, Response, ToolCall, Trace, Usage } from "./Models.ts"

/** Whether a log's first line is a Codex rollout's. */
export const isCodexRollout = (firstLine: string): boolean => {
  const line = parseJson(firstLine.trim())
  return obj(line).type === "session_meta" && Predicate.isObject(obj(line).payload)
}

/** Codex's shell tools, whose argument holds a command. */
const SHELLS = new Set(["shell", "shell_command", "exec_command", "local_shell"])

/** The command of a shell call: the script a shell was asked to run, or the program and its arguments. */
const commandOf = (args: Json): string | undefined => {
  const command = args.command ?? args.cmd
  if (Predicate.isString(command)) return command
  if (!Array.isArray(command) || !command.every(Predicate.isString)) return undefined
  const words = command as ReadonlyArray<string>
  // ["bash", "-lc", "npm test"], ["powershell.exe", "-Command", "npm test"]
  if (words.length >= 3 && /^-(?:l?c|Command)$/i.test(words[words.length - 2])) return words[words.length - 1]
  return words.map((w) => (/[\s"]/.test(w) ? JSON.stringify(w) : w)).join(" ")
}

/** Usage as Claude Code counts it: Codex's input tokens include the cached ones. */
const usageOf = (value: unknown): Usage | undefined => {
  const u = obj(value)
  const input = num(u.input_tokens)
  if (input === undefined) return undefined
  const cached = num(u.cached_input_tokens) ?? 0
  const written = num(u.cache_write_input_tokens) ?? 0
  return {
    input_tokens: Math.max(0, input - cached - written),
    output_tokens: num(u.output_tokens) ?? 0,
    cache_creation_input_tokens: written,
    cache_read_input_tokens: cached
  }
}

/** A tool's output as text: a string, the text parts of a list, or the `output` of Codex's JSON wrapping. */
const outputText = (output: unknown): { readonly text: string; readonly exitCode: number | undefined } => {
  if (Array.isArray(output)) return { text: output.map((p) => str(obj(p).text) ?? "").join(""), exitCode: undefined }
  if (!Predicate.isString(output)) return { text: "", exitCode: undefined }
  const wrapped = obj(parseJson(output))
  if (Predicate.isString(wrapped.output)) return { text: wrapped.output, exitCode: num(obj(wrapped.metadata).exit_code) }
  return { text: output, exitCode: undefined }
}

/** The exit code a shell's output reports first. */
const exitCodeIn = (text: string): number | undefined => {
  const m = /^(?:Exit code: |Process exited with code )(-?\d+)\s*$/m.exec(text)
  return m === null ? undefined : Number(m[1])
}

/** A code-mode script's output split into its shells' outputs, in order (the script's own header left out). */
const shellOutputs = (text: string): Array<string> => text.split(/^(?=Exit code: -?\d+\s*$|Chunk ID: )/m).slice(1)

const FAILED = /^(?:Script failed|Script terminated|apply_patch verification failed|aborted by user)|\naborted by user\s*$/

interface Pending {
  /** The calls the tool call stands for, in Claude Code's terms. */
  readonly calls: Array<ToolCall>
  /** A code-mode script's shell calls still waiting for their output, in order. */
  readonly shells: Array<ToolCall>
  /** A code-mode script's other calls. */
  readonly others: Array<ToolCall>
  readonly script: boolean
}

export const parseCodexRollout = (text: string, path: string): Trace => {
  let sessionId: string | undefined
  let cwd: string | undefined
  let version: string | undefined
  let gitBranch: string | undefined
  let model = "unknown"
  let skippedLines = 0
  const times: Array<DateTime.Utc> = []
  const typed: Array<Prompt> = []
  const sent: Array<Prompt> = []
  const responses: Array<Response> = []
  const calls: Array<ToolCall> = []
  const pending = new Map<string, Pending>()
  /** Code-mode cells still running, by cell id: their output comes with later `wait` calls. */
  const cells = new Map<string, Pending>()
  /** Those `wait` calls, by their own call id. */
  const waits = new Map<string, Pending>()
  /** Calls and text since the last model response was counted. */
  let since: Array<string> = []
  let textSince = ""
  let lastTotal: number | undefined

  const add = (call: Omit<ToolCall, "agentId" | "finishedAt" | "result" | "isError">): ToolCall => {
    const c: ToolCall = { ...call, agentId: undefined, finishedAt: undefined, result: undefined, isError: false }
    calls.push(c)
    since.push(c.id)
    return c
  }

  /** Claude Code's calls for one of Codex's tools (or a code-mode script's call to one). */
  const translate = (id: string, name: string, args: unknown, ts: DateTime.Utc | undefined): Array<ToolCall> => {
    const a = obj(args)
    if (SHELLS.has(name)) {
      const command = commandOf(Predicate.isObject(a.action) ? obj(a.action) : a)
      return command === undefined ? [] : [add({ id, name: "Bash", input: { command, ...(str(a.workdir) === undefined ? {} : { cwd: a.workdir }) }, startedAt: ts })]
    }
    if (name === "apply_patch") {
      const patch = Predicate.isString(args) ? args : str(a.input) ?? str(a.patch) ?? ""
      return patchEdits(patch).map((e, i) => add({ id: `${id}/${i}`, name: e.tool, input: e.input, startedAt: ts }))
    }
    return [add({ id, name, input: a, startedAt: ts })]
  }

  const settle = (call: ToolCall, result: string, isError: boolean, ts: DateTime.Utc | undefined) => {
    call.result = result
    call.isError = isError
    call.finishedAt = ts
  }

  /** A code-mode script's output, given to its calls: each shell its part, in order. */
  const feedScript = (p: Pending, text: string, ts: DateTime.Utc | undefined) => {
    const failed = FAILED.test(text)
    for (const part of shellOutputs(text)) {
      const call = p.shells.shift()
      if (call === undefined) break
      const code = exitCodeIn(part)
      settle(call, part, code !== undefined && code !== 0, ts)
    }
    const done = !/^Script running with cell ID/.test(text)
    for (const call of p.others) if (call.result === undefined && (done || failed)) settle(call, "", failed, ts)
    if (done) for (const call of p.shells.splice(0)) settle(call, "", failed, ts)
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    const record = parseJson(line)
    if (!Predicate.isObject(record)) {
      skippedLines++
      continue
    }
    const r = record as Json
    const ts = timestamp(r.timestamp)
    if (ts !== undefined) times.push(ts)
    const p = obj(r.payload)

    if (r.type === "session_meta") {
      sessionId ??= str(p.id) ?? str(p.session_id)
      cwd ??= str(p.cwd)
      version ??= str(p.cli_version)
      gitBranch ??= str(obj(p.git).branch)
    } else if (r.type === "turn_context") {
      model = str(p.model) ?? model
      cwd ??= str(p.cwd)
    } else if (r.type === "event_msg") {
      if (p.type === "token_count") {
        const info = obj(p.info)
        const usage = usageOf(info.last_token_usage)
        const total = num(obj(info.total_token_usage).total_tokens)
        // Codex repeats the count when nothing new was spent (rate-limit updates).
        if (usage === undefined || (total !== undefined && total === lastTotal)) continue
        lastTotal = total
        responses.push({ id: `response-${responses.length}`, model, agentId: undefined, timestamp: ts, usage, text: textSince, toolCallIds: since, stopReason: undefined })
        since = []
        textSince = ""
      } else if (p.type === "item_completed" && obj(p.item).type === "UserMessage") {
        const words = (Array.isArray(obj(p.item).content) ? (obj(p.item).content as ReadonlyArray<unknown>) : [])
          .map((c) => str(obj(c).text) ?? "")
          .join("\n")
        if (words.trim() !== "") typed.push({ text: words, timestamp: ts })
      } else if (p.type === "user_message" && str(p.message) !== undefined) {
        typed.push({ text: p.message as string, timestamp: ts })
      }
    } else if (r.type === "response_item") {
      const callId = str(p.call_id) ?? str(p.id)
      if (p.type === "message") {
        const words = (Array.isArray(p.content) ? (p.content as ReadonlyArray<unknown>) : [])
          .map((c) => str(obj(c).text) ?? "")
          .join("\n")
        if (p.role === "assistant") textSince += (textSince === "" ? "" : "\n") + words
        else if (p.role === "user" && isTyped(words)) sent.push({ text: words, timestamp: ts })
      } else if ((p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") && callId !== undefined) {
        if (pending.has(callId)) continue
        const name = p.type === "local_shell_call" ? "local_shell" : str(p.name) ?? "unknown"
        const fullName = str(p.namespace) === undefined ? name : `${p.namespace as string}.${name}`
        if (p.type === "custom_tool_call" && name === "exec" && Predicate.isString(p.input)) {
          const inner = scriptCalls(p.input).map((c, i) => ({ c, made: c.args === undefined ? [] : translate(`${callId}:${i}`, c.tool, c.args, ts) }))
          const shells = inner.flatMap(({ c, made }) => (SHELLS.has(c.tool) ? (made.length > 0 ? made : [placeholder(`${callId}:${c.tool}`)]) : []))
          const others = inner.flatMap(({ c, made }) => (SHELLS.has(c.tool) ? [] : made))
          pending.set(callId, { calls: inner.flatMap(({ made }) => made), shells, others, script: true })
          continue
        }
        const args = p.type === "local_shell_call" ? p : p.type === "custom_tool_call" ? p.input : parseJson(str(p.arguments) ?? "")
        const cell = name === "wait" ? str(obj(args).cell_id) : undefined
        if (cell !== undefined) {
          // Waiting on a code-mode script still running: its output is the script's.
          const script = cells.get(cell)
          if (script !== undefined) waits.set(callId, script)
          continue
        }
        pending.set(callId, { calls: translate(callId, fullName, args, ts), shells: [], others: [], script: false })
      } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && callId !== undefined) {
        const out = outputText(p.output)
        const waited = waits.get(callId)
        if (waited !== undefined) {
          waits.delete(callId)
          feedScript(waited, out.text, ts)
          continue
        }
        const call = pending.get(callId)
        if (call === undefined) continue
        if (call.script) {
          feedScript(call, out.text, ts)
          const cell = /^Script running with cell ID (\S+)/.exec(out.text)
          if (cell !== null) cells.set(cell[1], call)
          continue
        }
        const code = out.exitCode ?? exitCodeIn(out.text)
        const isError = (code !== undefined && code !== 0) || FAILED.test(out.text)
        for (const c of call.calls) if (c.result === undefined) settle(c, out.text, isError, ts)
      }
    }
  }

  const span = timeSpan(times)
  return {
    sessionId: sessionId ?? path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, ""),
    path,
    cwd,
    gitBranch,
    version,
    // The user's own messages when Codex logs them as such; else those sent as the user's, without Codex's own context.
    prompts: typed.length > 0 ? typed : sent,
    responses,
    toolCalls: sortByTime(calls, (c) => c.startedAt),
    apiErrors: 0,
    costState: undefined,
    startedAt: span.first,
    endedAt: span.last,
    skippedLines
  }
}

/** A shell call a script made whose command couldn't be read: it still takes its part of the output. */
const placeholder = (id: string): ToolCall => ({
  id,
  name: "Bash",
  input: {},
  agentId: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  result: undefined,
  isError: false
})

/**
 * Whether a message sent as the user's is the user's own: Codex also sends
 * its context that way (`<environment_context>`, AGENTS.md, skills, a
 * compacted history).
 */
const isTyped = (text: string): boolean => {
  const t = text.trimStart()
  return t !== "" && !t.startsWith("<") && !t.startsWith("# AGENTS.md instructions") && !/^The following is the Codex agent history/.test(t)
}
