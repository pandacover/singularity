/**
 * The verdicts of PREREGISTRATION-local-memory.md, computed from the runs'
 * results exactly as the rules are written (no new runs):
 *
 *     node apps/cli/examples/excalidraw/score-local-memory.ts gate
 *     node apps/cli/examples/excalidraw/score-local-memory.ts
 *
 * `gate` checks the drift runs against the earlier runs they repeat. Without
 * it, the rules: 1-3 decide stage 4, 5 compares with the graph's claim. The
 * mechanisms (rule 4) are counted by check-warnings.ts.
 *
 * Medians of total tokens throughout; the hooks runs' totals include the route
 * selection's model call.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem } from "effect"
import { field, loadRecords, type RunRecord } from "../../src/eval/Report.ts"
import { median } from "../../src/eval/PyFormat.ts"

const RUNS = "runs/excalidraw"
const EXISTING = ["altkey-zen-m", "altkey-viewmode-j", "altkey-snap-u", "toggle-minimap", "toggle-rulers", "toggle-presenter"]
const TOGGLE = ["toggle-minimap", "toggle-rulers", "toggle-presenter"]
const NEW = ["midpoint-snap-n", "page-breaks", "stats-shortcut-k"]

/** Each named directory and its second lane, if there is one. */
const load = Effect.fn("load")(function*(...names: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const dirs: Array<string> = []
  for (const name of names) {
    for (const dir of [`${RUNS}/${name}`, `${RUNS}/${name}-lane2`]) {
      if (yield* fs.exists(`${dir}/results.jsonl`)) dirs.push(dir)
    }
  }
  return dirs.length === 0 ? [] : yield* loadRecords(dirs)
})

const tokensK = (r: RunRecord): number => Number(field(r, "tokens", "total") ?? 0) / 1000
const of = (rs: ReadonlyArray<RunRecord>, task: string) => rs.filter((r) => r.task_id === task)

interface Cell {
  readonly n: number
  readonly median: number
  readonly min: number
  readonly max: number
  readonly failed: number
}

const cell = (rs: ReadonlyArray<RunRecord>): Cell => {
  const xs = rs.map(tokensK)
  return {
    n: rs.length,
    median: xs.length > 0 ? median(xs) : NaN,
    min: Math.min(...xs),
    max: Math.max(...xs),
    failed: rs.filter((r) => r.success !== true).length
  }
}

