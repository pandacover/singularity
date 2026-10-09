/**
 * Memory stores a change when it lands: one record per commit (or per
 * command, when one command made several), holding the prompts and steps of
 * the session that made it since that session's own previous commit, kept
 * when the last check before the commit passed (tests, a typecheck, a build
 * or a lint). A change to docs alone needs no check: nothing runs them.
 *
 * One step, run at every moment memory gets: right after an agent commits
 * (the tool-call hook starts it), and as a sweep at task start and at session
 * end for commits the trigger missed, such as one made in an editor after the
 * session; `learn --past` runs it over every session still on disk. Whichever
 * moment finds a commit stores it once (its record's id is the commit's), and
 * a commit looked at and left out is logged once with the reason
 * (`<tenant dir>/skipped.jsonl`), so status can say what memory missed and why.
 *
 * The session a commit belongs to:
 * - made: one of its shell commands that can make a commit was running when
 *   the commit was made (by the commit's time);
 * - written: no agent was committing then (an editor, a terminal), and exactly
 *   one session's edits since its own last commit, within a day, are among
 *   the lines the commit adds.
 * A commit that is no session's is someone's own work, not memory's. So are
 * commits by another author than the repo's own (`user.email`): a teammate's.
 * Copies of a commit (a branch whose history was written again with the same
 * times, a cherry-pick) are one change, stored once.
 */
import { DateTime, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { git, identifyRepo } from "../local/Git.ts"
import { buildRecord, commitRecordId, recordId } from "../records/Build.ts"
import { extractMechanical, relativizer } from "../records/Extract.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { classifyKey } from "../records/Shell.ts"
import { eventOfCall } from "../records/Triggers.ts"
import {
  EDIT_TOOLS,
  parseSession,
  SHELL_TOOLS,
  SHELL_WRITE,
  sliceTrace,
  type ToolCall,
  type Trace,
  type TraceWindow,
  traceUsage,
  usageTotal
} from "../traces/index.ts"
import { gatherEvidence } from "./Evidence.ts"
import { feedbackOf } from "./Feedback.ts"
import { isReadPlace } from "./Models.ts"
import { readFired, readSession } from "./Session.ts"
import { COMMITTING } from "./StoreTrigger.ts"
import { type AgentHomes, inside, pastSessions, type PastSession, pathKey, peekTranscript } from "./Transcripts.ts"
import { WorkflowStore } from "./WorkflowStore.ts"

/** A commit on one of the repo's branches. */
export interface BranchCommit {
  readonly hash: string
  readonly parent: string | undefined
  /** Committer time, epoch milliseconds (git keeps whole seconds). */
  readonly time: number
  /** Author time: older than the committer time when a rebase, an amend or a cherry-pick wrote the commit again. */
  readonly authored: number
  readonly email: string
  /** The first line of its message. */
  readonly title: string
  /** Its files, from the repo's top directory. */
  readonly files: ReadonlyArray<string>
}

/** The session a hook knows: the one that ran the command, or whose task started or ended. */
export interface KnownSession {
  readonly sessionId: string
  readonly transcript: string
}

export interface StoreOptions {
  /** Commits made after this (epoch ms); else every commit since the oldest session found. */
  readonly since?: number | undefined
  /** The hook's session: its commits are looked at even when a sweep left them out before. */
  readonly session?: KnownSession | undefined
  /** Look again at every commit left out before (`learn --past`, after memory learned to read more). */
  readonly again?: boolean | undefined
}

export interface StoreResult {
  readonly subject: string | undefined
  /** Sessions found in the repo's checkouts. */
  readonly sessions: number
  /** Commits looked at. */
  readonly examined: number
  readonly stored: ReadonlyArray<string>
  /** Records there already, of commits looked at again. */
  readonly existing: ReadonlyArray<string>
  /** Commits left out, by reason. */
  readonly skipped: ReadonlyMap<string, number>
}

/** Commits left out that memory didn't miss: someone's own work, and changes stored under another commit. */
export const NOT_FROM_A_SESSION = "no session made it or wrote it"
export const A_COPY = "a copy of another commit"
export const MADE_TOGETHER = "stored with the other commits its command made"

/** Whether a reason for leaving a commit out says memory missed a change of a session's. */
export const isMiss = (reason: string): boolean => reason !== NOT_FROM_A_SESSION && reason !== A_COPY && reason !== MADE_TOGETHER

/** How long before a commit a session's edits still count as what it holds, when the session didn't commit them itself. */
const WRITTEN_WITHIN_MS = 24 * 3600 * 1000
/** Commit times are whole seconds, and a call's logged times are close to its start and end. */
const SLACK_MS = 2000
/** A call with no logged end and nothing after it (still running, or cut short) ran for at most this long. */
const OPEN_CALL_MS = 30 * 60 * 1000
/** Shorter lines match by chance too easily to say whose an edit was. */
const MIN_LINE = 10
/** A commit whose author time is this much older than its committer time rewrites an earlier one. */
const REWRITTEN_MS = 60_000
/** What counts as a check of a change. */
const CHECKS = new Set(["test", "typecheck", "lint", "build"])
/** Documentation: a change to these alone needs no check. */
const DOCS = /(^|\/)(readme|license|licence|changelog|notice|authors|contributing|copying)$|\.(md|mdx|markdown|txt|rst|adoc)$/i

export const isDocs = (file: string): boolean => DOCS.test(file)

// --- the log of commits left out ---

export const Skip = Schema.Struct({
  at: Schema.String,
  subject: Schema.String,
  commit: Schema.String,
  session: Schema.NullOr(Schema.String),
  reason: Schema.String
})
export type Skip = typeof Skip.Type

const decodeSkip = Schema.decodeUnknownOption(Schema.fromJsonString(Skip))

export const skipsFile = (tenantDir: string, path: Path.Path): string => path.join(tenantDir, "skipped.jsonl")

/** Every commit left out, oldest first; a commit looked at again has a line each time its reason changed. */
export const readSkips = Effect.fn("readSkips")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(skipsFile(tenantDir, path)).pipe(Effect.orElseSucceed(() => ""))
  return text.split(/\r?\n/).flatMap((l) => Option.toArray(decodeSkip(l)))
})

