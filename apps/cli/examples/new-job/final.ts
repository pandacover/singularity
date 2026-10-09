// The "new job" report under the pre-registration's amendment: both passes count;
// per chore, success is the share of its runs that passed and turns the median of
// its runs; harm is a chore memory passed less often than no memory did.
// Outside src/, which is frozen for the measurement.
//   node examples/new-job/final.ts RUNS_DIR REVEAL.json [MEMORY_DIRS] [EXTRA_DIRS] > REPORT-numbers.md
// MEMORY_DIRS: memory's run folders, comma-separated (default: memory,memory-r2,
// the first version; memory-v2,memory-v2-r2 for the second). EXTRA_DIRS: more
// folders shown as conditions of their own, never in the bars (none-r3).
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
const [runsDir, revealFile, memoryArg, extraArg] = process.argv.slice(2)
const reveal = JSON.parse(readFileSync(revealFile, "utf8"))
const list: Array<Row> = Array.isArray(reveal.chores) ? reveal.chores : Object.entries(reveal.chores ?? {}).map(([id, v]) => ({ id, ...(v as object) }))
const info = new Map(list.map((c) => [String(c.id ?? c.chore), c]))
const cat = (id: string) => String(info.get(id)?.category ?? "?")

const dirs: Record<string, Array<string>> = {
  none: ["none", "none-r2"],
  memory: (memoryArg ?? "memory,memory-r2").split(","),
  awm: ["awm"],
  guide: ["guide"],
  // The stand-in ran with the first version only.
  ...(memoryArg === undefined ? { "none-haiku": ["none-haiku"], "memory-haiku": ["memory-haiku"] } : {}),
  ...Object.fromEntries((extraArg ?? "").split(",").filter((d) => d !== "").map((d) => [d, [d]]))
}
const rows = new Map<string, Array<Row>>()
for (const [setup, ds] of Object.entries(dirs)) {
  const all: Array<Row> = []
  for (const d of ds) {
    const f = join(runsDir, d, "results.jsonl")
    if (!existsSync(f)) continue
    for (const l of readFileSync(f, "utf8").split(/\r?\n/)) if (l.trim() !== "") all.push({ ...JSON.parse(l), pass: Number(/-r(\d+)$/.exec(d)?.[1] ?? 1) })
  }
  if (all.length > 0) rows.set(setup, all)
}
const median = (xs: Array<number>): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const f = (x: number | null, d = 0) => (x === null ? "–" : x.toFixed(d))
const pc = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`)
const ch = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? "–" : `${a >= b ? "+" : ""}${Math.round((100 * (a - b)) / b)}%`)

/** Per chore: success share, median turns, median tokens, runs. */
const perChore = (setup: string, phase: string) => {
  const out = new Map<string, { share: number; turns: number; tokens: number; cost: number; runs: number }>()
  for (const r of rows.get(setup) ?? []) {
    if (r.phase !== phase) continue
    const rs = (rows.get(setup) ?? []).filter((x) => x.phase === phase && x.task_id === r.task_id)
    out.set(r.task_id, {
      share: rs.filter((x) => x.success).length / rs.length,
      turns: median(rs.map((x) => x.num_turns))!,
      tokens: median(rs.map((x) => x.tokens?.total ?? 0))!,
      cost: median(rs.map((x) => x.cost_usd ?? 0))!,
      runs: rs.length
    })
  }
  return out
}
const phases = ["learn", "test", "update"]
const setups = [...rows.keys()]
const L: Array<string> = []

// 1. Harm.
L.push("## 1. Harm: chores memory passed less often than no memory", "")
let harms = 0
L.push("| Phase | Chore | Category | Memory passed | No memory passed | Memory turns | No-memory turns |", "|---|---|---|---|---|---|---|")
const helped: Array<string> = []
for (const p of phases) {
  const m = perChore("memory", p)
  const n = perChore("none", p)
  for (const [id, x] of m) {
    const y = n.get(id)
    if (y === undefined) continue
    if (x.share < y.share) {
      harms++
      L.push(`| ${p} | ${id} | ${cat(id)} | ${pc(x.share)} of ${x.runs} | ${pc(y.share)} of ${y.runs} | ${f(x.turns, 1)} | ${f(y.turns, 1)} |`)
    }
    if (x.share > y.share) helped.push(`${p}/${id} (${cat(id)}: ${pc(x.share)} against ${pc(y.share)})`)
  }
}
if (harms === 0) L.push("| – | none | | | | | |")
L.push("", `The other way, memory passing more often: ${helped.join(", ") || "none"}.`, "")

// 2. By condition and phase.
L.push("## 2. By condition and phase (every run)", "", "| Condition | Phase | Runs | Passed | Median turns | Median tokens | Median $ | Total $ |", "|---|---|---|---|---|---|---|---|")
for (const s of setups) for (const p of phases) {
  const rs = (rows.get(s) ?? []).filter((r) => r.phase === p)
  if (rs.length === 0) continue
  L.push(`| ${s} | ${p} | ${rs.length} | ${rs.filter((r) => r.success).length} (${pc(rs.filter((r) => r.success).length / rs.length)}) | ${f(median(rs.map((r) => r.num_turns)), 1)} | ${f(median(rs.map((r) => r.tokens?.total ?? 0)) === null ? null : median(rs.map((r) => r.tokens?.total ?? 0))! / 1000)}k | ${f(median(rs.map((r) => r.cost_usd ?? 0)), 3)} | ${f(rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0), 2)} |`)
}
L.push("")

// 3. By category (test and update), per-chore medians.
const cats = [...new Set(list.map((c) => String(c.category ?? "?")))].sort()
L.push("## 3. By kind of chore (test and update phases; per chore: share passed, median turns)", "", `| Category | Chores | ${setups.join(" | ")} |`, `|---|---|${setups.map(() => "---").join("|")}|`)
for (const c of cats) {
  const ids = list.filter((x) => String(x.category) === c).map((x) => String(x.id ?? x.chore)).filter((id) => !id.startsWith("L"))
  if (ids.length === 0) continue
  const cells = setups.map((s) => {
    const per = ids.map((id) => [...perChore(s, "test"), ...perChore(s, "update")].find(([k]) => k === id)?.[1]).filter((x) => x !== undefined) as Array<{ share: number; turns: number }>
    if (per.length === 0) return "–"
    return `${pc(per.reduce((a, x) => a + x.share, 0) / per.length)} · ${f(median(per.map((x) => x.turns)), 1)}`
  })
  L.push(`| ${c} | ${ids.length} | ${cells.join(" | ")} |`)
}
L.push("")

// 4. Traps.
L.push("## 4. Traps (every run, in time order within a condition)", "", "| Condition | Runs | Trap hits | Hits on a trap this condition had already hit |", "|---|---|---|---|")
for (const s of setups) {
  const rs = [...(rows.get(s) ?? [])].sort((a, b) => a.pass - b.pass || String(a.started_at).localeCompare(String(b.started_at)))
  const seen = new Set<string>()
  let hits = 0
  let again = 0
  for (const r of rs) for (const t of r.traps_hit ?? []) {
    hits++
    if (seen.has(t)) again++
    seen.add(t)
  }
  L.push(`| ${s} | ${rs.length} | ${hits} | ${again} |`)
}
L.push("")

// 5. Mazes.
const mazeIds = list.filter((c) => /maze/i.test(String(c.category)) || /maze/i.test(String(c.kind))).map((c) => String(c.id ?? c.chore))
if (mazeIds.length > 0) {
  L.push("## 5. Mazes (moves made against the fewest possible; turns)", "", `| Chore | Phase | ${setups.join(" | ")} |`, `|---|---|${setups.map(() => "---").join("|")}|`)
  for (const id of mazeIds) {
    const phase = id.startsWith("L") ? "learn" : id.startsWith("T") ? "test" : "update"
    const cells = setups.map((s) => {
      const rs = (rows.get(s) ?? []).filter((r) => r.task_id === id)
      return rs.length === 0 ? "–" : rs.map((r) => `${r.success ? "✓" : "✗"} ${r.moves ?? "?"}/${r.fewest_moves ?? "?"} · ${r.num_turns}t`).join("; ")
    })
    L.push(`| ${id} | ${phase} | ${cells.join(" | ")} |`)
  }
  L.push("")
}

// 6. The bars.
L.push("## 6. The bars, written before the runs", "")
const bars: Array<[string, boolean | null, string]> = []
for (const p of phases) {
  const m = (rows.get("memory") ?? []).filter((r) => r.phase === p)
  const n = (rows.get("none") ?? []).filter((r) => r.phase === p)
  const fm = m.filter((r) => !r.success).length / Math.max(1, m.length)
  const fn = n.filter((r) => !r.success).length / Math.max(1, n.length)
  bars.push([`${p}: no more failures than no memory`, m.length === 0 ? null : fm <= fn, `memory failed ${m.filter((r) => !r.success).length} of ${m.length} runs, no memory ${n.filter((r) => !r.success).length} of ${n.length}`])
}
const subset = (setup: string, phase: string, pred: (c: string) => boolean) => [...perChore(setup, phase)].filter(([id]) => pred(cat(id))).map(([, x]) => x)
const isRepeat = (c: string) => /repeat|shares/i.test(c)
const isRisky = (c: string) => /look-?alike|unrelated/i.test(c)
{
  const m = subset("memory", "test", isRepeat), n = subset("none", "test", isRepeat)
  const tm = median(m.map((x) => x.turns)), tn = median(n.map((x) => x.turns))
  const sm = m.reduce((a, x) => a + x.share, 0) / Math.max(1, m.length), sn = n.reduce((a, x) => a + x.share, 0) / Math.max(1, n.length)
  bars.push(["test, repeats and shares-parts: median turns at least 20% below no memory, success no lower", tm === null || tn === null ? null : tm <= 0.8 * tn && sm >= sn, `turns ${f(tm, 1)} against ${f(tn, 1)} (${ch(tm, tn)}); passed ${pc(sm)} against ${pc(sn)}; ${m.length} chores`])
}
{
  const m = subset("memory", "test", isRisky), n = subset("none", "test", isRisky)
  const tm = median(m.map((x) => x.turns)), tn = median(n.map((x) => x.turns))
  const sm = m.reduce((a, x) => a + x.share, 0) / Math.max(1, m.length), sn = n.reduce((a, x) => a + x.share, 0) / Math.max(1, n.length)
  bars.push(["test, look-alikes and unrelated: success no lower, median turns at most 10% above", tm === null || tn === null ? null : sm >= sn && tm <= 1.1 * tn, `turns ${f(tm, 1)} against ${f(tn, 1)} (${ch(tm, tn)}); passed ${pc(sm)} against ${pc(sn)}; ${m.length} chores`])
}
{
  const order = [...new Set((rows.get("none") ?? []).filter((r) => r.phase === "update").map((r) => r.task_id))].sort()
  const half = order.slice(Math.floor(order.length / 2))
  const pm = perChore("memory", "update"), pn = perChore("none", "update")
  const sm = [...pm.values()].reduce((a, x) => a + x.share, 0) / Math.max(1, pm.size), sn = [...pn.values()].reduce((a, x) => a + x.share, 0) / Math.max(1, pn.size)
  const cm = half.reduce((a, id) => a + (pm.get(id)?.turns ?? 0), 0), cn = half.reduce((a, id) => a + (pn.get(id)?.turns ?? 0), 0)
  bars.push(["update: success no lower, and the last half of update chores costs no more turns", pm.size === 0 ? null : sm >= sn && cm <= cn, `passed ${pc(sm)} against ${pc(sn)}; last half (${half.join(", ")}): ${f(cm, 1)} turns against ${f(cn, 1)}`])
}
L.push("| Bar | Holds | Numbers |", "|---|---|---|")
for (const [name, ok, nums] of bars) L.push(`| ${name} | ${ok === null ? "no data" : ok ? "yes" : "**no**"} | ${nums} |`)
L.push("", bars.every(([, ok]) => ok !== false) ? "**Memory passes the bars.**" : "**Memory fails the bars.**", "")

// 7. Against the baselines, test and update, first pass only (the baselines ran once).
L.push("## 7. Against the baselines (test and update phases, first pass)", "", "| Condition | Passed | Median turns | Median tokens |", "|---|---|---|---|")
for (const s of ["none", "memory", "awm", "guide"]) {
  const rs = (rows.get(s) ?? []).filter((r) => r.pass === 1 && r.phase !== "learn")
  if (rs.length === 0) continue
  L.push(`| ${s} | ${rs.filter((r) => r.success).length} of ${rs.length} | ${f(median(rs.map((r) => r.num_turns)), 1)} | ${f(median(rs.map((r) => r.tokens?.total ?? 0))! / 1000)}k |`)
}
L.push("")

// 8. The stand-in.
if (rows.has("none-haiku") || rows.has("memory-haiku")) {
  L.push("## 8. The stand-in for a second agent: Haiku, test phase", "", "| Condition | Runs | Passed | Median turns |", "|---|---|---|---|")
  for (const s of ["none-haiku", "memory-haiku"]) {
    const rs = rows.get(s) ?? []
    L.push(`| ${s} | ${rs.length} | ${rs.filter((r) => r.success).length} | ${f(median(rs.map((r) => r.num_turns)), 1)} |`)
  }
  const m = perChore("memory-haiku", "test"), n = perChore("none-haiku", "test")
  const harm = [...m].filter(([id, x]) => (n.get(id)?.share ?? 0) > x.share).map(([id]) => `${id} (${cat(id)})`)
  const help = [...m].filter(([id, x]) => n.has(id) && n.get(id)!.share < x.share).map(([id]) => `${id} (${cat(id)})`)
  L.push("", `Harm: ${harm.join(", ") || "none"}. Helped: ${help.join(", ") || "none"}.`, "")
}
process.stdout.write(L.join("\n") + "\n")
