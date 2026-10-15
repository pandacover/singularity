/**
 * Saved scripts at task start: the one stored change of this repo whose task
 * is most like the new one (Search.ts), read from git as it is now
 * (Render.ts), or nothing when none is alike enough. No model call and no
 * learning: memory is the changes the hooks stored when the agent committed
 * (src/workflows/Commits.ts), one record per commit.
 *
 * Reading the change from git at use time keeps it exact, and lets the
 * hand-over say which of its files were renamed, moved, rewritten or deleted
 * since (Fresh.ts): a rewritten file's change is left out with a pointer to
 * the file as it is now. The candidates above the bar are examined best
 * first, and passed over when:
 * - their commit is missing (a rebase, another clone): only this time;
 * - they are retired (Retired.ts), or found now to be reverted, superseded
 *   by a newer stored change of the same files and task, or gone (every file
 *   rewritten or deleted, on the branch it was committed to): retired from
 *   then on when the call may write (`persist`; `recall` doesn't);
 * - every file is rewritten or deleted on another branch than theirs: only
 *   this time, since the branch may come back.
 */
import { DateTime, Effect } from "effect"
import { git, hasCommit, identifyRepo } from "../local/Git.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { logHandover } from "../workflows/Session.ts"
import { isAncestor, judgeFile, liveCommands, revertedBy, sameChange, type Today, type Verdict } from "./Fresh.ts"
import {
  commandsToShow,
  diffChunks,
  fileKind,
  type FileNow,
  isSnapshot,
  MAX_HANDOVER_CHARS,
  mistakesNearby,
  mistakesToShow,
  renderScript
} from "./Render.ts"
import { readRetired, retire, type Retirement } from "./Retired.ts"
import { MIN_SCORE, rank, rankRecall } from "./Search.ts"

export interface ScriptsStart {
  readonly text: string | undefined
  /** The record handed over, and its score; the best score when nothing was. */
  readonly picked: { readonly id: string; readonly commit: string } | null
  readonly score: number
  /** Candidates above the bar passed over before the pick, and why. */
  readonly passed: ReadonlyArray<{ readonly id: string; readonly reason: string }>
}

/** How many candidates above the bar are examined (each costs a few git calls) before giving up. */
const MAX_EXAMINED = 5

/** Today's path of each file changed at `commit`, following renames since: null when it's gone. `to` is today (HEAD). */
export const pathsNow = Effect.fn("scripts.pathsNow")(function*(root: string, commit: string, paths: ReadonlyArray<string>, to = "HEAD") {
  const out = yield* git(root, ["diff", "--name-status", "-M", commit, to])
    .pipe(Effect.orElseSucceed(() => ""))
  const moved = new Map<string, string | null>()
  for (const line of out.split(/\r?\n/)) {
    const [status, from, dest] = line.split("\t")
    if (status === undefined || from === undefined) continue
    if (status.startsWith("R") && dest !== undefined) moved.set(from, dest)
    else if (status === "D") moved.set(from, null)
  }
  return new Map(paths.map((p) => [p, moved.has(p) ? moved.get(p)! : p] as const))
})

/** The change of a record's commit(s), one chunk per file, snapshots and binary files left out. */
export const readableChunks = (diff: string) =>
  diffChunks(diff).filter((c) => !isSnapshot(c.path) && !/^GIT binary patch$/m.test(c.text) && !/^Binary files /m.test(c.text))

type Stored = WorkflowRecord & { run: { head_commit: string } }

/**
 * A stored change's files as they stand today (`t`), each with its verdict:
 * the diff, today's paths, and `judgeFile` for each file the diff shows.
 */
export const judgeScript = Effect.fn("scripts.judgeScript")(function*(t: Today, record: Stored) {
  const head = record.run.head_commit
  const base = record.run.base_commit ?? `${head}^`
  const diff = yield* git(t.root, ["diff", base, head]).pipe(Effect.orElseSucceed(() => ""))
  const chunks = readableChunks(diff)
  const now = yield* pathsNow(t.root, head, record.files.map((f) => f.path), t.rev ?? "HEAD")
  const judged = new Map<string, Verdict | undefined>()
  // Source first: the searches for moved code (`MAX_SEARCHED`) go where they matter most.
  const order = [...record.files].sort((a, b) => RANK[fileKind(a.path)] - RANK[fileKind(b.path)])
  let searches = MAX_SEARCHED
  for (const f of order) {
    const path = now.get(f.path) ?? f.path
    const chunk = chunks.find((c) => c.path === f.path)
    // Snapshots, files the change deleted, and binary files with nothing to read, aren't judged.
    if (f.snapshot || f.status === "deleted" || (chunk === undefined && path !== null)) continue
    const verdict = yield* judgeFile(t, head, { now: path, chunk: chunk?.text }, searches > 0)
    if (verdict.kind !== "fresh") searches--
    judged.set(f.path, verdict)
  }
  const files = record.files.map((f): FileNow & { readonly verdict: Verdict | undefined } => {
    const verdict = judged.get(f.path)
    const path = now.get(f.path) ?? f.path
    const fate = verdict?.kind === "moved" ? { kind: "moved", to: verdict.to } as const : verdict?.kind === "stale" ? { kind: "stale", last: verdict.last } as const : undefined
    return { ...f, now: verdict?.kind === "gone" ? null : path, fate, verdict }
  })
  return { diff: chunks, files }
})

/** Files below the bar searched for (a git grep and two logs each) per script: a change of sixty translation files stays quick. */
const MAX_SEARCHED = 6
const RANK = { source: 0, test: 1, rest: 2 } as const

