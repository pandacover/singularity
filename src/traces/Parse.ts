/**
 * Parse Claude Code session transcripts.
 *
 * Claude Code writes one JSONL file per session to
 * `<config dir>/projects/<project slug>/<session id>.jsonl`, and each subagent's
 * transcript to `<session id>/subagents/**\/agent-<agent id>.jsonl` next to it.
 * Lines we use:
 *
 * - "assistant": one content block of a model response. A response with several
 *   blocks (thinking, text, tool_use) spans several lines sharing `message.id`,
 *   each repeating the response's usage, so usage must be counted once per id.
 * - "user": a prompt, or tool results (`tool_result` blocks).
 * - "cost-state": Claude Code's running cost and token totals for the session.
 *
 * Everything else (attachments, queue operations, titles) is ignored. The log
 * format isn't a stable API, so parsing is lenient: a field of an unexpected
 * shape counts as missing, and only lines that aren't JSON at all are skipped.
 */
import { Config, DateTime, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { homedir } from "node:os"
import type { Prompt, Response, ToolCall, Trace, Usage } from "./Models.ts"
import { emptyUsage, maxUsage } from "./Models.ts"

type Json = Readonly<Record<string, unknown>>

/** A response's `usage` from the API (snake_case keys). */
const ApiUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  output_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number))
})

/** One entry of Claude Code's `modelUsage` (camelCase keys), as in cost-state lines and result JSON. */
const ModelUsage = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  outputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cacheCreationInputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cacheReadInputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number))
})

const int = (n: number | null | undefined): number => Math.trunc(n ?? 0)

export const usageFromApi = (value: unknown): Usage =>
  Option.match(Schema.decodeUnknownOption(ApiUsage)(value), {
    onNone: () => emptyUsage,
    onSome: (u) => ({
      input_tokens: int(u.input_tokens),
      output_tokens: int(u.output_tokens),
      cache_creation_input_tokens: int(u.cache_creation_input_tokens),
      cache_read_input_tokens: int(u.cache_read_input_tokens)
    })
  })

export const usageFromModelUsage = (value: unknown): Usage =>
  Option.match(Schema.decodeUnknownOption(ModelUsage)(value), {
    onNone: () => emptyUsage,
    onSome: (u) => ({
      input_tokens: int(u.inputTokens),
      output_tokens: int(u.outputTokens),
      cache_creation_input_tokens: int(u.cacheCreationInputTokens),
      cache_read_input_tokens: int(u.cacheReadInputTokens)
    })
  })

