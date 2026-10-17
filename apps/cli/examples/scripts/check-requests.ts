// Which prompts src/traces/Requests.ts takes for asking for a change: every
// benchmark task prompt must be one (markdownlint, excalidraw, validator), and
// the prompts a memory home's records hold (the user's own, read only) are
// listed with the verdict and how many words of their own each has.
//
//   node apps/cli/examples/scripts/check-requests.ts
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { parse } from "smol-toml"
import { isRequest, ownTerms } from "../../src/traces/Requests.ts"
const root = path.join(import.meta.dirname, "..")
const bench: Array<[string, string]> = []
for (const t of JSON.parse(fs.readFileSync(`${root}/markdownlint/tasks.json`, "utf8")).tasks) bench.push([`markdownlint ${t.id}`, t.prompt])
for (const f of ["excalidraw/suite.toml", "excalidraw/long.toml", "validator/suite.toml"]) {
  const s = parse(fs.readFileSync(`${root}/${f}`, "utf8")) as { tasks?: Array<{ id: string; prompt: string }> }
  for (const t of s.tasks ?? []) bench.push([`${f} ${t.id}`, t.prompt])
}
const missed = bench.filter(([, p]) => !isRequest(p))
console.log(`benchmark prompts: ${bench.length}, not taken as requests: ${missed.length}`)
for (const [id, p] of missed) console.log(`  MISSED ${id}: ${p.slice(0, 120).replace(/\s+/g, " ")} | terms ${[...ownTerms(p)].join(",")}`)
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : [])
const tenants = path.join(os.homedir(), ".singularity", "tenants")
const recs = fs.readdirSync(tenants).flatMap((t) => fs.existsSync(path.join(tenants, t, "records")) ? walk(path.join(tenants, t, "records")) : []).map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
const seen = new Set<string>()
console.log("\nreal prompts (stored task and follow-ups), R = request:")
for (const r of recs) for (const p of [r.task.prompt, ...r.task.followups]) {
  const k = p.slice(0, 200); if (seen.has(k)) continue; seen.add(k)
  console.log(`${isRequest(p) ? "R" : "-"} ${String(ownTerms(p).size).padStart(3)} ${p.replace(/\s+/g, " ").slice(0, 110)}`)
}