const logSkip = Effect.fn("logSkip")(function*(tenantDir: string, skip: Skip) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(tenantDir, { recursive: true })
  yield* fs.writeFileString(skipsFile(tenantDir, path), JSON.stringify(skip) + "\n", { flag: "a" })
})

// --- the repo ---

/** Where a repo is checked out: its worktrees, the main one first, then paths memory saw it at that git no longer lists. */
export const checkoutsOf = Effect.fn("checkoutsOf")(function*(root: string, known: ReadonlyArray<string>) {
  const out = yield* git(root, ["worktree", "list", "--porcelain"]).pipe(Effect.orElseSucceed(() => ""))
  const listed = out.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length).trim())
  const all: Array<string> = []
  for (const p of [...listed, root, ...known]) if (!all.some((q) => pathKey(q) === pathKey(p))) all.push(p)
  return all
})

const isoOf = (t: number): string => new Date(t).toISOString()

/** Commits on the repo's branches (and HEAD), merges aside, made after `since`, newest first. */
export const branchCommits = Effect.fn("branchCommits")(function*(root: string, since: number | undefined) {
  const args = ["log", "--branches", "HEAD", "--no-merges", "--name-only", "--format=%x1e%H %P%x1f%ct%x1f%at%x1f%ae%x1f%s"]
  if (since !== undefined) args.push(`--since=${isoOf(since)}`)
  const out = yield* git(root, args).pipe(Effect.orElseSucceed(() => ""))
  return out.split("\x1e").flatMap((chunk): Array<BranchCommit> => {
    const [head, ...files] = chunk.split(/\r?\n/)
    const [hashes, ct, at, email, title] = head.split("\x1f")
    const [hash, parent] = (hashes ?? "").trim().split(/\s+/)
    const time = Number(ct) * 1000
    if (hash === undefined || hash === "" || !Number.isFinite(time)) return []
    return [{
      hash,
      parent: parent === "" ? undefined : parent,
      time,
      authored: Number.isFinite(Number(at)) ? Number(at) * 1000 : time,
      email: (email ?? "").trim(),
      title: (title ?? "").trim(),
      files: files.map((f) => f.trim()).filter((f) => f !== "")
    }]
  })
})

