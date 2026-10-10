/**
 * Hermes Agent's sessions, read as Claude Code's: memory learns from a Hermes
 * session the way it learns from a Claude Code one.
 *
 * Hermes keeps every session in one SQLite database, `<hermes home>/state.db`:
 * a `sessions` row each (its directory, model, token totals and cost), and
 * the messages in `messages`, in OpenAI's chat format (an assistant message's
 * `tool_calls`, a tool message per result). When it compresses a long
 * conversation it ends the session and goes on in a new one whose
 * `parent_session_id` is the old one, with some of the old messages copied
 * in: a task is the chain of sessions up to the one it ended in.
 *
 * A Hermes session is named as a transcript by the database and its id,
 * `<path>/state.db#<session id>`, so records keep a log path that reads again.
 *
 * Tool calls take Claude Code's names, as hooks read them (HookTool.ts):
 * `terminal` is Bash, `read_file` Read, `search_files` Grep or Glob, `patch`
 * an Edit (or, in its patch mode, the edits of a patch, ApplyPatch.ts) and
 * `write_file` a Write. Hermes's results are JSON; a terminal's exit code
 * other than 0, or a tool's error, makes the call an error. Hermes counts
 * tokens per session, not per response: the totals go on the first response.
 */
import { DateTime, Effect, Option, Predicate, Schema } from "effect"
import { patchEdits } from "./ApplyPatch.ts"
import { type Json, fromSeconds, obj, parseJson, str, timeSpan } from "./Json.ts"
import type { Prompt, Response, ToolCall, Trace } from "./Models.ts"
import { emptyUsage } from "./Models.ts"

export class HermesError extends Schema.TaggedError<HermesError>()("HermesError", {
  transcript: Schema.String,
  message: Schema.String
}) {}

/** A Hermes session as a transcript: its database and its id. */
export const hermesTranscript = (db: string, sessionId: string): string => `${db}#${sessionId}`

/** The database and session id a Hermes transcript names; undefined for a file's path. */
export const hermesRef = (transcript: string): { readonly db: string; readonly sessionId: string } | undefined => {
  const m = /^(.+\.db)#([^#\\/]+)$/.exec(transcript)
  return m === null ? undefined : { db: m[1], sessionId: m[2] }
}

const Num = Schema.optionalKey(Schema.NullOr(Schema.Number))
const Text = Schema.optionalKey(Schema.NullOr(Schema.String))

export const HermesSession = Schema.Struct({
  id: Schema.String,
  source: Text,
  model: Text,
  parent_session_id: Text,
  started_at: Num,
  ended_at: Num,
  end_reason: Text,
  input_tokens: Num,
  output_tokens: Num,
  cache_read_tokens: Num,
  cache_write_tokens: Num,
  estimated_cost_usd: Num,
  actual_cost_usd: Num,
  cwd: Text,
  git_branch: Text,
  git_repo_root: Text,
  last_activity_at: Num
})
export type HermesSession = typeof HermesSession.Type

export const HermesMessage = Schema.Struct({
  id: Schema.Number,
  role: Schema.String,
  content: Text,
  tool_call_id: Text,
  tool_calls: Text,
  tool_name: Text,
  timestamp: Num
})
export type HermesMessage = typeof HermesMessage.Type

const SESSION_COLUMNS = HermesSession.fields
const decodeSession = Schema.decodeUnknownOption(HermesSession)
const decodeMessage = Schema.decodeUnknownOption(HermesMessage)

/** Whether a session went on in a child: Hermes ends a session this way when it compresses its context. */
const continued = (parent: HermesSession, child: HermesSession) =>
  parent.end_reason === "compression" && parent.source === child.source

/** Copies of earlier messages a session starts with after compression. */
const isCopy = (text: string | null | undefined) => text?.startsWith("[PRIOR CONTEXT") === true

interface Db {
  readonly prepare: (sql: string) => { readonly all: (...params: ReadonlyArray<string>) => Array<unknown> }
  readonly close: () => void
}