/** `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export const claudeHome: Effect.Effect<string, never, Path.Path> = Effect.gen(function*() {
  const path = yield* Path.Path
  const configured = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR")).pipe(
    Effect.orElseSucceed(() => Option.none<string>())
  )
  return Option.getOrElse(Option.filter(configured, (s) => s !== ""), () => path.join(homedir(), ".claude"))
})

/** The transcript of a session, searched across all projects. */
export const findTranscript = Effect.fn("findTranscript")(function*(sessionId: string, home?: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const projects = path.join(home ?? (yield* claudeHome), "projects")
  if (!(yield* fs.exists(projects))) return undefined
  for (const dir of (yield* fs.readDirectory(projects)).sort()) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`)
    if (yield* fs.exists(candidate)) return candidate
  }
  return undefined
})

/** Subagent transcripts of a session: `<session>/subagents/**\/agent-*.jsonl`, sorted. */
export const subagentTranscripts = Effect.fn("subagentTranscripts")(function*(transcript: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(transcript.replace(/\.jsonl$/, ""), "subagents")
  if (!(yield* fs.exists(root))) return []
  const files = yield* fs.readDirectory(root, { recursive: true })
  return files
    .filter((f) => /^agent-.*\.jsonl$/.test(path.basename(f)))
    .map((f) => path.join(root, f))
    .sort()
})

export const parseSession = Effect.fn("parseSession")(function*(transcript: string, includeSubagents = true) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parser = new Parser(path.basename(transcript).replace(/\.jsonl$/, ""), transcript)
  parser.feed(yield* fs.readFileString(transcript), undefined)
  if (includeSubagents) {
    for (const sub of yield* subagentTranscripts(transcript)) {
      parser.feed(yield* fs.readFileString(sub), path.basename(sub).replace(/^agent-/, "").replace(/\.jsonl$/, ""))
    }
  }
  return parser.finish()
})

class Parser {
  private readonly sessionId: string
  private readonly path: string
  private cwd: string | undefined
  private gitBranch: string | undefined
  private version: string | undefined
  private readonly prompts: Array<Prompt> = []
  private readonly responses = new Map<string, Response>()
  private readonly toolCalls = new Map<string, ToolCall>()
  private readonly timestamps: Array<DateTime.Utc> = []
  private apiErrors = 0
  private costState: Json | undefined
  private skippedLines = 0

  constructor(sessionId: string, path: string) {
    this.sessionId = sessionId
    this.path = path
  }

  feed(text: string, fileAgentId: string | undefined): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        this.skippedLines++
        continue
      }
      if (Predicate.isObject(record)) this.record(record as Json, fileAgentId)
    }
  }

  private record(r: Json, fileAgentId: string | undefined): void {
    const ts = timestamp(r.timestamp)
    if (ts !== undefined) this.timestamps.push(ts)
    // Older Claude Code versions logged subagents inline as sidechains.
    let agentId = fileAgentId
    if (agentId === undefined && truthy(r.isSidechain)) agentId = str(r.agentId) ?? "sidechain"

    if (fileAgentId === undefined) {
      this.cwd ??= str(r.cwd)
      this.gitBranch ??= str(r.gitBranch)
      this.version ??= str(r.version)
    }

    if (r.type === "assistant") this.assistant(r, agentId, ts)
    else if (r.type === "user") this.user(r, agentId, ts)
    else if (r.type === "cost-state" && fileAgentId === undefined) this.costState = r
  }

  private assistant(r: Json, agentId: string | undefined, ts: DateTime.Utc | undefined): void {
    const msg = obj(r.message)
    if (truthy(r.isApiErrorMessage)) {
      this.apiErrors++
      return
    }
    const model = str(msg.model) ?? "unknown"
    if (model === "<synthetic>") return
    const msgId = str(msg.id) ?? str(r.uuid) ?? `line-${this.responses.size}`
    const usage = usageFromApi(msg.usage)
    let resp = this.responses.get(msgId)
    if (resp === undefined) {
      resp = { id: msgId, model, agentId, timestamp: ts, usage, text: "", toolCallIds: [], stopReason: undefined }
      this.responses.set(msgId, resp)
    } else {
      resp.usage = maxUsage(resp.usage, usage)
    }
    resp.stopReason = str(msg.stop_reason) ?? resp.stopReason

    for (const block of blocks(msg.content)) {
      if (block.type === "text") {
        resp.text += (resp.text ? "\n" : "") + (str(block.text) ?? "")
      } else if (block.type === "tool_use") {
        const id = str(block.id)
        if (id === undefined || this.toolCalls.has(id)) continue
        this.toolCalls.set(id, {
          id,
          name: str(block.name) ?? "unknown",
          input: Predicate.isObject(block.input) ? (block.input as Json) : {},
          agentId,
          startedAt: ts,
          finishedAt: undefined,
          result: undefined,
          isError: false
        })
        resp.toolCallIds.push(id)
      }
    }
  }

  private user(r: Json, agentId: string | undefined, ts: DateTime.Utc | undefined): void {
    const content = blocks(obj(r.message).content)
    const results = content.filter((b) => b.type === "tool_result")
    for (const b of results) {
      const call = this.toolCalls.get(str(b.tool_use_id) ?? "")
      if (call === undefined) continue
      call.result = resultText(b.content)
      call.isError = truthy(b.is_error)
      call.finishedAt = ts
    }
    if (results.length > 0 || agentId !== undefined || truthy(r.isMeta) || truthy(r.isCompactSummary)) return
    const text = content.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n")
    if (text) this.prompts.push({ text, timestamp: ts })
  }

  finish(): Trace {
    const millis = this.timestamps.map(DateTime.toEpochMillis)
    return {
      sessionId: this.sessionId,
      path: this.path,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      version: this.version,
      prompts: this.prompts,
      responses: sortByTime([...this.responses.values()], (x) => x.timestamp),
      toolCalls: sortByTime([...this.toolCalls.values()], (x) => x.startedAt),
      apiErrors: this.apiErrors,
      costState: this.costState,
      startedAt: millis.length ? this.timestamps[millis.indexOf(Math.min(...millis))] : undefined,
      endedAt: millis.length ? this.timestamps[millis.indexOf(Math.max(...millis))] : undefined,
      skippedLines: this.skippedLines
    }
  }
}

const obj = (value: unknown): Json => (Predicate.isObject(value) ? (value as Json) : {})

/** A non-empty string, or undefined (like Python's `x or default` on a string field). */
const str = (value: unknown): string | undefined => (Predicate.isString(value) && value !== "" ? value : undefined)

const truthy = (value: unknown): boolean => Predicate.isTruthy(value)

const blocks = (content: unknown): Array<Json> => {
  if (Predicate.isString(content)) return [{ type: "text", text: content }]
  if (Array.isArray(content)) return content.filter((b): b is Json => Predicate.isObject(b))
  return []
}

const resultText = (content: unknown): string => {
  if (Predicate.isString(content)) return content
  const parts: Array<string> = []
  for (const b of blocks(content)) {
    if (b.type === "text") parts.push(str(b.text) ?? "")
    else if (b.type === "image") parts.push("[image]")
  }
  return parts.join("\n")
}

/** An ISO timestamp; one without a zone is taken as UTC. */
const timestamp = (value: unknown): DateTime.Utc | undefined => {
  if (!Predicate.isString(value)) return undefined
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`
  return Option.getOrUndefined(DateTime.make(withZone).pipe(Option.map(DateTime.toUtc)))
}

/** Stable sort by time, entries without a time last. */
const sortByTime = <A>(items: Array<A>, time: (a: A) => DateTime.Utc | undefined): Array<A> =>
  items.sort((a, b) => {
    const ta = time(a)
    const tb = time(b)
    if (ta === undefined || tb === undefined) return (ta === undefined ? 1 : 0) - (tb === undefined ? 1 : 0)
    return DateTime.toEpochMillis(ta) - DateTime.toEpochMillis(tb)
  })