/** The lines a commit adds, trimmed. */
const addedLines = Effect.fn("addedLines")(function*(root: string, hash: string) {
  const out = yield* git(root, ["show", "--format=", "--no-color", "--no-ext-diff", "-U0", hash]).pipe(Effect.orElseSucceed(() => ""))
  return new Set(out.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim()).filter((l) => l.length >= MIN_LINE))
})

/**
 * `commits` as runs of commits each the parent of the next, oldest first: one
 * run when they follow one another, several when they sit on different
 * branches (a run ends where the commits branch).
 */
export const chainsOf = <C extends { readonly hash: string; readonly parent: string | undefined }>(commits: ReadonlyArray<C>): Array<Array<C>> => {
  const hashes = new Set(commits.map((c) => c.hash))
  const children = (c: C) => commits.filter((x) => x.parent === c.hash)
  const starts = commits.filter((c) => c.parent === undefined || !hashes.has(c.parent) || commits.filter((x) => x.parent === c.parent).length > 1)
  return starts.map((start) => {
    const chain = [start]
    for (let next = children(start); next.length === 1; next = children(next[0])) chain.push(next[0])
    return chain
  })
}

// --- what a session did ---

interface Shell {
  readonly call: ToolCall
  readonly start: number
  readonly end: number
  readonly committing: boolean
}

interface EditStep {
  readonly start: number
  /** From the checkout's top directory. */
  readonly file: string
  readonly lines: ReadonlyArray<string>
}

interface Facts {
  readonly session: PastSession
  readonly trace: Trace
  readonly shells: ReadonlyArray<Shell>
  readonly edits: ReadonlyArray<EditStep>
}

const millis = (t: DateTime.Utc | undefined): number | undefined => (t === undefined ? undefined : DateTime.toEpochMillis(t))
const str = (v: unknown): string | undefined => (Predicate.isString(v) ? v : undefined)

/** The text an edit writes: an edit's new strings, a written file's content. */
const editText = (call: ToolCall): string => {
  const edits = call.input.edits
  const many = Array.isArray(edits) ? edits.map((e) => (Predicate.isObject(e) ? str((e as Record<string, unknown>).new_string) ?? "" : "")) : []
  return [str(call.input.new_string), str(call.input.content), str(call.input.new_source), ...many].filter((s) => s !== undefined).join("\n")
}

const factsOf = (session: PastSession, trace: Trace, checkouts: ReadonlyArray<string>, path: Path.Path): Facts => {
  const cwd = trace.cwd ?? session.cwd
  const checkout = checkouts.filter((c) => inside(cwd, c)).sort((a, b) => b.length - a.length)[0] ?? cwd
  const relative = relativizer(checkout)
  const times = [...trace.toolCalls.map((c) => millis(c.startedAt)), ...trace.responses.map((r) => millis(r.timestamp))]
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b)
  const shells: Array<Shell> = []
  const edits: Array<EditStep> = []
  for (const call of trace.toolCalls) {
    const start = millis(call.startedAt)
    if (start === undefined) continue
    if (SHELL_TOOLS.has(call.name)) {
      const command = str(call.input.command) ?? ""
      const next = times.find((t) => t > start)
      shells.push({ call, start, end: millis(call.finishedAt) ?? next ?? start + OPEN_CALL_MS, committing: COMMITTING.test(command) })
    } else if (EDIT_TOOLS.has(call.name)) {
      const raw = str(call.input.file_path) ?? str(call.input.notebook_path)
      if (raw === undefined) continue
      const file = relative(path.isAbsolute(raw) ? raw : path.join(cwd, raw))
      edits.push({ start, file, lines: editText(call).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= MIN_LINE) })
    }
  }
  return { session, trace, shells, edits }
}