/** The database, read-only, for the time `use` takes. */
const withDb = <A>(transcript: string, db: string, use: (d: Db) => A) =>
  Effect.tryPromise({
    try: async () => {
      const { DatabaseSync } = await import("node:sqlite")
      const d = new DatabaseSync(db, { readOnly: true, timeout: 5000 }) as unknown as Db
      try {
        return use(d)
      } finally {
        d.close()
      }
    },
    catch: (e) => new HermesError({ transcript, message: e instanceof Error ? e.message : String(e) })
  })

/** The session columns this database has, of those read: older versions of Hermes lack some. */
const sessionColumns = (d: Db): string => {
  const have = new Set(d.prepare("PRAGMA table_info(sessions)").all().map((c) => str(obj(c).name)))
  return Object.keys(SESSION_COLUMNS).filter((c) => have.has(c)).join(", ")
}

const sessionRows = (d: Db, where: string, ...params: ReadonlyArray<string>): Array<HermesSession> =>
  d.prepare(`SELECT ${sessionColumns(d)} FROM sessions${where}`).all(...params).flatMap((r) => Option.toArray(decodeSession(r)))

/** A session and the ones it went on from, oldest first, with their messages. */
export const readHermesSession = Effect.fn("readHermesSession")(function*(transcript: string) {
  const ref = hermesRef(transcript)
  if (ref === undefined) return yield* new HermesError({ transcript, message: "isn't a Hermes session" })
  const chain = yield* withDb(transcript, ref.db, (d) => {
    const sessions: Array<HermesSession> = []
    let id: string | null | undefined = ref.sessionId
    while (id !== undefined && id !== null && sessions.length < 200) {
      const row: HermesSession | undefined = sessionRows(d, " WHERE id = ?", id)[0]
      if (row === undefined || (sessions.length > 0 && !continued(row, sessions[0]))) break
      sessions.unshift(row)
      id = row.parent_session_id
    }
    const read = d.prepare("SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY id")
    return sessions.map((session) => ({ session, messages: read.all(session.id).flatMap((r) => Option.toArray(decodeMessage(r))) }))
  })
  if (chain.length === 0) return yield* new HermesError({ transcript, message: "no such session" })
  return hermesTrace(chain, transcript)
})

/** A session's row: what Hermes counted for it, its cost among them; undefined when it can't be read. */
export const hermesSessionRow = (db: string, sessionId: string) =>
  withDb(hermesTranscript(db, sessionId), db, (d) => sessionRows(d, " WHERE id = ?", sessionId)[0]).pipe(
    Effect.orElseSucceed(() => undefined)
  )

export interface HermesTask {
  /** The session the task ended in, and the transcript that names it. */
  readonly sessionId: string
  readonly transcript: string
  readonly cwd: string
  /** When its first session started and its last was last active, in milliseconds. */
  readonly first: number
  readonly last: number
}

/**
 * The tasks a Hermes database holds, each the last session of its chain:
 * sessions of the user's own, not those Hermes's subagents ran or tools
 * started (source `tool`, as memory's own learning calls are).
 */
export const hermesTasks = Effect.fn("hermesTasks")(function*(db: string) {
  const { rows, lastMessage } = yield* withDb(db, db, (d) => ({
    rows: sessionRows(d, ""),
    lastMessage: new Map(
      d.prepare("SELECT session_id AS id, MAX(timestamp) AS at FROM messages GROUP BY session_id").all()
        .flatMap((r) => (str(obj(r).id) === undefined || typeof obj(r).at !== "number" ? [] : [[obj(r).id as string, obj(r).at as number] as const]))
    )
  }))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const hasChild = new Set(rows.flatMap((r) => {
    const parent = r.parent_session_id === undefined || r.parent_session_id === null ? undefined : byId.get(r.parent_session_id)
    return parent !== undefined && continued(parent, r) ? [parent.id] : []
  }))
  const out: Array<HermesTask> = []
  for (const tip of rows) {
    if (hasChild.has(tip.id) || tip.source === "subagent" || tip.source === "tool") continue
    let root = tip
    for (let i = 0; i < 200; i++) {
      const parent = root.parent_session_id === undefined || root.parent_session_id === null ? undefined : byId.get(root.parent_session_id)
      if (parent === undefined || !continued(parent, root)) break
      root = parent
    }
    const cwd = tip.cwd ?? tip.git_repo_root ?? root.cwd
    const first = root.started_at
    const last = lastMessage.get(tip.id) ?? tip.last_activity_at ?? tip.ended_at ?? tip.started_at
    if (cwd === undefined || cwd === null || first === undefined || first === null || last === undefined || last === null) continue
    out.push({ sessionId: tip.id, transcript: hermesTranscript(db, tip.id), cwd, first: first * 1000, last: last * 1000 })
  }
  return out
})

