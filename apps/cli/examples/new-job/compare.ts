// Per chore, side by side: no memory (both passes of the first night), the
// first and the second version of memory (both passes each), and the third pass
// without memory (the drift check). Share of runs passed, then median turns.
//   node examples/new-job/compare.ts RUNS_DIR REVEAL.json > COMPARE.md
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
const [runsDir, revealFile] = process.argv.slice(2)
const reveal = JSON.parse(readFileSync(revealFile, "utf8"))
const list: Array<Row> = Array.isArray(reveal.chores) ? reveal.chores : Object.entries(reveal.chores ?? {}).map(([id, v]) => ({ id, ...(v as object) }))
const cat = (id: string) => String(list.find((c) => String(c.id ?? c.chore) === id)?.category ?? "?")

const columns: Array<[string, Array<string>]> = [
  ["no memory", ["none", "none-r2"]],
  ["memory v1", ["memory", "memory-r2"]],
  ["memory v2", ["memory-v2", "memory-v2-r2"]],
  ["no memory, today", ["none-r3"]]
]
const load = (ds: Array<string>) =>
  ds.flatMap((d) => {
    const f = join(runsDir, d, "results.jsonl")
    return existsSync(f) ? readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Row) : []
  })
const data = columns.map(([name, ds]) => [name, load(ds)] as const)
const median = (xs: Array<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const cell = (rows: ReadonlyArray<Row>, phase: string, id: string) => {
  const rs = rows.filter((r) => r.phase === phase && r.task_id === id)
  if (rs.length === 0) return "–"
  const passed = rs.filter((r) => r.success).length
  const mark = passed === rs.length ? "" : passed === 0 ? " ✗" : " ½"
  return `${passed}/${rs.length}${mark} · ${median(rs.map((r) => r.num_turns))}`
}
const L: Array<string> = []
L.push(`| Phase | Chore | Kind | ${columns.map(([n]) => n).join(" | ")} |`, `|---|---|---|${columns.map(() => "---").join("|")}|`)
for (const phase of ["learn", "test", "update"]) {
  const ids = [...new Set(data.flatMap(([, rows]) => rows.filter((r) => r.phase === phase).map((r) => String(r.task_id))))].sort()
  for (const id of ids) L.push(`| ${phase} | ${id} | ${cat(id)} | ${data.map(([, rows]) => cell(rows, phase, id)).join(" | ")} |`)
}
L.push("", "| Condition | Runs | Passed | Trap hits | Median turns | Median tokens |", "|---|---|---|---|---|---|")
for (const [name, rows] of data) {
  if (rows.length === 0) continue
  const traps = rows.reduce((a, r) => a + (r.traps_hit?.length ?? 0), 0)
  L.push(`| ${name} | ${rows.length} | ${rows.filter((r) => r.success).length} | ${traps} | ${median(rows.map((r) => r.num_turns))} | ${Math.round((median(rows.map((r) => r.tokens?.total ?? 0)) ?? 0) / 1000)}k |`)
}
process.stdout.write(L.join("\n") + "\n")