/** The session's command that was committing when a commit was made at `time`, if any. */
const committingAt = (f: Facts, time: number): Shell | undefined =>
  f.shells.filter((s) => s.committing && time >= s.start - SLACK_MS && time <= s.end + SLACK_MS).at(-1)

// --- storing ---

type Found =
  | { readonly kind: "made"; readonly facts: Facts; readonly shell: Shell }
  | { readonly kind: "written"; readonly facts: Facts }
  | { readonly kind: "none"; readonly reason: string }

/** One change to store: a commit, or the commits one command made, one after the other. */
interface Change {
  readonly commits: ReadonlyArray<BranchCommit>
  readonly found: Exclude<Found, { readonly kind: "none" }>
}

/** Store the commits on a repo's branches that memory hasn't looked at yet, each with the session it came from. */
export const storeCommits = Effect.fn("storeCommits")(function*(cwd: string, homes: AgentHomes, tenantDir: string, options: StoreOptions = {}) {
  const store = yield* RecordStore
  const path = yield* Path.Path
  const nothing = (subject?: string, sessions = 0): StoreResult => ({ subject, sessions, examined: 0, stored: [], existing: [], skipped: new Map() })
  const repo = yield* identifyRepo(cwd)
  if (repo === undefined || repo.head === undefined) return nothing()
  const subject = yield* store.subjectFor(repo, { create: true })
  if (subject === undefined) return nothing()
  const email = (yield* git(repo.root, ["config", "user.email"]).pipe(Effect.orElseSucceed(() => ""))).trim().toLowerCase()
  const ownCommits = (from: number | undefined) =>
    branchCommits(repo.root, from).pipe(Effect.map((cs) => cs.filter((c) => email === "" || c.email.toLowerCase() === email)))

  // The latest reason each commit was left out for; the hook's own session looks again at those it may be the answer to.
  const before = new Map((yield* readSkips(tenantDir)).filter((s) => s.subject === subject.id).map((s) => [s.commit, s.reason] as const))
  const unsure = (reason: string | undefined) => reason === NOT_FROM_A_SESSION || reason?.startsWith("more than one session") === true
  const known = options.session
  const fresh = Effect.fnUntraced(function*(c: BranchCommit, mayBeOurs: boolean) {
    if (yield* store.has(commitRecordId(subject.id, c.hash))) return false
    return !before.has(c.hash) || options.again === true || (mayBeOurs && unsure(before.get(c.hash)))
  })
  // Most sweeps find nothing new: one git call says so, before any session's log is read.
  if (options.since !== undefined) {
    let any = false
    for (const c of yield* ownCommits(options.since)) if (c.time >= options.since && (yield* fresh(c, known !== undefined))) any = true
    if (!any) return nothing(subject.id)
  }
  const checkouts = yield* checkoutsOf(repo.root, subject.paths)

  // The sessions of every checkout, and the hook's own wherever it ran, still running now.
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
  const sessions = (yield* pastSessions(checkouts, homes)).map((s) => (s.sessionId === known?.sessionId ? { ...s, last: Math.max(s.last, nowMs) } : s))
  if (known !== undefined && !sessions.some((s) => s.sessionId === known.sessionId)) {
    const peek = yield* peekTranscript(known.transcript).pipe(Effect.option, Effect.map(Option.getOrUndefined))
    if (peek?.cwd !== undefined && peek.first !== undefined) {
      const agent = /rollout-[^/\\]*\.jsonl$/.test(known.transcript) ? "codex" : "claude"
      sessions.push({ agent, sessionId: known.sessionId, transcript: known.transcript, cwd: peek.cwd, first: peek.first, last: nowMs })
    }
  }
  if (sessions.length === 0) return nothing(subject.id)

  // Commits since `since`, and since the start of any session still running then, for its earlier commits.
  const since = options.since ?? Math.min(...sessions.map((s) => s.first))
  const listFrom = Math.min(since, ...sessions.filter((s) => s.last >= since).map((s) => s.first)) - 60_000
  const commits = yield* ownCommits(listFrom)
  const knownSpan = known === undefined ? undefined : sessions.find((s) => s.sessionId === known.sessionId)
  const todo: Array<BranchCommit> = []
  const existing: Array<string> = []
  for (const c of [...commits].reverse()) {
    if (c.time < since) continue
    const id = commitRecordId(subject.id, c.hash)
    if (options.again === true && (yield* store.has(id))) existing.push(id)
    if (yield* fresh(c, knownSpan !== undefined && c.time >= knownSpan.first - SLACK_MS)) todo.push(c)
  }
  if (todo.length === 0) return { ...nothing(subject.id, sessions.length), existing }

  // Copies of one commit (same author, author time and title) are one change: the one stored, else the one HEAD has.
  const onHead = new Set(
    (yield* git(repo.root, ["rev-list", "HEAD", `--since=${isoOf(listFrom)}`]).pipe(Effect.orElseSucceed(() => ""))).split(/\r?\n/).map((l) => l.trim())
  )
  const copies = new Map<string, Array<BranchCommit>>()
  for (const c of commits) {
    const key = `${c.email.toLowerCase()}\u0000${c.authored}\u0000${c.title}`
    copies.set(key, [...(copies.get(key) ?? []), c])
  }
  const copyOf = new Map<string, string>()
  for (const group of copies.values()) {
    if (group.length < 2) continue
    const stored: Array<BranchCommit> = []
    for (const c of group) if (yield* store.has(commitRecordId(subject.id, c.hash))) stored.push(c)
    const kept = stored[0] ?? group.find((c) => onHead.has(c.hash)) ?? [...group].sort((a, b) => a.hash.localeCompare(b.hash))[0]
    for (const c of group) if (c.hash !== kept.hash) copyOf.set(c.hash, kept.hash)
  }

  // Logs are read once, and only those of sessions that could have made or written a commit to look at.
  const facts = new Map<string, Facts | undefined>()
  const factsFor = Effect.fnUntraced(function*(s: PastSession) {
    if (!facts.has(s.transcript)) {
      const trace = yield* parseSession(s.transcript).pipe(Effect.option, Effect.map(Option.getOrUndefined))
      facts.set(s.transcript, trace === undefined ? undefined : factsOf(s, trace, checkouts, path))
    }
    return facts.get(s.transcript)
  })
  /** When the session's own commits before `time` were made: its last one's command start, or undefined. */
  const lastCommitBefore = (f: Facts, time: number): number | undefined =>
    commits.filter((c) => c.time < time).map((c) => committingAt(f, c.time)?.start).filter((t): t is number => t !== undefined && t < time).sort((a, b) => b - a)[0]

  const find = Effect.fnUntraced(function*(c: BranchCommit) {
    // Made by a session's command.
    const made: Array<{ readonly facts: Facts; readonly shell: Shell }> = []
    for (const s of sessions.filter((s) => c.time >= s.first - 60_000 && c.time <= s.last + 5 * 60_000)) {
      const f = yield* factsFor(s)
      const shell = f === undefined ? undefined : committingAt(f, c.time)
      if (f !== undefined && shell !== undefined) made.push({ facts: f, shell })
    }
    if (made.length > 1) {
      const naming = made.filter((m) => /\bcommit\b/i.test(str(m.shell.call.input.command) ?? ""))
      if (naming.length !== 1) return { kind: "none", reason: "more than one session was committing when it was made" } satisfies Found
      return { kind: "made", ...naming[0] } satisfies Found
    }
    if (made.length === 1) return { kind: "made", ...made[0] } satisfies Found
    // Written by a session, committed outside it.
    const added = yield* addedLines(repo.root, c.hash)
    const files = new Set(c.files.map((f) => f.toLowerCase()))
    const wrote: Array<Facts> = []
    for (const s of sessions.filter((s) => s.first <= c.time && s.last >= c.time - WRITTEN_WITHIN_MS)) {
      const f = yield* factsFor(s)
      if (f === undefined) continue
      const from = lastCommitBefore(f, c.time)
      const mine = f.edits.filter((e) => e.start < c.time && (from === undefined || e.start > from) && files.has(e.file.toLowerCase()))
      if (mine.some((e) => e.lines.some((l) => added.has(l)))) wrote.push(f)
    }
    if (wrote.length > 1) return { kind: "none", reason: "more than one session wrote what it adds" } satisfies Found
    if (wrote.length === 1) return { kind: "written", facts: wrote[0] } satisfies Found
    return { kind: "none", reason: NOT_FROM_A_SESSION } satisfies Found
  })

  const stored: Array<string> = []
  const skipped = new Map<string, number>()
  const now = DateTime.formatIso(yield* DateTime.now)
  const leaveOut = Effect.fnUntraced(function*(c: BranchCommit, reason: string, session: string | null) {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
    if (before.get(c.hash) !== reason) yield* logSkip(tenantDir, { at: now, subject: subject.id, commit: c.hash, session, reason })
  })

  // Which session each commit is from; the commits one command made, one after the other, are one change.
  const changes: Array<Change> = []
  const byCommand = new Map<string, Array<{ readonly commit: BranchCommit; readonly found: Change["found"] }>>()
  for (const c of todo) {
    if (copyOf.has(c.hash)) {
      yield* leaveOut(c, A_COPY, null)
      continue
    }
    const found: Found = yield* find(c)
    if (found.kind === "none") yield* leaveOut(c, found.reason, null)
    else if (found.kind === "written") changes.push({ commits: [c], found })
    else {
      const key = `${found.facts.session.transcript}\u0000${found.shell.start}`
      byCommand.set(key, [...(byCommand.get(key) ?? []), { commit: c, found }])
    }
  }
  for (const group of byCommand.values()) for (const chain of chainsOf(group.map((g) => g.commit))) changes.push({ commits: chain, found: group[0].found })

  const ctx: RecordContext = { subject: subject.id, tenant: store.tenant, repo: checkouts[0], root: repo.root, tenantDir, createdAt: now, lastCommitBefore }
  for (const change of changes) {
    const outcome = yield* recordOf(change, ctx)
    if ("reason" in outcome) {
      for (const c of change.commits) yield* leaveOut(c, outcome.reason, change.found.facts.trace.sessionId)
      continue
    }
    const put = yield* store.put(outcome.record).pipe(
      Effect.as(true),
      Effect.catchTag("RecordExists", () => Effect.succeed(false))
    )
    if (put) stored.push(outcome.record.id)
    else existing.push(outcome.record.id)
    for (const c of change.commits.slice(0, -1)) yield* leaveOut(c, MADE_TOGETHER, change.found.facts.trace.sessionId)
  }
  return { subject: subject.id, sessions: sessions.length, examined: todo.length, stored, existing, skipped } satisfies StoreResult
})

