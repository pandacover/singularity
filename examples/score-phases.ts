/**
 * Where runs' turns and tokens go, by phase, read from run output directories
 * (no new runs):
 *
 *     node examples/score-phases.ts NAME=DIR[,DIR...] NAME=DIR... [--task ID ...] [-v]
 *
 * Each NAME is a group of run directories (a setup and its lanes). Per run:
 * success, tokens, dollars, turns; the turns before the first edit (looking:
 * what memory didn't give) with their tokens and how many reads and searches
 * they made; the turns after the last edit (the finish: checks and the last
 * word). Then medians per group and task, and per task each group against the
 * first one. `-v` lists each run.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Option, Path, Schema } from "effect"
import { median } from "../src/eval/PyFormat.ts"
import { loadRecords } from "../src/eval/Report.ts"
import { relativizer } from "../src/records/Extract.ts"
import { EDIT_TOOLS, parseSession, SHELL_TOOLS, SHELL_WRITE, type ToolCall, usageTotal } from "../src/traces/index.ts"
import { lookingOf } from "../src/workflows/Lookups.ts"

const Run = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  success: Schema.NullOr(Schema.Boolean),
  cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Struct({ total: Schema.Number })))
})

const isEdit = (c: ToolCall): boolean =>
  EDIT_TOOLS.has(c.name) || (SHELL_TOOLS.has(c.name) && typeof c.input.command === "string" && SHELL_WRITE.test(c.input.command))

interface Row {
  readonly group: string
  readonly task: string
  readonly id: string
  readonly ok: boolean
  readonly tokens: number
  readonly usd: number
  readonly turns: number
  readonly look: number
  readonly lookTokens: number
  readonly lookups: number
  readonly finish: number
}

const args = process.argv.slice(2)
const verbose = args.includes("-v")
const tasks: Array<string> = []
const groups: Array<{ name: string; dirs: Array<string> }> = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-v") continue
  if (args[i] === "--task") {
    tasks.push(args[++i])
    continue
  }
  const [name, dirs] = args[i].split("=")
  groups.push({ name, dirs: dirs.split(",") })
}

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  const rows: Array<Row> = []
  for (const g of groups) {
    for (const dir of g.dirs) {
      for (const record of yield* loadRecords([dir]).pipe(Effect.orElseSucceed(() => [] as Array<unknown>))) {
        const r = yield* Schema.decodeUnknownEffect(Run)(record)
        if (r.session_id === undefined || (tasks.length > 0 && !tasks.includes(r.task_id))) continue
        const trace = yield* parseSession(path.join(dir, "runs", r.run_id, "transcript", `${r.session_id}.jsonl`)).pipe(Effect.option)
        if (Option.isNone(trace)) continue
        const calls = new Map(trace.value.toolCalls.map((c) => [c.id, c]))
        const turns = trace.value.responses
          .filter((x) => x.agentId === undefined)
          .map((x) => ({ tokens: usageTotal(x.usage), calls: x.toolCallIds.flatMap((id) => calls.get(id) ?? []) }))
        let last = -1
        turns.forEach((t, i) => {
          if (t.calls.some(isEdit)) last = i
        })
        const looking = lookingOf(trace.value, relativizer(trace.value.cwd))
        rows.push({
          group: g.name,
          task: r.task_id,
          id: r.run_id,
          ok: r.success === true,
          tokens: r.tokens?.total ?? turns.reduce((n, t) => n + t.tokens, 0),
          usd: r.cost_usd ?? 0,
          turns: turns.length,
          look: looking.turns,
          lookTokens: looking.tokens,
          lookups: looking.lookups.length,
          finish: last < 0 ? 0 : turns.length - last - 1
        })
      }
    }
  }
  if (verbose) {
    for (const r of rows) {
      yield* Console.log(
        `${r.group.padEnd(14)} ${r.id.padEnd(34)} ${r.ok ? "ok  " : "FAIL"} ${String(Math.round(r.tokens / 1000)).padStart(5)}k $${r.usd.toFixed(2)} ` +
          `${String(r.turns).padStart(3)} turns, ${r.look} before the first edit (${Math.round(r.lookTokens / 1000)}k, ${r.lookups} lookups), ${r.finish} after the last`
      )
    }
    yield* Console.log("")
  }
  const med = (xs: ReadonlyArray<number>) => median([...xs])
  yield* Console.log("Medians per task (failed runs counted):")
  yield* Console.log(`${"task".padEnd(24)} ${"group".padEnd(14)} runs ok   tokens  dollars turns before(look tokens, lookups) after`)
  for (const task of [...new Set(rows.map((r) => r.task))]) {
    const base = rows.filter((r) => r.task === task && r.group === groups[0].name)
    for (const g of groups) {
      const rs = rows.filter((r) => r.task === task && r.group === g.name)
      if (rs.length === 0) continue
      const tokens = med(rs.map((r) => r.tokens))
      const usd = med(rs.map((r) => r.usd))
      const vs = g.name === groups[0].name || base.length === 0
        ? ""
        : `  tokens ${pct(tokens, med(base.map((r) => r.tokens)))}, dollars ${pct(usd, med(base.map((r) => r.usd)))}`
      yield* Console.log(
        `${task.padEnd(24)} ${g.name.padEnd(14)} ${String(rs.length).padStart(4)} ${String(rs.filter((r) => r.ok).length).padStart(2)} ` +
          `${String(Math.round(tokens / 1000)).padStart(6)}k  $${usd.toFixed(3)} ${String(med(rs.map((r) => r.turns))).padStart(5)} ` +
          `${String(med(rs.map((r) => r.look))).padStart(6)} (${Math.round(med(rs.map((r) => r.lookTokens)) / 1000)}k, ${med(rs.map((r) => r.lookups))})` +
          `${String(med(rs.map((r) => r.finish))).padStart(12)}${vs}`
      )
    }
  }
})

const pct = (x: number, base: number) => (base === 0 ? "n/a" : `${x >= base ? "+" : ""}${Math.round(((x - base) / base) * 100)}%`)

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
