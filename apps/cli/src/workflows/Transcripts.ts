/**
 * Where agents keep their sessions' logs, and which sessions ran in a
 * repository: Claude Code's, Codex's and Hermes Agent's, past and present.
 * Memory stores the changes they committed from these logs (Commits.ts),
 * whether a session committed a moment ago or before memory was set up.
 *
 * Claude Code keeps a session's transcript in a directory named after the
 * directory it ran in, every character but letters and digits made a dash
 * (`C:\a\b` is `C--a-b`). Sessions in a checkout or below it are found by
 * that name, then confirmed by the `cwd` the transcript records. Codex keeps
 * its sessions by date (`sessions/YYYY/MM/DD/rollout-*.jsonl`), each saying
 * on its first line where it ran; Hermes Agent keeps them in its database
 * (traces/Hermes.ts). A repo checked out in several places (git worktrees)
 * has the sessions of all of them.
 */
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { hermesTasks } from "../traces/Hermes.ts"

/** Where the agents whose sessions memory reads keep their own files; an agent left out isn't read. */
export interface AgentHomes {
  /** Claude Code's configuration directory. */
  readonly claude?: string | undefined
  /** Codex's home (`CODEX_HOME`, or `~/.codex`). */
  readonly codex?: string | undefined
  /** Hermes Agent's home, which holds its `state.db`. */
  readonly hermes?: string | undefined
}

/** Claude Code's name for a project directory. */
export const projectDirName = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, "-")

/** How much of a transcript's start and end is read to find where and when it ran. */
const PEEK_BYTES = 64 * 1024

const Line = Schema.fromJsonString(Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String)
}))
const decodeLine = Schema.decodeUnknownOption(Line)

/** The complete lines of a chunk cut out of a file: the first and last may be partial. */
const linesOf = (chunk: string, fromStart: boolean): Array<string> => {
  const lines = chunk.split(/\r?\n/)
  return fromStart ? lines.slice(0, -1) : lines.slice(1)
}

export interface Peek {
  readonly cwd: string | undefined
  readonly first: number | undefined
  readonly last: number | undefined
}

const nothingSeen: Peek = { cwd: undefined, first: undefined, last: undefined }

/** Where a session ran and when it started and ended, from its transcript's first and last lines. */
export const peekTranscript = Effect.fn("peekTranscript")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const size = Number((yield* fs.stat(file)).size)
  const read = (offset: number) =>
    fs.stream(file, { offset, bytesToRead: PEEK_BYTES }).pipe(Stream.decodeText(), Stream.mkString)
  const whole = size <= PEEK_BYTES
  const head = yield* read(0)
  const headLines = whole ? head.split(/\r?\n/) : linesOf(head, true)
  const tailLines = whole ? headLines : linesOf(yield* read(size - PEEK_BYTES), false)
  const decoded = (lines: ReadonlyArray<string>) => lines.flatMap((l) => Option.toArray(decodeLine(l)))
  const time = (t: string | undefined) => (t === undefined || Number.isNaN(Date.parse(t)) ? undefined : Date.parse(t))
  const fromHead = decoded(headLines)
  const fromTail = decoded(tailLines)
  return {
    cwd: fromHead.find((l) => l.cwd !== undefined)?.cwd,
    first: fromHead.map((l) => time(l.timestamp)).find((t) => t !== undefined),
    last: fromTail.map((l) => time(l.timestamp)).filter((t) => t !== undefined).at(-1)
  } satisfies Peek
})

/** A path as Windows and git both print it, for comparing: forward slashes, no trailing one, lower case. */
export const pathKey = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/** Whether `dir` is `root` or inside it. */
export const inside = (dir: string, root: string): boolean => {
  const d = pathKey(dir)
  const r = pathKey(root)
  return d === r || d.startsWith(`${r}/`)
}

const insideAny = (dir: string, roots: ReadonlyArray<string>): boolean => roots.some((r) => inside(dir, r))

export interface PastSession {
  /** The agent the session ran in. */
  readonly agent: "claude" | "codex" | "hermes"
  readonly sessionId: string
  readonly transcript: string
  readonly cwd: string
  readonly first: number
  readonly last: number
}

