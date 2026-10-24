// Outcome 3 of PREREGISTRATION-git-show-2026-10-17.md: the hand-over by
// commit's own part, read from the with arm's hand-over log (moment "git") and
// the sessions' transcripts. Free: no model call.
//
//   node apps/cli/examples/scripts/score-git-show.mjs [--ml <root>] [--json <file>]
//
// For each fire: the session and task, its size, the kinds of mistake it named
// (keysOf, as in replay-git-handover.ts), whether the session made a mistake
// of that kind after the fire, and whether the paired session without memory
// (same pass, same task) made it at all. Then the dollars of the sessions with
// a fire against their pairs, and of those without one; every hand-over by
// moment; and the sessions that ran `singularity recall`.
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const { values: opts } = parseArgs({
  options: {
    ml: { type: "string", default: "C:/singularity-workspaces/eval-1017/ml" },
    json: { type: "string" }
  }
})

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
    : []

// What markdownlint's mistakes teach: replay-git-handover.ts and stored-mistakes.mjs.
const keysOf = (text) => {
  const keys = new Set()
  if (/UnicodeDecodeError: 'charmap' codec/.test(text)) keys.add("python-encoding")
  if (/Parsing error: Unterminated string constant/.test(text)) keys.add("python-escapes")
  if (/plan expected \d+ assertions? but received \d+/.test(text)) keys.add("plan-count")
  if (/\b\d+ == \d+\b/.test(text)) keys.add("file-count")
  if (/✖ projectFiles|Issue\(s\) with/.test(text)) keys.add("project-files")
  if (/Invalid state: Snapshot|Snapshot '[^']*' (?:not found|missing)/.test(text)) keys.add("snapshot")
  if (/✖ readme\b/.test(text)) keys.add("readme")
  if (/✖ validateJsonUsingConfigSchema/.test(text)) keys.add("schema")
  if (/does not meet (?:\w+ )?threshold/.test(text)) keys.add("coverage")
  if (/ENOENT: no such file or directory, open '(?:doc-build|doc-src)/.test(text)) keys.add("missing-doc")
  for (const line of text.split(/\r?\n/)) {
    if (!/\b\d+:\d+\s+error\s/.test(line) || /Parsing error/.test(line)) continue
    const rule = line.trim().split(/\s+/).pop() ?? ""
    if (/^(@[\w-]+\/)?[a-z][\w-]*(\/[\w-]+)?$/.test(rule) && rule.includes("-")) keys.add(`lint:${rule}`)
  }
  if (/error TS\d+/.test(text)) keys.add("types")
  return keys
}

/** A session's shell calls in order, with their output and when their result came back. */
const shellCalls = (file) => {
  const lines = readJsonl(file)
  const results = new Map()
  for (const o of lines) {
    if (o.type !== "user" || !Array.isArray(o.message?.content)) continue
    for (const c of o.message.content) {
      if (c.type === "tool_result") {
        results.set(c.tool_use_id, {
          text: Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content ?? ""),
          failed: c.is_error === true,
          at: String(o.timestamp ?? "")
        })
      }
    }
  }
  const calls = []
  for (const o of lines) {
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue
    for (const c of o.message.content) {
      if (c.type !== "tool_use" || (c.name !== "Bash" && c.name !== "PowerShell")) continue
      const r = results.get(c.id)
      calls.push({ index: calls.length, command: String(c.input?.command ?? ""), output: r?.text ?? "", failed: r?.failed ?? false, at: r?.at ?? String(o.timestamp ?? "") })
    }
  }
  return calls
}

const failedKeys = (calls) =>
  new Set(calls.filter((c) => c.failed || /exit code [1-9]|not ok \d|✖|error/i.test(c.output)).flatMap((c) => [...keysOf(c.output)]))

const cost = (r) => r?.result?.total_cost_usd ?? 0
const pct = (a, b) => (b === 0 ? "n/a" : `${((a / b - 1) * 100).toFixed(0)}%`)

