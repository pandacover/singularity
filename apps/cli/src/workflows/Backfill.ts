/**
 * The sessions a repository had before memory was set up, in Claude Code,
 * Codex and Hermes Agent, recorded the way the session-end hook records a
 * session that just ended (HookEnd.ts): those that committed a change while
 * they ran, and whose last test run passed.
 *
 * Claude Code keeps a session's transcript in a directory named after the
 * directory it ran in, every character but letters and digits made a dash
 * (`C:\a\b` is `C--a-b`). Sessions in the repo or below it are found by that
 * name, then confirmed by the `cwd` the transcript records. Codex keeps its
 * sessions by date (`sessions/YYYY/MM/DD/rollout-*.jsonl`), each saying on
 * its first line where it ran; Hermes Agent keeps them in its database
 * (traces/Hermes.ts). A session's commits are those on the current branch
 * made between its first and last event, and a few minutes after, for a
 * commit made as it closed.
 */
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { git } from "../local/Git.ts"
import { hermesTasks } from "../traces/Hermes.ts"
import { recordWorkflowSession, type SessionOutcome } from "./HookEnd.ts"

/** Where the agents whose past sessions memory reads keep their own files; an agent left out isn't read. */
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

/** Minutes after a session's last event that a commit still counts as its own. */
const COMMIT_GRACE_MS = 10 * 60 * 1000

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

const inside = (dir: string, root: string): boolean => {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return n(dir) === n(root) || n(dir).startsWith(`${n(root)}/`)
}

export interface PastSession {
  /** The agent the session ran in. */
  readonly agent: "claude" | "codex" | "hermes"
  readonly sessionId: string
  readonly transcript: string
  readonly cwd: string
  readonly first: number
  readonly last: number
}

/** Claude Code's sessions that ran in `repoRoot` or below it. */
const claudeSessions = Effect.fn("claudeSessions")(function*(repoRoot: string, claudeHomeDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const projects = path.join(claudeHomeDir, "projects")
  if (!(yield* fs.exists(projects).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<PastSession>
  const name = projectDirName(path.resolve(repoRoot)).toLowerCase()
  const dirs = (yield* fs.readDirectory(projects)).filter((d) => d.toLowerCase() === name || d.toLowerCase().startsWith(`${name}-`))
  const out: Array<PastSession> = []
  for (const dir of dirs) {
    const files = yield* fs.readDirectory(path.join(projects, dir)).pipe(Effect.orElseSucceed(() => [] as Array<string>))
    for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
      const transcript = path.join(projects, dir, f)
      const peek = yield* peekTranscript(transcript).pipe(Effect.orElseSucceed((): Peek => ({ cwd: undefined, first: undefined, last: undefined })))
      if (peek.cwd === undefined || peek.first === undefined || peek.last === undefined || !inside(peek.cwd, repoRoot)) continue
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

/** Codex's sessions that ran in `repoRoot` or below it, live and archived. */
const codexSessions = Effect.fn("codexSessions")(function*(repoRoot: string, codexHome: string) {
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
      if (Option.isNone(meta) || !inside(meta.value.payload.cwd, repoRoot)) continue
      const started = Date.parse(meta.value.timestamp)
      const peek = yield* peekTranscript(transcript).pipe(Effect.orElseSucceed((): Peek => ({ cwd: undefined, first: undefined, last: undefined })))
      if (Number.isNaN(started) || peek.last === undefined) continue
      out.push({ agent: "codex", sessionId: meta.value.payload.id, transcript, cwd: meta.value.payload.cwd, first: started, last: peek.last })
    }
  }
  return out
})

/** Hermes Agent's tasks that ran in `repoRoot` or below it. */
const hermesSessions = Effect.fn("hermesSessions")(function*(repoRoot: string, hermesHomeDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const db = path.join(hermesHomeDir, "state.db")
  if (!(yield* fs.exists(db).pipe(Effect.orElseSucceed(() => false)))) return [] as Array<PastSession>
  const tasks = yield* hermesTasks(db).pipe(Effect.orElseSucceed(() => []))
  return tasks.filter((t) => inside(t.cwd, repoRoot)).map((t): PastSession => ({ agent: "hermes", ...t }))
})

/** The transcripts of sessions that ran in `repoRoot` or below it, in every agent given, oldest first. */
export const pastSessions = Effect.fn("pastSessions")(function*(repoRoot: string, homes: AgentHomes) {
  const out: Array<PastSession> = [
    ...(homes.claude === undefined ? [] : yield* claudeSessions(repoRoot, homes.claude)),
    ...(homes.codex === undefined ? [] : yield* codexSessions(repoRoot, homes.codex)),
    ...(homes.hermes === undefined ? [] : yield* hermesSessions(repoRoot, homes.hermes))
  ]
  return out.sort((a, b) => a.first - b.first)
})

export interface Commit {
  readonly hash: string
  readonly parent: string | undefined
  /** Committer time, in milliseconds. */
  readonly time: number
}

/** The current branch's commits along first parents, newest first. */
export const branchCommits = Effect.fn("branchCommits")(function*(repoRoot: string) {
  const out = yield* git(repoRoot, ["log", "--first-parent", "--format=%H %P %ct", "HEAD"]).pipe(Effect.orElseSucceed(() => ""))
  return out.split(/\r?\n/).flatMap((line): Array<Commit> => {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) return []
    const time = Number(parts[parts.length - 1]) * 1000
    return Number.isFinite(time) ? [{ hash: parts[0], parent: parts.length > 2 ? parts[1] : undefined, time }] : []
  })
})

/** The commits a session made: its base (the parent of its first) and its last; undefined if it made none. */
export const sessionRange = (commits: ReadonlyArray<Commit>, first: number, last: number): { readonly base: string; readonly head: string } | undefined => {
  const made = commits.filter((c) => c.time >= first && c.time <= last + COMMIT_GRACE_MS)
  if (made.length === 0) return undefined
  const oldest = made[made.length - 1]
  if (oldest.parent === undefined) return undefined
  return { base: oldest.parent, head: made[0].hash }
}

export interface BackfillResult {
  readonly sessions: number
  readonly recorded: ReadonlyArray<string>
  /** How many sessions each reason left out ("nothing was committed", "the last test run failed", ...). */
  readonly skipped: ReadonlyMap<string, number>
}

/** Record a repo's past sessions; ones recorded before are counted as recorded. */
export const backfill = Effect.fn("backfill")(function*(
  repoRoot: string,
  homes: AgentHomes,
  tenantDir: string,
  onSession?: (done: number, total: number) => Effect.Effect<void>
) {
  const sessions = yield* pastSessions(repoRoot, homes)
  const commits = yield* branchCommits(repoRoot)
  const recorded: Array<string> = []
  const skipped = new Map<string, number>()
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
  for (const [i, s] of sessions.entries()) {
    if (onSession !== undefined) yield* onSession(i, sessions.length)
    const range = sessionRange(commits, s.first, s.last)
    if (range === undefined) {
      skip("nothing was committed")
      continue
    }
    const outcome: SessionOutcome = yield* recordWorkflowSession({ sessionId: s.sessionId, transcript: s.transcript, cwd: s.cwd, range }, tenantDir).pipe(
      Effect.orElseSucceed((): SessionOutcome => ({ record: undefined, reason: "its transcript couldn't be read" }))
    )
    if (outcome.record !== undefined) recorded.push(outcome.record)
    else skip(outcome.reason)
  }
  return { sessions: sessions.length, recorded, skipped } satisfies BackfillResult
})
