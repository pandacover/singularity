/**
 * The verdicts of PREREGISTRATION-v1.md, computed from the runs' results
 * exactly as the rules are written (no new runs):
 *
 *     node apps/cli/examples/excalidraw/score-v1.ts gate
 *     node apps/cli/examples/excalidraw/score-v1.ts
 *     node apps/cli/examples/excalidraw/score-v1.ts fit --repo REPO
 *     node apps/cli/examples/excalidraw/score-v1.ts examples
 *     node apps/cli/examples/excalidraw/score-v1.ts cues
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
import { EDIT_TOOLS, parseSession, SHELL_TOOLS, SHELL_WRITE } from "../../src/traces/index.ts"
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

const TOGGLES = ["toggle-minimap", "toggle-rulers", "toggle-presenter"]

/** The turn of a run's first edit (its own, not a subagent's), from its transcript. */
const firstEditTurn = Effect.fn("firstEditTurn")(function*(r: RunRecord) {
  const fs = yield* FileSystem.FileSystem
  const dir = `${String(r._dir)}/runs/${String(r.run_id)}/transcript`
  if (!(yield* fs.exists(dir))) return NaN
  const file = (yield* fs.readDirectory(dir)).find((f) => f.endsWith(".jsonl"))
  if (file === undefined) return NaN
  const trace = yield* parseSession(`${dir}/${file}`)
  const turnOf = new Map<string, number>()
  trace.responses.filter((x) => x.agentId === undefined).forEach((resp, i) => resp.toolCallIds.forEach((id) => turnOf.set(id, i + 1)))
  const first = trace.toolCalls.find((c) =>
    c.agentId === undefined &&
    (EDIT_TOOLS.has(c.name) || (SHELL_TOOLS.has(c.name) && typeof c.input.command === "string" && SHELL_WRITE.test(c.input.command)))
  )
  return first === undefined ? NaN : (turnOf.get(first.id) ?? NaN)
})

/**
 * After the measurement, on the toggle tasks: v1 handing over the change
 * drafted at task start (workflows-draft), and v1 with one existing example at
 * each place (not kept; runs/excalidraw/v1ex-toggles/example-change.patch),
 * against v1 as measured, v0, the exact script and no memory: tokens, turns,
 * the first edit's turn, and whether runs added an icon (a detail an example
 * can carry over).
 */
const examples = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const setups: ReadonlyArray<readonly [string, ReadonlyArray<RunRecord>]> = [
    ["v1 + draft", yield* load("v1draft-toggles")],
    ["v1 + example", yield* load("v1ex-toggles")],
    ["v1", yield* load("v1-existing")],
    ["v0", yield* load("v0spots-existing", "hooks-spots-1")],
    ["exact script", yield* load("saved-scripts-1")],
    ["no memory", yield* load("baseline-2-toggle")]
  ]
  const changes: [Array<number>, Array<number>] = [[], []]
  for (const t of TOGGLES) {
    yield* Console.log(t)
    for (const [name, all] of setups) {
      const rs = of(all, t)
      if (rs.length === 0) continue
      const turns = median(rs.map((r) => Number(field(r, "trace", "api_calls") ?? 0)))
      const first: Array<number> = []
      let icons = 0
      for (const r of rs) {
        first.push(yield* firstEditTurn(r))
        const diff = `${String(r._dir)}/runs/${String(r.run_id)}/diff.patch`
        if ((yield* fs.exists(diff)) && /^\+\s*icon:/m.test(yield* fs.readFileString(diff))) icons++
      }
      const edits = first.filter((x) => Number.isFinite(x))
      yield* Console.log(
        `  ${name.padEnd(13)} ${show(cell(rs))}; ${turns} turns, first edit in turn ${edits.length > 0 ? median(edits) : "-"} (${first.join(", ")})` +
          `${icons > 0 ? `; ${icons} added an icon` : ""}`
      )
    }
    // Each change against v1 as measured (the third setup).
    for (const i of [0, 1] as const) changes[i].push(change(cell(of(setups[i][1], t)), cell(of(setups[2][1], t))))
  }
  yield* Console.log("")
  for (const [i, name] of [[0, "v1 + draft"], [1, "v1 + example"]] as const) {
    yield* Console.log(`${name} against v1, per task: ${changes[i].map(pct).join(", ")}; median ${pct(median(changes[i]))}`)
  }
})