const sum = (chain: ReadonlyArray<HermesSession>, key: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens") =>
  chain.reduce((acc, s) => acc + Math.trunc(s[key] ?? 0), 0)

/** `/c/Users/a` as `C:/Users/a`, when the session ran on Windows: Hermes's shell writes paths that way. */
const windowsPath = (onWindows: boolean) => (p: unknown): unknown =>
  onWindows && Predicate.isString(p) ? p.replace(/^\/([a-zA-Z])(?=\/)/, (_, d: string) => `${d.toUpperCase()}:`) : p

/** Claude Code's calls for one of Hermes's. */
const translate = (name: string, args: Json, fix: (p: unknown) => unknown): Array<{ readonly name: string; readonly input: Json }> => {
  const path = fix(args.path)
  const at = Predicate.isString(path) ? { file_path: path } : {}
  switch (name) {
    case "terminal":
    case "shell": {
      const command = str(args.command) ?? str(args.cmd)
      return command === undefined ? [] : [{ name: "Bash", input: { command, ...(str(args.workdir) === undefined ? {} : { cwd: fix(args.workdir) }) } }]
    }
    case "read_file":
      return [{ name: "Read", input: { ...at, ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }) } }]
    case "search_files": {
      const within = Predicate.isString(path) ? { path } : {}
      return args.target === "files"
        ? [{ name: "Glob", input: { pattern: args.pattern, ...within } }]
        : [{ name: "Grep", input: { pattern: args.pattern, ...within, ...(str(args.file_glob) === undefined ? {} : { glob: args.file_glob }) } }]
    }
    case "patch":
      if (args.mode === "patch" || (Predicate.isString(args.patch) && args.old_string === undefined)) {
        return patchEdits(str(args.patch) ?? "").map((e) => ({ name: e.tool, input: { ...e.input, file_path: fix(e.file) } }))
      }
      return [{ name: "Edit", input: { ...at, old_string: args.old_string, new_string: args.new_string, ...(args.replace_all === true ? { replace_all: true } : {}) } }]
    case "write_file":
      return [{ name: "Write", input: { ...at, content: args.content } }]
    default:
      return [{ name, input: args }]
  }
}

/** A tool message's text and whether it says the call failed. */
const resultOf = (tool: string | undefined, content: string): { readonly text: string; readonly isError: boolean } => {
  const json = parseJson(content)
  if (!Predicate.isObject(json) || Array.isArray(json)) return { text: content, isError: false }
  const r = json as Json
  if (tool === "terminal" || tool === "shell") {
    const code = r.exit_code
    const text = [str(r.output), str(r.error)].filter((s): s is string => s !== undefined).join("\n")
    return { text, isError: typeof code === "number" && code !== 0 }
  }
  const text = tool === "read_file" && Predicate.isString(r.content) ? r.content : content
  return { text, isError: r.success === false || str(r.error) !== undefined }
}

/**
 * Whether a message sent as the user's is the user's own: Hermes sends its
 * notes that way too, each opening with a bracketed tag (`[System: ...]`,
 * `[Your active task list was preserved across context compression]`,
 * `[IMPORTANT: Background process ... finished]`).
 */
const isTyped = (text: string) => text.trim() !== "" && !/^\[[^\]\n]{2,}\]/.test(text.trimStart())

