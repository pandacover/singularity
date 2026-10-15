/**
 * The `scripts` setup: remember each successful run as a worked example.
 *
 * After a successful run, save its prompt, the files it changed, its source diff
 * (snapshot files are listed but not included), the shell commands that
 * worked (no error, and no failure in their output: a pipe into `tail` hides a
 * failed exit status) and the mistakes it made. Before a run, pick the saved
 * run most like the new task with the daily search (src/scripts/Search.ts:
 * none below its score) and hand it over in the system prompt, shown as the
 * daily hook shows a stored commit (src/scripts/Render.ts, within one hook's
 * room).
 *
 * Retrieval uses the prompt text only, never the task id or family, so the
 * setup has no information the agent wouldn't have in real use.
 *
 * The first saved-scripts setups (`saved-scripts`, `saved-scripts-top2`),
 * which picked by the cosine of word counts and showed a longer note, were
 * removed; their saved runs are this setup's (same files), and `eval report`
 * still reads their results.
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { reportsFailure, SHELL_TOOLS } from "../traces/index.ts"
import type { Injection, MemorySetup, Outcome, SetupServices } from "./Setups.ts"
import { MemoryError } from "./Setups.ts"
import { isoNow } from "./Time.ts"
import { extractMechanical } from "../records/Extract.ts"
import { commandsToShow, countLines, diffChunks, mistakesNearby, mistakesToShow, renderScript } from "../scripts/Render.ts"
import { MIN_SCORE, rank, tellingFiles } from "../scripts/Search.ts"

export const MAX_COMMANDS = 8

/** One saved run, stored as `<memory dir>/<id>.json` (snake_case keys, as the Python version wrote them). */
export const Entry = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  prompt: Schema.String,
  files_changed: Schema.Array(Schema.String),
  snapshots_changed: Schema.Array(Schema.String),
  source_diff: Schema.String,
  commands: Schema.Array(Schema.String),
  tool_calls: Schema.NullOr(Schema.Number),
  created_at: Schema.String,
  /** Failed commands with what worked instead (src/scripts/Render.ts); entries saved before it lack it. */
  mistakes: Schema.optionalKey(Schema.Array(Schema.String))
})
export type Entry = typeof Entry.Type

const EntryJson = Schema.fromJsonString(Entry)

export interface SavedScripts extends MemorySetup {
  /** The saved runs, in file-name order. */
  readonly entries: Effect.Effect<Array<Entry>, MemoryError, SetupServices>
}

export const makeScripts = (memoryDir: string, frozen = false): SavedScripts => {
  const entries: SavedScripts["entries"] = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (!(yield* fs.exists(memoryDir))) return [] as Array<Entry>
    const names = (yield* fs.readDirectory(memoryDir)).filter((n) => n.endsWith(".json")).sort()
    return yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(memoryDir, name)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EntryJson)),
        Effect.mapError((e) => new MemoryError({ message: `${name}: ${e.message}` }))
      ))
  }).pipe(Effect.mapError((e) => (e instanceof MemoryError ? e : new MemoryError({ message: e.message }))))

  const beforeRun = Effect.fn("Scripts.beforeRun")(function*(task: { readonly prompt: string }) {
    const all = yield* entries
    const top = rank(task.prompt, all)[0]
    const info = { entries: all.length, frozen, similarity: round3(top?.score ?? 0) }
    if (top === undefined || top.score < MIN_SCORE) {
      return { systemPrompt: undefined, info: { ...info, retrieved: null } } satisfies Injection
    }
    const text = renderEntry(top.doc, top.score, all.filter((e) => e.id !== top.doc.id).reverse())
    return {
      systemPrompt: text,
      info: { ...info, retrieved: { id: top.doc.id, task_id: top.doc.task_id }, chars: text.length }
    } satisfies Injection
  })

  const afterRun = Effect.fn("Scripts.afterRun")(function*(outcome: Outcome) {
    if (frozen || !outcome.success) return
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entry = makeEntry(outcome)
    // Keep one entry per prompt: the cheapest successful run.
    for (const old of yield* entries) {
      if (old.prompt !== entry.prompt) continue
      if ((old.tool_calls ?? 0) <= (entry.tool_calls ?? 0)) return
      yield* fs.remove(path.join(memoryDir, `${old.id}.json`))
    }
    yield* fs.makeDirectory(memoryDir, { recursive: true })
    yield* fs.writeFileString(path.join(memoryDir, `${entry.id}.json`), JSON.stringify(entry, null, 2) + "\n")
  }, Effect.mapError((e) => (e instanceof MemoryError ? e : new MemoryError({ message: e.message }))))

  return { name: "scripts", beforeRun, afterRun, entries }
}

