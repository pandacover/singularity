// Scores the runs of PREREGISTRATION-eval-2026-10-16.md: the markdownlint
// passes (driver.mjs records and the with arm's hand-over log) against its
// bars, and the harness suites (eval run results) task by task.
//
//   node apps/cli/examples/scripts/score-eval.mjs [--ml <root>] [--harness <dir>]... [--json <file>]
//
// --ml is the folder holding runs-p<N>/, sg-home-p<N>/ and the clones
// (default C:/singularity-workspaces/eval-1016/ml); each --harness is a
// suite's output folder holding nomem-lane<N>/ and scripts-lane<N>/.
// --declarations is check-declarations.mjs's --json output: with it, tasks
// are also scored with the type declarations compared in both arms (the
// driver compares them only when their build type-checks).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const { values: opts } = parseArgs({
  options: {
    ml: { type: "string", default: "C:/singularity-workspaces/eval-1016/ml" },
    harness: { type: "string", multiple: true, default: [] },
    declarations: { type: "string" },
    json: { type: "string" }
  }
})
const declarations = opts.declarations ? JSON.parse(fs.readFileSync(opts.declarations, "utf8")) : undefined

const readJsonl = (file) => {
  if (!fs.existsSync(file)) return []
  const out = []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}
const median = (xs) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const pct = (a, b) => (b === 0 || !Number.isFinite(a) || !Number.isFinite(b) ? "n/a" : `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%`)
const k = (n) => (Number.isFinite(n) ? `${Math.round(n / 1000).toLocaleString("en-US")}k` : "-")
const M = (n) => `${(n / 1e6).toFixed(2)}M`
const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "-")
const out = []
const say = (line = "") => out.push(line)

/** Shell commands a session ran, from its transcript. */
const commandsOf = (transcript) => {
  const cmds = []
  for (const l of readJsonl(transcript)) {
    const content = l.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c.type === "tool_use" && (c.name === "Bash" || c.name === "PowerShell") && typeof c.input?.command === "string") cmds.push(c.input.command)
    }
  }
  return cmds
}
const recallCalls = (cmds) => cmds.filter((c) => /\bsingularity(\.cmd)?\s+recall\b/.test(c)).length

// --- markdownlint ------------------------------------------------------------

/** Tokens of a driver record: model_usage sums every turn (usage can be the last one alone). */
const tokensOf = (r) => {
  const models = Object.values(r.result?.model_usage ?? {})
  if (models.length > 0) {
    const s = (key) => models.reduce((n, m) => n + (m[key] ?? 0), 0)
    const input = s("inputTokens")
    const write = s("cacheCreationInputTokens")
    const read = s("cacheReadInputTokens")
    const output = s("outputTokens")
    return { input, write, read, output, total: input + write + read + output }
  }
  const u = r.result?.usage ?? {}
  const input = u.input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const output = u.output_tokens ?? 0
  return { input, write, read, output, total: input + write + read + output }
}

