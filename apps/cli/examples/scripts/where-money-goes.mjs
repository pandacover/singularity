// Where a markdownlint task's money goes, from the session transcripts of the
// 2026-10-16 runs: reading past commits, other reading before the first edit,
// editing, and from the first check run to the end (with the stretch from the
// first failing check to the last). Also: how agents found past changes in
// git, whether a hand-over spared them that, which files hand-overs hid as
// changed since, and which checks failed. Free: reads files only.
//
// A call's cost is its own usage at Sonnet 5.5's prices; summed per session
// it equals the record's total_cost_usd. A check run failed when its output
// shows it (a test runner's fail count, ✖ failing tests, a plan mismatch, a
// coverage threshold, ESLint's problems, TypeScript's errors) or its status
// says so; "memory saw" counts the ones src/records/Outcome.ts's callFailed
// also judges failed, the judge the stored mistakes come from.
//
//   node apps/cli/examples/scripts/where-money-goes.mjs [--results <dir>] [--projects <dir>] [--json <file>]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { callFailed } from "../../src/records/Outcome.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const { values: opts } = parseArgs({
  options: {
    results: { type: "string", default: path.join(here, "results", "eval-2026-10-16") },
    projects: { type: "string", default: path.join(os.homedir(), ".claude", "projects") },
    prefix: { type: "string", default: "C--singularity-workspaces-eval-1016-ml-arm-" },
    // the with arm's memory homes, sg-home-p<pass>: the mistakes stored
    ml: { type: "string", default: "C:/singularity-workspaces/eval-1016/ml" },
    json: { type: "string" }
  }
})
const PRICE = { input: 2e-6, write1h: 4e-6, write5m: 2.5e-6, read: 0.2e-6, output: 10e-6 }

const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l))

const costOf = (u) => {
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? u.cache_creation_input_tokens ?? 0
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  return (u.input_tokens ?? 0) * PRICE.input + w1 * PRICE.write1h + w5 * PRICE.write5m +
    (u.cache_read_input_tokens ?? 0) * PRICE.read + (u.output_tokens ?? 0) * PRICE.output
}

const isCheck = (cmd) => /\bnpm (test|t\b|run (test|lint|ci|build-declaration|update-snapshots))|node --test|npx (eslint|tsc|markdownlint)|\btsc\b/.test(cmd)
const writesFile = (cmd) => {
  if (/\bsed -i|perl -[a-z]*i|writeFileSync|\btee\b|python|git apply|git checkout --|npm run build-(docs|config|example)/.test(cmd)) return true
  for (const m of cmd.matchAll(/(?:^|[^2&>])>{1,2}\s*([^\s;&|]+)/g)) if (!/^(\/tmp|\/dev\/null|nul\b|&)/i.test(m[1])) return true
  return false
}
const gitHistory = (cmd) =>
  cmd.split(/&&|;|\|\||\n/).map((s) => s.trim()).filter((s) => /^git\s+(-C \S+\s+)?(log|show|blame)\b/.test(s) && !/^git show HEAD:/.test(s))
const kindOfGit = (part) => (/--grep|\s-[SG]/.test(part) ? "search" : /\bblame\b/.test(part) ? "blame" : /\s--\s+\S/.test(part) && /\blog\b/.test(part) ? "path" : "commit")
const failureKinds = (text) => {
  const kinds = new Set()
  if (/plan expected|assertions? but received/i.test(text)) kinds.add("assertion count")
  if (/snapshot/i.test(text) && /✖|fail|mismatch/i.test(text)) kinds.add("snapshot")
  if (/does not meet (\w+ )?threshold/i.test(text)) kinds.add("coverage")
  if (/✖ [1-9]\d* problems?|\d+:\d+\s+error\s/.test(text)) kinds.add("lint")
  if (/(actual|expected): \{\s*MD\d+/.test(text)) kinds.add("test markers")
  if (/✖ readme\b/i.test(text)) kinds.add("readme")
  if (/✖ validateJsonUsingConfigSchema/.test(text)) kinds.add("schema")
  if (/✖ projectFiles/.test(text)) kinds.add("project files")
  if (/error TS\d+/.test(text)) kinds.add("types")
  return [...kinds]
}
const failedByOutput = (text) => /ℹ fail [1-9]|✖ failing tests|not ok \d|plan expected|does not meet (\w+ )?threshold|✖ [1-9]\d* problems?|error TS\d+|npm (ERR!|error) /.test(text)
const resultText = (c) => (Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content ?? ""))

