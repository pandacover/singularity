// Scores the two arms of the markdownlint long task against the bars of
// PREREGISTRATION-long-daily.md:
//
//   node score.mjs --runs <dir with with/ and without/> --home <memory home> [--json out.json]
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const { values: opts } = parseArgs({
  options: { runs: { type: "string" }, home: { type: "string" }, json: { type: "string" } }
})
if (!opts.runs || !opts.home) {
  console.error("usage: node score.mjs --runs <dir> --home <memory home> [--json out.json]")
  process.exit(2)
}

const readJsonl = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) : []

// The last record of each task (a task rerun replaces the earlier one).
const recordsOf = (arm) => {
  const byTask = new Map()
  for (const r of readJsonl(path.join(opts.runs, arm, "records.jsonl"))) byTask.set(r.task, r)
  return [...byTask.values()].sort((a, b) => a.index - b.index)
}

const tokensOf = (r) => {
  // model_usage sums every turn of the session; usage is its last turn alone
  // when it had several (a command moved to the background ends with one more).
  const models = Object.values(r.result?.model_usage ?? {})
  if (models.length > 0) {
    const sum = (k) => models.reduce((n, m) => n + (m[k] ?? 0), 0)
    const input = sum("inputTokens")
    const write = sum("cacheCreationInputTokens")
    const read = sum("cacheReadInputTokens")
    const output = sum("outputTokens")
    return { input, write, read, output, total: input + write + read + output }
  }
  const u = r.result?.usage ?? {}
  const input = u.input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const output = u.output_tokens ?? 0
  return { input, write, read, output, total: input + write + read + output }
}

const tenantDir = path.join(opts.home, "tenants", "local")
const handovers = readJsonl(path.join(tenantDir, "workflows", "handovers.jsonl")).filter((h) => h.moment === "start")
const candidatesDir = path.join(tenantDir, "workflows", "candidates")
const rounds = fs.existsSync(candidatesDir)
  ? fs.readdirSync(candidatesDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(candidatesDir, f), "utf8")))
  : []
const skipped = readJsonl(path.join(tenantDir, "skipped.jsonl"))
const recordsDir = path.join(tenantDir, "records")
const stored = fs.existsSync(recordsDir)
  ? fs.readdirSync(recordsDir).flatMap((s) => fs.readdirSync(path.join(recordsDir, s)).map((f) => `${s}/${f}`))
  : []

const arms = { without: recordsOf("without"), with: recordsOf("with") }
const pct = (a, b) => (b === 0 ? "n/a" : `${(((a - b) / b) * 100).toFixed(0)}%`)
const usd = (x) => `$${x.toFixed(2)}`
const k = (x) => `${(x / 1000).toFixed(0)}k`

const rows = []
for (const w of arms.without) {
  const m = arms.with.find((r) => r.task === w.task)
  const h = m ? handovers.filter((x) => x.session_id === m.session_id) : []
  rows.push({
    index: w.index, task: w.task, kind: w.kind,
    without: { passed: w.passed, checks: w.checks, usd: w.result?.total_cost_usd ?? 0, tokens: tokensOf(w), turns: w.result?.num_turns ?? 0, min: w.wall_ms / 60000 },
    with: m && {
      passed: m.passed, checks: m.checks, usd: m.result?.total_cost_usd ?? 0, tokens: tokensOf(m), turns: m.result?.num_turns ?? 0, min: m.wall_ms / 60000,
      handover_chars: h.reduce((s, x) => s + (x.chars ?? 0), 0), workflows: h.flatMap((x) => x.workflows.map((wf) => wf.id)),
      waited_min: (m.background_wait_ms ?? 0) / 60000
    }
  })
}

console.log("task                         kind         without                         with")
for (const r of rows) {
  const a = r.without
  const b = r.with
  const cell = (x) => (x ? `${x.passed ? "pass" : "FAIL"} ${usd(x.usd).padStart(6)} ${k(x.tokens.total).padStart(6)} ${String(x.turns).padStart(3)}t ${x.min.toFixed(1).padStart(5)}m` : "-")
  console.log(`${String(r.index).padStart(2)} ${r.task.padEnd(26)} ${r.kind.padEnd(12)} ${cell(a).padEnd(32)} ${cell(b)}${b ? `  handover ${b.handover_chars} chars [${b.workflows.join(", ")}]` : ""}`)
}

