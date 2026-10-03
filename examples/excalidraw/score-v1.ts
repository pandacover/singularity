/**
 * The verdicts of PREREGISTRATION-v1.md, computed from the runs' results
 * exactly as the rules are written (no new runs):
 *
 *     node examples/excalidraw/score-v1.ts gate
 *     node examples/excalidraw/score-v1.ts
 *     node examples/excalidraw/score-v1.ts fit --repo REPO
 *
 * `gate` checks the gate runs against the earlier runs they repeat. Without an
 * argument: rules 1-4, then v1 against v0 (reported). `fit`: for each v1 run,
 * the places it was shown (its hand-over, `injection.shown`) against where its
 * edits went (its diff, places found at the base commit as memory finds them).
 *
 * Medians of total tokens throughout; memory runs' totals include their own
 * model call at task start.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem } from "effect"
import { median } from "../../src/eval/PyFormat.ts"
import { field, loadRecords, type RunRecord } from "../../src/eval/Report.ts"
import { fileAt, git } from "../../src/local/Git.ts"
import { editsOfDiff, placeOfEdit } from "../../src/workflows/Edits.ts"
import { placeIdOf } from "../../src/workflows/Evidence.ts"
import { placeKey, sharedNameStart } from "../../src/workflows/Places.ts"

const RUNS = "runs/excalidraw"
const REPEATS_AND_TWINS = ["altkey-zen-m", "toggle-minimap", "altkey-viewmode-j", "altkey-snap-u", "toggle-rulers"]
const SIMILAR = ["toggle-presenter", "page-breaks", "midpoint-snap-n", "stats-shortcut-k"]
const ALL = [...REPEATS_AND_TWINS, ...SIMILAR]
const SUBJECT = "excalidraw"

const args = process.argv.slice(2)
const repoArg = args.flatMap((a, i) => (a === "--repo" && args[i + 1] !== undefined ? [args[i + 1]] : []))[0]

/** Each named directory and its second lane, if there is one; each record knows its directory (`_dir`). */
const load = Effect.fn("load")(function*(...names: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const out: Array<RunRecord> = []
  for (const name of names) {
    for (const dir of [`${RUNS}/${name}`, `${RUNS}/${name}-lane2`]) {
      if (yield* fs.exists(`${dir}/results.jsonl`)) out.push(...(yield* loadRecords([dir])).map((r) => ({ ...r, _dir: dir })))
    }
  }
  return out
})

const tokensK = (r: RunRecord): number => Number(field(r, "tokens", "total") ?? 0) / 1000
const of = (rs: ReadonlyArray<RunRecord>, task: string) => rs.filter((r) => r.task_id === task)

interface Cell {
  readonly n: number
  readonly median: number
  readonly min: number
  readonly max: number
  readonly failed: number
  readonly cost: number
  readonly calls: number
}

const cell = (rs: ReadonlyArray<RunRecord>): Cell => {
  const xs = rs.map(tokensK)
  return {
    n: rs.length,
    median: xs.length > 0 ? median(xs) : NaN,
    min: Math.min(...xs),
    max: Math.max(...xs),
    failed: rs.filter((r) => r.success !== true).length,
    cost: rs.length > 0 ? median(rs.map((r) => Number(r.cost_usd ?? 0))) : NaN,
    calls: rs.length > 0 ? median(rs.map((r) => Number(field(r, "trace", "tool_calls") ?? 0))) : NaN
  }
}

const k = (x: number) => `${Math.round(x)}k`
const show = (c: Cell) =>
  c.n === 0 ? "no runs" : `${k(c.median)} (${k(c.min)}–${k(c.max)}), $${c.cost.toFixed(2)}, ${Math.round(c.calls)} calls, ${c.n} runs${c.failed > 0 ? `, ${c.failed} failed` : ""}`
