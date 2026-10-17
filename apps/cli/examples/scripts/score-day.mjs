// Scores the day-of-work runs (PREREGISTRATION-day-2026-10-16.md), in the
// order it fixed: harm first, then dollars (new against without, new against
// old), then how memory behaved: which prompts got a hand-over and what, and
// what the records were filed under. Free: reads files only.
//
//   node apps/cli/examples/scripts/score-day.mjs [--ml <dir>] [--passes 1,2,3] [--json <file>]
//
// <ml>/day-runs-p<k>/<arm>/ holds a pass's driver output for each arm
// (without, old, new); <ml>/day-home-<arm>-p<k>/ its memory home.
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { isRequest } from "../../src/traces/Requests.ts"

const { values: opts } = parseArgs({
  options: {
    ml: { type: "string", default: "C:/singularity-workspaces/eval-1016/ml" },
    passes: { type: "string", default: "1,2,3" },
    // Tasks an arm's pass must have to count as complete (12; fewer to try the script on a short run).
    tasks: { type: "string", default: "12" },
    json: { type: "string" }
  }
})
const ARMS = ["without", "old", "new"]
const passes = opts.passes.split(",").map(Number)
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) : [])
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
const money = (x) => `$${x.toFixed(2)}`
const pct = (a, b) => `${a >= b ? "+" : ""}${Math.round((100 * (a - b)) / b)}%`
const tokensOf = (u) => (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
const tasksDay = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "markdownlint", "tasks-day.json"), "utf8")).tasks

// The runs: each task's record, with what the person paid for it (its turns, and its conversation's opening).
const runs = {}
for (const p of passes) for (const arm of ARMS) {
  const dir = path.join(opts.ml, `day-runs-p${p}`, arm)
  const records = readJsonl(path.join(dir, "records.jsonl"))
  if (records.length === 0) continue
  // Tokens from the conversations' logs, each response to the turn it came in.
  const responses = []
  for (const t of fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => d.startsWith("thread-")) : []) {
    const seen = new Set()
    for (const o of readJsonl(path.join(dir, t, "transcript.jsonl"))) {
      if (o.type !== "assistant" || !o.message?.usage || seen.has(o.message.id)) continue
      seen.add(o.message.id)
      responses.push({ at: Date.parse(o.timestamp), tokens: tokensOf(o.message.usage) })
    }
  }
  const inTurn = (turn) => {
    const from = Date.parse(turn.at)
    return responses.filter((r) => r.at >= from && r.at <= from + turn.ms + 2000).reduce((a, r) => a + r.tokens, 0)
  }
  runs[`${arm}-${p}`] = records.map((r) => ({
    ...r,
    bill: r.cost_usd + (r.orient_cost_usd ?? 0),
    tokens: r.turns.reduce((a, t) => a + inTurn(t), 0) + (r.orient_at ? inTurn({ at: r.orient_at, ms: r.orient_ms ?? 0 }) : 0)
  }))
  runs[`${arm}-${p}`].handovers = readJsonl(path.join(dir, "handovers.jsonl"))
}
const complete = passes.filter((p) => ARMS.every((a) => (runs[`${a}-${p}`] ?? []).length === Number(opts.tasks)))
const lines = []
const say = (s = "") => { lines.push(s); console.log(s) }
say(`# The day of work: passes with all three arms complete: ${complete.join(", ") || "none"}\n`)

// 1. Harm first.
say("## Harm first: passed without memory, failed with it (same pass)\n")
let harms = 0
for (const arm of ["old", "new"]) for (const p of complete) for (const r of runs[`${arm}-${p}`]) {
  const w = runs[`without-${p}`].find((x) => x.task === r.task)
  if (w?.passed && !r.passed) {
    harms++
    const prev = runs[`${arm}-${p}`].find((x) => x.index === r.index - 1)
    say(`- ${arm}, pass ${p}, ${r.task}: ${JSON.stringify(r.checks)}${prev === undefined || prev.passed ? " (first failure of its run)" : " (after an earlier failure)"}`)
  }
}
if (harms === 0) say("- none")
const runsOfFailures = (rs) => rs.filter((r) => !r.passed && (r.index === 1 || rs.find((x) => x.index === r.index - 1)?.passed)).length
say("\n| pass | arm | passed | runs of failures | dollars | tokens |\n|---|---|---|---|---|---|")
for (const p of complete) for (const arm of ARMS) {
  const rs = runs[`${arm}-${p}`]
  say(`| ${p} | ${arm} | ${rs.filter((r) => r.passed).length} of 12 | ${runsOfFailures(rs)} | ${money(rs.reduce((a, r) => a + r.bill, 0))} | ${(rs.reduce((a, r) => a + r.tokens, 0) / 1e6).toFixed(2)}M |`)
}