/**
 * PREREGISTRATION-v1-cues.md: v1 without a model call at task start, its
 * cues picking the workflows and filling the blanks the task states
 * (workflows-cues), against v1 as measured, on six tasks. Rule 1: at most 1
 * failed run of the 18. Rule 2: median tokens and dollars within +15% of v1's
 * on at least 5 of the 6 tasks. Also reported: turns, the first edit's turn,
 * and how many runs labelled the setting as the task names it.
 */
const CUES_TASKS = ["toggle-minimap", "toggle-rulers", "toggle-presenter", "midpoint-snap-n", "page-breaks", "stats-shortcut-k"]

const cues = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  // Each task's prompt, from the suite (records don't keep it), for the name it quotes.
  const suite = (yield* fs.readFileString("apps/cli/examples/excalidraw/suite.toml")).replace(/\r\n/g, "\n")
  const quotedName = new Map([...suite.matchAll(/id = "([^"]+)"[\s\S]*?prompt = """\n([\s\S]*?)"""/g)].map((m) => [m[1], /"([^"]+)"/.exec(m[2])?.[1]]))
  const now = yield* load("v1cues-toggles", "v1cues-new")
  const v1 = yield* load("v1-existing", "v1-new")
  let failed = 0
  let runs = 0
  let within = 0
  for (const t of CUES_TASKS) {
    const [a, b] = [cell(of(now, t)), cell(of(v1, t))]
    runs += a.n
    failed += a.failed
    const tokens = change(a, b)
    const dollars = (a.cost - b.cost) / b.cost
    const ok = a.n > 0 && tokens <= 0.15 && dollars <= 0.15
    if (ok) within++
    const turns = (rs: ReadonlyArray<RunRecord>) => median(rs.map((r) => Number(field(r, "trace", "api_calls") ?? 0)))
    // The first edit's turn, and whether the run labelled the setting as the task names it (an added `"…": "<name>"`).
    const watched = Effect.fnUntraced(function*(rs: ReadonlyArray<RunRecord>) {
      const firsts: Array<number> = []
      let labelled = 0
      const quoted = quotedName.get(t)
      for (const r of rs) {
        firsts.push(yield* firstEditTurn(r))
        const diff = `${String(r._dir)}/runs/${String(r.run_id)}/diff.patch`
        if (quoted !== undefined && (yield* fs.exists(diff))) {
          const added = (yield* fs.readFileString(diff)).split(/\r?\n/).filter((l) => l.startsWith("+"))
          if (added.some((l) => l.includes(`": "${quoted}"`))) labelled++
        }
      }
      const edits = firsts.filter((x) => Number.isFinite(x))
      const label = t.startsWith("toggle-") || t === "page-breaks" ? `, ${labelled} of ${rs.length} labelled as the task names it` : ""
      return `${turns(rs)} turns, first edit in turn ${edits.length > 0 ? median(edits) : "-"}${label}`
    })
    yield* Console.log(t)
    yield* Console.log(`  v1 + cues  ${show(a)}; ${yield* watched(of(now, t))}`)
    yield* Console.log(`  v1         ${show(b)}; ${yield* watched(of(v1, t))}`)
    yield* Console.log(`  tokens ${pct(tokens)}, dollars ${pct(dollars)}: ${ok ? "within" : "outside"} +15%`)
  }
  yield* Console.log("")
  yield* Console.log(`Rule 1. At most 1 failed run of 18: ${failed} of ${runs} failed: ${failed <= 1 && runs === 18 ? "holds" : runs < 18 ? "not all runs in" : "fails"}`)
  yield* Console.log(`Rule 2. Tokens and dollars within +15% of v1 on at least 5 of 6 tasks: ${within} of 6: ${within >= 5 ? "holds" : "fails"}`)
})

const program = args[0] === "gate" ? gate : args[0] === "fit" ? fit : args[0] === "examples" ? examples : args[0] === "cues" ? cues : rules
program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
