// Whether the mistakes memory stored in the 2026-10-16 markdownlint runs were
// worth handing over. A stored mistake is a record's detour: a call that
// failed, the call that then worked, and what the run spent in between. Each
// is sorted by what it teaches (this repository, this machine or its tools,
// only its own task), whether the record says what fixed it, and whether a
// later task of the same pass made the same mistake. Then the most the later
// tasks could have saved had memory warned them, three ways: what the
// hand-over showed, every mistake of the change it handed over, and every
// mistake stored so far. That's a ceiling: it counts a warned mistake as never
// made, though its fix still had to be done; for a test count mistake, whose
// numbers only a test run tells, it also says what's left once the edit and
// the run after the failing one are taken out. Free: reads files only.
//
//   node apps/cli/examples/scripts/stored-mistakes.mjs [--results <dir>] [--projects <dir>] [--ml <dir>] [--home <dir>]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const here = path.dirname(fileURLToPath(import.meta.url))
const { values: opts } = parseArgs({
  options: {
    results: { type: "string", default: path.join(here, "results", "eval-2026-10-16") },
    projects: { type: "string", default: path.join(os.homedir(), ".claude", "projects") },
    prefix: { type: "string", default: "C--singularity-workspaces-eval-1016-ml-arm-with-p" },
    // the with arm's memory homes, sg-home-p<pass>
    ml: { type: "string", default: "C:/singularity-workspaces/eval-1016/ml" },
    // a memory home to count the same way, read only (the user's own by default)
    home: { type: "string", default: path.join(os.homedir(), ".singularity") }
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
const tokensOf = (u) => (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)

// What a mistake teaches, from text: a stored symptom with its commands, or a call's whole output.
const MACHINE = new Set(["python-encoding", "python-escapes"])
const COUNTS = new Set(["plan-count", "file-count"])
const REPO = new Set([...COUNTS, "project-files", "snapshot", "readme", "schema", "coverage", "missing-doc"])
const keysOf = (text, kind) => {
  const keys = new Set()
  if (kind === "tool_error") return keys
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
    const rule = line.trim().split(/\s+/).pop()
    if (/^(@[\w-]+\/)?[a-z][\w-]*(\/[\w-]+)?$/.test(rule) && rule.includes("-")) keys.add(`lint:${rule}`)
  }
  if (/error TS\d+/.test(text)) keys.add("types")
  if (/(?:expected|actual): \{ ?MD\d+|Too few or too many issues found/.test(text)) keys.add("markers")
  if (/^AssertionError: \(/m.test(text)) keys.add("own-script")
  if (keys.size === 0 && /ℹ fail [1-9]|✖ failing tests|not ok \d/.test(text)) keys.add("tests-failed")
  return keys
}
const lessonKeys = (keys) => [...keys].filter((k) => MACHINE.has(k) || REPO.has(k) || k.startsWith("lint:"))
const bucketOf = (keys) => {
  const ks = [...keys]
  if (ks.some((k) => MACHINE.has(k))) return "this machine or its tools"
  if (ks.some((k) => REPO.has(k) || k.startsWith("lint:"))) return "this repository"
  if (ks.some((k) => k === "types" || k === "markers")) return "only its own task"
  if (ks.includes("tests-failed")) return "can't tell (says only that tests failed)"
  return "noise (a tool's own error, the agent's own assert)"
}
const BUCKETS = ["this repository", "this machine or its tools", "only its own task", "can't tell (says only that tests failed)", "noise (a tool's own error, the agent's own assert)"]

const isCheck = (cmd) => /\bnpm (test|t\b|run (test|lint|ci|build-declaration|update-snapshots))|node --test|npx (eslint|tsc|markdownlint)|\btsc\b/.test(cmd)

// Whether a record says what fixed a mistake: the edit, by key where that's knowable.
const EDIT = /\bsed -i|perl -[a-z]*i|\bpython\b|cat\s*>{1,2}\s*[^\s/]|printf [^|]*>\s*[^\s/]|\btee\b|writeFileSync|eslint --fix|update-snapshots/
const fixShown = (d) => {
  const text = [d.fixed?.command ?? "", ...(d.added ?? [])].join("\n")
  const edited = d.files_edited ?? []
  const keys = lessonKeys(keysOf([d.symptom ?? "", d.failed?.command ?? ""].join("\n"), d.kind))
  const byKey = (k) =>
    k === "plan-count" ? /t\.plan|plan\(/.test(text) || edited.some((f) => f.endsWith("markdownlint-test.mjs"))
    : k === "file-count" ? /files\.length|filteredFiles/.test(text) || edited.some((f) => f.endsWith("markdownlint-test-project.mjs"))
    : k === "snapshot" ? /update-snapshots/.test(text) || edited.some((f) => f.endsWith(".snapshot"))
    : k === "python-encoding" ? /encoding\s*=\s*['"]?utf-?8|-X utf8|PYTHONUTF8/i.test(text)
    : EDIT.test(text) || edited.length > 0 || ["Edit", "Write", "MultiEdit"].includes(d.fixed?.tool)
  if (keys.length > 0) return keys.some(byKey)
  return EDIT.test(text) || edited.length > 0 || ["Edit", "Write", "MultiEdit"].includes(d.fixed?.tool)
}

// The sessions: responses (deduped by message id, as the record's turns are) and tool calls in order.
const sessionOf = (file) => {
  const responses = []
  const byId = new Map()
  const calls = []
  const results = new Map()
  for (const o of readJsonl(file)) {
    if (o.type === "assistant" && o.message?.usage) {
      let r = byId.get(o.message.id)
      if (!r) { r = { tools: [] }; byId.set(o.message.id, r); responses.push(r) }
      r.usage = o.message.usage
      for (const c of o.message.content ?? []) if (c.type === "tool_use") { calls.push(c); r.tools.push(c) }
    }
    if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === "tool_result") results.set(c.tool_use_id, Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content ?? ""))
      }
    }
  }
  for (const r of responses) { r.cost = costOf(r.usage); r.tokens = tokensOf(r.usage) }
  return { responses, calls, results }
}

const tasks = []
let aligned = 0, detourCount = 0, callsAligned = 0
for (const pass of [1, 2, 3]) {
  const runs = readJsonl(path.join(opts.results, `markdownlint-p${pass}-with-records.jsonl`))
  const handovers = readJsonl(path.join(opts.results, `markdownlint-p${pass}-handovers.jsonl`))
  const dir = path.join(opts.ml, `sg-home-p${pass}`, "tenants", "local", "records", `arm-with-p${pass}`)
  const records = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
  for (const run of runs) {
    const record = records.find((r) => (run.commits ?? []).some((c) => c.startsWith(r.run.head_commit)))
    const session = sessionOf(path.join(opts.projects, `${opts.prefix}${pass}`, `${run.session_id}.jsonl`))
    const start = handovers.find((h) => h.session_id === run.session_id && h.moment === "start" && h.picked)
    const detours = (record?.detours ?? []).map((d) => {
      detourCount++
      const range = session.responses.slice(d.failed.turn + 1, d.fixed.turn + 1)
      if (range.reduce((a, r) => a + r.tokens, 0) === d.cost.tokens) aligned++
      const call = session.calls[d.failed.call]
      const command = String(call?.input?.command ?? "")
      if (call && (d.failed.command == null ? call.name === d.failed.tool : command.includes(d.failed.command.split("\n")[0].trim().slice(0, 40)))) callsAligned++
      const output = call ? session.results.get(call.id) ?? "" : ""
      const stored = keysOf([d.symptom ?? "", d.failed?.command ?? ""].join("\n"), d.kind)
      const actual = keysOf([d.symptom ?? "", output].join("\n"), d.kind)
      return { d, stored, actual, from: d.failed.turn + 1, to: d.fixed.turn + 1, multiline: (d.failed.command ?? "").trim().includes("\n"), fixShown: fixShown(d) }
    })
    const shownText = start ? (start.text.match(/## Mistakes (?:it made|other changes to these files made)\n\n([\s\S]*?)(?=\n\n## |$)/g) ?? []).join("\n") : ""
    tasks.push({ pass, index: run.index, task: run.task, cost: run.result?.total_cost_usd ?? 0, session, record, detours, picked: start?.picked?.commit, shownKeys: new Set(lessonKeys(keysOf(shownText))) })
  }
}

const money = (x) => `$${x.toFixed(2)}`
const share = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-")
console.log("# Mistakes memory stored in the markdownlint runs (2026-10-16, with arm, three passes)\n")
console.log(`- ${detourCount} stored mistakes; their token cost matches the transcript's responses for ${aligned}, their failed call for ${callsAligned}`)

// The table: what each stored mistake teaches.
console.log("\n| teaches about | mistakes | says what fixed it | a later task of the pass made it again | left out of hand-overs (spans lines) | what they cost |")
console.log("|---|---|---|---|---|---|")
for (const bucket of BUCKETS) {
  const rows = []
  for (const t of tasks) for (const x of t.detours) if (bucketOf(x.stored) === bucket) rows.push({ t, x })
  const again = rows.filter(({ t, x }) => {
    const keys = lessonKeys(x.stored)
    return keys.length > 0 && tasks.some((u) => u.pass === t.pass && u.index > t.index && u.detours.some((y) => keys.some((k) => y.actual.has(k))))
  })
  const cost = rows.reduce((a, { t, x }) => a + t.session.responses.slice(x.from, x.to).reduce((b, r) => b + r.cost, 0), 0)
  console.log(`| ${bucket} | ${rows.length} | ${rows.filter(({ x }) => x.fixShown).length} | ${again.length} | ${rows.filter(({ x }) => x.multiline).length} | ${money(cost)} |`)
}
const keyCounts = {}
for (const t of tasks) for (const x of t.detours) for (const k of x.stored) keyCounts[k] = (keyCounts[k] ?? 0) + 1
console.log(`\nStored mistakes by key: ${Object.entries(keyCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`)

// The ceiling: later tasks' mistakes a warning could have spared, by what memory could have told.
const views = {
  "what the hand-over showed": (t) => t.shownKeys,
  "every mistake of the change handed over": (t) => {
    const r = tasks.find((u) => u.pass === t.pass && u.record && t.picked && u.record.run.head_commit === t.picked)
    return new Set(r ? r.detours.flatMap((x) => lessonKeys(x.stored)) : [])
  },
  "every mistake stored so far": (t) => new Set(tasks.filter((u) => u.pass === t.pass && u.index < t.index).flatMap((u) => u.detours.flatMap((x) => lessonKeys(x.stored))))
}
const spared = (view, from, withCounts, only) => {
  let dollars = 0, mistakes = 0
  for (const t of tasks.filter((u) => u.index >= from)) {
    const known = view(t)
    const turns = new Set()
    for (const x of t.detours) {
      const keys = lessonKeys(x.actual).filter((k) => (withCounts || !COUNTS.has(k)) && (only === undefined || only(k)))
      if (!keys.some((k) => known.has(k))) continue
      mistakes++
      for (let i = x.from; i < x.to; i++) turns.add(i)
    }
    for (const i of turns) dollars += t.session.responses[i]?.cost ?? 0
  }
  return { dollars, mistakes }
}
for (const from of [2, 3]) {
  const total = tasks.filter((t) => t.index >= from).reduce((a, t) => a + t.cost, 0)
  const all = tasks.filter((t) => t.index >= from).reduce((a, t) => a + t.detours.length, 0)
  console.log(`\nTasks ${from}-12: ${money(total)}, ${all} stored mistakes. The most a warning could have spared:\n`)
  console.log("| memory could tell | mistakes matched | dollars | share | without the count mistakes: matched | dollars | share |")
  console.log("|---|---|---|---|---|---|---|")
  for (const [name, view] of Object.entries(views)) {
    const a = spared(view, from, true)
    const b = spared(view, from, false)
    console.log(`| ${name} | ${a.mistakes} | ${money(a.dollars)} | ${share(a.dollars, total)} | ${b.mistakes} | ${money(b.dollars)} | ${share(b.dollars, total)} |`)
  }
  const any = views["every mistake stored so far"]
  const parts = [
    ["the test counts (plan, files)", (k) => COUNTS.has(k)],
    ["this machine or its tools", (k) => MACHINE.has(k)],
    ["the rest of this repository's", (k) => !COUNTS.has(k) && !MACHINE.has(k)]
  ].map(([name, only]) => {
    const s = spared(any, from, true, only)
    return `${name} ${s.mistakes} (${money(s.dollars)}, ${share(s.dollars, total)})`
  })
  console.log(`\nOf every mistake stored so far, by what it teaches (a mistake can match two): ${parts.join("; ")}`)

  // A test count can't be known before the tests run: after the failing run the agent still has to
  // edit the counts and run the tests again. A warning that names where the counts live could spare
  // the rest: looking for them, and the edits and runs beyond the first.
  const split = { look: 0, extraEdits: 0, extraChecks: 0, firstEdit: 0, firstCheck: 0, other: 0 }
  let warnable = 0
  for (const t of tasks.filter((u) => u.index >= from)) {
    const known = any(t)
    const full = new Set()
    const counted = new Map()
    for (const x of t.detours) {
      const keys = lessonKeys(x.actual).filter((k) => known.has(k))
      if (keys.length === 0) continue
      if (keys.some((k) => !COUNTS.has(k))) { for (let i = x.from; i < x.to; i++) full.add(i); continue }
      let edits = 0, checks = 0
      for (let i = x.from; i < x.to; i++) {
        const tools = t.session.responses[i]?.tools ?? []
        const commands = tools.map((c) => String(c.input?.command ?? ""))
        const kind = commands.some(isCheck) ? "check"
          : tools.some((c) => ["Edit", "Write", "MultiEdit"].includes(c.name)) || commands.some((c) => c !== "" && EDIT.test(c)) ? "edit"
          : tools.length > 0 ? "look" : "other"
        const part = kind === "check" ? (checks++ === 0 ? "firstCheck" : "extraChecks") : kind === "edit" ? (edits++ === 0 ? "firstEdit" : "extraEdits") : kind
        if (!counted.has(i)) counted.set(i, part)
      }
    }
    for (const i of full) warnable += t.session.responses[i]?.cost ?? 0
    for (const [i, part] of counted) {
      const cost = t.session.responses[i]?.cost ?? 0
      split[part] += cost
      if (!full.has(i) && ["look", "extraEdits", "extraChecks", "other"].includes(part)) warnable += cost
    }
  }
  console.log(`Inside the count mistakes a warning could have spared: looking ${money(split.look)}, edits beyond the first ${money(split.extraEdits)}, test runs beyond the first ${money(split.extraChecks)}, no tool ${money(split.other)}; it couldn't spare the first edit ${money(split.firstEdit)} and the first rerun ${money(split.firstCheck)}`)
  console.log(`So the most a list of every stored mistake could spare, the counts' unavoidable part taken out: ${money(warnable)}, ${share(warnable, total)}`)
}

// The same count over a memory home in daily use, read only.
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : [])) : [])
const tenants = path.join(opts.home, "tenants")
const files = fs.existsSync(tenants) ? fs.readdirSync(tenants).flatMap((t) => walk(path.join(tenants, t, "records"))) : []
if (files.length > 0) {
  const recs = files.map((f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }).filter((r) => r && Array.isArray(r.detours))
  // Only what doesn't depend on markdownlint's own checks: the keys above are tuned to them.
  const ds = recs.flatMap((r) => r.detours)
  const kinds = {}
  for (const d of ds) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1
  const summaryOnly = (s) => s.split(/\r?\n/).every((l) => /^\s*$|^(ℹ )?fail \d+|^✖ failing tests|^(Test Files|Tests)\s+\d+ failed|^FAIL\b|^\d+ failing/.test(l.trim()))
  const subjects = [...new Set(recs.map((r) => r.subject))]
  console.log(`\n${opts.home}: ${recs.length} records (${subjects.join(", ")}), ${ds.length} stored mistakes by kind ${JSON.stringify(kinds)}; left out of hand-overs as spanning lines ${ds.filter((d) => (d.failed?.command ?? "").trim().includes("\n")).length}; Python's charmap error ${ds.filter((d) => /UnicodeDecodeError: 'charmap'/.test(d.symptom ?? "")).length}; symptom says only that tests failed ${ds.filter((d) => summaryOnly(d.symptom ?? "")).length}; files_edited recorded ${ds.filter((d) => (d.files_edited ?? []).length > 0).length}`)
}