const fires = []
const sessions = []
const moments = {}
let recallSessions = 0
for (const dir of fs.readdirSync(opts.ml).filter((d) => /^runs-p\d+$/.test(d)).sort()) {
  const pass = Number(dir.slice(6))
  const withRecords = new Map(readJsonl(path.join(opts.ml, dir, "with", "records.jsonl")).map((r) => [r.task, r]))
  const withoutRecords = new Map(readJsonl(path.join(opts.ml, dir, "without", "records.jsonl")).map((r) => [r.task, r]))
  const handovers = readJsonl(path.join(opts.ml, `sg-home-p${pass}`, "tenants", "local", "workflows", "handovers.jsonl"))
  for (const h of handovers) if (h.picked) moments[h.moment] = (moments[h.moment] ?? 0) + 1
  for (const [task, w] of withRecords) {
    const wo = withoutRecords.get(task)
    const calls = shellCalls(path.join(opts.ml, dir, "with", task, "transcript.jsonl"))
    const woCalls = shellCalls(path.join(opts.ml, dir, "without", task, "transcript.jsonl"))
    if (calls.some((c) => /singularity(\.cmd)?\s+recall\b/.test(c.command))) recallSessions++
    const mine = handovers.filter((h) => h.session_id === w.session_id && h.moment === "git" && h.picked)
    const used = new Set()
    for (const h of mine) {
      // The call that fired it: the first unused one with its command whose result came back by then.
      const call = calls.find((c) => !used.has(c.index) && c.command.slice(0, 300) === h.command && c.at <= h.at) ??
        calls.find((c) => !used.has(c.index) && c.command.slice(0, 300) === h.command)
      if (call !== undefined) used.add(call.index)
      const named = [...new Set(String(h.text ?? "").split("\n").filter((l) => l.startsWith("- `")).flatMap((m) => [...keysOf(m)]))]
      const after = call === undefined ? new Set() : failedKeys(calls.filter((c) => c.index > call.index))
      const paired = failedKeys(woCalls)
      fires.push({
        pass, task, session: w.session_id, call: call?.index ?? null, read: String(h.read).slice(0, 10), chars: h.chars,
        command: h.command.replace(/\s+/g, " ").slice(0, 90),
        named,
        made_after: named.filter((k) => after.has(k)),
        made_without: named.filter((k) => paired.has(k))
      })
    }
    sessions.push({ pass, task, fired: mine.length > 0, with_usd: cost(w), without_usd: cost(wo), with_passed: w.passed, without_passed: wo?.passed })
  }
}

console.log(`hand-overs by moment: ${Object.entries(moments).map(([m, n]) => `${m} ${n}`).join(", ") || "none"}`)
console.log(`sessions that ran singularity recall: ${recallSessions} of ${sessions.length}`)
console.log(`\ngit fires: ${fires.length}, in ${new Set(fires.map((f) => f.session)).size} of ${sessions.length} sessions; chars ${fires.map((f) => f.chars).sort((a, b) => a - b).join(", ")}`)
for (const f of fires) {
  console.log(`p${f.pass} ${f.task} call ${f.call ?? "?"}: ${f.read}, ${f.chars} chars; named ${f.named.join(",") || "-"}; made after ${f.made_after.join(",") || "-"}; paired without made ${f.made_without.join(",") || "-"} | ${f.command}`)
}
const naming = fires.filter((f) => f.named.length > 0)
console.log(`\n${naming.length} fires named a mistake; in ${naming.filter((f) => f.made_after.length > 0).length} the session made one of those kinds after it (replay ceiling, 10-16: 5 of 12); the paired session without memory made one in ${naming.filter((f) => f.made_without.length > 0).length}`)

const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0)
for (const [label, xs] of [["sessions with a git fire", sessions.filter((s) => s.fired)], ["sessions without one", sessions.filter((s) => !s.fired)]]) {
  console.log(`${label}: ${xs.length}, with $${sum(xs, "with_usd").toFixed(2)} against without $${sum(xs, "without_usd").toFixed(2)} (${pct(sum(xs, "with_usd"), sum(xs, "without_usd"))}); passed ${xs.filter((s) => s.with_passed).length} against ${xs.filter((s) => s.without_passed).length} (driver's checks)`)
}

// Outcome 2's interval: with against without, the ratio of summed dollars
// (and tokens), a bootstrap over the task pairs (10,000 draws, a fixed seed).
const tokens = (r) => {
  const u = r?.result?.usage ?? {}
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}
const pairs = []
for (const dir of fs.readdirSync(opts.ml).filter((d) => /^runs-p\d+$/.test(d)).sort()) {
  const w = new Map(readJsonl(path.join(opts.ml, dir, "with", "records.jsonl")).map((r) => [r.task, r]))
  for (const wo of readJsonl(path.join(opts.ml, dir, "without", "records.jsonl"))) {
    const x = w.get(wo.task)
    if (x !== undefined) pairs.push({ index: wo.index, usd: [cost(wo), cost(x)], tokens: [tokens(wo), tokens(x)] })
  }
}
let seed = 1
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const interval = (ps, k) => {
  const ratio = (xs) => xs.reduce((a, p) => a + p[k][1], 0) / xs.reduce((a, p) => a + p[k][0], 0) - 1
  const draws = []
  for (let i = 0; i < 10000; i++) draws.push(ratio(ps.map(() => ps[Math.floor(random() * ps.length)])))
  draws.sort((a, b) => a - b)
  const f = (x) => `${(x * 100).toFixed(1)}%`
  return `${f(ratio(ps))} (95% interval ${f(draws[249])} to ${f(draws[9749])})`
}
console.log(`\nwith against without, ${pairs.length} task pairs: dollars ${interval(pairs, "usd")}, tokens ${interval(pairs, "tokens")}`)
const later = pairs.filter((p) => p.index >= 3)
console.log(`tasks 3-12, ${later.length} pairs: dollars ${interval(later, "usd")}`)
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ moments, recallSessions, fires, sessions }, null, 2) + "\n")