// 2 and 3. Dollars, paired by task and pass, with a bootstrap over the pairs.
const SEED = 20261016
const rand = (() => { let s = SEED; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) })()
const compare = (a, b, from = 1, key = "bill") => {
  const pairs = complete.flatMap((p) => runs[`${a}-${p}`].filter((r) => r.index >= from).map((r) => [r[key], runs[`${b}-${p}`].find((x) => x.task === r.task)?.[key] ?? 0]))
  const sum = (ps, i) => ps.reduce((s, x) => s + x[i], 0)
  const ratio = sum(pairs, 0) / sum(pairs, 1)
  const boots = []
  for (let k = 0; k < 4000; k++) {
    const sample = pairs.map(() => pairs[Math.floor(rand() * pairs.length)])
    boots.push(sum(sample, 0) / sum(sample, 1))
  }
  boots.sort((x, y) => x - y)
  return { a: sum(pairs, 0), b: sum(pairs, 1), ratio, lo: boots[100], hi: boots[3899], n: pairs.length }
}
const verdict = (c, failsA, failsB) =>
  failsA > failsB || c.ratio >= 1.1 ? "hurts" : c.ratio <= 0.9 && c.hi < 1 ? "helps" : "no clear difference"
say("\n## Dollars (every turn of the day; a conversation's opening with its first task)\n")
say("| arms | dollars | change (95% interval) | tasks 2-12 | tokens | by the plan |\n|---|---|---|---|---|---|")
for (const [a, b] of [["new", "without"], ["new", "old"], ["old", "without"]]) {
  if (complete.length === 0) break
  const c = compare(a, b)
  const later = compare(a, b, 2)
  const tok = compare(a, b, 1, "tokens")
  const fails = (arm) => complete.reduce((s, p) => s + runsOfFailures(runs[`${arm}-${p}`]), 0)
  const show = (x) => `${Math.round(100 * (x - 1))}%`
  say(`| ${a} against ${b} | ${money(c.b)} to ${money(c.a)} | ${show(c.ratio)} (${show(c.lo)} to ${show(c.hi)}) | ${show(later.ratio)} | ${show(tok.ratio)} | ${verdict(c, fails(a), fails(b))} |`)
}

// 4. How memory behaved.
say("\n## Hand-overs, by the prompt that got one\n")
const kindOf = new Map(tasksDay.map((t) => [t.id, t.kind]))
for (const arm of ["old", "new"]) {
  const counts = {}
  const rows = []
  for (const p of complete) {
    const rs = runs[`${arm}-${p}`]
    const byCommit = new Map(rs.flatMap((r) => r.commits.map((c) => [c.split(" ")[0], r])))
    for (const h of rs.handovers) {
      const at = Date.parse(h.at)
      let prompt = "?"
      let task
      for (const r of rs) {
        if (r.orient_at && at >= Date.parse(r.orient_at) - 1000 && at <= Date.parse(r.orient_at) + (r.orient_ms ?? 60000)) { prompt = "opening"; task = r }
        for (const t of r.turns) if (at >= Date.parse(t.at) - 1000 && at <= Date.parse(t.at) + t.ms) { prompt = t.label; task = r }
      }
      const picked = h.picked ? byCommit.get(h.picked.commit) : undefined
      const key = `${h.moment} at ${prompt}: ${h.picked ? "handed over" : "nothing"}`
      counts[key] = (counts[key] ?? 0) + 1
      if (h.picked) rows.push(`  - pass ${p}, ${task?.task ?? "?"} (${prompt}, ${h.moment}): ${picked?.task ?? h.picked.commit.slice(0, 8)} at ${h.score}${picked && task ? (kindOf.get(picked.task) === kindOf.get(task.task) ? ", same kind" : ", another kind") : ""}`)
    }
  }
  say(`- ${arm}: ${Object.entries(counts).sort().map(([k, n]) => `${k} ${n}`).join("; ") || "no hand-over attempts"}`)
  for (const row of rows) say(row)
}
say("\n## What the records were filed under\n")
for (const arm of ["old", "new"]) {
  let total = 0, asks = 0, request = 0, messages = 0
  for (const p of complete) {
    for (const f of walk(path.join(opts.ml, `day-home-${arm}-p${p}`, "tenants")).filter((f) => f.includes(`${path.sep}records${path.sep}`) && f.endsWith(".json"))) {
      const r = JSON.parse(fs.readFileSync(f, "utf8"))
      total++
      if (isRequest(r.task.prompt)) asks++
      if (tasksDay.some((t) => r.task.prompt.trim().startsWith(t.prompt.trim().slice(0, 60)))) request++
      if (r.task.message) messages++
    }
  }
  say(`- ${arm}: ${total} records; filed under a prompt that asks ${asks}, under the task's own request ${request}; with a commit message ${messages}`)
}
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ complete, runs }, null, 1) + "\n")
