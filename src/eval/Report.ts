/**
 * Summarize results.jsonl files into comparison tables.
 *
 * Medians with (min-max) ranges throughout: run-to-run variance is large, so a
 * single mean would hide whether two setups actually differ.
 */
import { Effect, FileSystem, Path, Predicate, Schema } from "effect"
import { median, pyFixed, pyPercentSigned } from "./PyFormat.ts"

/** One line of results.jsonl. Old and new records differ in which keys they have, so it stays loosely typed. */
export type RunRecord = Readonly<Record<string, unknown>>

export class ReportError extends Schema.TaggedError<ReportError>()("ReportError", {
  message: Schema.String
}) {}

const RecordLine = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** Records from results.jsonl files or run output directories, in order. */
export const loadRecords = Effect.fn("loadRecords")(function*(paths: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const records: Array<RunRecord> = []
  for (const p of paths) {
    const isDir = yield* fs.stat(p).pipe(
      Effect.map((s) => s.type === "Directory"),
      Effect.mapError((e) => new ReportError({ message: e.message }))
    )
    const file = isDir ? path.join(p, "results.jsonl") : p
    const text = yield* fs.readFileString(file).pipe(Effect.mapError((e) => new ReportError({ message: e.message })))
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue
      records.push(
        yield* Schema.decodeUnknownEffect(RecordLine)(line).pipe(
          Effect.mapError((e) => new ReportError({ message: `${file}: ${e.message}` }))
        )
      )
    }
  }
  return records
})

/** A nested field: `field(r, "trace", "tool_calls")`. */
export const field = (r: unknown, ...keys: ReadonlyArray<string>): unknown =>
  keys.reduce<unknown>((v, k) => (Predicate.isObject(v) ? (v as Record<string, unknown>)[k] : undefined), r)

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : undefined)

const nums = (values: ReadonlyArray<unknown>): Array<number> =>
  values.map(num).filter((v): v is number => v !== undefined)

/** Markdown table per (setup, task), plus a row per setup over all tasks. */
export const summarize = (records: ReadonlyArray<RunRecord>): string => {
  const groups = groupBy(records, (r) => `${r.setup}\u0000${r.task_id}`)
  const bySetup = groupBy(records, (r) => String(r.setup))
  const header = ["setup", "task", "runs", "success", "cost $", "tokens", "wall s", "tool calls", "issues"]
  const rows = [...groups.values()].map((rs) => summaryRow(String(rs[0].setup), String(rs[0].task_id), rs))
  if (groups.size > bySetup.size) {
    for (const [setup, rs] of bySetup) rows.push(summaryRow(setup, "**all**", rs))
  }
  return table(header, rows)
}

const summaryRow = (setup: string, task: string, rs: ReadonlyArray<RunRecord>): Array<string> => {
  const issues = rs.map((r) => r.status).filter((s) => s !== "completed").map(String)
  const counts = [...new Set(issues)].sort(byCodePoint).map((s) => `${issues.filter((i) => i === s).length} ${s}`)
  return [
    setup,
    task,
    String(rs.length),
    ok(rs),
    spread(rs.map((r) => r.cost_usd), (x) => pyFixed(x, 2)),
    spread(rs.map((r) => field(r, "tokens", "total")), (x) => pyFixed(x, 0, true), 1e-3, "k"),
    spread(rs.map((r) => r.wall_time_s), (x) => pyFixed(x, 0)),
    spread(rs.map((r) => field(r, "trace", "tool_calls")), (x) => pyFixed(x, 0)),
    counts.join(", ")
  ]
}

const spread = (values: ReadonlyArray<unknown>, fmt: (x: number) => string, scale = 1, suffix = ""): string => {
  const xs = nums(values).map((v) => v * scale)
  if (xs.length === 0) return "-"
  const med = fmt(median(xs)) + suffix
  return xs.length === 1 ? med : `${med} (${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))})`
}

/** How a memory run relates to what it retrieved: exact repeat, similar task, or nothing. */
export const runKind = (r: RunRecord): string => {
  const retrieved = field(r, "injection", "retrieved", "task_id")
  if (retrieved === undefined || retrieved === null) return "no match"
  return retrieved === r.task_id ? "exact repeat" : "similar task"
}

interface Metric {
  readonly name: string
  readonly get: (r: RunRecord) => number | undefined
  readonly fmt: (x: number) => string
}

const METRICS: ReadonlyArray<Metric> = [
  { name: "tool calls", get: (r) => num(field(r, "trace", "tool_calls")), fmt: (x) => pyFixed(x, 0) },
  {
    name: "tokens",
    get: (r) => {
      const total = num(field(r, "tokens", "total")) ?? 0
      return total / 1000 || undefined
    },
    fmt: (x) => pyFixed(x, 0, true) + "k"
  },
  { name: "cost $", get: (r) => num(r.cost_usd), fmt: (x) => pyFixed(x, 2) },
  { name: "wall s", get: (r) => num(r.wall_time_s), fmt: (x) => pyFixed(x, 0) }
]

