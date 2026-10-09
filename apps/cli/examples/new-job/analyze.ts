// After every run: the per-chore table, what memory handed over in each run,
// and how memory learned, for the "new job" report. Outside src/, which is
// frozen for the measurement.
//   node examples/new-job/analyze.ts RUNS_DIR REVEAL.json > analysis.md
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const [runsDir, revealFile] = process.argv.slice(2)
const reveal = JSON.parse(readFileSync(revealFile, "utf8"))
const list: Array<Record<string, unknown>> = Array.isArray(reveal.chores) ? reveal.chores : Object.entries(reveal.chores ?? {}).map(([id, v]) => ({ id, ...(v as object) }))
const info = new Map(list.map((c) => [String(c.id ?? c.chore), c]))
const conds = ["none", "memory", "awm", "guide", "none-haiku", "memory-haiku"]
const rows = new Map<string, Array<Record<string, any>>>()
for (const c of conds) {
  const f = join(runsDir, c, "results.jsonl")
  if (!existsSync(f)) continue
  rows.set(c, readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l)))
}
const out: Array<string> = []
const cell = (r: Record<string, any> | undefined) => (r === undefined ? "–" : `${r.success ? "✓" : "✗"} ${r.num_turns ?? "?"}`)

out.push("## Every chore", "", `| Phase | Chore | App | Category | Kind | ${[...rows.keys()].join(" | ")} |`, `|---|---|---|---|---|${[...rows.keys()].map(() => "---").join("|")}|`)
const ids = [...new Set([...rows.values()].flat().map((r) => `${r.phase}/${r.task_id}`))].sort((a, b) => ["learn", "test", "update"].indexOf(a.split("/")[0]) - ["learn", "test", "update"].indexOf(b.split("/")[0]) || a.localeCompare(b))
for (const id of ids) {
  const [phase, chore] = id.split("/")
  const c = info.get(chore) ?? {}
  out.push(`| ${phase} | ${chore} | ${c.app ?? "?"} | ${c.category ?? "?"} | ${String(c.kind ?? "?").slice(0, 40)} | ${[...rows.keys()].map((k) => cell(rows.get(k)!.find((r) => r.phase === phase && r.task_id === chore))).join(" | ")} |`)
}
out.push("", "✓/✗ = the chore's check passed or failed; the number is the agent's turns.", "")

// What memory handed over, run by run.
const home = join(runsDir, "memory-home", "tenants", "local", "web", "handovers.jsonl")
if (existsSync(home)) {
  const lines = readFileSync(home, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l))
  const bySession = new Map<string, { start?: any; pointers: number; warnings: number }>()
  for (const l of lines) {
    const s = bySession.get(l.session_id) ?? { pointers: 0, warnings: 0 }
    if (l.moment === "start") s.start = l
    else {
      s.pointers += (l.pointers ?? []).length
      s.warnings += (l.pitfalls ?? []).length
    }
    bySession.set(l.session_id, s)
  }
  out.push("## What memory handed over, run by run", "", "| Phase | Chore | Category | Workflows handed over | Characters | Pointers | Warnings | Result |", "|---|---|---|---|---|---|---|---|")
  for (const r of rows.get("memory") ?? []) {
    const s = bySession.get(r.session_id)
    const c = info.get(r.task_id) ?? {}
    out.push(`| ${r.phase} | ${r.task_id} | ${c.category ?? "?"} | ${s?.start?.workflows?.map((w: any) => w.id).join(", ") || "none"} | ${s?.start?.chars ?? 0} | ${s?.pointers ?? 0} | ${s?.warnings ?? 0} | ${cell(r)} |`)
  }
  out.push("")
}

// How memory learned.
out.push("## How memory learned", "", "| After chore | App | Outcome | Version | Learning cost $ | Why |", "|---|---|---|---|---|---|")
let learnCost = 0
for (const r of rows.get("memory") ?? []) {
  const l = r.learned
  if (l === null || l === undefined || l.kind === "waiting") continue
  learnCost += Number(l.costUsd ?? 0)
  out.push(`| ${r.phase}/${r.task_id} | ${String(l.subject ?? "").replace("web-127-0-0-1-", "port ")} | ${l.kind} | ${l.version ?? "–"} | ${Number(l.costUsd ?? 0).toFixed(3)} | ${String(l.reason ?? "").slice(0, 120)} |`)
}
out.push("", `Learning cost in all: $${learnCost.toFixed(2)}.`, "")
process.stdout.write(out.join("\n") + "\n")