const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`
const change = (a: Cell, b: Cell) => (a.median - b.median) / b.median

const gate = Effect.gen(function*() {
  const checks = [
    { name: "2.1.286: saved-scripts on altkey-viewmode-j", runs: yield* load("v1-gate-286"), old: yield* load("saved-scripts-1"), task: "altkey-viewmode-j" },
    { name: "2.1.287: saved-scripts-warnings on altkey-zen-m", runs: yield* load("v1-gate-287"), old: yield* load("saved-scripts-warnings-1"), task: "altkey-zen-m" }
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
  const noMemory = yield* load("baseline-1", "baseline-2-toggle", "baseline-3-new")
  const saved = yield* load("saved-scripts-1", "saved-scripts-2-new")
  const top2 = yield* load("saved-scripts-top2-1")
  const v1 = yield* load("v1-existing", "v1-new")
  const v0 = yield* load("v0spots-existing", "v0spots-new", "hooks-spots-1")

  yield* Console.log("Rule 1. Close to the exact script on exact repeats and twins (median of the per-task changes against saved-scripts at most +15%)")
  const changes: Array<number> = []
  for (const t of REPEATS_AND_TWINS) {
    const a = cell(of(v1, t))
    const s = cell(of(saved, t))
    changes.push(change(a, s))
    yield* Console.log(`  ${t.padEnd(18)} v1 ${show(a)}; exact script ${show(s)}: ${pct(change(a, s))}`)
  }
  const rule1 = median(changes)
  yield* Console.log(`  median of the changes ${pct(rule1)} -> ${rule1 <= 0.15 ? "holds" : "fails"}\n`)

  yield* Console.log("Rule 2. Better than the exact script on similar tasks (at least 25% below the better saved-scripts variant, no more failures, on 3 of 4)")
  const better = (t: string) => [cell(of(saved, t)), cell(of(top2, t))].filter((c) => c.n > 0).sort((a, b) => a.median - b.median)[0]
  let wins = 0
  for (const t of SIMILAR) {
    const a = cell(of(v1, t))
    const b = better(t)
    const win = a.median <= 0.75 * b.median && a.failed <= b.failed
    const noise = win && a.median >= b.min && a.median <= b.max
    if (win) wins++
    yield* Console.log(`  ${t.padEnd(18)} v1 ${show(a)}; better exact script ${show(b)}: ${pct(change(a, b))} -> ${win ? (noise ? "win, within run-to-run noise" : "win") : "no win"}`)
  }
  yield* Console.log(`  ${wins} of 4 won -> ${wins >= 3 ? "holds" : "fails"}\n`)

  yield* Console.log("Rule 3. Never worse than no memory (worse: more than 15% above its median and above its highest run)")
  let worse = 0
  for (const t of ALL) {
    const a = cell(of(v1, t))
    const n = cell(of(noMemory, t))
    const isWorse = a.median > 1.15 * n.median && a.median > n.max
    if (isWorse) worse++
    yield* Console.log(`  ${t.padEnd(18)} v1 ${show(a)}; no memory ${show(n)}: ${pct(change(a, n))}${isWorse ? "  WORSE" : ""}`)
  }
  yield* Console.log(`  ${worse} of ${ALL.length} worse -> ${worse === 0 ? "holds" : "fails"}\n`)

  const failed = v1.filter((r) => r.success !== true)
  yield* Console.log(`Rule 4. No failed runs: ${failed.length} of ${v1.length} failed${failed.map((r) => ` ${r.run_id}`).join(",")} -> ${failed.length === 0 ? "holds" : "fails"}\n`)

  yield* Console.log(`The goal (rules 1-4): ${rule1 <= 0.15 && wins >= 3 && worse === 0 && failed.length === 0 ? "met" : "not met"}\n`)

  yield* Console.log("Reported: v1 against v0 (v0 with its code at the places)")
  for (const t of ALL) {
    const a = cell(of(v1, t))
    const b = cell(of(v0, t))
    yield* Console.log(`  ${t.padEnd(18)} v1 ${show(a)}; v0 ${show(b)}: ${pct(change(a, b))}`)
  }
  const perTask = ALL.map((t) => change(cell(of(v1, t)), cell(of(v0, t)))).filter((x) => Number.isFinite(x))
  yield* Console.log(`  median of the changes ${pct(median(perTask))}`)
})

/** The key Evidence.ts gives a place for new files; it must match. */
const newFileKey = (dir: string, prefix: string, ext: string) => JSON.stringify(["new", dir, prefix, ext])

const fit = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  if (repoArg === undefined) return yield* Console.error("fit needs --repo REPO: a clone to read files at the base commit")
  const v1 = yield* load("v1-existing", "v1-new")
  const files = new Map<string, ReadonlyArray<string> | undefined>()
  const names = new Map<string, ReadonlyArray<string>>()
  const rows: Array<{ task: string; edited: number; hit: number; unused: number; missed: number }> = []
  for (const r of v1) {
    const runDir = `${String(r._dir)}/runs/${String(r.run_id)}`
    const base = String(r.base_sha ?? "")
    const diffFile = `${runDir}/diff.patch`
    if (runDir === "" || base === "" || !(yield* fs.exists(diffFile))) continue
    const d = editsOfDiff((yield* fs.readFileString(diffFile)).replace(/\r\n?/g, "\n"))
    const edited = new Set<string>()
    for (const e of d.edits) {
      const key = `${base} ${e.file}`
      if (!files.has(key)) files.set(key, (yield* fileAt(repoArg, base, e.file))?.split("\n"))
      const lines = files.get(key)
      if (lines !== undefined) edited.add(placeIdOf(SUBJECT, placeKey(placeOfEdit(lines, e))))
    }
    for (const c of d.created) {
      const slash = c.file.lastIndexOf("/")
      const dir = c.file.slice(0, slash)
      const name = c.file.slice(slash + 1)
      const dot = name.lastIndexOf(".")
      const stem = dot <= 0 ? name : name.slice(0, dot)
      const ext = dot <= 0 ? "" : name.slice(dot)
      if (!names.has(`${base} ${dir}`)) {
        const out = yield* git(repoArg, ["ls-tree", "--name-only", base, `${dir}/`]).pipe(Effect.orElseSucceed(() => ""))
        names.set(`${base} ${dir}`, out.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.trim().split("/").pop()!.replace(/\.[^.]*$/, "")))
      }
      const prefix = names.get(`${base} ${dir}`)!.map((n) => sharedNameStart(stem, n)).reduce((a, b) => (b.length > a.length ? b : a), "")
      edited.add(placeIdOf(SUBJECT, newFileKey(dir, prefix.length >= 4 ? prefix : "", ext)))
    }
    const shownList = (field(r, "injection", "shown") as Array<{ place: string }> | undefined) ?? []
    const shown = new Set(shownList.map((s) => s.place))
    rows.push({
      task: String(r.task_id),
      edited: edited.size,
      hit: [...edited].filter((p) => shown.has(p)).length,
      unused: [...shown].filter((p) => !edited.has(p)).length,
      missed: [...edited].filter((p) => !shown.has(p)).length
    })
  }
  yield* Console.log("Per task (medians over v1's runs): places edited, of them shown, edited but not shown, shown and left alone")
  for (const t of ALL) {
    const rs = rows.filter((x) => x.task === t)
    if (rs.length === 0) continue
    const m = (f: (x: (typeof rs)[number]) => number) => Math.round(median(rs.map(f)))
    yield* Console.log(`  ${t.padEnd(18)} ${rs.length} runs: edited ${m((x) => x.edited)}, shown ${m((x) => x.hit)}, not shown ${m((x) => x.missed)}, left alone ${m((x) => x.unused)}`)
  }
})

const program = args[0] === "gate" ? gate : args[0] === "fit" ? fit : rules
program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