interface RecordContext {
  readonly subject: string
  readonly tenant: string
  /** A checkout that stays (the main worktree): where the record's commits are read later. */
  readonly repo: string
  readonly root: string
  readonly tenantDir: string
  readonly createdAt: string
  readonly lastCommitBefore: (f: Facts, time: number) => number | undefined
}

/** A change's record, or why it has none. */
const recordOf = Effect.fnUntraced(function*(change: Change, ctx: RecordContext) {
  const store = yield* RecordStore
  const { found } = change
  const first = change.commits[0]
  const head = change.commits[change.commits.length - 1]
  const f = found.facts
  const skip = (reason: string) => ({ reason })
  if (first.parent === undefined) return skip("it is the repo's first commit")
  if (change.commits.some((c) => c.authored < c.time - REWRITTEN_MS)) return skip("it rewrites an earlier commit (a rebase, an amend or a cherry-pick)")
  // A session recorded whole, before memory stored commits one by one, keeps its record.
  if (yield* store.has(recordId(ctx.subject, f.trace.sessionId))) return skip("stored before with its whole session")

  const to = found.kind === "made" ? found.shell.start : head.time - 1
  const window: TraceWindow = { from: ctx.lastCommitBefore(f, found.kind === "made" ? found.shell.start : head.time), to }
  const part = sliceTrace(f.trace, window)
  if (found.kind === "made") {
    const files = new Set(change.commits.flatMap((c) => c.files).map((x) => x.toLowerCase()))
    const edited = f.edits.some((e) => e.start <= to && (window.from === undefined || e.start > window.from) && files.has(e.file.toLowerCase()))
    const scripted = part.toolCalls.some((call) => SHELL_TOOLS.has(call.name) && SHELL_WRITE.test(str(call.input.command) ?? ""))
    if (!edited && !scripted) return skip("its session's steps changed none of its files")
  }
  const m = extractMechanical(part, "", { succeeded: true })
  const last = m.commands.filter((x) => x.keys.some((k) => CHECKS.has(classifyKey(k)))).at(-1)
  if (!change.commits.every((c) => c.files.length > 0 && c.files.every(isDocs))) {
    if (last === undefined) return skip("no check was run before it")
    if (!last.ok) return skip("the last check before it failed")
  }

  const diff = yield* git(ctx.root, ["diff", "--binary", first.parent, head.hash]).pipe(Effect.map((s) => s.replace(/\r\n?/g, "\n")))
  const record = buildRecord({
    id: commitRecordId(ctx.subject, head.hash),
    tenant: ctx.tenant,
    subject: ctx.subject,
    trace: part,
    diff,
    outcome: "success",
    checks: last === undefined || !last.ok ? [] : [{ command: last.command, ok: true, exit_code: 0 }],
    memory: null,
    run: {
      source: "session",
      log: f.session.transcript,
      run_dir: null,
      run_id: null,
      setup: null,
      task_id: null,
      repo: ctx.repo,
      base_commit: first.parent,
      head_commit: head.hash,
      segment: { from: window.from === undefined ? null : isoOf(window.from), to: isoOf(window.to) },
      started_at: part.startedAt === undefined ? null : DateTime.formatIso(part.startedAt),
      cost_usd: null,
      tokens: usageTotal(traceUsage(part))
    },
    createdAt: ctx.createdAt
  })
  // The memory handed over at the session's start goes with its first change.
  const memory = window.from === undefined ? yield* feedbackFor(record, part, ctx) : null
  return { record: { ...record, memory } }
})