const sessions = []
for (const pass of [1, 2, 3]) {
  const handovers = readJsonl(path.join(opts.results, `markdownlint-p${pass}-handovers.jsonl`))
  for (const arm of ["without", "with"]) {
    const records = readJsonl(path.join(opts.results, `markdownlint-p${pass}-${arm}-records.jsonl`))
    const chain = records.flatMap((r) => (r.commits ?? []).map((c) => ({ hash: c.split(" ")[0], index: r.index })))
    const dir = path.join(opts.projects, `${opts.prefix}${arm}-p${pass}`)
    for (const r of records) {
      const lines = readJsonl(path.join(dir, `${r.session_id}.jsonl`))
      const start = handovers.find((h) => h.session_id === r.session_id && h.moment === "start" && h.picked)
      const byFile = handovers.find((h) => h.session_id === r.session_id && h.moment === "file" && h.picked)
      const indexOf = (hash) => chain.find((c) => c.hash === hash)?.index
      const before = chain.filter((c) => c.index < r.index).reverse()
      const calls = []
      const byId = new Map()
      const results = new Map()
      for (const o of lines) {
        if (o.type === "assistant" && o.message?.usage) {
          let call = byId.get(o.message.id)
          if (!call) { call = { tools: [] }; byId.set(o.message.id, call); calls.push(call) }
          call.usage = o.message.usage
          for (const c of o.message.content ?? []) if (c.type === "tool_use") call.tools.push(c)
        }
        if (o.type === "user" && Array.isArray(o.message?.content)) {
          for (const c of o.message.content) if (c.type === "tool_result") results.set(c.tool_use_id, { text: resultText(c), isError: c.is_error === true })
        }
      }
      let firstEdit = -1, firstCheck = -1, firstFailing = -1, lastFailing = -1
      const git = []
      const failures = []
      calls.forEach((call, i) => {
        call.cost = costOf(call.usage)
        call.history = false
        for (const t of call.tools) {
          const cmd = t.name === "Bash" ? String(t.input?.command ?? "") : ""
          const res = results.get(t.id)
          const parts = cmd ? gitHistory(cmd) : []
          if (parts.length > 0 && !isCheck(cmd) && !writesFile(cmd)) call.history = true
          if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(t.name) || (cmd && parts.length === 0 && !isCheck(cmd) && writesFile(cmd))) {
            if (firstEdit < 0) firstEdit = i
          }
          if (cmd && isCheck(cmd)) {
            if (firstCheck < 0) firstCheck = i
            if (res && (res.isError || failedByOutput(res.text))) {
              failures.push({ kinds: failureKinds(res.text), memorySaw: callFailed({ tool: "Bash", command: cmd, output: res.text, isError: res.isError }) })
              if (firstFailing < 0) firstFailing = i
              lastFailing = i
            }
          }
          if (firstEdit < 0) for (const part of parts) {
            const refs = []
            for (const m of part.matchAll(/HEAD~(\d+)|HEAD\^|\bHEAD\b|\b([0-9a-f]{7,40})\b/g)) {
              const ix = m[1] !== undefined ? before[Number(m[1])]?.index : m[0] === "HEAD^" ? before[1]?.index : m[0] === "HEAD" ? before[0]?.index : chain.find((c) => c.hash.startsWith(m[2]))?.index
              if (ix !== undefined) refs.push(ix)
            }
            git.push({ command: part.slice(0, 160), kind: kindOfGit(part), refs })
          }
        }
      })
      const n = calls.length
      const e = firstEdit < 0 ? n : firstEdit
      const c = firstCheck < 0 ? n : Math.max(firstCheck, e)
      const sum = (from, to, pred = () => true) => calls.slice(from, to).filter(pred).reduce((a, x) => a + x.cost, 0)
      const files = start ? [...start.text.matchAll(/^- (\S+) \(\+\d+ -\d+([^)\n]*)\)/gm)].map((m) => ({ path: m[1], hidden: /isn.t shown/.test(m[2]) })) : []
      const pickedIndex = start ? indexOf(start.picked.commit) : undefined
      sessions.push({
        pass, arm, index: r.index, task: r.task, kind: r.kind, passed: r.passed,
        cost: sum(0, n), recordCost: r.result?.total_cost_usd ?? 0, calls: n,
        beforeEdit: sum(0, e), history: sum(0, e, (x) => x.history), editToCheck: sum(e, c), checkToEnd: sum(c, n),
        failingStretch: firstFailing < 0 ? 0 : sum(firstFailing, lastFailing + 1),
        failures, git,
        start: start ? { picked: pickedIndex, score: start.score, chars: start.chars, hidden: files.filter((f) => f.hidden).map((f) => f.path) } : null,
        byFile: byFile ? { file: byFile.file, picked: indexOf(byFile.picked.commit) } : null,
        lookedUpPicked: pickedIndex !== undefined && git.some((g) => g.refs.includes(pickedIndex))
      })
    }
  }
}
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(sessions, null, 1) + "\n")