/** Whether every file judged is stale or gone (and at least one was judged). */
export const allGone = (files: ReadonlyArray<{ readonly verdict: Verdict | undefined }>): boolean => {
  const judged = files.filter((f) => f.verdict !== undefined)
  return judged.length > 0 && judged.every((f) => f.verdict!.kind === "stale" || f.verdict!.kind === "gone")
}

/** Ordering of two stored changes: the commit history's when one holds the other, else when each was made. */
const newer = Effect.fnUntraced(function*(root: string, a: Stored, b: Stored) {
  if (yield* isAncestor(root, b.run.head_commit, a.run.head_commit)) return true
  if (yield* isAncestor(root, a.run.head_commit, b.run.head_commit)) return false
  const when = (r: Stored) => r.run.segment?.to ?? r.run.started_at ?? r.created_at
  return when(a) > when(b)
})

export const startScripts = Effect.fn("startScripts")(function*(
  input: { readonly sessionId: string; readonly prompt: string; readonly cwd: string },
  options: {
    readonly tenantDir: string
    readonly persist?: boolean | undefined
    readonly budget?: number | undefined
    readonly minScore?: number | undefined
    /** A recall mid-task: `prompt` is a short line of what the agent is about to do (`Search.rankRecall`). */
    readonly query?: boolean | undefined
  }
) {
  const nothing: ScriptsStart = { text: undefined, picked: null, score: 0, passed: [] }
  const records = yield* RecordStore
  const repo = yield* identifyRepo(input.cwd)
  const subject = repo === undefined ? undefined : yield* records.subjectFor(repo)
  if (repo === undefined || subject === undefined) return nothing
  const retired = yield* readRetired(options.tenantDir)
  const stored = (yield* records.find({ subject: subject.id, outcome: "success" }))
    .filter((r): r is Stored => r.run.head_commit !== null && !retired.has(r.id))
  const docs = stored.map((r) => ({ id: r.id, prompt: r.task.prompt, files: r.files.map((f) => f.path), record: r }))
  const ranked = options.query === true
    ? rankRecall(input.prompt, docs)
    : rank(input.prompt, docs).map((r) => ({ ...r, matches: r.score >= (options.minScore ?? MIN_SCORE) }))
  const today: Today = { root: repo.root }
  const now = DateTime.formatIso(yield* DateTime.now)
  const retiring: Array<Retirement> = []
  const passed: Array<{ id: string; reason: string }> = []
  const pass = (r: Stored, reason: string, keep: boolean) => {
    passed.push({ id: r.id, reason })
    if (keep) retiring.push({ id: r.id, commit: r.run.head_commit, reason, at: now })
  }

  let picked: { readonly r: (typeof ranked)[number]; readonly judged: Effect.Success<ReturnType<typeof judgeScript>> } | undefined
  for (const r of ranked.slice(0, MAX_EXAMINED)) {
    if (!r.matches) break
    const record = r.doc.record
    const head = record.run.head_commit
    if (!(yield* hasCommit(repo.root, head))) {
      pass(record, "its commit isn't in this repo", false)
      continue
    }
    const revert = yield* revertedBy(today, head)
    if (revert !== undefined) {
      pass(record, `reverted by ${revert.slice(0, 12)}`, true)
      continue
    }
    const files = record.files.filter((f) => !f.snapshot).map((f) => f.path)
    let superseded: Stored | undefined
    for (const other of stored) {
      if (other.id === record.id || !sameChange({ files, prompt: record.task.prompt }, { files: other.files.filter((f) => !f.snapshot).map((f) => f.path), prompt: other.task.prompt })) continue
      if ((yield* hasCommit(repo.root, other.run.head_commit)) && (yield* newer(repo.root, other, record))) {
        superseded = other
        break
      }
    }
    if (superseded !== undefined) {
      pass(record, `superseded by ${superseded.id}`, true)
      continue
    }
    const judged = yield* judgeScript(today, record)
    if (allGone(judged.files)) {
      // Gone for good only where the change was committed to: on another branch it may come back.
      pass(record, "gone", yield* isAncestor(repo.root, head, "HEAD"))
      continue
    }
    picked = { r, judged }
    break
  }

  let text: string | undefined
  if (picked !== undefined) {
    const record = picked.r.doc.record
    const head = record.run.head_commit
    const own = mistakesToShow(record.detours)
    text = renderScript({
      prompt: record.task.prompt,
      commit: head,
      score: picked.r.score,
      files: picked.judged.files.map(({ verdict: _, ...f }) => f),
      commands: yield* liveCommands(today, head, commandsToShow(record.commands), record.files.map((f) => f.path)),
      mistakes: own,
      nearby: mistakesNearby(
        record.files.map((f) => f.path),
        [...stored].reverse().filter((r) => r.id !== record.id).map((r) => ({ files: r.files.map((f) => f.path), mistakes: mistakesToShow(r.detours) })),
        own
      ),
      diff: picked.judged.diff
    }, options.budget ?? MAX_HANDOVER_CHARS)
  }
  const result: ScriptsStart = {
    text,
    picked: picked === undefined ? null : { id: picked.r.doc.id, commit: picked.r.doc.record.run.head_commit },
    score: Math.round((picked?.r.score ?? ranked[0]?.score ?? 0) * 1000) / 1000,
    passed
  }
  if (options.persist === false) return result
  yield* retire(options.tenantDir, retiring)
  yield* logHandover(options.tenantDir, {
    at: now,
    session_id: input.sessionId,
    moment: "start",
    memory: "scripts",
    subject: subject.id,
    stored: stored.length,
    picked: result.picked,
    score: result.score,
    // The runner-ups, to read later how close the pick was.
    others: ranked.slice(picked === undefined ? 0 : 1, 4).map((r) => ({ id: r.doc.id, score: Math.round(r.score * 1000) / 1000 })),
    passed,
    chars: text?.length ?? 0,
    text: text ?? null
  })
  return result
})
