/**
 * The long task's runs (long.toml) change by change, read from run output
 * directories (no new runs):
 *
 *     node apps/cli/examples/excalidraw/score-long.ts NAME=DIR[,DIR...] NAME=DIR... [--task ID] [-v]
 *
 * As score-phases.ts per run (success, tokens, dollars, turns, the turns
 * before the first edit and after the last), and per change of the four: the
 * turn of its first and last edit, and whether its hidden test passed. An
 * edit belongs to a change when the lines it adds (or its file's name, or a
 * shell command that writes) name that change: its setting, its key. Then
 * medians per group, each against the first group, and in how many runs the
 * two similar changes (the toggles, 1 and 3) were edited side by side rather
 * than one after the other. `--task` reads another long task's runs
 * (`long-mixed-changes`), or a single task's, against the first long task's
 * changes (to check the attribution).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { median } from "../../src/eval/PyFormat.ts"
import { loadRecords } from "../../src/eval/Report.ts"
import { relativizer } from "../../src/records/Extract.ts"
import { EDIT_TOOLS, parseSession, SHELL_TOOLS, SHELL_WRITE, type ToolCall, usageTotal } from "../../src/traces/index.ts"
import { lookingOf } from "../../src/workflows/Lookups.ts"

interface Change {
  readonly name: string
  /** The test file in the check log that says whether the change works. */
  readonly test: string
  readonly words: RegExp
  readonly file?: RegExp
}

// What each change adds, never what is there already: existing midpoint and stats lines are where the
// toggles' lines go, so shell edits name them as anchors. Midpoint's own action file counts by its name;
// a bug fix by its files (an edit's text starts with its file).
const RULERS: Change = { name: "1 rulers", test: "hidden-check-rulers.test.tsx", words: /ruler|\bCODES\.U\b|\bKeyU\b|Alt\+U\b/i }
const PRESENTER: Change = { name: "3 presenter", test: "hidden-check-presenter.test.tsx", words: /presenter|\bCODES\.J\b|\bKeyJ\b|Alt\+J\b/i }
const CHANGES_OF: Record<string, ReadonlyArray<Change>> = {
  "long-four-changes": [
    RULERS,
    { name: "2 midpoint", test: "hidden-check-midpoint.test.tsx", words: /\bCODES\.N\b|\bKeyN\b|Alt\+N\b|midpointSnapping:\s*\[/i, file: /midpoint/i },
    PRESENTER,
    { name: "4 stats", test: "hidden-check-stats.test.tsx", words: /stats\.open|stats:\s*\[|\bCODES\.K\b|\bKEYS\.K\b|\bKeyK\b|Alt\+K\b/i }
  ],
  "long-mixed-changes": [
    RULERS,
    { name: "2 save-as", test: "textWysiwyg.test.tsx", words: /textWysiwyg/i },
    PRESENTER,
    { name: "4 youtube", test: "embeddable.test.ts", words: /embeddable|RE_YOUTUBE/i }
  ]
}

const Run = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  success: Schema.NullOr(Schema.Boolean),
  cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Struct({ total: Schema.Number })))
})

const Strings = Schema.Struct({ old_string: Schema.optionalKey(Schema.String), new_string: Schema.optionalKey(Schema.String) })
const EditInput = Schema.Struct({
  file_path: Schema.optionalKey(Schema.String),
  old_string: Schema.optionalKey(Schema.String),
  new_string: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  edits: Schema.optionalKey(Schema.Array(Strings)),
  command: Schema.optionalKey(Schema.String)
})

const isEdit = (c: ToolCall): boolean =>
  EDIT_TOOLS.has(c.name) || (SHELL_TOOLS.has(c.name) && typeof c.input.command === "string" && SHELL_WRITE.test(c.input.command))

/** Lines of `after` that `before` doesn't have (as many times as it doesn't). */
const added = (before: string, after: string): Array<string> => {
  const left = new Map<string, number>()
  for (const l of before.split(/\r?\n/)) left.set(l, (left.get(l) ?? 0) + 1)
  return after.split(/\r?\n/).filter((l) => {
    const n = left.get(l) ?? 0
    if (n === 0) return true
    left.set(l, n - 1)
    return false
  })
}

/** What an edit brings: its file and the lines it adds; a shell command that writes, whole. */
const brought = (c: ToolCall): { readonly file: string; readonly text: string } => {
  const input = Schema.decodeUnknownOption(EditInput)(c.input)
  if (Option.isNone(input)) return { file: "", text: "" }
  const i = input.value
  if (SHELL_TOOLS.has(c.name)) return { file: "", text: i.command ?? "" }
  const pairs = i.edits ?? [{ old_string: i.old_string, new_string: i.new_string }]
  const lines = i.content !== undefined ? [i.content] : pairs.flatMap((p) => added(p.old_string ?? "", p.new_string ?? ""))
  return { file: i.file_path ?? "", text: [i.file_path ?? "", ...lines].join("\n") }
}

const belongs = (c: ToolCall, ch: Change): boolean => {
  const b = brought(c)
  return ch.words.test(b.text) || (ch.file?.test(b.file) ?? false)
}

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

interface ChangeRow {
  readonly first: number | null
  readonly last: number | null
  readonly edits: number
  /** Its hidden test file passed; null if the log doesn't say. */
  readonly passed: boolean | null
}

interface Row {
  readonly group: string
  readonly id: string
  readonly ok: boolean
  readonly tokens: number
  readonly usd: number
  readonly turns: number
  readonly look: number
  readonly finish: number
  readonly changes: ReadonlyArray<ChangeRow>
}

