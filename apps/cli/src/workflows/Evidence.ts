/**
 * What recorded runs show, read for memory v1: for each successful run, the
 * places its edits went (Places.ts), in the order it made them, the files it
 * created and what it read before writing them, the commands that checked its
 * work, and its detours. Places are pooled across runs: the same place, found
 * from different tasks' edits, is one place with all of them as evidence.
 *
 * Nothing here calls a model. What a run wrote is kept for the model that
 * induces workflows to read, never in memory itself.
 */
import { Effect, FileSystem, Option, Path } from "effect"
import { createHash } from "node:crypto"
import { fileAt, git } from "../local/Git.ts"
import type { Detour, WorkflowRecord } from "../records/Models.ts"
import { extractMechanical, type Mechanical, relativizer, stillADetour } from "../records/Extract.ts"
import { recordTrace } from "../records/Segment.ts"
import { classifyKey } from "../records/Shell.ts"
import { EDIT_TOOLS, ownWords, type ToolCall } from "../traces/index.ts"
import { editsOfDiff, placeOfEdit } from "./Edits.ts"
import { type Looking, lookingOf } from "./Lookups.ts"
import type { Place, WorkflowMemory } from "./Models.ts"
import { isKindStart, placeKey, placesOfRead, type PlaceShape, sharedNameStart } from "./Places.ts"
import { linesOfSpan, MAX_SEARCH_PLACES, type ReadSpan, readSpans } from "./Reads.ts"

export interface PlaceUse {
  readonly place: string
  readonly kind: "add" | "change" | "remove" | "create"
  readonly file: string
  /** What the run wrote there, and what it replaced: for the inducing model, not for memory. */
  readonly added: string
  readonly removed: string
}

export interface RunEvidence {
  readonly record: string
  readonly subject: string
  /** The eval task, or the start of the prompt. */
  readonly task: string
  /** What the run was asked to do: its prompt, or for a change in daily use, its commit titles and prompts (`promptOf`). */
  readonly prompt: string
  readonly base: string | null
  readonly tokens: number | null
  readonly turns: number
  /** In the order the run made them (by when it first edited each file). */
  readonly uses: ReadonlyArray<PlaceUse>
  readonly snapshots: ReadonlyArray<string>
  /** Commands that worked and checked something (tests, typecheck, lint, build): what each runs, and the shortest line that ran it. */
  readonly checks: ReadonlyArray<{ readonly key: string; readonly line: string }>
  readonly detours: ReadonlyArray<Detour>
  /** For each file it created: the files of the same kind it read before writing it. */
  readonly readFirst: ReadonlyArray<{ readonly created: string; readonly read: ReadonlyArray<string> }>
  /** The task's own values: names, keys and labels it introduced or named, while still its own (`stillOwn`), which memory must never carry. */
  readonly values: ReadonlyArray<string>
  /** The main thread's tool calls and working directory, for checking triggers against its detours. */
  readonly calls: ReadonlyArray<ToolCall>
  readonly cwd: string | undefined
  /** What it looked up before its first edit (Lookups.ts); null without its log. */
  readonly looking: Looking | null
  /** Places it read in files it didn't change (Reads.ts), in the order first read, with the turn (from 0). */
  readonly reads: ReadonlyArray<{ readonly place: string; readonly file: string; readonly turn: number }>
}

export interface Evidence {
  /** Places runs edited, pooled across runs. */
  readonly places: ReadonlyArray<Place>
  /** Places runs read in files they didn't change, pooled across runs (`reads` set). */
  readonly readPlaces: ReadonlyArray<Place>
  readonly runs: ReadonlyArray<RunEvidence>
  /** Runs left out, and why. */
  readonly skipped: ReadonlyArray<string>
  /** Edited files that are one of several named alike in their directory, with the start they share (`actionToggle`). */
  readonly families: ReadonlyMap<string, string>
}

const MAX_TEXT = 400