/** A saved run as the daily hook shows a stored commit. */
export const renderEntry = (entry: Entry, score: number, others: ReadonlyArray<Entry> = []): string => {
  const chunks = diffChunks(entry.source_diff)
  const links = tellingFiles([entry, ...others].map((e) => ({ files: e.files_changed })), 2)
  const counts = new Map(chunks.map((c) => [c.path, countLines(c.text)] as const))
  return renderScript({
    prompt: entry.prompt,
    commit: null,
    score,
    files: [
      ...entry.files_changed.map((path) => ({ path, status: "modified" as const, ...(counts.get(path) ?? { added: 0, removed: 0 }), snapshot: false, now: path })),
      ...entry.snapshots_changed.map((path) => ({ path, status: "modified" as const, added: 0, removed: 0, snapshot: true, now: path }))
    ],
    commands: commandsToShow(entry.commands.map((command) => ({ command, ok: true }))),
    mistakes: entry.mistakes ?? [],
    nearby: mistakesNearby(entry.files_changed.filter(links), others.map((o) => ({ files: o.files_changed, mistakes: o.mistakes ?? [] })), entry.mistakes ?? []),
    diff: chunks
  })
}

export const makeEntry = (outcome: Outcome): Entry => {
  const [files, snapshots, source] = splitDiff(outcome.diff)
  const commands: Array<string> = []
  for (const c of outcome.trace?.toolCalls ?? []) {
    const cmd = String(c.input.command || "").trim()
    const worked = !c.isError && !reportsFailure(c.result ?? "")
    if (SHELL_TOOLS.has(c.name) && worked && cmd && !commands.includes(cmd)) commands.push(cmd.slice(0, 300))
  }
  return {
    id: `${outcome.task.id}-${compactTimestamp()}`,
    task_id: outcome.task.id,
    prompt: outcome.task.prompt,
    files_changed: files,
    snapshots_changed: snapshots,
    source_diff: source,
    commands: commands.slice(-MAX_COMMANDS),
    tool_calls: outcome.trace === undefined ? null : outcome.trace.toolCalls.length,
    created_at: isoNow(),
    mistakes: outcome.trace === undefined ? [] : mistakesToShow(extractMechanical(outcome.trace, outcome.diff, { succeeded: true }).detours)
  }
}

/** Changed files, changed snapshot files, and the diff without snapshots. */
export const splitDiff = (diff: string): [Array<string>, Array<string>, string] => {
  const files: Array<string> = []
  const snapshots: Array<string> = []
  const kept: Array<string> = []
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue
    const firstLine = chunk.split("\n", 1)[0].replace(/\r$/, "")
    const at = firstLine.lastIndexOf(" b/")
    const path = at >= 0 ? firstLine.slice(at + 3) : firstLine
    if (path.endsWith(".snap") || path.includes("/__snapshots__/")) {
      snapshots.push(path)
    } else {
      files.push(path)
      kept.push(chunk)
    }
  }
  return [files, snapshots, kept.join("")]
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000

/** `YYYYMMDDHHMMSS` plus six fractional digits, like the Python version's `%Y%m%d%H%M%S%f`. */
const compactTimestamp = (): string => {
  const now = new Date()
  const micros = String(now.getUTCMilliseconds() * 1000 + Math.floor(Math.random() * 1000)).padStart(6, "0")
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14) + micros
}
