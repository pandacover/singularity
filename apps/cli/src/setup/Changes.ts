/**
 * `singularity changes`: what memory stored in a repo, one line per change,
 * newest first: when it was committed, its commit and title (read from git),
 * the files it changed, and whether memory retired it. `changes <commit>`
 * prints one in full, as an agent would read it now. With --json, the same
 * as data for agents and scripts.
 */
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { git, identifyRepo } from "../local/Git.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { matchSubject, type Subject } from "../records/Subjects.ts"
import { readRetired } from "../scripts/Retired.ts"
import { renderStored } from "../scripts/Start.ts"
import { shortDate } from "./Status.ts"
import { makeStyle, plural } from "./Ui.ts"

/** A change asked for that memory doesn't have, or a commit that names several. */
export class ChangesError extends Schema.TaggedError<ChangesError>()("ChangesError", {
  message: Schema.String
}) {}

/** A stored change, as `changes` shows it. */
export interface Change {
  readonly id: string
  /** The commit that holds it. */
  readonly commit: string | null
  /** The commit's title and date, from git; null when the commit isn't in this clone. */
  readonly title: string | null
  /** How many commits it holds (a command that made several, or follow-ups folded in); null when git can't say. */
  readonly commits: number | null
  readonly committed_at: string | null
  readonly stored_at: string
  /** What the session's task asked, its first line. */
  readonly task: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly status: string; readonly added: number; readonly removed: number }>
  readonly checks: ReadonlyArray<{ readonly command: string; readonly ok: boolean }>
  /** Why memory no longer hands it over (Retired.ts), when it doesn't. */
  readonly retired: { readonly reason: string; readonly at: string } | null
}

export interface ChangesReport {
  /** The repo; null when the one asked for isn't one memory has changes for. */
  readonly repo: { readonly id: string; readonly name: string; readonly root: string | null } | null
  /** The repos memory has changes for, to pick one with --repo. */
  readonly repos: ReadonlyArray<{ readonly id: string; readonly name: string }>
  /** Newest first. */
  readonly changes: ReadonlyArray<Change>
}

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0] ?? ""

/** Commits per git call: Windows cuts a command line at 32,767 characters. */
const COMMITS_PER_CALL = 200

interface CommitInfo {
  readonly date: string
  readonly title: string
  readonly parent: string | undefined
}

/** Each commit's date, title and first parent, a git call per 200; commits missing from the clone are left out. */
const commitInfo = Effect.fn("changes.commitInfo")(function*(root: string, commits: ReadonlyArray<string>) {
  const out = new Map<string, CommitInfo>()
  for (let i = 0; i < commits.length; i += COMMITS_PER_CALL) {
    const text = yield* git(root, ["log", "--no-walk=unsorted", "--ignore-missing", "--format=%H%x1f%P%x1f%cI%x1f%s", ...commits.slice(i, i + COMMITS_PER_CALL)]).pipe(
      Effect.orElseSucceed(() => "")
    )
    for (const line of text.split(/\r?\n/)) {
      const [hash, parents, date, title] = line.split("\x1f")
      if (hash !== undefined && parents !== undefined && date !== undefined && title !== undefined) {
        out.set(hash, { date, title, parent: parents.split(" ")[0] || undefined })
      }
    }
  }
  return out
})

/**
 * How many commits a stored change holds: 1 when its base is its commit's
 * parent; else counted (a command that made several, or follow-ups folded
 * in); null when git can't say.
 */
const commitCount = Effect.fn("changes.commitCount")(function*(root: string, base: string | null, head: string, seen: CommitInfo | undefined) {
  if (seen === undefined) return null
  if (base === null || base === seen.parent) return 1
  return yield* git(root, ["rev-list", "--count", `${base}..${head}`]).pipe(
    Effect.map((s) => Number.parseInt(s.trim(), 10) || null),
    Effect.orElseSucceed(() => null)
  )
})

/**
 * The repo `repo` names (a subject's id or name, or a folder in it; here when
 * not given), and a checkout of it to read commits from.
 */
const resolveRepo = Effect.fn("changes.resolveRepo")(function*(subjects: ReadonlyArray<Subject>, cwd: string, repo: string | undefined) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const named = repo === undefined ? undefined : subjects.find((s) => s.id === repo) ?? subjects.find((s) => s.name === repo)
  if (named === undefined) {
    const found = yield* identifyRepo(path.resolve(cwd, repo ?? "."))
    const subject = found === undefined ? undefined : matchSubject(subjects, found)
    return subject === undefined ? undefined : { subject, root: found!.root }
  }
  for (const p of [...named.paths].reverse()) {
    if (yield* fs.exists(p).pipe(Effect.orElseSucceed(() => false))) return { subject: named, root: p }
  }
  return { subject: named, root: null }
})