export const placeIdOf = (subject: string, key: string): string =>
  `p-${createHash("sha256").update(`${subject}\u0000${key}`).digest("hex").slice(0, 8)}`

const newFileKey = (dir: string, prefix: string, ext: string) => JSON.stringify(["new", dir, prefix, ext])

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s)

const MAX_LABEL = 60

/**
 * The task a run did: the eval task, or the start of its prompt (`promptOf`).
 * Tasks in a repo often start alike ("This is our fork of markdownlint. Add a
 * new built-in rule:"), so a prompt cut short ends with a hash of all of it:
 * different tasks never share a label, and the runs of one task always do.
 */
export const taskLabel = (r: WorkflowRecord, prompt: string = r.task.prompt): string => {
  if (r.run.task_id !== null) return r.run.task_id
  const text = prompt.trim().replace(/\s+/g, " ")
  if (text.length <= MAX_LABEL) return text
  return `${text.slice(0, MAX_LABEL).trimEnd()}… #${createHash("sha256").update(text).digest("hex").slice(0, 6)}`
}

/** A change's commit titles, at most, in its description: a command that made more is one change all the same. */
const MAX_TITLES = 5
/** Each prompt in a change's description is cut to this, and the description to the next: a pasted log or spec takes no round's room. */
const MAX_ASK = 400
const MAX_DESCRIPTION = 1500

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)

/**
 * A change in daily use as `promptOf` describes it: its commit titles, then
 * the prompts typed for it, in the person's own words (what they pasted or
 * quoted is left out: it says what they read, not what they asked).
 */
export const describeChange = (titles: ReadonlyArray<string>, prompts: ReadonlyArray<string>): string =>
  clipTo(
    [...titles.slice(0, MAX_TITLES), ...prompts.map((p) => clipTo(ownWords(p), MAX_ASK))].map((s) => s.trim()).filter((s) => s !== "").join("\n\n"),
    MAX_DESCRIPTION
  )

/**
 * What a run was asked to do: an eval run's prompt, or a session's stored
 * whole. A change stored in daily use (`run.segment`) is described by the
 * part of its session since the previous commit: the titles of its commits,
 * then every prompt typed in that time. Its first prompt alone is often no
 * ask at all: "commit and open a PR" while the last change's pull request
 * was still being opened, or "yes, do it" after a plan.
 */
const promptOf = Effect.fnUntraced(function*(r: WorkflowRecord, repo: string) {
  if (r.run.segment === undefined || r.run.base_commit === null || r.run.head_commit === null) return r.task.prompt
  const log = yield* git(repo, ["log", "--reverse", "--format=%s", `${r.run.base_commit}..${r.run.head_commit}`]).pipe(Effect.orElseSucceed(() => ""))
  return describeChange(log.split(/\r?\n/), [r.task.prompt, ...r.task.followups])
})

/** The run's change: its eval diff, or the session's commits. */
const diffOf = Effect.fnUntraced(function*(r: WorkflowRecord, repo: string | undefined) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (r.run.run_dir !== null && r.run.run_id !== null) {
    const file = path.join(r.run.run_dir, "runs", r.run.run_id, "diff.patch")
    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
      return (yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))).replace(/\r\n?/g, "\n")
    }
  }
  if (repo !== undefined && r.run.base_commit !== null && r.run.head_commit !== null) {
    return yield* git(repo, ["diff", r.run.base_commit, r.run.head_commit]).pipe(
      Effect.map((s) => s.replace(/\r\n?/g, "\n")),
      Effect.orElseSucceed(() => "")
    )
  }
  return ""
})

/** File names in a directory at a commit. */
const namesAt = Effect.fnUntraced(function*(repo: string, commit: string, dir: string) {
  const out = yield* git(repo, ["ls-tree", "--name-only", commit, `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/`]).pipe(
    Effect.orElseSucceed(() => "")
  )
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").map((l) => l.split("/").pop()!)
})

