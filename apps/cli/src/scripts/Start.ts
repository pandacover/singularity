/**
 * Saved scripts at task start: the one stored change of this repo whose task
 * is most like the new one (Search.ts), read from git as it is now
 * (Render.ts), or nothing when none is alike enough; or, when the person
 * chose a model, the one it picks (Pick.ts), in a hook of its own that runs
 * in the background (Hook.ts `userPromptPick`). No learning: memory is the changes the hooks stored when the agent committed
 * (src/workflows/Commits.ts), one record per commit. The task-start hook
 * hands over a pointer to it (`pointer`: its commit, what it was for, its
 * files; Render.ts `renderPointer`), then the repo's card: the check scripts
 * earlier sessions ran, still on disk, that the session wasn't given yet
 * (`facts`; facts/Lookup.ts `cardFacts`). `singularity recall` and
 * `singularity changes` show a change in full: the pointer, then what git
 * doesn't show about it (Render.ts `renderFull`), never its diff.
 *
 * Reading the change from git at use time keeps it exact, and lets the
 * hand-over say which of its files were renamed, moved, rewritten or deleted
 * since (Fresh.ts): a rewritten file's line says so, with the commit that
 * changed it last. The candidates above the bar are examined best
 * first, never one the session itself made, and passed over when:
 * - their commit is missing (a rebase, another clone): only this time;
 * - they are retired (Retired.ts), or found now to be reverted, superseded
 *   by a newer stored change of the same files and task, or gone (every file
 *   rewritten or deleted, on the branch it was committed to): retired from
 *   then on when the call may write (`persist`; `recall` doesn't);
 * - every file is rewritten or deleted on another branch than theirs: only
 *   this time, since the branch may come back.
 *
 * A session starts a task at its first prompt that asks for something and at
 * the first after each commit (Cycle.ts). Apart from those, when the agent
 * reads a stored commit in git, what git doesn't show about it comes along
 * (`commitHandover`, started by History.ts), once a commit a session.
 *
 * A record is found by its commit message, or by its task when the message
 * says too little (records/Task.ts); records stored before messages were
 * kept get theirs from git here.
 */
import { DateTime, Effect } from "effect"
import { cardFacts, indexPath, isLive, packageScripts, readIndex, rehome, renderCard } from "../facts/Lookup.ts"
import { commitMessages, git, hasCommit, identifyRepo } from "../local/Git.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { changeMessage } from "../records/Task.ts"
import { logHandover } from "../workflows/Session.ts"
import { isAncestor, judgeFile, liveCommands, revertedBy, sameChange, type Today, type Verdict } from "./Fresh.ts"
import { commandsToShow, diffChunks, fileKind, type FileNow, isSnapshot, MAX_HANDOVER_CHARS, renderBehind, renderFull, renderPointer } from "./Render.ts"
import type { Picks } from "../local/Home.ts"
import { readRetired, retire, type Retirement } from "./Retired.ts"
import { MIN_SCORE, rank, rankRecall } from "./Search.ts"

