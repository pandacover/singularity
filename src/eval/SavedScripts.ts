/**
 * The simple baseline: remember each successful run as a worked example.
 *
 * After a successful run, save its prompt, the files it changed, its source diff
 * (snapshot files are listed but not included) and the shell commands that
 * worked. Before a run, find the saved run whose prompt is most similar to the
 * new one and hand it to the agent in the system prompt. An exact repeat gets
 * the whole recipe; a similar task gets a worked example to adapt.
 *
 * Retrieval uses the prompt text only, never the task id or family, so the
 * setup has no information the agent wouldn't have in real use.
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { SHELL_TOOLS } from "../traces/index.ts"
import type { Injection, MemorySetup, Outcome, SetupServices } from "./Setups.ts"
import { MemoryError } from "./Setups.ts"
import { isoNow } from "./Time.ts"

/** Below this prompt similarity, nothing is injected. */
export const MIN_SIMILARITY = 0.35
export const MAX_DIFF_CHARS = 16_000
export const MAX_COMMANDS = 8

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have in into is it its of on or " +
    "should so that the this to was were will with make sure pass tests typecheck"
  ).split(" ")
)

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
  created_at: Schema.String
})
export type Entry = typeof Entry.Type

const EntryJson = Schema.fromJsonString(Entry)

export interface SavedScripts extends MemorySetup {
  /** The saved runs, in file-name order. */
  readonly entries: Effect.Effect<Array<Entry>, MemoryError, SetupServices>
}

export const makeSavedScripts = (memoryDir: string, frozen = false): SavedScripts => {
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

  const beforeRun = Effect.fn("SavedScripts.beforeRun")(function*(task: { readonly prompt: string }) {
    const all = yield* entries
    const [best, score] = bestMatch(task.prompt, all)
    const info = { entries: all.length, frozen, similarity: Math.round(score * 1000) / 1000 }
    if (best === undefined || score < MIN_SIMILARITY) {
      return { systemPrompt: undefined, info: { ...info, retrieved: null } } satisfies Injection
    }
    return {
      systemPrompt: render(best),
      info: { ...info, retrieved: { id: best.id, task_id: best.task_id } }
    } satisfies Injection
  })

  const afterRun = Effect.fn("SavedScripts.afterRun")(function*(outcome: Outcome) {
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

  return { name: "saved-scripts", beforeRun, afterRun, entries }
}

export const makeEntry = (outcome: Outcome): Entry => {
  const [files, snapshots, source] = splitDiff(outcome.diff)
  const commands: Array<string> = []
  for (const c of outcome.trace?.toolCalls ?? []) {
    const cmd = String(c.input.command || "").trim()
    if (SHELL_TOOLS.has(c.name) && !c.isError && cmd && !commands.includes(cmd)) commands.push(cmd.slice(0, 300))
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
    created_at: isoNow()
  }
}

export const render = (entry: Entry): string => {
  const files = entry.files_changed.map((f) => `- ${f}`).join("\n") || "- (none)"
  const snaps = entry.snapshots_changed.map((f) => `- ${f}`).join("\n")
  const commands = entry.commands.map((c) => `- \`${c}\``).join("\n") || "- (none recorded)"
  let diff = entry.source_diff
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)\n"
  const parts = [
    "# Notes from a previous task in this repository",
    "",
    "A task like the one you're about to do was solved successfully here before. " +
    "Below is what that run changed. Use it as a guide where it applies, and adapt " +
    "it to the current task: names, keys and details may differ.",
    "",
    "## The previous task",
    "",
    entry.prompt,
    "",
    "## Files it changed",
    "",
    files
  ]
  if (snaps) parts.push("", "Snapshot files it regenerated (not shown below):", "", snaps)
  parts.push(
    "",
    "## Shell commands it ran successfully",
    "",
    commands,
    "",
    "## Its change to source files",
    "",
    "```diff",
    diff.replace(/\n+$/, ""),
    "```",
    ""
  )
  return parts.join("\n")
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

const words = (text: string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (!STOPWORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return counts
}

export const cosine = (a: Map<string, number>, b: Map<string, number>): number => {
  let dot = 0
  for (const [w, n] of a) dot += n * (b.get(w) ?? 0)
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0))
  const denom = norm(a) * norm(b)
  return denom ? dot / denom : 0
}

export const promptSimilarity = (a: string, b: string): number => cosine(words(a), words(b))

/** The entry with the most similar prompt (the first one on ties), and its score. */
export const bestMatch = (prompt: string, entries: ReadonlyArray<Entry>): [Entry | undefined, number] => {
  const query = words(prompt)
  let best: Entry | undefined
  let bestScore = 0
  for (const e of entries) {
    const score = cosine(query, words(e.prompt))
    if (best === undefined || score > bestScore) {
      best = e
      bestScore = score
    }
  }
  return [best, bestScore]
}

/** `YYYYMMDDHHMMSS` plus six fractional digits, like the Python version's `%Y%m%d%H%M%S%f`. */
const compactTimestamp = (): string => {
  const now = new Date()
  const micros = String(now.getUTCMilliseconds() * 1000 + Math.floor(Math.random() * 1000)).padStart(6, "0")
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14) + micros
}
