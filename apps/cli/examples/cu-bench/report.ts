/**
 * The cu-bench report (PREREGISTRATION.md's bars), from the arms' results.jsonl
 * and, once every run is done, the runner's `reveal` (chore kinds and seeds).
 *
 *   node examples/cu-bench/report.ts <runs dir> [reveal.json]
 *
 * Per chore: success is the share of its runs that passed, turns the median of
 * its runs. Arms: none, memory, guide; replicates are the folders `<arm>-<k>`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

interface Result {
  readonly arm: string
  readonly phase: string
  readonly task_id: string
  readonly success: boolean
  readonly num_turns: number | null
  readonly cost_usd: number | null
  readonly traps_hit: ReadonlyArray<unknown>
  readonly handed?: number
  readonly status: string
}

const [runsDir, revealFile] = process.argv.slice(2)
const results: Array<Result> = []
for (const d of readdirSync(runsDir)) {
  const f = join(runsDir, d, "results.jsonl")
  if (!existsSync(f) || !statSync(join(runsDir, d)).isDirectory()) continue
  for (const line of readFileSync(f, "utf-8").split(/\r?\n/)) {
    if (line.trim() === "") continue
    try {
      results.push(JSON.parse(line) as Result)
    } catch {
      // A partial line.
    }
  }
}

const reveal = revealFile !== undefined && existsSync(revealFile) ? (JSON.parse(readFileSync(revealFile, "utf-8")) as Record<string, unknown>) : undefined
const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? NaN : s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const arms = ["none", "memory", "guide"]
const chores = [...new Set(results.map((r) => r.task_id))].sort()
const of = (arm: string, chore: string) => results.filter((r) => r.arm === arm && r.task_id === chore)
const pct = (x: number) => `${(100 * x).toFixed(0)}%`

/** A chore's kind from reveal, when it says (field names vary: kind, type, category). */
const kindOf = (chore: string): string => {
  const list = reveal?.chores
  const entry = Array.isArray(list)
    ? (list as Array<Record<string, unknown>>).find((c) => c.id === chore)
    : typeof list === "object" && list !== null ? (list as Record<string, Record<string, unknown>>)[chore] : undefined
  const k = entry?.kind ?? entry?.type ?? entry?.category
  return typeof k === "string" ? k : "?"
}

console.log(`runs: ${arms.map((a) => `${a} ${results.filter((r) => r.arm === a).length}`).join(", ")}`)
for (const arm of arms) {
  const rs = results.filter((r) => r.arm === arm)
  if (rs.length === 0) continue
  const passes = rs.filter((r) => r.success).length
  const turns = chores.map((c) => median(of(arm, c).map((r) => r.num_turns ?? NaN).filter((n) => !Number.isNaN(n)))).filter((n) => !Number.isNaN(n))
  const dollars = rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0)
  const crashed = rs.filter((r) => r.status !== "success").length
  console.log(`${arm}: ${passes}/${rs.length} passed (${pct(passes / rs.length)}), median of chores' median turns ${median(turns)}, sum of chores' median turns ${turns.reduce((a, b) => a + b, 0)}, $${dollars.toFixed(2)}${crashed > 0 ? `, ${crashed} not ending in success status` : ""}`)
}

// Harm first: chores memory passed less often than none.
console.log("\nper chore (passes of runs; median turns) none | memory | guide; kind")
const harms: Array<string> = []
for (const c of chores) {
  const cell = (arm: string) => {
    const rs = of(arm, c)
    return rs.length === 0 ? "-" : `${rs.filter((r) => r.success).length}/${rs.length}; ${median(rs.map((r) => r.num_turns ?? NaN).filter((n) => !Number.isNaN(n)))}`
  }
  const none = of("none", c)
  const mem = of("memory", c)
  const dn = none.filter((r) => r.success).length
  const dm = mem.filter((r) => r.success).length
  if (mem.length > 0 && none.length > 0 && dm / mem.length < dn / none.length) harms.push(`${c} (${kindOf(c)}): memory ${dm}/${mem.length}, none ${dn}/${none.length}; traps memory hit: ${JSON.stringify(mem.filter((r) => !r.success).map((r) => r.traps_hit))}`)
  console.log(`  ${c} ${(none[0]?.phase ?? mem[0]?.phase ?? "").padEnd(7)} ${cell("none").padEnd(9)} | ${cell("memory").padEnd(9)} | ${cell("guide").padEnd(9)}; ${kindOf(c)}`)
}
console.log(`\nharms (memory passed less often than none): ${harms.length === 0 ? "none" : ""}`)
for (const h of harms) console.log(`  ${h}`)

// By phase and by kind.
const groups = (key: (r: Result) => string) => {
  const names = [...new Set(results.map(key))].sort()
  for (const g of names) {
    const line = arms.map((a) => {
      const rs = results.filter((r) => r.arm === a && key(r) === g)
      if (rs.length === 0) return `${a} -`
      const cs = [...new Set(rs.map((r) => r.task_id))]
      return `${a} ${rs.filter((r) => r.success).length}/${rs.length} (turns ${cs.map((c) => median(rs.filter((r) => r.task_id === c).map((r) => r.num_turns ?? NaN))).reduce((x, y) => x + y, 0)})`
    })
    console.log(`  ${g.padEnd(14)} ${line.join(" | ")}`)
  }
}
console.log("\nby phase (passes; sum of chores' median turns)")
groups((r) => r.phase)
if (reveal !== undefined) {
  console.log("\nby kind")
  groups((r) => kindOf(r.task_id))
}