const money = (x) => `$${x.toFixed(2)}`
const share = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-")
const total = (s, k) => s.reduce((a, x) => a + x[k], 0)
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const arms = ["without", "with"]

console.log("# Where a markdownlint task's money goes (2026-10-16, three passes)\n")
for (const arm of arms) {
  const s = sessions.filter((x) => x.arm === arm)
  console.log(`- ${arm}: transcripts ${money(total(s, "cost"))}, records ${money(total(s, "recordCost"))}`)
}

console.log("\n## Tasks 2-12, shares of the arm's dollars\n")
console.log("| arm | before the first edit | of it, reading past commits | first edit to first check | first check to the end | of it, first failing check to the last |")
console.log("|---|---|---|---|---|---|")
for (const arm of arms) {
  const s = sessions.filter((x) => x.arm === arm && x.index >= 2)
  const T = total(s, "cost")
  console.log(`| ${arm} | ${share(total(s, "beforeEdit"), T)} | ${share(total(s, "history"), T)} | ${share(total(s, "editToCheck"), T)} | ${share(total(s, "checkToEnd"), T)} | ${share(total(s, "failingStretch"), T)} |`)
}

console.log("\n## Past commits before the first edit, tasks 2-12\n")
{
  const s = sessions.filter((x) => x.arm === "without" && x.index >= 2)
  const read = s.filter((x) => x.git.length > 0)
  const recent = read.filter((x) => x.git.some((g) => g.refs.some((ix) => ix >= x.index - 3)))
  const kinds = {}
  for (const x of s) for (const g of x.git) kinds[g.kind] = (kinds[g.kind] ?? 0) + 1
  console.log(`- without memory: ${read.length} of ${s.length} sessions read past commits; ${recent.length} of those looked at one of the last three tasks' commits; commands by kind ${JSON.stringify(kinds)}`)
  const w = sessions.filter((x) => x.arm === "with" && x.start?.picked !== undefined)
  console.log(`- with a start hand-over: ${w.filter((x) => x.git.length > 0).length} of ${w.length} still read past commits; ${w.filter((x) => x.lookedUpPicked).length} looked up the very commit handed over`)
  const none = sessions.filter((x) => x.arm === "with" && x.index >= 2 && x.start === null)
  console.log(`- with memory, no start hand-over: ${none.filter((x) => x.git.length > 0).length} of ${none.length} read past commits`)
}