/** A repo's stored changes (`repo` as `resolveRepo` reads it), newest first, from the store of `tenantDir`'s tenant. */
export const gatherChanges = Effect.fn("gatherChanges")(function*(o: { readonly cwd: string; readonly repo?: string | undefined; readonly tenantDir: string }) {
  const store = yield* RecordStore
  const subjects = yield* store.subjects()
  const repos = subjects.map((s) => ({ id: s.id, name: s.name }))
  const found = yield* resolveRepo(subjects, o.cwd, o.repo)
  if (found === undefined) return { repo: null, repos, changes: [] } satisfies ChangesReport
  const records = yield* store.find({ subject: found.subject.id, outcome: "success" })
  const retired = yield* readRetired(o.tenantDir)
  const root = found.root
  const info = root === null
    ? new Map<string, CommitInfo>()
    : yield* commitInfo(root, records.flatMap((r) => (r.run.head_commit === null ? [] : [r.run.head_commit])))
  const changes = yield* Effect.forEach(records, Effect.fnUntraced(function*(r) {
    const commit = r.run.head_commit
    const seen = commit === null ? undefined : info.get(commit)
    const gone = retired.get(r.id)
    const change: Change = {
      id: r.id,
      commit,
      title: seen?.title ?? null,
      commits: root === null || commit === null ? null : yield* commitCount(root, r.run.base_commit, commit, seen),
      committed_at: seen?.date ?? null,
      stored_at: r.created_at,
      task: firstLine(r.task.prompt),
      files: r.files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed })),
      checks: r.checks.map((c) => ({ command: c.command, ok: c.ok })),
      retired: gone === undefined ? null : { reason: gone.reason, at: gone.at }
    }
    // Without its commit, when its session got there (`run.segment.to`); `created_at` is when memory stored it.
    return { change, when: Date.parse(seen?.date ?? r.run.segment?.to ?? r.run.started_at ?? r.created_at) || 0 }
  }))
  changes.sort((a, b) => b.when - a.when)
  return { repo: { id: found.subject.id, name: found.subject.name, root }, repos, changes: changes.map((c) => c.change) } satisfies ChangesReport
})

/** The changes `arg` names: a record id, or a commit (at least 4 characters of it). */
export const findChange = (changes: ReadonlyArray<Change>, arg: string): Array<Change> => {
  const exact = changes.filter((c) => c.id === arg)
  if (exact.length > 0) return exact
  const prefix = arg.toLowerCase()
  return prefix.length < 4 ? [] : changes.filter((c) => c.commit?.startsWith(prefix))
}

const TITLE_WIDTH = 60

const EMPTY = "none yet: memory stores a change when a session commits it with passing checks; singularity store adds earlier sessions'"

const cut = (s: string, width: number) => (s.length > width ? s.slice(0, width - 1) + "…" : s)

/** A retirement's reason with record ids shortened to their commit: "folded into cd9cdb74edca". */
const reasonText = (reason: string, subject: string) => reason.replaceAll(`${subject}-`, "")

const lines = (c: Change) => {
  const added = c.files.reduce((n, f) => n + f.added, 0)
  const removed = c.files.reduce((n, f) => n + f.removed, 0)
  return `${plural(c.files.length, "file")} +${added} -${removed}${c.commits !== null && c.commits > 1 ? ` in ${c.commits} commits` : ""}`
}

const checksText = (checks: Change["checks"]) => {
  const failed = checks.filter((c) => !c.ok).length
  return failed === 0 ? `${plural(checks.length, "check")} passed` : `${failed} of ${plural(checks.length, "check")} failed`
}