export const hermesTrace = (
  chain: ReadonlyArray<{ readonly session: HermesSession; readonly messages: ReadonlyArray<HermesMessage> }>,
  path: string
): Trace => {
  const sessions = chain.map((c) => c.session)
  const tip = sessions[sessions.length - 1]
  const cwd = tip.cwd ?? tip.git_repo_root ?? sessions.find((s) => s.cwd)?.cwd ?? undefined
  const fix = windowsPath(cwd !== undefined && /^[A-Za-z]:[\\/]/.test(cwd))
  const prompts: Array<Prompt> = []
  const responses: Array<Response> = []
  const calls = new Map<string, ToolCall>()
  /** The calls each of Hermes's stands for (a patch's edits are several), by its id. */
  const parts = new Map<string, ReadonlyArray<string>>()
  const times: Array<DateTime.Utc> = []
  let skippedLines = 0

  for (const { session, messages } of chain) {
    const started = fromSeconds(session.started_at)
    if (started !== undefined) times.push(started)
    for (const m of messages) {
      const ts = fromSeconds(m.timestamp)
      if (ts !== undefined) times.push(ts)
      const content = m.content ?? ""
      if (m.role === "user") {
        if (isTyped(content) && !prompts.some((p) => p.text === content)) prompts.push({ text: content, timestamp: ts })
      } else if (m.role === "assistant") {
        if (isCopy(content)) continue
        const toolCallIds: Array<string> = []
        const listed = parseJson(m.tool_calls ?? "null")
        if (m.tool_calls !== null && m.tool_calls !== undefined && !Array.isArray(listed)) skippedLines++
        for (const c of Array.isArray(listed) ? listed : []) {
          const id = str(obj(c).id) ?? str(obj(c).call_id)
          const fn = obj(obj(c).function)
          const name = str(fn.name)
          if (id === undefined || name === undefined || parts.has(id)) continue
          const raw = fn.arguments
          const args = obj(Predicate.isString(raw) ? parseJson(raw) : raw)
          const made = translate(name, args, fix)
          parts.set(id, made.map((_, i) => (made.length === 1 ? id : `${id}/${i}`)))
          made.forEach((t, i) => {
            const callId = made.length === 1 ? id : `${id}/${i}`
            calls.set(callId, { id: callId, name: t.name, input: t.input, agentId: undefined, startedAt: ts, finishedAt: undefined, result: undefined, isError: false })
            toolCallIds.push(callId)
          })
        }
        responses.push({
          id: `message-${m.id}`,
          model: session.model ?? "unknown",
          agentId: undefined,
          timestamp: ts,
          usage: emptyUsage,
          text: content,
          toolCallIds,
          stopReason: undefined
        })
      } else if (m.role === "tool" && m.tool_call_id !== undefined && m.tool_call_id !== null) {
        if (content.startsWith("[Duplicate tool output")) continue
        const result = resultOf(m.tool_name ?? undefined, content)
        for (const callId of parts.get(m.tool_call_id) ?? []) {
          const call = calls.get(callId)
          if (call === undefined || call.result !== undefined) continue
          call.result = result.text
          call.isError = result.isError
          call.finishedAt = ts
        }
      }
    }
  }

  if (responses.length > 0) {
    responses[0] = {
      ...responses[0],
      usage: {
        input_tokens: sum(sessions, "input_tokens"),
        output_tokens: sum(sessions, "output_tokens"),
        cache_creation_input_tokens: sum(sessions, "cache_write_tokens"),
        cache_read_input_tokens: sum(sessions, "cache_read_tokens")
      }
    }
  }
  const costs = sessions.map((s) => s.actual_cost_usd ?? s.estimated_cost_usd).filter((c): c is number => typeof c === "number")
  const span = timeSpan(times)
  return {
    sessionId: tip.id,
    path,
    cwd,
    gitBranch: tip.git_branch ?? undefined,
    version: undefined,
    prompts,
    responses,
    toolCalls: [...calls.values()],
    apiErrors: 0,
    costState: costs.length === 0 ? undefined : { totalCostUSD: costs.reduce((a, b) => a + b, 0) },
    startedAt: span.first,
    endedAt: span.last,
    skippedLines
  }
}