/** Claude Code's sessions that ran in one of `roots` or below. */
const claudeSessions = Effect.fn("claudeSessions")(function*(roots: ReadonlyArray<string>, claudeHomeDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const projects = path.join(claudeHomeDir, "projects")
  if (!(yield* fs.exists(projects).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<PastSession>
  const names = roots.map((r) => projectDirName(path.resolve(r)).toLowerCase())
  const dirs = (yield* fs.readDirectory(projects)).filter((d) => names.some((n) => d.toLowerCase() === n || d.toLowerCase().startsWith(`${n}-`)))
  const out: Array<PastSession> = []
  for (const dir of dirs) {
    const files = yield* fs.readDirectory(path.join(projects, dir)).pipe(Effect.orElseSucceed(() => [] as Array<string>))
    for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
      const transcript = path.join(projects, dir, f)
      const peek = yield* peekTranscript(transcript).pipe(Effect.orElseSucceed(() => nothingSeen))
      if (peek.cwd === undefined || peek.first === undefined || peek.last === undefined || !insideAny(peek.cwd, roots)) continue
      out.push({ agent: "claude", sessionId: f.replace(/\.jsonl$/, ""), transcript, cwd: peek.cwd, first: peek.first, last: peek.last })
    }
  }
  return out
})

/** A Codex rollout's first line: the session's id, where it ran and when it started. */
const CodexMeta = Schema.fromJsonString(Schema.Struct({
  timestamp: Schema.String,
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({ id: Schema.String, cwd: Schema.String })
}))
const decodeCodexMeta = Schema.decodeUnknownOption(CodexMeta)

/** Codex's sessions that ran in one of `roots` or below, live and archived. */
const codexSessions = Effect.fn("codexSessions")(function*(roots: ReadonlyArray<string>, codexHome: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const out: Array<PastSession> = []
  for (const dir of ["sessions", "archived_sessions"].map((d) => path.join(codexHome, d))) {
    if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) continue
    const files = yield* fs.readDirectory(dir, { recursive: true }).pipe(Effect.orElseSucceed(() => [] as Array<string>))
    for (const f of files.filter((f) => /^rollout-.*\.jsonl$/.test(path.basename(f)))) {
      const transcript = path.join(dir, f)
      // The first line holds Codex's instructions too: tens of kilobytes, read whole.
      const first = yield* fs.stream(transcript).pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead, Effect.orElseSucceed(() => Option.none<string>()))
      const meta = Option.flatMap(first, (line) => decodeCodexMeta(line))
      if (Option.isNone(meta) || !insideAny(meta.value.payload.cwd, roots)) continue
      const started = Date.parse(meta.value.timestamp)
      const peek = yield* peekTranscript(transcript).pipe(Effect.orElseSucceed(() => nothingSeen))
      if (Number.isNaN(started) || peek.last === undefined) continue
      out.push({ agent: "codex", sessionId: meta.value.payload.id, transcript, cwd: meta.value.payload.cwd, first: started, last: peek.last })
    }
  }
  return out
})

/** Hermes Agent's tasks that ran in one of `roots` or below. */
const hermesSessions = Effect.fn("hermesSessions")(function*(roots: ReadonlyArray<string>, hermesHomeDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const db = path.join(hermesHomeDir, "state.db")
  if (!(yield* fs.exists(db).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<PastSession>
  const tasks = yield* hermesTasks(db).pipe(Effect.orElseSucceed(() => []))
  return tasks.filter((t) => insideAny(t.cwd, roots)).map((t): PastSession => ({ agent: "hermes", ...t }))
})

/** The sessions that ran in a repo's checkouts (`roots`) or below them, in every agent given, oldest first. */
export const pastSessions = Effect.fn("pastSessions")(function*(roots: string | ReadonlyArray<string>, homes: AgentHomes) {
  const all = typeof roots === "string" ? [roots] : roots
  const out: Array<PastSession> = [
    ...(homes.claude === undefined ? [] : yield* claudeSessions(all, homes.claude)),
    ...(homes.codex === undefined ? [] : yield* codexSessions(all, homes.codex)),
    ...(homes.hermes === undefined ? [] : yield* hermesSessions(all, homes.hermes))
  ]
  return out.sort((a, b) => a.first - b.first)
})