/** The list of a repo's changes, drawn from what `gatherChanges` found. */
export const renderChanges = (r: ChangesReport, o: { readonly color: boolean }): Array<string> => {
  const s = makeStyle(o.color)
  const out = [""]
  if (r.repo === null) {
    out.push(`  ${s.magenta("◆")} ${s.bold("singularity")}  ${s.dim("no changes stored for this repo")}`)
    out.push("", r.repos.length > 0
      ? `  Memory has changes for ${r.repos.map((x) => x.id).join(", ")}: ${s.cyan("singularity changes --repo NAME")}`
      : `  ${s.dim(EMPTY)}`)
    return [...out, ""]
  }
  const retired = r.changes.filter((c) => c.retired !== null).length
  out.push(
    `  ${s.magenta("◆")} ${s.bold("singularity")}  ${plural(r.changes.length, "change")} stored in ${r.repo.name}` +
      (retired === 0 ? "" : s.dim(` (${retired} retired)`))
  )
  if (r.changes.length === 0) return [...out, "", `  ${s.dim(EMPTY)}`, ""]
  out.push("")
  const width = Math.max(...r.changes.map((c) => lines(c).length)) + 2
  for (const c of r.changes) {
    const date = shortDate(c.committed_at ?? c.stored_at).padEnd(7)
    const sha = (c.commit?.slice(0, 10) ?? "").padEnd(10)
    const title = cut(c.title ?? c.task, TITLE_WIDTH).padEnd(TITLE_WIDTH)
    const tail = c.retired !== null
      ? `retired: ${reasonText(c.retired.reason, r.repo.id)}`
      : c.title === null && c.commit !== null ? "commit not in this clone" : ""
    const line = `${date} ${sha}  ${title}  ${lines(c).padEnd(width)}${tail}`.trimEnd()
    out.push(`    ${c.retired === null ? line : s.dim(line)}`)
  }
  out.push("", `  ${s.dim("one in full, as an agent would read it:")} ${s.cyan("singularity changes <commit>")}`, "")
  return out
}

/** One change in full: what it is, then the hand-over an agent would read now (`text`), or why there is none. */
export const renderChange = (c: Change, text: string | undefined, o: { readonly color: boolean; readonly subject: string }): Array<string> => {
  const s = makeStyle(o.color)
  const facts = [
    ...(c.committed_at === null ? [] : [`committed ${shortDate(c.committed_at)}`]),
    `stored ${shortDate(c.stored_at)}`,
    lines(c),
    ...(c.checks.length === 0 ? [] : [checksText(c.checks)])
  ]
  const out = [
    "",
    `  ${s.magenta("◆")} ${s.bold(c.commit?.slice(0, 10) ?? c.id)}  ${c.title ?? c.task}`,
    `    ${s.dim(facts.join(" · "))}`
  ]
  if (c.retired !== null) out.push(`    ${s.yellow(`retired: ${reasonText(c.retired.reason, o.subject)}`)}${s.dim(", so memory no longer hands it over")}`)
  out.push("")
  if (text !== undefined) return [...out, text.trimEnd(), ""]
  return [
    ...out,
    s.dim(`  Its commit isn't in this clone, so its change can't be read from git. Its task:`),
    "",
    c.task,
    "",
    ...c.files.map((f) => `  ${f.path} (${f.status}, +${f.added} -${f.removed})`),
    ""
  ]
}

export const runChanges = Effect.fn("runChanges")(function*(o: {
  readonly cwd: string
  readonly change?: string | undefined
  readonly repo?: string | undefined
  readonly memoryHome?: string | undefined
  readonly color: boolean
  readonly json: boolean
}) {
  const home = yield* loadHome(o.memoryHome)
  yield* Effect.gen(function*() {
    const report = yield* gatherChanges({ cwd: o.cwd, repo: o.repo, tenantDir: home.tenantDir })
    if (o.change === undefined) {
      return yield* Console.log(o.json ? JSON.stringify(report, null, 2) : renderChanges(report, o).join("\n"))
    }
    const repo = report.repo
    if (repo === null) return yield* new ChangesError({ message: "memory has no changes stored for this repo; pick one with --repo NAME" })
    const matches = findChange(report.changes, o.change)
    if (matches.length === 0) return yield* new ChangesError({ message: `no stored change in ${repo.name} matches ${o.change}` })
    if (matches.length > 1) {
      return yield* new ChangesError({ message: `${o.change} names ${matches.length} stored changes: ${matches.map((c) => c.commit?.slice(0, 10) ?? c.id).join(", ")}` })
    }
    const change = matches[0]
    const text = repo.root === null ? undefined : yield* renderStored(repo.root, home.tenantDir, yield* (yield* RecordStore).get(change.id))
    yield* Console.log(o.json ? JSON.stringify({ ...change, text: text ?? null }, null, 2) : renderChange(change, text, { color: o.color, subject: repo.id }).join("\n"))
  }).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
})