const splitName = (file: string) => {
  const slash = file.lastIndexOf("/")
  const dir = slash < 0 ? "" : file.slice(0, slash)
  const name = file.slice(slash + 1)
  const dot = name.lastIndexOf(".")
  return { dir, stem: dot <= 0 ? name : name.slice(0, dot), ext: dot <= 0 ? "" : name.slice(dot) }
}

/** The order a run first edited each file in, what it read before creating each new file, and the parts of files it read. */
const fromTranscript = Effect.fnUntraced(function*(r: WorkflowRecord, created: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const order = new Map<string, number>()
  const readFirst = new Map<string, Array<string>>()
  const spans: Array<ReadSpan & { readonly turn: number }> = []
  const none = {
    order,
    readFirst,
    spans,
    calls: [] as ReadonlyArray<ToolCall>,
    cwd: undefined as string | undefined,
    looking: null as Looking | null,
    mechanical: undefined as Mechanical | undefined
  }
  if (!(yield* fs.exists(r.run.log).pipe(Effect.orElseSucceed(() => false)))) return none
  const trace = yield* recordTrace(r).pipe(Effect.option)
  if (Option.isNone(trace)) return none
  const relative = relativizer(trace.value.cwd)
  const reads: Array<string> = []
  const calls = trace.value.toolCalls.filter((c) => c.agentId === undefined)
  const turnOf = new Map<string, number>()
  trace.value.responses.filter((x) => x.agentId === undefined).forEach((x, i) => x.toolCallIds.forEach((id) => turnOf.set(id, i)))
  for (const call of calls) {
    for (const s of readSpans(call, relative)) spans.push({ ...s, turn: turnOf.get(call.id) ?? 0 })
    const raw = call.input.file_path ?? call.input.notebook_path
    if (typeof raw !== "string") continue
    const file = relative(raw)
    if (call.name === "Read") reads.push(file)
    if (!EDIT_TOOLS.has(call.name)) continue
    if (!order.has(file)) order.set(file, order.size)
    if (created.includes(file) && !readFirst.has(file)) {
      const { dir } = splitName(file)
      readFirst.set(file, [...new Set(reads.filter((f) => f !== file && splitName(f).dir === dir))])
    }
  }
  // Its commands and detours as the rules judge them now (records/Outcome.ts): a record keeps what the rules said when it was made.
  const mechanical = extractMechanical(trace.value, "", { succeeded: r.run.outcome === "success" })
  return { order, readFirst, spans, calls, cwd: trace.value.cwd, looking: lookingOf(trace.value, relative), mechanical }
})

const IDENT = /[A-Za-z_$][\w$]{3,}/g
const LITERAL = /^(true|false|null|undefined|this|that|with|from|import|export|const|return)$/i

/** Prose: Markdown and plain text, whose words are English. Only what it puts in backticks is code. */
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i

