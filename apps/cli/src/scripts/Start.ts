/**
 * Saved scripts at task start: the one stored change of this repo whose task
 * is most like the new one (Search.ts), read from git as it is now
 * (Render.ts), or nothing when none is alike enough. No model call and no
 * learning: memory is the changes the hooks stored when the agent committed
 * (src/workflows/Commits.ts), one record per commit.
 *
 * Reading the change from git at use time keeps it exact, and lets the
 * hand-over say which of its files were renamed or deleted since. Records
 * whose commit is gone (a rebase, another clone) are passed over.
 */
import { DateTime, Effect } from "effect"
import { git, hasCommit, identifyRepo } from "../local/Git.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { logHandover } from "../workflows/Session.ts"
import { commandsToShow, diffChunks, type FileNow, isSnapshot, MAX_HANDOVER_CHARS, mistakesToShow, renderScript } from "./Render.ts"
import { MIN_SCORE, rank } from "./Search.ts"

export interface ScriptsStart {
  readonly text: string | undefined
  /** The record handed over, and its score; the best score when nothing was. */
  readonly picked: { readonly id: string; readonly commit: string } | null
  readonly score: number
}

/** Today's path of each file changed at `commit`, following renames since: null when it's gone. */
export const pathsNow = Effect.fn("scripts.pathsNow")(function*(root: string, commit: string, paths: ReadonlyArray<string>) {
  const out = yield* git(root, ["diff", "--name-status", "-M", commit, "HEAD"])
    .pipe(Effect.orElseSucceed(() => ""))
  const moved = new Map<string, string | null>()
  for (const line of out.split(/\r?\n/)) {
    const [status, from, to] = line.split("\t")
    if (status === undefined || from === undefined) continue
    if (status.startsWith("R") && to !== undefined) moved.set(from, to)
    else if (status === "D") moved.set(from, null)
  }
  return new Map(paths.map((p) => [p, moved.has(p) ? moved.get(p)! : p] as const))
})

/** The change of a record's commit(s), one chunk per file, snapshots and binary files left out. */
const readableChunks = (diff: string) =>
  diffChunks(diff).filter((c) => !isSnapshot(c.path) && !/^GIT binary patch$/m.test(c.text) && !/^Binary files /m.test(c.text))

export const startScripts = Effect.fn("startScripts")(function*(
  input: { readonly sessionId: string; readonly prompt: string; readonly cwd: string },
  options: { readonly tenantDir: string; readonly persist?: boolean | undefined; readonly budget?: number | undefined; readonly minScore?: number | undefined }
) {
  const nothing: ScriptsStart = { text: undefined, picked: null, score: 0 }
  const records = yield* RecordStore
  const repo = yield* identifyRepo(input.cwd)
  const subject = repo === undefined ? undefined : yield* records.subjectFor(repo)
  if (repo === undefined || subject === undefined) return nothing
  const stored = (yield* records.find({ subject: subject.id, outcome: "success" }))
    .filter((r): r is WorkflowRecord & { run: { head_commit: string } } => r.run.head_commit !== null)
  const ranked = rank(input.prompt, stored.map((r) => ({ id: r.id, prompt: r.task.prompt, record: r })))
  const minScore = options.minScore ?? MIN_SCORE
  let picked: (typeof ranked)[number] | undefined
  for (const r of ranked) {
    if (r.score < minScore) break
    if (yield* hasCommit(repo.root, r.doc.record.run.head_commit)) {
      picked = r
      break
    }
  }
  let text: string | undefined
  if (picked !== undefined) {
    const record = picked.doc.record
    const head = record.run.head_commit
    const base = record.run.base_commit ?? `${head}^`
    const diff = yield* git(repo.root, ["diff", base, head]).pipe(Effect.orElseSucceed(() => ""))
    const now = yield* pathsNow(repo.root, head, record.files.map((f) => f.path))
    const files: Array<FileNow> = record.files.map((f) => ({ ...f, now: now.get(f.path) ?? f.path }))
    text = renderScript({
      prompt: record.task.prompt,
      commit: head,
      score: picked.score,
      files,
      commands: commandsToShow(record.commands),
      mistakes: mistakesToShow(record.detours),
      diff: readableChunks(diff)
    }, options.budget ?? MAX_HANDOVER_CHARS)
  }
  const result: ScriptsStart = {
    text,
    picked: picked === undefined ? null : { id: picked.doc.id, commit: picked.doc.record.run.head_commit },
    score: Math.round((picked?.score ?? ranked[0]?.score ?? 0) * 1000) / 1000
  }
  if (options.persist === false) return result
  yield* logHandover(options.tenantDir, {
    at: DateTime.formatIso(yield* DateTime.now),
    session_id: input.sessionId,
    moment: "start",
    memory: "scripts",
    subject: subject.id,
    stored: stored.length,
    picked: result.picked,
    score: result.score,
    // The runner-ups, to read later how close the pick was.
    others: ranked.slice(picked === undefined ? 0 : 1, 4).map((r) => ({ id: r.doc.id, score: Math.round(r.score * 1000) / 1000 })),
    chars: text?.length ?? 0,
    text: text ?? null
  })
  return result
})