const args = process.argv.slice(2)
const verbose = args.includes("-v")
const at = args.indexOf("--task")
const task = at < 0 ? "long-four-changes" : args[at + 1]
const CHANGES = CHANGES_OF[task] ?? CHANGES_OF["long-four-changes"]
const groups = args.filter((a, i) => a !== "-v" && (at < 0 || (i !== at && i !== at + 1))).map((a) => {
  const [name, dirs] = a.split("=")
  return { name, dirs: dirs.split(",") }
})

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const rows: Array<Row> = []
  for (const g of groups) {
    for (const dir of g.dirs) {
      for (const record of yield* loadRecords([dir]).pipe(Effect.orElseSucceed(() => [] as Array<unknown>))) {
        const r = yield* Schema.decodeUnknownEffect(Run)(record)
        if (r.session_id === undefined || r.task_id !== task) continue
        const runDir = path.join(dir, "runs", r.run_id)
        const trace = yield* parseSession(path.join(runDir, "transcript", `${r.session_id}.jsonl`)).pipe(Effect.option)
        if (Option.isNone(trace)) continue
        const calls = new Map(trace.value.toolCalls.map((c) => [c.id, c]))
        const turns = trace.value.responses
          .filter((x) => x.agentId === undefined)
          .map((x) => ({ tokens: usageTotal(x.usage), calls: x.toolCallIds.flatMap((id) => calls.get(id) ?? []) }))
        let last = -1
        turns.forEach((t, i) => {
          if (t.calls.some(isEdit)) last = i
        })
        const log = plain(yield* fs.readFileString(path.join(runDir, "checks.log")).pipe(Effect.orElseSucceed(() => "")))
        const changes = CHANGES.map((ch) => {
          let first: number | null = null
          let lastTurn: number | null = null
          let edits = 0
          turns.forEach((t, i) => {
            const n = t.calls.filter((c) => isEdit(c) && belongs(c, ch)).length
            if (n === 0) return
            edits += n
            first ??= i + 1
            lastTurn = i + 1
          })
          const file = ch.test
          const failed = log.split("\n").some((l) => l.includes(file) && /FAIL|❯|×/.test(l))
          const passed = failed ? false : log.split("\n").some((l) => l.includes(file) && l.includes("✓")) ? true : null
          return { first, last: lastTurn, edits, passed }
        })
        rows.push({
          group: g.name,
          id: r.run_id,
          ok: r.success === true,
          tokens: r.tokens?.total ?? turns.reduce((n, t) => n + t.tokens, 0),
          usd: r.cost_usd ?? 0,
          turns: turns.length,
          look: lookingOf(trace.value, relativizer(trace.value.cwd)).turns,
          finish: last < 0 ? 0 : turns.length - last - 1,
          changes
        })
      }
    }
  }
  const span = (c: ChangeRow) => (c.first === null ? "-" : `${c.first}-${c.last}`)
  // The similar pair, side by side: each toggle has an edit between the other's first and last.
  const together = (r: Row) => {
    const [a, b] = [r.changes[0], r.changes[2]]
    return a.first !== null && b.first !== null && a.last !== null && b.last !== null && a.first <= b.last && b.first <= a.last
  }
  if (verbose) {
    for (const r of rows) {
      const parts = r.changes.map((c, i) => `${CHANGES[i].name.split(" ")[1]} ${span(c)}${c.passed === false ? " FAIL" : ""}`).join(", ")
      yield* Console.log(
        `${r.group.padEnd(10)} ${r.id.padEnd(34)} ${r.ok ? "ok  " : "FAIL"} ${String(Math.round(r.tokens / 1000)).padStart(5)}k $${r.usd.toFixed(2)} ` +
          `${String(r.turns).padStart(3)} turns, ${r.look} before the first edit, ${r.finish} after the last; edits by turn: ${parts}` +
          `${together(r) ? "; toggles side by side" : ""}`
      )
    }
    yield* Console.log("")
  }
  const med = (xs: ReadonlyArray<number>) => (xs.length === 0 ? NaN : median([...xs]))
  const pct = (x: number, base: number) => (base === 0 ? "n/a" : `${x >= base ? "+" : ""}${Math.round(((x - base) / base) * 100)}%`)
  const base = rows.filter((r) => r.group === groups[0]?.name)
  yield* Console.log("Medians per group (failed runs counted):")
  for (const g of groups) {
    const rs = rows.filter((r) => r.group === g.name)
    if (rs.length === 0) continue
    const tokens = med(rs.map((r) => r.tokens))
    const usd = med(rs.map((r) => r.usd))
    const vs = g.name === groups[0].name || base.length === 0
      ? ""
      : `  (tokens ${pct(tokens, med(base.map((r) => r.tokens)))}, dollars ${pct(usd, med(base.map((r) => r.usd)))})`
    yield* Console.log(
      `${g.name}: ${rs.length} runs, ${rs.filter((r) => r.ok).length} ok, ${Math.round(tokens / 1000)}k tokens, $${usd.toFixed(3)}, ` +
        `${med(rs.map((r) => r.turns))} turns, ${med(rs.map((r) => r.look))} before the first edit, ${med(rs.map((r) => r.finish))} after the last${vs}`
    )
    for (const [i, ch] of CHANGES.entries()) {
      const cs = rs.map((r) => r.changes[i])
      const firsts = cs.flatMap((c) => (c.first === null ? [] : [c.first]))
      const lasts = cs.flatMap((c) => (c.last === null ? [] : [c.last]))
      yield* Console.log(
        `  ${ch.name.padEnd(12)} first edit in turn ${med(firsts)}, last in turn ${med(lasts)}, ` +
          `hidden test passed in ${cs.filter((c) => c.passed === true).length} of ${cs.length}`
      )
    }
    yield* Console.log(`  toggles (1 and 3) edited side by side in ${rs.filter(together).length} of ${rs.length}`)
  }
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
