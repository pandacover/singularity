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
import { relativizer } from "../records/Extract.ts"
import { classifyKey } from "../records/Shell.ts"
import { EDIT_TOOLS, parseSession, type ToolCall } from "../traces/index.ts"
import { editsOfDiff, placeOfEdit } from "./Edits.ts"
import type { Place } from "./Models.ts"
import { placeKey, type PlaceShape, sharedNameStart } from "./Places.ts"

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
  /** The task's own values: names, keys and labels it introduced or named, which memory must never carry. */
  readonly values: ReadonlyArray<string>
  /** The main thread's tool calls and working directory, for checking triggers against its detours. */
  readonly calls: ReadonlyArray<ToolCall>
  readonly cwd: string | undefined
}

export interface Evidence {
  readonly places: ReadonlyArray<Place>
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

export const taskLabel = (r: WorkflowRecord): string => r.run.task_id ?? r.task.prompt.trim().replace(/\s+/g, " ").slice(0, 60)

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

/** The order a run first edited each file in, and what it read before creating each new file. */
const fromTranscript = Effect.fnUntraced(function*(r: WorkflowRecord, created: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const order = new Map<string, number>()
  const readFirst = new Map<string, Array<string>>()
  const none = { order, readFirst, calls: [] as ReadonlyArray<ToolCall>, cwd: undefined as string | undefined }
  if (!(yield* fs.exists(r.run.log).pipe(Effect.orElseSucceed(() => false)))) return none
  const trace = yield* parseSession(r.run.log).pipe(Effect.option)
  if (Option.isNone(trace)) return none
  const relative = relativizer(trace.value.cwd)
  const reads: Array<string> = []
  const calls = trace.value.toolCalls.filter((c) => c.agentId === undefined)
  for (const call of calls) {
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
  return { order, readFirst, calls, cwd: trace.value.cwd }
})

const IDENT = /[A-Za-z_$][\w$]{3,}/g
const LITERAL = /^(true|false|null|undefined|this|that|with|from|import|export|const|return)$/i

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
 * to a file that didn't have them, and the names of the files it created and
 * what they export. Which of them are new to the repo is up to git
 * (`existingNames`): `Keyboard` is new to one test file, not to the repo.
 */
export const newNames = (
  edits: ReadonlyArray<{ readonly added: ReadonlyArray<string>; readonly before: ReadonlyArray<string> | undefined }>,
  created: ReadonlyArray<{ readonly file: string; readonly content: string }>
): Array<string> => {
  const names = new Set<string>()
  for (const e of edits) {
    const before = new Set((e.before ?? []).join("\n").match(IDENT) ?? [])
    for (const name of e.added.join("\n").match(IDENT) ?? []) if (!before.has(name) && !LITERAL.test(name)) names.add(name)
  }
  for (const c of created) {
    names.add(splitName(c.file).stem)
    for (const m of c.content.matchAll(/export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  }
  return [...names]
}

/** Which of `names` occur as whole words anywhere in the repo at `commit`. */
const existingNames = Effect.fnUntraced(function*(repo: string, commit: string, names: ReadonlyArray<string>) {
  const found = new Set<string>()
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100)
    // git grep exits 1 when nothing matches.
    const out = yield* git(repo, ["grep", "-h", "-o", "-w", "-F", ...chunk.flatMap((n) => ["-e", n]), commit, "--"]).pipe(
      Effect.orElseSucceed(() => "")
    )
    for (const l of out.split(/\r?\n/)) if (l.trim() !== "") found.add(l.trim())
  }
  return found
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
  const files = new Map<string, ReadonlyArray<string> | undefined>()
  const runs: Array<RunEvidence> = []
  const skipped: Array<string> = []
  const families = new Map<string, string>()
  const checkedFamily = new Set<string>()
  /** Whether a file is one of several in its directory named alike: at least two others share a start of 4 letters or more. */
  const noteFamily = Effect.fnUntraced(function*(repo: string, base: string, file: string) {
    if (checkedFamily.has(file)) return
    checkedFamily.add(file)
    const { dir, stem } = splitName(file)
    const others = (yield* namesAt(repo, base, dir)).map((n) => splitName(n).stem).filter((n) => n !== stem)
    const starts = others.map((n) => sharedNameStart(stem, n)).filter((s) => s.length >= 4)
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
    const linesAt = Effect.fnUntraced(function*(file: string) {
      const key = `${repo}\u0000${base}\u0000${file}`
      if (!files.has(key)) files.set(key, (yield* fileAt(repo, base, file))?.split("\n"))
      return files.get(key)
    })
    const label = taskLabel(r)
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
    const { order, readFirst, calls, cwd } = yield* fromTranscript(r, d.created.map((c) => c.file))
    const orderOf = (file: string, fallback: number) => order.get(file) ?? 1000 + fallback
    const before: Array<{ readonly added: ReadonlyArray<string>; readonly before: ReadonlyArray<string> | undefined }> = []

    for (const [i, e] of d.edits.entries()) {
      const lines = yield* linesAt(e.file)
      before.push({ added: e.added, before: lines })
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
      const kept = prefix.length >= 4 ? prefix : ""
      const id = placeIdOf(r.subject, newFileKey(dir, kept, ext))
      if (!shapes.has(id)) shapes.set(id, { subject: r.subject, shape: { file: dir, chain: [], group: null }, newFile: { dir, prefix: kept, ext } })
      note(id, "create")
      uses.push({ place: id, kind: "create", file: c.file, added: clip(c.content), removed: "", order: orderOf(c.file, d.edits.length + i) })
    }
    uses.sort((a, b) => a.order - b.order)

    // For each command that checks (tests, typecheck, lint, build) and worked: the shortest line that ran it.
    const shortest = new Map<string, string>()
    for (const c of r.commands.filter((c) => c.ok)) {
      for (const k of c.keys.filter((k) => ["test", "typecheck", "lint", "build"].includes(classifyKey(k)))) {
        const seen = shortest.get(k)
        if (seen === undefined || c.command.length < seen.length) shortest.set(k, c.command)
      }
    }
    const checks = [...shortest.entries()].map(([key, line]) => ({ key, line: line.trim().replace(/\s+/g, " ") }))
    const candidates = newNames(before, d.created)
    const existing = yield* existingNames(repo, base, candidates)
    const values = [...new Set([...promptValues(r.task.prompt), ...candidates.filter((n) => !existing.has(n))])].sort()
    runs.push({
      record: r.id,
      subject: r.subject,
      task: label,
      prompt: r.task.prompt,
      base,
      tokens: r.run.tokens,
      turns: r.run.turns,
      uses: uses.map(({ order: _order, ...u }) => u),
      snapshots: d.snapshots,
      checks,
      detours: r.detours,
      readFirst: [...readFirst.entries()].map(([created, read]) => ({ created, read })),
      values,
      calls,
      cwd
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
  return { places, runs, skipped, families } satisfies Evidence
})

/** A place as a PlaceShape, for finding it in code. */
export const shapeOf = (p: Place): PlaceShape => ({ file: p.file, chain: p.chain, group: p.group })
