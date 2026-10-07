/**
 * What a run still had to look up before its first edit: the reads and
 * searches of the turns before it changed anything. Each of those turns
 * rereads the whole context, so this is what memory's hand-over left out,
 * and what learning from results (Evolve.ts) can teach memory to give.
 *
 * Each lookup is told in terms of memory: a read around a place memory has
 * (shown to the run or not, with how much of it the hand-over showed), a
 * read of an existing file of the kind a step creates, or something memory
 * knows nothing about.
 *
 * Pure: a parsed session and places as found in the code at the run's start
 * in, words out.
 */
import { isReadOnlyCommand } from "../records/Shell.ts"
import { EDIT_TOOLS, SEARCH_TOOLS, SHELL_TOOLS, SHELL_WRITE, type ToolCall, type Trace, usageTotal } from "../traces/index.ts"
import { describePlace } from "./Induce.ts"
import type { Located } from "./Locate.ts"
import type { Place } from "./Models.ts"

export interface Lookup {
  /** The turn it was made in, from 0. */
  readonly turn: number
  readonly tool: string
  /** Reads: the file, relative to the repo, and the lines read, from 1 (`to` null: to the end). */
  readonly file: string | null
  readonly from: number | null
  readonly to: number | null
  /** Searches: the pattern (Grep, Glob) or the command line (shell). */
  readonly pattern: string | null
  /** Where a search looked, when it said. */
  readonly within: string | null
}

export interface Looking {
  /** The turns before the first edit, and their tokens. */
  readonly turns: number
  readonly tokens: number
  readonly lookups: ReadonlyArray<Lookup>
}

const MAX_PATTERN = 160

const isEdit = (c: ToolCall): boolean =>
  EDIT_TOOLS.has(c.name) || (SHELL_TOOLS.has(c.name) && typeof c.input.command === "string" && SHELL_WRITE.test(c.input.command))

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const clip = (s: string) => (s.length > MAX_PATTERN ? `${s.slice(0, MAX_PATTERN)}…` : s)

const lookupOf = (c: ToolCall, turn: number, relative: (p: string) => string): Lookup | undefined => {
  const none = { turn, tool: c.name, file: null, from: null, to: null, pattern: null, within: null }
  if (c.name === "Read") {
    const raw = str(c.input.file_path)
    if (raw === null) return undefined
    const offset = num(c.input.offset)
    const limit = num(c.input.limit)
    const from = offset === null ? 1 : Math.max(1, offset)
    return { ...none, file: relative(raw), from, to: limit === null ? null : from + limit - 1 }
  }
  if (SEARCH_TOOLS.has(c.name)) {
    const pattern = str(c.input.pattern)
    const within = str(c.input.path) ?? str(c.input.glob)
    return pattern === null ? undefined : { ...none, pattern: clip(pattern), within: within === null ? null : relative(within) }
  }
  if (SHELL_TOOLS.has(c.name)) {
    const command = str(c.input.command)
    return command === null || !isReadOnlyCommand(command) ? undefined : { ...none, pattern: clip(command.trim().replace(/\s+/g, " ")) }
  }
  return undefined
}

/** The main thread's lookups before its first edit (all of them when it never edited). */
export const lookingOf = (trace: Trace, relative: (p: string) => string): Looking => {
  const calls = new Map(trace.toolCalls.map((c) => [c.id, c]))
  const turns = trace.responses
    .filter((r) => r.agentId === undefined)
    .map((r) => ({ tokens: usageTotal(r.usage), calls: r.toolCallIds.flatMap((id) => calls.get(id) ?? []) }))
  const first = turns.findIndex((t) => t.calls.some(isEdit))
  const before = first < 0 ? turns : turns.slice(0, first)
  return {
    turns: before.length,
    tokens: before.reduce((n, t) => n + t.tokens, 0),
    lookups: before.flatMap((t, turn) => t.calls.flatMap((c) => lookupOf(c, turn, relative) ?? []))
  }
}

const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"

const lines = (from: number, to: number) => (from === to ? `line ${from}` : `lines ${from}-${to}`)

/**
 * A lookup in memory's terms. `located`: memory's places as found in the
 * code the run started from; `shown`: the places it was handed, with the
 * lines of each the hand-over showed (1-based, inclusive).
 */
export const describeLookup = (
  l: Lookup,
  places: ReadonlyArray<Place>,
  located: ReadonlyMap<string, Located>,
  shown: ReadonlyMap<string, ReadonlyArray<number>>
): string => {
  if (l.file === null) {
    return `searched ${l.tool === "Grep" || l.tool === "Glob" ? `for ${code(l.pattern ?? "")}${l.within === null ? "" : ` in ${code(l.within)}`}` : `with ${code(l.pattern ?? "")}`}`
  }
  const span = l.to === null ? (l.from === 1 ? "the whole file" : `from line ${l.from}`) : lines(l.from ?? 1, l.to)
  const file: string = l.file
  const what = `read ${code(file)}, ${span}`
  const around: Array<string> = []
  for (const p of places) {
    const at = located.get(p.id)
    if (at === undefined) continue
    if (at.kind === "new-file") {
      const name: string = file.split("/").pop() ?? ""
      if (file === `${at.dir}/${name}` && name.startsWith(at.prefix)) {
        around.push(`an existing file of the kind place ${p.id} creates (${describePlace(p)})`)
      }
      continue
    }
    if (at.file !== file) continue
    const from = at.region.from + 1
    const to = at.region.to + 1
    if ((l.to ?? Number.MAX_SAFE_INTEGER) < from || (l.from ?? 1) > to) continue
    const seen = shown.get(p.id)
    around.push(
      `place ${p.id} (${lines(from, to)}): ${
        seen === undefined ? "not handed over" : seen.length === 0 ? "handed over without its code" : `the hand-over showed ${seen.length} of its ${to - from + 1} lines`
      }`
    )
  }
  return around.length === 0 ? `${what}: no place memory has` : `${what}, around ${around.join("; ")}`
}