const codeIn = (file: string, text: string): string =>
  PROSE.test(file) ? [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join("\n") : text

/** What a task's prompt names as its own: what it quotes or puts in backticks, and the keys it names (Alt+M). */
export const promptValues = (prompt: string): Array<string> => {
  const values = new Set<string>()
  for (const m of prompt.matchAll(/`([^`]+)`|"([^"]+)"|“([^”]+)”/g)) {
    const v = (m[1] ?? m[2] ?? m[3]).trim()
    if (v.length >= 2) values.add(v)
  }
  for (const m of prompt.matchAll(/\b(?:(?:Alt|Ctrl|Cmd|Shift|Meta|CtrlOrCmd)\+)+[A-Za-z0-9/']/g)) values.add(m[0])
  return [...values]
}

/**
 * Names a task's change may have brought into the code: those its edits added
 * to a file that didn't have them (in prose, only in backticks: a doc's new
 * sentence brings words, not names), and the names of the files it created
 * and what they export. Which of them are new to the repo is up to git
 * (`existingNames`): `Keyboard` is new to one test file, not to the repo.
 */
export const newNames = (
  edits: ReadonlyArray<{ readonly file: string; readonly added: ReadonlyArray<string>; readonly before: ReadonlyArray<string> | undefined }>,
  created: ReadonlyArray<{ readonly file: string; readonly content: string }>
): Array<string> => {
  const names = new Set<string>()
  for (const e of edits) {
    const before = new Set((e.before ?? []).join("\n").match(IDENT) ?? [])
    for (const name of codeIn(e.file, e.added.join("\n")).match(IDENT) ?? []) if (!before.has(name) && !LITERAL.test(name)) names.add(name)
  }
  for (const c of created) {
    names.add(splitName(c.file).stem)
    for (const m of c.content.matchAll(/export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  }
  return [...names]
}

/**
 * Searches run side by side. One word per search: git grep prints every line
 * that matches, and with many words that takes minutes in a repo with large
 * files (a hundred words: over three minutes in markdownlint, against a tenth
 * of a second for one), past the time git is given.
 */
const SEARCHES = 4

/** Which of `names` occur as whole words anywhere in the repo at `commit`. */
const existingNames = Effect.fnUntraced(function*(repo: string, commit: string, names: ReadonlyArray<string>) {
  // git grep -q stops at the first match, and exits 1 when nothing matches.
  const found = yield* Effect.forEach(
    names,
    (n) => git(repo, ["grep", "-q", "-I", "-w", "-F", "-e", n, commit, "--"]).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
    { concurrency: SEARCHES }
  )
  return new Set(names.filter((_, i) => found[i]))
})

/** Values no file can use as a word: long ones and ones across lines are a task's own wording. */
const MAX_WORD_VALUE = 120

/** The files that use each of `values` at `commit`, as a whole word in any case, by the value in lower case. */
const filesUsing = Effect.fnUntraced(function*(repo: string, commit: string, values: ReadonlyArray<string>) {
  const unique = [...new Set(values.map((v) => v.toLowerCase()))]
  // git grep exits 1 when nothing matches.
  const found = yield* Effect.forEach(
    unique,
    (v) => git(repo, ["grep", "-I", "-i", "-l", "-w", "-F", "-z", "-e", v, commit, "--"]).pipe(Effect.orElseSucceed(() => "")),
    { concurrency: SEARCHES }
  )
  const files = new Map<string, Set<string>>()
  unique.forEach((v, i) => {
    const used = found[i].split("\u0000").map((f) => f.trim()).filter((f) => f !== "")
    if (used.length > 0) files.set(v, new Set(used.map((f) => (f.startsWith(`${commit}:`) ? f.slice(commit.length + 1) : f))))
  })
  return files
})

/** A run's change committed in its repo: where, its last commit, and the files it touched. Eval runs' changes aren't commits. */
interface Committed {
  readonly repo: string
  readonly head: string
  readonly touched: ReadonlySet<string>
}

/**
 * A name stays a task's own while it is only the task's: once files its
 * change didn't touch use it, in any case, it is a word of the repo (`update`,
 * `hook`, `setup`), which memory may write. Read at the newest change memory
 * learns from: in a repo that grows, most of its words were new once. Eval
 * runs' changes never land in the repo, so their names stay theirs.
 */
const stillOwn = Effect.fnUntraced(function*(runs: ReadonlyArray<RunEvidence>, committed: ReadonlyMap<string, Committed>) {
  const out = [...runs]
  for (const subject of new Set(runs.filter((r) => committed.has(r.record)).map((r) => r.subject))) {
    const mine = out.flatMap((r, i) => (r.subject === subject && committed.has(r.record) ? [i] : []))
    const repo = committed.get(out[mine[0]].record)!.repo
    const heads = [...new Set(mine.map((i) => committed.get(out[i].record)!.head))]
    const newest = (yield* git(repo, ["rev-list", "--no-walk", "--ignore-missing", "-n", "1", ...heads]).pipe(Effect.orElseSucceed(() => ""))).trim()
    if (newest === "") continue
    const words = [...new Set(mine.flatMap((i) => out[i].values))].filter((v) => v.length <= MAX_WORD_VALUE && !/[\r\n]/.test(v))
    const users = yield* filesUsing(repo, newest, words)
    for (const i of mine) {
      const touched = committed.get(out[i].record)!.touched
      out[i] = { ...out[i], values: out[i].values.filter((v) => [...(users.get(v.toLowerCase()) ?? [])].every((f) => touched.has(f))) }
    }
  }
  return out
})

export interface GatherOptions {
  /** Where to read files at a run's base commit, when not in the run's own working directory. */
  readonly repo?: string | undefined
}

/** The evidence of successful runs, with the places they share. */
export const gatherEvidence = Effect.fn("gatherEvidence")(function*(records: ReadonlyArray<WorkflowRecord>, options: GatherOptions = {}) {
  const fs = yield* FileSystem.FileSystem
  const shapes = new Map<string, { readonly subject: string; readonly shape: PlaceShape; readonly newFile: Place["new_file"] }>()
  const pooled = new Map<string, { evidence: Set<string>; tasks: Set<string>; add: number; change: number; create: number }>()
  const readShapes = new Map<string, { readonly subject: string; readonly shape: PlaceShape }>()
  const readPooled = new Map<string, { evidence: Set<string>; tasks: Set<string> }>()
  const files = new Map<string, ReadonlyArray<string> | undefined>()
  const runs: Array<RunEvidence> = []
  const committed = new Map<string, Committed>()
  const skipped: Array<string> = []
  const families = new Map<string, string>()
  const checkedFamily = new Set<string>()
  /** Whether a file is one of several in its directory named alike: at least two others share a start that makes a kind (`isKindStart`). */
  const noteFamily = Effect.fnUntraced(function*(repo: string, base: string, file: string) {
    if (checkedFamily.has(file)) return
    checkedFamily.add(file)
    const { dir, stem } = splitName(file)
    const others = (yield* namesAt(repo, base, dir)).map((n) => splitName(n).stem).filter((n) => n !== stem)
    const starts = others.map((n) => sharedNameStart(stem, n)).filter((s) => isKindStart(stem, s))
    const best = starts.reduce((a, b) => (b.length > a.length ? b : a), "")
    // The longest start at least two others share.
    const shared = [...new Set(starts)].filter((s) => starts.filter((t) => t.startsWith(s)).length >= 2).sort((a, b) => b.length - a.length)[0]
    if (shared !== undefined && best !== "") families.set(file, shared)
  })

  for (const r of records) {
    if (r.run.outcome !== "success") continue
    const repo = options.repo ?? (r.run.repo !== null && (yield* fs.exists(r.run.repo).pipe(Effect.orElseSucceed(() => false))) ? r.run.repo : undefined)
    if (repo === undefined || r.run.base_commit === null) {
      skipped.push(`${r.id}: no repo or base commit to read its files at`)
      continue
    }
    const base = r.run.base_commit
    const diff = yield* diffOf(r, repo)
    if (diff.trim() === "") {
      skipped.push(`${r.id}: no diff`)
      continue
    }
    const d = editsOfDiff(diff)
    if (r.run.head_commit !== null) {
      committed.set(r.id, { repo, head: r.run.head_commit, touched: new Set([...d.edits.map((e) => e.file), ...d.created.map((c) => c.file), ...d.deleted, ...d.snapshots]) })
    }
    const linesAt = Effect.fnUntraced(function*(file: string) {
      const key = `${repo}\u0000${base}\u0000${file}`
      if (!files.has(key)) files.set(key, (yield* fileAt(repo, base, file))?.split("\n"))
      return files.get(key)
    })
    const prompt = yield* promptOf(r, repo)
    const label = taskLabel(r, prompt)
    const note = (id: string, kind: PlaceUse["kind"]) => {
      const p = pooled.get(id) ?? { evidence: new Set<string>(), tasks: new Set<string>(), add: 0, change: 0, create: 0 }
      p.evidence.add(r.id)
      p.tasks.add(label)
      if (kind === "create") p.create++
      else if (kind === "add") p.add++
      else p.change++
      pooled.set(id, p)
    }
    const uses: Array<PlaceUse & { readonly order: number }> = []
    const { order, readFirst, spans, calls, cwd, looking, mechanical } = yield* fromTranscript(r, d.created.map((c) => c.file))
    const orderOf = (file: string, fallback: number) => order.get(file) ?? 1000 + fallback
    const before: Array<{ readonly file: string; readonly added: ReadonlyArray<string>; readonly before: ReadonlyArray<string> | undefined }> = []

    for (const [i, e] of d.edits.entries()) {
      const lines = yield* linesAt(e.file)
      before.push({ file: e.file, added: e.added, before: lines })
      if (lines === undefined) continue
      yield* noteFamily(repo, base, e.file)
      const shape = placeOfEdit(lines, e)
      const id = placeIdOf(r.subject, placeKey(shape))
      if (!shapes.has(id)) shapes.set(id, { subject: r.subject, shape, newFile: null })
      note(id, e.kind)
      uses.push({ place: id, kind: e.kind, file: e.file, added: clip(e.added.join("\n")), removed: clip(e.removed.join("\n")), order: orderOf(e.file, i) })
    }
    for (const [i, c] of d.created.entries()) {
      const { dir, stem, ext } = splitName(c.file)
      const names = (yield* namesAt(repo, base, dir)).map((n) => splitName(n).stem)
      const prefix = names.map((n) => sharedNameStart(stem, n)).reduce((a, b) => (b.length > a.length ? b : a), "")
      const kept = isKindStart(stem, prefix) ? prefix : ""
      const id = placeIdOf(r.subject, newFileKey(dir, kept, ext))
      if (!shapes.has(id)) shapes.set(id, { subject: r.subject, shape: { file: dir, chain: [], group: null }, newFile: { dir, prefix: kept, ext } })
      note(id, "create")
      uses.push({ place: id, kind: "create", file: c.file, added: clip(c.content), removed: "", order: orderOf(c.file, d.edits.length + i) })
    }
    uses.sort((a, b) => a.order - b.order)

    // What it read in files it didn't change: the blocks those lines are in, at its base commit.
    const changed = new Set([...d.edits.map((e) => e.file), ...d.created.map((c) => c.file), ...d.deleted])
    const reads: Array<{ place: string; file: string; turn: number }> = []
    for (const s of spans) {
      if (changed.has(s.file)) continue
      const lines = yield* linesAt(s.file)
      if (lines === undefined) continue
      const shapes = placesOfRead(s.file, lines, linesOfSpan(lines, s))
      if (s.pattern !== undefined && shapes.length > MAX_SEARCH_PLACES) continue
      for (const shape of shapes) {
        const id = placeIdOf(r.subject, placeKey(shape))
        if (!readShapes.has(id)) readShapes.set(id, { subject: r.subject, shape })
        const p = readPooled.get(id) ?? { evidence: new Set<string>(), tasks: new Set<string>() }
        p.evidence.add(r.id)
        p.tasks.add(label)
        readPooled.set(id, p)
        if (!reads.some((x) => x.place === id)) reads.push({ place: id, file: s.file, turn: s.turn })
      }
    }

    // For each command that checks (tests, typecheck, lint, build) and worked: the shortest line that ran it.
    const shortest = new Map<string, string>()
    for (const c of (mechanical?.commands ?? r.commands).filter((c) => c.ok)) {
      for (const k of c.keys.filter((k) => ["test", "typecheck", "lint", "build"].includes(classifyKey(k)))) {
        const seen = shortest.get(k)
        if (seen === undefined || c.command.length < seen.length) shortest.set(k, c.command)
      }
    }
    const checks = [...shortest.entries()].map(([key, line]) => ({ key, line: line.trim().replace(/\s+/g, " ") }))
    const candidates = newNames(before, d.created)
    const existing = yield* existingNames(repo, base, candidates)
    const values = [...new Set([...promptValues(prompt), ...candidates.filter((n) => !existing.has(n))])].sort()
    runs.push({
      record: r.id,
      subject: r.subject,
      task: label,
      prompt,
      base,
      tokens: r.run.tokens,
      turns: r.run.turns,
      uses: uses.map(({ order: _order, ...u }) => u),
      snapshots: d.snapshots,
      checks,
      detours: mechanical?.detours ?? r.detours.filter(stillADetour),
      readFirst: [...readFirst.entries()].map(([created, read]) => ({ created, read })),
      values,
      calls,
      cwd,
      looking,
      reads
    })
  }

  const places: Array<Place> = [...shapes.entries()].map(([id, s]) => {
    const p = pooled.get(id)!
    return {
      id,
      subject: s.subject,
      file: s.shape.file,
      chain: s.shape.chain,
      group: s.shape.group,
      new_file: s.newFile,
      evidence: [...p.evidence].sort(),
      tasks: [...p.tasks].sort(),
      edits: { add: p.add, change: p.change, create: p.create }
    }
  })
  places.sort((a, b) => b.evidence.length - a.evidence.length || a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
  const readPlaces: Array<Place> = [...readShapes.entries()].map(([id, s]) => {
    const p = readPooled.get(id)!
    return {
      id,
      subject: s.subject,
      file: s.shape.file,
      chain: s.shape.chain,
      group: s.shape.group,
      new_file: null,
      evidence: [...p.evidence].sort(),
      tasks: [...p.tasks].sort(),
      edits: { add: 0, change: 0, create: 0 },
      reads: p.evidence.size,
      show: "outline" as const
    }
  })
  readPlaces.sort((a, b) => b.tasks.length - a.tasks.length || b.evidence.length - a.evidence.length || a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
  return { places, readPlaces, runs: yield* stillOwn(runs, committed), skipped, families } satisfies Evidence
})

/** A place as a PlaceShape, for finding it in code. */
export const shapeOf = (p: Place): PlaceShape => ({ file: p.file, chain: p.chain, group: p.group })

/**
 * The evidence of new runs, with each place counting the runs memory learned
 * from too (`learned`, other runs). A learning round reads the new runs only,
 * a few changes in daily use; read alone, a place three tasks edited is one
 * run's when one new run edited it, and can't carry a step. Only the places
 * the new runs edited and those `memory` has are listed: every place earlier
 * runs edited is hundreds in a repo used for a while, most of each round's
 * prompts, and earlier rounds already weighed them.
 */
export const withPlacesOf = (evidence: Evidence, learned: Evidence, memory: Pick<WorkflowMemory, "places">): Evidence => {
  const listed = new Set([...evidence.places, ...memory.places].map((p) => p.id))
  const pooled = new Map(learned.places.filter((p) => listed.has(p.id)).map((p) => [p.id, p]))
  for (const p of evidence.places) {
    const had = pooled.get(p.id)
    pooled.set(
      p.id,
      had === undefined ? p : {
        ...p,
        evidence: [...new Set([...had.evidence, ...p.evidence])].sort(),
        tasks: [...new Set([...had.tasks, ...p.tasks])].sort(),
        edits: { add: had.edits.add + p.edits.add, change: had.edits.change + p.edits.change, create: had.edits.create + p.edits.create }
      }
    )
  }
  const places = [...pooled.values()].sort((a, b) => b.evidence.length - a.evidence.length || a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
  return { ...evidence, places, families: new Map([...learned.families, ...evidence.families]) }
}