const k = (x: number) => `${Math.round(x)}k`
const show = (c: Cell) => (c.n === 0 ? "no runs" : `${k(c.median)} (${k(c.min)}–${k(c.max)}), ${c.n} runs${c.failed > 0 ? `, ${c.failed} failed` : ""}`)
const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`
const change = (a: Cell, b: Cell) => (a.median - b.median) / b.median

const gate = Effect.gen(function*() {
  const checks = [
    { name: "2.1.286: saved-scripts on altkey-viewmode-j", runs: yield* load("drift-286"), old: yield* load("saved-scripts-1"), task: "altkey-viewmode-j" },
    { name: "2.1.287: saved-scripts-warnings on altkey-zen-m", runs: yield* load("drift-287"), old: yield* load("saved-scripts-warnings-1"), task: "altkey-zen-m" }
  ]
  let pass = true
  for (const c of checks) {
    const now = cell(of(c.runs, c.task))
    const before = cell(of(c.old, c.task))
    const ok = now.n > 0 && Math.abs(change(now, before)) <= 0.15
    pass &&= ok
    yield* Console.log(`${c.name}: ${show(now)} against ${show(before)}: ${pct(change(now, before))} -> ${ok ? "within ±15%" : "OUTSIDE ±15%"}`)
  }
  yield* Console.log(pass ? "\nThe gate passes: the earlier runs are the baselines." : "\nThe gate FAILS: stop, and decide with the user.")
})

const rules = Effect.gen(function*() {
  const noMemory = [...(yield* load("baseline-1", "baseline-2-toggle")), ...(yield* load("baseline-3-new"))]
  const saved = [...(yield* load("saved-scripts-1")), ...(yield* load("saved-scripts-2-new"))]
  const top2 = yield* load("saved-scripts-top2-1")
  const seed = [...(yield* load("hooks-1-existing")), ...(yield* load("hooks-1-new"))]
  const zenOnly = yield* load("hooks-zen-only-1")

  yield* Console.log("Rule 1. Close to saved-scripts on the existing tasks (median of the per-task changes at most +15%)")
  const changes: Array<number> = []
  for (const t of EXISTING) {
    const h = cell(of(seed, t))
    const s = cell(of(saved, t))
    changes.push(change(h, s))
    yield* Console.log(`  ${t.padEnd(18)} hooks ${show(h)}; saved-scripts ${show(s)}: ${pct(change(h, s))}`)
  }
  const rule1 = median(changes)
  yield* Console.log(`  median of the changes ${pct(rule1)} -> ${rule1 <= 0.15 ? "holds" : "fails"}\n`)

  yield* Console.log("Rule 2. Never worse than no memory (worse: more than 15% above its median and above its highest run)")
  let worse = 0
  const cells = [...[...EXISTING, ...NEW].map((t) => ({ t, h: of(seed, t), label: "seed" })), ...TOGGLE.map((t) => ({ t, h: of(zenOnly, t), label: "zen-only" }))]
  for (const { t, h, label } of cells) {
    const hc = cell(h)
    const nc = cell(of(noMemory, t))
    const isWorse = hc.median > 1.15 * nc.median && hc.median > nc.max
    if (isWorse) worse++
    yield* Console.log(`  ${`${t} (${label})`.padEnd(28)} hooks ${show(hc)}; no memory ${show(nc)}: ${pct(change(hc, nc))}${isWorse ? "  WORSE" : ""}`)
  }
  yield* Console.log(`  ${worse} of ${cells.length} worse -> ${worse === 0 ? "holds" : "fails"}\n`)

  const all = [...seed, ...zenOnly]
  const failed = all.filter((r) => r.success !== true)
  yield* Console.log(`Rule 3. No failed runs: ${failed.length} of ${all.length} failed${failed.map((r) => ` ${r.run_id}`).join(",")} -> ${failed.length === 0 ? "holds" : "fails"}\n`)

  yield* Console.log("Rule 5. Wins on the four kinds of new task (at least 25% below the better saved-scripts variant; partial overlap: against no memory)")
  const better = (t: string) => {
    const options = [cell(of(saved, t)), cell(of(top2, t))].filter((c) => c.n > 0)
    return options.sort((a, b) => a.median - b.median)[0]
  }
  let wins = 0
  for (const t of NEW) {
    const h = cell(of(seed, t))
    const b = better(t)
    const win = h.median <= 0.75 * b.median && h.failed <= b.failed
    const noise = win && h.median >= b.min && h.median <= b.max
    if (win) wins++
    yield* Console.log(`  ${t.padEnd(18)} hooks ${show(h)}; better saved-scripts ${show(b)}: ${pct(change(h, b))} -> ${win ? (noise ? "win, within run-to-run noise" : "win") : "no win"}`)
  }
  const partial = TOGGLE.map((t) => change(cell(of(zenOnly, t)), cell(of(noMemory, t))))
  const partialWin = median(partial) <= -0.25 && cell(zenOnly).failed <= TOGGLE.reduce((n, t) => n + cell(of(noMemory, t)).failed, 0)
  if (partialWin) wins++
  yield* Console.log(`  partial overlap    zen-only hooks against no memory on the toggle tasks: ${partial.map(pct).join(", ")}; median ${pct(median(partial))} -> ${partialWin ? "win" : "no win"}`)
  yield* Console.log(`  ${wins} of 4 kinds won (the graph: 1 of 4)\n`)

  yield* Console.log(`Stage 4's goal (rules 1-3): ${rule1 <= 0.15 && worse === 0 && failed.length === 0 ? "met" : "not met"}`)
})

const program = process.argv[2] === "gate" ? gate : rules
program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