export interface ScriptsStart {
  readonly text: string | undefined
  /** The record handed over, and its score; the best score when nothing was. */
  readonly picked: { readonly id: string; readonly commit: string } | null
  readonly score: number
  /** Candidates above the bar passed over before the pick, and why. */
  readonly passed: ReadonlyArray<{ readonly id: string; readonly reason: string }>
  /** The facts the card handed over (facts/Lookup.ts), by id. */
  readonly facts: ReadonlyArray<string>
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
 * A stored change's files as they stand today (`t`): each with today's path
 * and its verdict, `judgeFile` on its chunk of the change, for each file the
 * change shows.
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
  return { files }
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

/** What a hand-over is chosen from: the repo's stored changes, not retired, and the time. */
interface Store {
  readonly root: string
  readonly subject: string
  readonly stored: ReadonlyArray<Stored>
  readonly today: Today
  readonly now: string
}

const openStore = Effect.fn("scripts.openStore")(function*(cwd: string, tenantDir: string) {
  const records = yield* RecordStore
  const repo = yield* identifyRepo(cwd)
  const subject = repo === undefined ? undefined : yield* records.subjectFor(repo)
  if (repo === undefined || subject === undefined) return undefined
  const retired = yield* readRetired(tenantDir)
  const found = (yield* records.find({ subject: subject.id, outcome: "success" }))
    .filter((r): r is Stored => r.run.head_commit !== null && !retired.has(r.id))
  const stored = yield* withMessages(repo.root, found)
  return { root: repo.root, subject: subject.id, stored, today: { root: repo.root }, now: DateTime.formatIso(yield* DateTime.now) } satisfies Store
})

/** Records stored before commit messages were kept, with their head commit's from git: two calls for all of them. */
const withMessages = Effect.fn("scripts.withMessages")(function*(root: string, records: ReadonlyArray<Stored>) {
  const messages = yield* commitMessages(root, records.filter((r) => r.task.message === undefined).map((r) => r.run.head_commit))
  return records.map((r): Stored => {
    const message = r.task.message === undefined ? messages.get(r.run.head_commit) : undefined
    return message === undefined ? r : { ...r, task: { ...r.task, message: changeMessage([message]) } }
  })
})

interface Candidate {
  readonly record: Stored
  readonly score: number
}

/**
 * The first of `candidates` (best first) still worth handing over, read from
 * git as it is now; the ones passed over before it, and why; and of those,
 * the ones to retire from then on.
 */
const choose = Effect.fn("scripts.choose")(function*(s: Store, candidates: ReadonlyArray<Candidate>) {
  const retiring: Array<Retirement> = []
  const passed: Array<{ id: string; reason: string }> = []
  const pass = (r: Stored, reason: string, keep: boolean) => {
    passed.push({ id: r.id, reason })
    if (keep) retiring.push({ id: r.id, commit: r.run.head_commit, reason, at: s.now })
  }
  for (const c of candidates.slice(0, MAX_EXAMINED)) {
    const record = c.record
    const head = record.run.head_commit
    if (!(yield* hasCommit(s.root, head))) {
      pass(record, "its commit isn't in this repo", false)
      continue
    }
    const revert = yield* revertedBy(s.today, head)
    if (revert !== undefined) {
      pass(record, `reverted by ${revert.slice(0, 12)}`, true)
      continue
    }
    const files = record.files.filter((f) => !f.snapshot).map((f) => f.path)
    let superseded: Stored | undefined
    for (const other of s.stored) {
      const theirs = { files: other.files.filter((f) => !f.snapshot).map((f) => f.path), prompt: other.task.prompt, message: other.task.message }
      if (other.id === record.id || !sameChange({ files, prompt: record.task.prompt, message: record.task.message }, theirs)) continue
      if ((yield* hasCommit(s.root, other.run.head_commit)) && (yield* newer(s.root, other, record))) {
        superseded = other
        break
      }
    }
    if (superseded !== undefined) {
      pass(record, `superseded by ${superseded.id}`, true)
      continue
    }
    const judged = yield* judgeScript(s.today, record)
    if (allGone(judged.files)) {
      // Gone for good only where the change was committed to: on another branch it may come back.
      pass(record, "gone", yield* isAncestor(s.root, head, "HEAD"))
      continue
    }
    return { picked: { ...c, judged }, passed, retiring }
  }
  return { picked: undefined, passed, retiring }
})

/** The project commands a stored change's session ran, which its commit doesn't show: the ones still live here (Fresh.ts). */
const commandsOf = (s: Store, record: Stored) =>
  liveCommands(s.today, record.run.head_commit, commandsToShow(record.commands), record.files.map((f) => f.path))

/** The chosen change in full: the pointer, then what git doesn't show about it. */
const show = Effect.fn("scripts.show")(function*(
  s: Store,
  picked: Candidate & { readonly judged: Effect.Success<ReturnType<typeof judgeScript>> },
  budget: number
) {
  const record = picked.record
  return renderFull({
    prompt: record.task.prompt,
    message: record.task.message,
    commit: record.run.head_commit,
    files: picked.judged.files.map(({ verdict: _, ...f }) => f),
    commands: yield* commandsOf(s, record)
  }, budget)
})

/** The chosen change as a task's start points to it: its commit, what it was for, its files as they are today. */
const point = (picked: Candidate & { readonly judged: Effect.Success<ReturnType<typeof judgeScript>> }) =>
  renderPointer({
    prompt: picked.record.task.prompt,
    message: picked.record.task.message,
    commit: picked.record.run.head_commit,
    files: picked.judged.files.map(({ verdict: _, ...f }) => f)
  })

/** The first line of what a stored change was for: its commit message's, else its task's. */
const titleOf = (r: Stored): string | undefined =>
  [r.task.message, r.task.prompt].flatMap((t) => (t === undefined ? [] : t.split(/\r?\n/))).map((l) => l.trim()).find((l) => l !== "")

/**
 * The repo's card for a session (facts/Lookup.ts `cardFacts`): the check
 * scripts its index names, each still live in this checkout, that the
 * session wasn't given and didn't teach itself, the scripts of the change it
 * points to (`lead`) first. Read, never built here: the
 * index is written when memory stores (facts/Index.ts).
 */
const cardOf = (s: Store, sessionId: string, tenantDir: string, given: ReadonlySet<string>, lead: Stored | undefined) => {
  const index = readIndex(indexPath(tenantDir, s.subject))
  if (index === undefined) return { text: undefined, ids: [] }
  const scripts = packageScripts(s.root)
  const facts = cardFacts(index, { sessionId, given, live: (f) => isLive(f, s.root, scripts) }, lead?.run.head_commit)
  const titles = new Map(s.stored.map((r) => [r.run.head_commit, titleOf(r)] as const))
  const here = rehome(tenantDir, s.subject, s.root)
  const card = renderCard(facts.map((f) => ({ ...f, text: here(f.text) })), (commit) => titles.get(commit))
  return { text: card.text, ids: card.facts.map((f) => f.id) }
}

/**
 * A stored change as an agent would read it now, whatever its task
 * (`singularity changes <commit>`), retired or not; undefined when its commit
 * isn't in this clone. Nothing is retired or logged.
 */
export const renderStored = Effect.fn("scripts.renderStored")(function*(cwd: string, tenantDir: string, record: WorkflowRecord) {
  const s = yield* openStore(cwd, tenantDir)
  const head = record.run.head_commit
  if (s === undefined || head === null || !(yield* hasCommit(s.root, head))) return undefined
  // Its commit message as the hand-overs have it (`openStore`), which a record stored before messages were kept lacks.
  const [stored] = yield* withMessages(s.root, [{ ...record, run: { ...record.run, head_commit: head } }])
  return yield* show(s, { record: stored, score: 1, judged: yield* judgeScript(s.today, stored) }, MAX_HANDOVER_CHARS)
})

const round3 = (x: number) => Math.round(x * 1000) / 1000

export const startScripts = Effect.fn("startScripts")(function*(
  input: { readonly sessionId: string; readonly prompt: string; readonly cwd: string },
  options: {
    readonly tenantDir: string
    readonly persist?: boolean | undefined
    readonly budget?: number | undefined
    readonly minScore?: number | undefined
    /** A recall mid-task: `prompt` is a short line of what the agent is about to do (`Search.rankRecall`). */
    readonly query?: boolean | undefined
    /** Point to the change (`Render.renderPointer`) rather than show it in full. */
    readonly pointer?: boolean | undefined
    /** Add the repo's card, without the facts the session was given already (`given`). */
    readonly facts?: { readonly given: ReadonlySet<string> } | undefined
    /** Leave the past change out: another hook hands it over (the card alone, then). */
    readonly noChange?: boolean | undefined
    /** A model picks the change (Pick.ts), run in `cwd`; word search when it can't be asked. */
    readonly pick?: { readonly picks: Picks; readonly cwd: string } | undefined
  }
) {
  const nothing: ScriptsStart = { text: undefined, picked: null, score: 0, passed: [], facts: [] }
  const s = yield* openStore(input.cwd, options.tenantDir)
  if (s === undefined) return nothing
  // A session is never pointed to a change it made itself.
  const docs = s.stored.filter((r) => r.run.session_id !== input.sessionId)
    .map((r) => ({ id: r.id, prompt: r.task.prompt, message: r.task.message, files: r.files.map((f) => f.path), record: r }))
  const byWords = () =>
    options.query === true
      ? rankRecall(input.prompt, docs)
      : rank(input.prompt, docs).map((r) => ({ ...r, matches: r.score >= (options.minScore ?? MIN_SCORE) }))
  let ranked: ReadonlyArray<{ readonly doc: typeof docs[number]; readonly score: number; readonly matches: boolean }> = []
  let model: Record<string, unknown> | undefined
  if (options.noChange === true) ranked = []
  else if (options.pick !== undefined) {
    // Loaded only here: it brings the agents' commands (setup/Wiring.ts), which a task's start otherwise never needs.
    const { askModel, MAX_LISTED } = yield* Effect.promise(() => import("./Pick.ts"))
    const listed = docs.slice(-MAX_LISTED)
    const asked = yield* askModel(options.pick.picks, input.prompt, listed, options.pick.cwd).pipe(Effect.result)
    if (asked._tag === "Success") {
      const doc = asked.success.index === null ? undefined : listed[asked.success.index]
      ranked = doc === undefined ? [] : [{ doc, score: 1, matches: true }]
      model = { by: "model", model: options.pick.picks.model, seconds: asked.success.seconds, cost_usd: asked.success.costUsd }
    } else {
      ranked = byWords()
      model = { by: "words", model: options.pick.picks.model, error: asked.failure.message }
    }
  } else ranked = byWords()
  const { picked, passed, retiring } = yield* choose(s, ranked.filter((r) => r.matches).map((r) => ({ record: r.doc.record, score: r.score })))
  const change = picked === undefined ? undefined : options.pointer === true ? point(picked) : yield* show(s, picked, options.budget ?? MAX_HANDOVER_CHARS)
  const card = options.facts === undefined ? { text: undefined, ids: [] } : cardOf(s, input.sessionId, options.tenantDir, options.facts.given, picked?.record)
  const parts = [change, card.text].filter((t): t is string => t !== undefined)
  const text = parts.length === 0 ? undefined : parts.join("\n")
  const result: ScriptsStart = {
    text,
    picked: picked === undefined ? null : { id: picked.record.id, commit: picked.record.run.head_commit },
    score: round3(picked?.score ?? ranked[0]?.score ?? 0),
    passed,
    facts: card.ids
  }
  if (options.persist === false) return result
  yield* retire(options.tenantDir, retiring)
  yield* logHandover(options.tenantDir, {
    at: s.now,
    session_id: input.sessionId,
    // "pick": the change a model picked, handed over beside the start's card (Hook.ts `userPromptPick`).
    moment: options.pick === undefined ? "start" : "pick",
    ...model,
    memory: "scripts",
    subject: s.subject,
    stored: s.stored.length,
    picked: result.picked,
    score: result.score,
    // The runner-ups, to read later how close the pick was.
    others: ranked.slice(picked === undefined ? 0 : 1, 4).map((r) => ({ id: r.doc.id, score: round3(r.score) })),
    passed,
    facts: card.ids,
    chars: text?.length ?? 0,
    text: text ?? null
  })
  return result
})

/**
 * A hand-over mid-task, by commit (History.ts): the agent read past commits
 * with `git show` or `git log`, `hashes` (whole or a prefix) or `revs` to
 * resolve. The first of them memory stored, that this session didn't make
 * and wasn't given yet (`given`), brings what git doesn't show about it
 * (Render.ts `renderBehind`), or nothing when memory has nothing more on it.
 * Its files aren't judged against today's code (Fresh.ts): the agent is
 * reading that very commit.
 */
export const commitHandover = Effect.fn("scripts.commitHandover")(function*(
  input: {
    readonly sessionId: string
    readonly cwd: string
    readonly command: string
    readonly hashes: ReadonlyArray<string>
    readonly revs: ReadonlyArray<string>
    readonly given: ReadonlyArray<string>
  },
  options: { readonly tenantDir: string; readonly persist?: boolean | undefined }
) {
  const nothing: ScriptsStart = { text: undefined, picked: null, score: 0, passed: [], facts: [] }
  const s = yield* openStore(input.cwd, options.tenantDir)
  if (s === undefined || s.stored.length === 0) return nothing
  const resolved: Array<string> = []
  for (const rev of input.revs) {
    const hash = yield* git(s.root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).pipe(Effect.map((h) => h.trim()), Effect.orElseSucceed(() => ""))
    if (hash !== "") resolved.push(hash)
  }
  const usable = (r: Stored) => r.run.session_id !== input.sessionId && !input.given.includes(r.run.head_commit)
  const read = [...input.hashes, ...resolved]
  let record = read
    .flatMap((h) => s.stored.filter((r) => r.run.head_commit.toLowerCase().startsWith(h.toLowerCase())).slice(0, 1))
    .find(usable)
  // A commit inside a stored change of several (one command made them): the
  // first stored change after it, on the way to HEAD, whose base is before it.
  for (const h of record === undefined ? read.slice(0, 3) : []) {
    const full = yield* git(s.root, ["rev-parse", "--verify", "--quiet", `${h}^{commit}`]).pipe(Effect.map((x) => x.trim()), Effect.orElseSucceed(() => ""))
    if (full === "") continue
    const after = yield* git(s.root, ["rev-list", "--reverse", "--ancestry-path", `${full}..HEAD`]).pipe(Effect.orElseSucceed(() => ""))
    const heads = new Map(s.stored.map((r) => [r.run.head_commit.toLowerCase(), r] as const))
    const next = after.split("\n").map((x) => heads.get(x.trim().toLowerCase())).find((r) => r !== undefined)
    const base = next?.run.base_commit
    if (next === undefined || base === null || base === undefined || base.toLowerCase() === full.toLowerCase()) continue
    const holds = yield* git(s.root, ["merge-base", "--is-ancestor", base, full]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
    if (holds && usable(next)) {
      record = next
      break
    }
  }
  if (record === undefined) return nothing
  const behind = renderBehind({ commit: record.run.head_commit, prompt: record.task.prompt, message: record.task.message, commands: yield* commandsOf(s, record) })
  const text = behind === undefined ? undefined : rehome(options.tenantDir, s.subject, s.root)(behind)
  const result: ScriptsStart = {
    text,
    picked: text === undefined ? null : { id: record.id, commit: record.run.head_commit },
    score: text === undefined ? 0 : 1,
    passed: [],
    facts: []
  }
  if (options.persist === false) return result
  yield* logHandover(options.tenantDir, {
    at: s.now,
    session_id: input.sessionId,
    moment: "git",
    memory: "scripts",
    subject: s.subject,
    stored: s.stored.length,
    command: input.command.slice(0, 300),
    read: record.run.head_commit,
    picked: result.picked,
    chars: text?.length ?? 0,
    text: text ?? null
  })
  return result
})