/** What became of the memory the session was handed at its start, judged by its first change. */
const feedbackFor = Effect.fnUntraced(function*(record: WorkflowRecord, part: Trace, ctx: RecordContext) {
  const state = yield* readSession(ctx.tenantDir, part.sessionId)
  if (state === undefined) return null
  const evidence = yield* gatherEvidence([record], { repo: ctx.repo })
  const edited = new Map((evidence.runs[0]?.uses ?? []).map((u) => [u.place, u.file] as const))
  const handed = yield* (yield* WorkflowStore).memory(state.version).pipe(Effect.orElseSucceed(() => undefined))
  const placesOf = (wid: string) => handed?.workflows.find((w) => w.id === wid)?.steps.flatMap((s) => (s.place === null ? [] : [s.place])) ?? []
  const relative = relativizer(part.cwd)
  const end = millis(part.endedAt) ?? Infinity
  const fired = (yield* readFired(ctx.tenantDir, part.sessionId)).filter((x) => Date.parse(x.at) <= end)
  return feedbackOf(
    {
      version: state.version,
      workflows: state.workflows.map((w) => ({ id: w.id, places: placesOf(w.id) })),
      shown: state.shown.map((s) => s.place),
      read: (handed?.places ?? []).filter(isReadPlace).map((p) => p.id),
      pitfalls: state.pitfalls,
      fired: fired.map((x) => ({ pitfall: x.pitfall, at: Date.parse(x.at) })),
      triggers: state.triggers
    },
    {
      edited,
      events: part.toolCalls.filter((c) => c.agentId === undefined).map((c) => ({ event: eventOfCall(c, relative), at: millis(c.startedAt) }))
    }
  )
})

/** Every commit a repo's sessions still on disk made or wrote: memory set up in a repo with a past, or reading it again (`learn --past`). */
export const storePast = (cwd: string, homes: AgentHomes, tenantDir: string) => storeCommits(cwd, homes, tenantDir, { again: true })