/**
 * Each memory setup against the baseline, per task and per kind of run.
 *
 * Task rows read "baseline -> setup (change)", using medians. Group rows give
 * the median of the per-task changes (and their range), so a cheap task and an
 * expensive one count equally instead of pooling runs with different baselines.
 */
export const compare = (records: ReadonlyArray<RunRecord>, baseline = "no-memory"): string => {
  const base = groupBy(records.filter((r) => r.setup === baseline), (r) => String(r.task_id))
  const other = groupBy(records.filter((r) => r.setup !== baseline), (r) => `${r.setup}\u0000${r.task_id}`)
  if (base.size === 0 || other.size === 0) {
    throw new ReportError({ message: `need runs of '${baseline}' and of at least one other setup` })
  }

  const header = ["setup", "task", "kind", "runs", "success", ...METRICS.map((m) => m.name)]
  const rows: Array<Array<string>> = []
  interface Group {
    tasks: number
    runs: number
    ok: Array<unknown>
    changes: Map<string, Array<number>>
  }
  const groups = new Map<string, Group>()
  for (const rs of other.values()) {
    const setup = String(rs[0].setup)
    const task = String(rs[0].task_id)
    const b = base.get(task) ?? []
    const kinds = [...new Set(rs.map(runKind))].sort(byCodePoint)
    rows.push([setup, task, kinds.join(", "), `${b.length} / ${rs.length}`, `${ok(b)} / ${ok(rs)}`, ...METRICS.map((m) => delta(b, rs, m))])
    for (const kind of kinds) {
      const sub = rs.filter((r) => runKind(r) === kind)
      const key = `${setup}\u0000${kind}`
      let g = groups.get(key)
      if (g === undefined) {
        g = { tasks: 0, runs: 0, ok: [], changes: new Map(METRICS.map((m) => [m.name, []])) }
        groups.set(key, g)
      }
      g.tasks += 1
      g.runs += sub.length
      g.ok.push(...sub.map((r) => r.success).filter((s) => s !== undefined && s !== null))
      for (const m of METRICS) {
        const c = change(b, sub, m)
        if (c !== undefined) g.changes.get(m.name)!.push(c)
      }
    }
  }
  for (const key of [...groups.keys()].sort(byCodePoint)) {
    const g = groups.get(key)!
    const [setup, kind] = key.split("\u0000")
    const okText = g.ok.length ? `${nums(g.ok).reduce((a, v) => a + v, 0)}/${g.ok.length}` : "n/a"
    rows.push([setup, `**${g.tasks} tasks**`, `**${kind}**`, String(g.runs), okText, ...METRICS.map((m) => spreadPct(g.changes.get(m.name)!))])
  }
  const note =
    `Task rows: ${baseline} -> setup (change), medians; runs and success are ${baseline} / setup.\n` +
    "Group rows: median per-task change (range across tasks); runs and success are the setup's."
  return `${note}\n\n${table(header, rows)}`
}

const values = (rs: ReadonlyArray<RunRecord>, m: Metric): Array<number> =>
  rs.map(m.get).filter((v): v is number => v !== undefined)

const change = (b: ReadonlyArray<RunRecord>, s: ReadonlyArray<RunRecord>, m: Metric): number | undefined => {
  const bx = values(b, m)
  const sx = values(s, m)
  if (bx.length === 0 || sx.length === 0 || !median(bx)) return undefined
  const mb = median(bx)
  return (median(sx) - mb) / mb
}

const delta = (b: ReadonlyArray<RunRecord>, s: ReadonlyArray<RunRecord>, m: Metric): string => {
  const bx = values(b, m)
  const sx = values(s, m)
  if (bx.length === 0 || sx.length === 0) return "-"
  const mb = median(bx)
  const ms = median(sx)
  const c = mb ? ` (${pyPercentSigned((ms - mb) / mb)})` : ""
  return `${m.fmt(mb)} -> ${m.fmt(ms)}${c}`
}

const spreadPct = (changes: ReadonlyArray<number>): string => {
  if (changes.length === 0) return "-"
  const med = pyPercentSigned(median(changes))
  return changes.length === 1
    ? med
    : `${med} (${pyPercentSigned(Math.min(...changes))} to ${pyPercentSigned(Math.max(...changes))})`
}

const ok = (rs: ReadonlyArray<RunRecord>): string => {
  const known = rs.map((r) => r.success).filter((s) => s !== undefined && s !== null)
  return known.length ? `${nums(known).reduce((a, v) => a + v, 0)}/${known.length}` : "n/a"
}

const table = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: ReadonlyArray<string>) => "| " + cells.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |"
  return [line(header), "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|", ...rows.map(line)].join("\n")
}

const groupBy = <A>(items: ReadonlyArray<A>, key: (a: A) => string): Map<string, Array<A>> => {
  const out = new Map<string, Array<A>>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list === undefined) out.set(k, [item])
    else list.push(item)
  }
  return out
}

/** Python's default string order (by code point), unlike `localeCompare`. */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