console.log("\n## What the start hand-overs hid as changed since\n")
{
  const w = sessions.filter((x) => x.arm === "with" && x.start !== null)
  const hidden = {}
  for (const x of w) for (const f of x.start.hidden) hidden[f] = (hidden[f] ?? 0) + 1
  console.log(`- ${w.length} start hand-overs; files whose change wasn't shown: ${Object.entries(hidden).map(([f, k]) => `${f} ${k}`).join(", ") || "none"}`)
  // A hand-over shows a stored mistake only when its failed command is one line (mistakesToShow).
  const stored = []
  for (const pass of [1, 2, 3]) {
    const dir = path.join(opts.ml, `sg-home-p${pass}`, "tenants", "local", "records", `arm-with-p${pass}`)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      for (const d of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).detours ?? []) {
        stored.push({ multiline: (d.failed?.command ?? "").trim().includes("\n"), kinds: failureKinds(d.symptom ?? "") })
      }
    }
  }
  if (stored.length > 0) {
    const dropped = stored.filter((d) => d.multiline)
    const kinds = {}
    for (const d of dropped) for (const k of d.kinds) kinds[k] = (kinds[k] ?? 0) + 1
    console.log(`- mistakes stored in the three passes: ${stored.length}; left out of any hand-over because the failed command spans lines: ${dropped.length} (by kind ${JSON.stringify(kinds)})`)
  }
}

console.log("\n## Failing check runs\n")
const handedTasks = new Set(sessions.filter((x) => x.arm === "with" && x.start !== null).map((x) => x.task))
for (const arm of arms) {
  const s = sessions.filter((x) => x.arm === arm)
  const runs = s.flatMap((x) => x.failures)
  const kinds = {}
  for (const x of s) for (const k of new Set(x.failures.flatMap((f) => f.kinds))) kinds[k] = (kinds[k] ?? 0) + 1
  const repeat = s.filter((x) => {
    const earlier = new Set(s.filter((y) => y.pass === x.pass && y.index < x.index).flatMap((y) => y.failures.flatMap((f) => f.kinds)))
    return x.failures.some((f) => f.kinds.some((k) => earlier.has(k)))
  })
  const h = s.filter((x) => handedTasks.has(x.task))
  console.log(`- ${arm}: ${s.filter((x) => x.failures.length > 0).length} of ${s.length} sessions had a failing check run (${runs.length} runs, memory's judge saw ${runs.filter((f) => f.memorySaw).length}); ${repeat.length} hit a kind an earlier task of the pass had hit. Sessions by kind: ${JSON.stringify(kinds)}`)
  console.log(`  on the ${handedTasks.size} tasks with a start hand-over: ${h.filter((x) => x.failures.length > 0).length} of ${h.length} sessions had one, median ${median(h.map((x) => x.failures.length))} failing runs`)
}

console.log("\n## Per task, medians of three passes, without -> with\n")
console.log("| task | dollars | before the first edit | first check to the end | failing check runs | handed over |")
console.log("|---|---|---|---|---|---|")
for (const task of [...new Set(sessions.map((x) => x.task))]) {
  const w = sessions.filter((x) => x.task === task && x.arm === "without")
  const m = sessions.filter((x) => x.task === task && x.arm === "with")
  const tn = (ix) => `t${String(ix).padStart(2, "0")}`
  const handed = [...new Set(m.map((x) => (x.start ? tn(x.start.picked) : x.byFile ? `${tn(x.byFile.picked)} by file` : "none")))].join(", ")
  const f = (k) => `${money(median(w.map((x) => x[k])))} -> ${money(median(m.map((x) => x[k])))}`
  console.log(`| ${task} | ${f("cost")} | ${f("beforeEdit")} | ${f("checkToEnd")} | ${median(w.map((x) => x.failures.length))} -> ${median(m.map((x) => x.failures.length))} | ${handed} |`)
}