const sum = (list, arm, f) => list.reduce((s, r) => s + (r[arm] ? f(r[arm]) : 0), 0)
const totals = (list) => ({
  without: { failed: list.filter((r) => !r.without.passed).length, usd: sum(list, "without", (x) => x.usd), tokens: sum(list, "without", (x) => x.tokens.total), turns: sum(list, "without", (x) => x.turns), min: sum(list, "without", (x) => x.min) },
  with: { failed: list.filter((r) => r.with && !r.with.passed).length, usd: sum(list, "with", (x) => x.usd), tokens: sum(list, "with", (x) => x.tokens.total), turns: sum(list, "with", (x) => x.turns), min: sum(list, "with", (x) => x.min) }
})
// Only tasks both arms have done are compared.
const paired = rows.filter((r) => r.with)
if (paired.length < rows.length) console.log(`
(with singularity has done ${paired.length} of ${rows.length} tasks; totals compare those only)`)
const all = totals(paired)
const reach = totals(paired.filter((r) => r.index >= 3))
const learnUsd = rounds.reduce((s, c) => s + (c.cost_usd ?? 0), 0)

console.log("")
console.log(`all ${paired.length}: without ${all.without.failed} failed, ${usd(all.without.usd)}, ${k(all.without.tokens)} tokens, ${all.without.turns} turns, ${all.without.min.toFixed(0)} min`)
console.log(`        with    ${all.with.failed} failed, ${usd(all.with.usd)} + learning ${usd(learnUsd)} = ${usd(all.with.usd + learnUsd)}, ${k(all.with.tokens)} tokens, ${all.with.turns} turns, ${all.with.min.toFixed(0)} min`)
console.log(`tasks 3-12: tokens ${pct(reach.with.tokens, reach.without.tokens)}, dollars ${pct(reach.with.usd, reach.without.usd)}, failed ${reach.without.failed} -> ${reach.with.failed}`)

console.log("")
console.log("harm (passed without, failed with):", rows.filter((r) => r.without.passed && r.with && !r.with.passed).map((r) => r.task).join(", ") || "none")
console.log("passed with, failed without:", rows.filter((r) => !r.without.passed && r.with?.passed).map((r) => r.task).join(", ") || "none")
const a = all.with.failed <= all.without.failed
const b = reach.with.tokens <= 0.8 * reach.without.tokens && reach.with.usd <= 0.9 * reach.without.usd
const c = all.with.usd + learnUsd < all.without.usd
console.log(`bars: (a) no more failures ${a}; (b) tasks 3-12 tokens -20% and dollars -10% ${b}; (c) all-in dollars lower ${c}`)
console.log(`verdict: ${a && b && c ? "singularity helps" : !a || all.with.usd + learnUsd > all.without.usd ? "hurts" : "doesn't pay off here"}`)

console.log("")
console.log(`learning rounds: ${rounds.length}`)
for (const c2 of rounds) console.log(`  ${c2.id} ${c2.created_at} ${usd(c2.cost_usd ?? 0)} ${c2.status} records ${(c2.records ?? []).length} workflows ${(c2.memory?.workflows ?? []).length}${c2.reason ? ` (${c2.reason})` : ""}`)
console.log(`stored records: ${stored.length}; left out: ${skipped.length}`)
for (const s of skipped) console.log(`  left out ${s.commit?.slice(0, 8)}: ${s.reason}`)

if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ rows, all, reach, learnUsd, rounds: rounds.map((c2) => ({ id: c2.id, created_at: c2.created_at, cost_usd: c2.cost_usd, status: c2.status, records: c2.records, workflows: (c2.memory?.workflows ?? []).map((w) => w.id) })), skipped, stored }, null, 2) + "\n")