const markdownlint = () => {
  if (!fs.existsSync(opts.ml)) return undefined
  const passes = fs.readdirSync(opts.ml).filter((d) => /^runs-p\d+$/.test(d)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
  const rows = []
  for (const dir of passes) {
    const pass = Number(dir.slice(6))
    const home = path.join(opts.ml, `sg-home-p${pass}`, "tenants", "local")
    const handovers = readJsonl(path.join(home, "workflows", "handovers.jsonl"))
    // A stored script's id ends with its commit's first 12 characters.
    const commitTask = new Map()
    for (const arm of ["without", "with"]) {
      const byTask = new Map()
      for (const r of readJsonl(path.join(opts.ml, dir, arm, "records.jsonl"))) byTask.set(r.task, r)
      const records = [...byTask.values()].sort((a, b) => a.index - b.index)
      let previousPassed = true
      let previousPassedBoth = true
      for (const r of records) {
        const clone = path.join(opts.ml, `arm-${arm}-p${pass}`)
        const shas = (r.commits ?? []).map((c) => c.split(" ")[0])
        if (arm === "with") for (const sha of shas) commitTask.set(sha.slice(0, 12), r.task)
        let dts = false
        for (const sha of shas) {
          try {
            const files = execFileSync("git", ["-C", clone, "show", "--name-only", "--format=", sha], { encoding: "utf8" })
            if (/^dts\//m.test(files)) dts = true
          } catch {}
        }
        const cmds = commandsOf(path.join(opts.ml, dir, arm, r.task, "transcript.jsonl"))
        const start = handovers.find((h) => h.session_id === r.session_id && h.moment === "start")
        const file = handovers.find((h) => h.session_id === r.session_id && h.moment === "file")
        const decl = declarations?.find((d) => d.pass === pass && d.arm === arm && d.task === r.task)
        const staleDeclarations = decl?.stale ?? []
        rows.push({
          pass, arm, task: r.task, index: r.index, kind: r.kind, passed: r.passed, checks: r.checks, types: r.types,
          staleDeclarations, passedBoth: r.passed && staleDeclarations.length === 0,
          firstFailure: !r.passed && previousPassed,
          firstFailureBoth: !(r.passed && staleDeclarations.length === 0) && previousPassedBoth,
          cost: r.result?.total_cost_usd ?? 0, tokens: tokensOf(r), turns: r.result?.num_turns ?? 0, wallMs: r.wall_ms,
          timedOut: r.timed_out, uncommitted: r.left_uncommitted, commits: shas.length, dtsCommitted: dts,
          recall: recallCalls(cmds), buildDeclaration: cmds.filter((c) => c.includes("build-declaration")).length,
          start: start === undefined ? undefined : {
            picked: start.picked?.id ?? null, score: start.score, chars: start.chars, stored: start.stored,
            mentionsBuildDeclaration: (start.text ?? "").includes("build-declaration"), watching: start.watching ?? null
          },
          file: file === undefined ? undefined : { file: file.file, picked: file.picked?.id ?? null, score: file.score, chars: file.chars }
        })
        previousPassed = r.passed
        previousPassedBoth = r.passed && staleDeclarations.length === 0
      }
    }
    for (const row of rows.filter((x) => x.pass === pass && x.arm === "with")) {
      for (const h of [row.start, row.file]) if (h?.picked) h.pickedTask = commitTask.get(h.picked.slice(-12)) ?? h.picked
    }
  }
  if (rows.length === 0) return undefined
  const of = (arm, pred = () => true) => rows.filter((r) => r.arm === arm && pred(r))
  const totals = (rs) => ({
    n: rs.length, passed: rs.filter((r) => r.passed).length, firstFailures: rs.filter((r) => r.firstFailure).length,
    cost: sum(rs.map((r) => r.cost)), tokens: sum(rs.map((r) => r.tokens.total)), turns: sum(rs.map((r) => r.turns))
  })

  say("# markdownlint, daily use")
  say()
  const complete = [...new Set(rows.map((r) => r.pass))].filter((p) => of("without", (r) => r.pass === p).length === 12 && of("with", (r) => r.pass === p).length === 12)
  say(`Passes with both arms complete: ${complete.join(", ") || "none"}`)
  say()
  say("## Harm first: passed without memory, failed with it (same pass)")
  const harm = rows.filter((r) => r.arm === "with" && !r.passed && rows.some((w) => w.arm === "without" && w.pass === r.pass && w.task === r.task && w.passed))
  if (harm.length === 0) say("none")
  for (const r of harm) say(`- pass ${r.pass} ${r.task}: ${JSON.stringify(r.checks)}${r.firstFailure ? " (first failure of its run)" : " (after an earlier failure)"}`)
  say()
  say("## Per pass")
  say("| pass | arm | passed | first failures | cost | tokens | turns |")
  say("|---|---|---|---|---|---|---|")
  for (const p of [...new Set(rows.map((r) => r.pass))]) {
    for (const arm of ["without", "with"]) {
      const t = totals(of(arm, (r) => r.pass === p))
      say(`| ${p} | ${arm} | ${t.passed} of ${t.n} | ${t.firstFailures} | ${usd(t.cost)} | ${M(t.tokens)} | ${t.turns} |`)
    }
  }
  say()
  if (declarations !== undefined) {
    say("## With the type declarations compared in both arms (check-declarations.mjs; not pre-registered)")
    say("The driver compares the committed declarations with a fresh build only when the build type-checks; here they are compared for every task, type errors or not.")
    say()
    say("| pass | arm | passed | first failures | tasks with stale declarations |")
    say("|---|---|---|---|---|")
    for (const p of [...new Set(rows.map((r) => r.pass))]) {
      for (const arm of ["without", "with"]) {
        const rs = of(arm, (r) => r.pass === p)
        say(`| ${p} | ${arm} | ${rs.filter((r) => r.passedBoth).length} of ${rs.length} | ${rs.filter((r) => r.firstFailureBoth).length} | ${rs.filter((r) => r.staleDeclarations.length > 0).map((r) => r.task.slice(0, 3)).join(" ") || "none"} |`)
      }
    }
    const harmBoth = rows.filter((r) => r.arm === "with" && !r.passedBoth && rows.some((w) => w.arm === "without" && w.pass === r.pass && w.task === r.task && w.passedBoth))
    say()
    say(`Harm, compared this way: ${harmBoth.length === 0 ? "none" : harmBoth.map((r) => `pass ${r.pass} ${r.task}${r.firstFailureBoth ? " (first)" : ""}`).join("; ")}`)
    say()
  }
  const inComplete = (r) => complete.includes(r.pass)
  const w = totals(of("without", inComplete))
  const m = totals(of("with", inComplete))
  const late = (r) => inComplete(r) && r.index >= 3
  const w3 = totals(of("without", late))
  const m3 = totals(of("with", late))
  say(`## Bars (complete passes ${complete.join(", ")})`)
  say(`(a) first failures: without ${w.firstFailures}, with ${m.firstFailures}: ${m.firstFailures <= w.firstFailures ? "holds" : "FAILS"}`)
  say(`(b) tasks 3-12: tokens ${M(w3.tokens)} -> ${M(m3.tokens)} (${pct(m3.tokens, w3.tokens)}, bar -20%), dollars ${usd(w3.cost)} -> ${usd(m3.cost)} (${pct(m3.cost, w3.cost)}, bar -10%): ${m3.tokens <= 0.8 * w3.tokens && m3.cost <= 0.9 * w3.cost ? "holds" : "fails"}`)
  say(`(c) all tasks: dollars ${usd(w.cost)} -> ${usd(m.cost)} (${pct(m.cost, w.cost)}): ${m.cost < w.cost ? "holds" : "fails"}`)
  say(`passed: without ${w.passed} of ${w.n}, with ${m.passed} of ${m.n}; tokens ${M(w.tokens)} -> ${M(m.tokens)} (${pct(m.tokens, w.tokens)}); turns ${w.turns} -> ${m.turns}`)
  say()
  say("## Tasks with a start hand-over and without one (same pass, same task in both arms)")
  const handed = (r) => inComplete(r) && rows.some((x) => x.arm === "with" && x.pass === r.pass && x.task === r.task && x.start?.picked)
  const notHanded = (r) => inComplete(r) && !handed(r)
  for (const [name, pred] of [["start hand-over", handed], ["none at start", notHanded]]) {
    const a = totals(of("without", pred))
    const b = totals(of("with", pred))
    say(`- ${name}: ${b.n} task runs; cost ${usd(a.cost)} -> ${usd(b.cost)} (${pct(b.cost, a.cost)}), tokens ${M(a.tokens)} -> ${M(b.tokens)} (${pct(b.tokens, a.tokens)}), passed ${a.passed} -> ${b.passed}`)
  }
  say()
  say("## Per task (medians over complete passes)")
  say("| # | task | without $ | with $ | Δ$ | without tokens | with tokens | Δtokens | passed w/o | passed with | hand-overs (pass: picked score chars) |")
  say("|---|---|---|---|---|---|---|---|---|---|---|")
  for (const task of [...new Set(rows.map((r) => r.task))]) {
    const a = of("without", (r) => r.task === task && inComplete(r))
    const b = of("with", (r) => r.task === task && inComplete(r))
    if (a.length === 0 && b.length === 0) continue
    const ho = b.map((r) => `p${r.pass}: ${r.start?.picked ? `${r.start.pickedTask} ${r.start.score} ${r.start.chars}` : "none"}${r.file ? `; file ${r.file.file} -> ${r.file.pickedTask}` : ""}`).join("; ")
    const ca = median(a.map((r) => r.cost))
    const cb = median(b.map((r) => r.cost))
    const ta = median(a.map((r) => r.tokens.total))
    const tb = median(b.map((r) => r.tokens.total))
    say(`| ${(a[0] ?? b[0]).index} | ${task} | ${usd(ca)} | ${usd(cb)} | ${pct(cb, ca)} | ${k(ta)} | ${k(tb)} | ${pct(tb, ta)} | ${a.filter((r) => r.passed).length}/${a.length} | ${b.filter((r) => r.passed).length}/${b.length} | ${ho} |`)
  }
  say()
  say("## Failures")
  for (const r of rows.filter((x) => !x.passed)) {
    const failed = Object.entries(r.checks ?? {}).filter(([, v]) => !v).map(([c]) => c)
    say(`- pass ${r.pass} ${r.arm} ${r.task}: ${failed.join(", ") || "no commit"}${r.firstFailure ? " (first)" : ""}${r.dtsCommitted ? ", committed dts/" : ""}${r.uncommitted ? ", left uncommitted work" : ""}${r.timedOut ? ", timed out" : ""}`)
  }
  say()
  say("## Read out")
  const withRows = of("with", inComplete)
  say(`- recall calls: with ${sum(withRows.map((r) => r.recall))} in ${withRows.length} sessions; without ${sum(of("without", inComplete).map((r) => r.recall))}`)
  say(`- file hand-overs: ${withRows.filter((r) => r.file).length} (${withRows.filter((r) => r.file).map((r) => `p${r.pass} ${r.task}: ${r.file.file} -> ${r.file.pickedTask}`).join("; ") || "none"})`)
  const bd = (arm) => of(arm, inComplete).filter((r) => r.buildDeclaration > 0 && !r.task.startsWith("t05"))
  say(`- ran build-declaration (t05 aside): without ${bd("without").length}, with ${bd("with").length}; with arm sessions whose start hand-over named it: ${withRows.filter((r) => r.start?.mentionsBuildDeclaration).length}, of which ran it ${withRows.filter((r) => r.start?.mentionsBuildDeclaration && r.buildDeclaration > 0).length}`)
  say(`- committed dts/: without ${of("without", inComplete).filter((r) => r.dtsCommitted).length}, with ${withRows.filter((r) => r.dtsCommitted).length}`)
  say(`- types (declaration build, not counted) ok: without ${of("without", inComplete).filter((r) => r.types).length}, with ${withRows.filter((r) => r.types).length}`)
  say()
  return { rows, complete }
}

// --- the harness suites ------------------------------------------------------

const harness = (dir) => {
  const runs = []
  for (const sub of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^(nomem|scripts)-lane\d+$/.test(sub)) continue
    for (const r of readJsonl(path.join(dir, sub, "results.jsonl"))) {
      const transcript = path.join(dir, sub, "runs", String(r.run_id), "transcript", `${r.session_id}.jsonl`)
      runs.push({ ...r, recall: recallCalls(commandsOf(transcript)) })
    }
  }
  if (runs.length === 0) return undefined
  say(`# ${dir}`)
  say()
  say("| task | setup | runs | passed | median tokens | range | median $ | median turns | hand-over | recall |")
  say("|---|---|---|---|---|---|---|---|---|---|")
  const verdicts = []
  for (const task of [...new Set(runs.map((r) => r.task_id))]) {
    const by = {}
    for (const setup of ["no-memory", "scripts"]) {
      const rs = runs.filter((r) => r.task_id === task && r.setup === setup)
      if (rs.length === 0) continue
      const tokens = rs.map((r) => r.tokens?.total ?? 0)
      const inj = rs[0].injection ?? {}
      by[setup] = {
        n: rs.length, passed: rs.filter((r) => r.success === true).length,
        tokens: median(tokens), cost: median(rs.map((r) => r.cost_usd ?? 0)), turns: median(rs.map((r) => r.agent?.num_turns ?? 0)),
        totalCost: sum(rs.map((r) => r.cost_usd ?? 0))
      }
      const ho = setup === "scripts" ? (inj.retrieved ? `${inj.retrieved.task_id} ${inj.similarity}` : `none (${inj.similarity})`) : ""
      say(`| ${task} | ${setup} | ${rs.length} | ${by[setup].passed} | ${k(by[setup].tokens)} | ${k(Math.min(...tokens))}-${k(Math.max(...tokens))} | ${usd(by[setup].cost)} | ${by[setup].turns} | ${ho} | ${sum(rs.map((r) => r.recall))} |`)
    }
    const a = by["no-memory"]
    const b = by["scripts"]
    if (a && b) {
      const fewerFails = b.n - b.passed <= a.n - a.passed
      const verdict = !fewerFails || b.tokens > 1.1 * a.tokens ? "hurts" : b.tokens <= 0.8 * a.tokens && b.cost <= 0.9 * a.cost ? "helps" : "no clear difference"
      verdicts.push({ task, tokens: pct(b.tokens, a.tokens), cost: pct(b.cost, a.cost), failsNoMemory: a.n - a.passed, failsScripts: b.n - b.passed, verdict, runs: [a.n, b.n] })
    }
  }
  say()
  say("| task | runs (no memory, scripts) | median tokens | median $ | failed runs (no memory, scripts) | verdict |")
  say("|---|---|---|---|---|---|")
  for (const v of verdicts) say(`| ${v.task} | ${v.runs.join(", ")} | ${v.tokens} | ${v.cost} | ${v.failsNoMemory}, ${v.failsScripts} | ${v.verdict} |`)
  const spent = (setup) => sum(runs.filter((r) => r.setup === setup).map((r) => r.cost_usd ?? 0))
  say()
  say(`Spent: no memory ${usd(spent("no-memory"))}, scripts ${usd(spent("scripts"))}`)
  say()
  return { runs: runs.map(({ recall, ...r }) => ({ run_id: r.run_id, task: r.task_id, setup: r.setup, success: r.success, cost: r.cost_usd, tokens: r.tokens?.total, turns: r.agent?.num_turns, recall })), verdicts }
}

const result = { markdownlint: markdownlint(), harness: Object.fromEntries(opts.harness.map((d) => [d, harness(d)])) }
console.log(out.join("\n"))
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(result, null, 2) + "\n")
