// Does the recall note's wording decide whether an agent runs `singularity
// recall` on its own? Six markdownlint tasks, each started where pass 1 of the
// 2026-10-16 eval left the repo before it (its earlier changes in git and in
// memory, nothing handed over), asked in a fresh session under the note setup
// installs (A) or a variant tied to the agent's habit of reading git history
// (B). A session ends at its first edit, where an agent has decided how to go
// about the change (PREREGISTRATION-note-2026-10-17.md in ../scripts).
//
//   node note-test.mjs --out <dir> --dry-run    prepare every session's repo and memory, run recall, spend nothing
//   node note-test.mjs --out <dir> --probe      one one-line session in a scratch repo: does the stop hook end it?
//   node note-test.mjs --out <dir>              the twelve sessions
//   node note-test.mjs --out <dir> --score      score the sessions run so far again
//   node note-test.mjs --out <dir> --clean      remove the clones (their node_modules junctions first)
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const here = path.dirname(fileURLToPath(import.meta.url))
const { values: opts } = parseArgs({
  options: {
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    probe: { type: "boolean", default: false },
    score: { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
    // Pass 1 of the 2026-10-16 markdownlint eval, memory arm: its clone, its memory and its task records.
    source: { type: "string", default: "C:/singularity-workspaces/eval-1016/ml/arm-with-p1" },
    "source-home": { type: "string", default: "C:/singularity-workspaces/eval-1016/ml/sg-home-p1" },
    "source-runs": { type: "string", default: "C:/singularity-workspaces/eval-1016/ml/runs-p1/with" },
    // The branch's code, frozen (COMMIT.txt there): its note is the installed one.
    app: { type: "string", default: "C:/singularity-workspaces/eval-1016/app-new" },
    claude: { type: "string", default: "C:/singularity-workspaces/_claude/2.1.296/claude.exe" },
    budget: { type: "string", default: "0.60" },
    "max-turns": { type: "string", default: "40" },
    cap: { type: "string", default: "4.00" },
    "timeout-min": { type: "string", default: "15" }
  }
})
if (!opts.out) {
  console.error("usage: node note-test.mjs --out <dir> [--dry-run | --probe | --score | --clean]")
  process.exit(2)
}

// Everything this starts runs below normal priority, so the user can keep working.
try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
} catch {}

const out = path.resolve(opts.out)
const app = path.resolve(opts.app)
fs.mkdirSync(out, { recursive: true })

// --- the two notes: A as setup installs it, B tied to reading git history, no hedges ---

const { RECALL_NOTE } = await import(pathToFileURL(path.join(app, "apps", "cli", "src", "setup", "Instructions.ts")).href)
const NOTE_B = `## singularity memory

This machine keeps the changes past coding sessions committed in each git
repository, with what git doesn't keep: the commands each session ran and the
mistakes it made. At task start you may be handed one, headed "A past change
in this repository like your task".

When nothing was handed over, run \`singularity recall "<what you are about to do>"\`
in the repository before you look through its history for how something was
done (git log, git show, git blame). It prints the most similar past change,
read from git as it is now, with the commands its session ran and the mistakes
it made, or says there is none. It takes a second or two and calls no model.`
const notes = { A: path.join(out, "notes", "A.md"), B: path.join(out, "notes", "B.md") }
fs.mkdirSync(path.dirname(notes.A), { recursive: true })
fs.writeFileSync(notes.A, RECALL_NOTE + "\n")
fs.writeFileSync(notes.B, NOTE_B + "\n")

// --- the sessions, in the order they run: each task under both notes, which one first alternating ---

const PLAN = [
  ["t04-list-max-depth", "A", "B"],
  ["t07-link-url-scheme", "B", "A"],
  ["t09-md014-prompts", "A", "B"],
  ["t10-ol-delimiter-style", "B", "A"],
  ["t08-todo-comments-example", "A", "B"],
  ["t11-circular-extends", "B", "A"]
]
// What an agent might ask recall for, for the dry run only.
const QUERIES = {
  "t04-list-max-depth": "add a new built-in rule MD063 list-max-depth",
  "t07-link-url-scheme": "add a new built-in rule MD064 link-url-scheme",
  "t09-md014-prompts": "add a prompts parameter to rule MD014 commands-show-output",
  "t10-ol-delimiter-style": "add a new built-in rule MD065 ol-delimiter-style",
  "t08-todo-comments-example": "add an example custom rule todo-comments to test/rules",
  "t11-circular-extends": "fix the stack overflow in readConfig when an extends chain is circular"
}
const { tasks } = JSON.parse(fs.readFileSync(path.join(here, "tasks-day.json"), "utf8"))
const ids = tasks.map((t) => t.id)
// Each task's commits in the source pass: where it started and what it committed.
const passRecords = fs.readFileSync(path.join(opts["source-runs"], "records.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l))
const commitsOf = Object.fromEntries(passRecords.map((r) => [r.task, { pre: r.pre, post: r.post }]))
const sessions = PLAN.flatMap(([task, first, second]) => [first, second].map((note) => ({ task, note, name: `${task.slice(0, 3)}-${note}` })))

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  fs.appendFileSync(path.join(out, "note-test.log"), line + "\n")
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const gitOk = (cwd, ...args) => {
  try {
    git(cwd, ...args)
    return true
  } catch {
    return false
  }
}

// --- a session's starting state: the repo before its task, memory of the tasks before it ---

const sessionDir = (s) => path.join(out, s.name)
const repoOf = (s) => path.join(sessionDir(s), "repo")
const homeOf = (s) => path.join(sessionDir(s), "home")

const prepare = (s) => {
  const dir = sessionDir(s)
  const repo = repoOf(s)
  if (fs.existsSync(repo)) throw new Error(`${repo} exists: --clean first`)
  fs.mkdirSync(dir, { recursive: true })
  const { pre } = commitsOf[s.task]
  // A clone holding nothing after the task's start: no remote, no reflog, the later commits pruned.
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--no-local", "--no-checkout", opts.source, repo], { stdio: "ignore" })
  git(repo, "config", "core.autocrlf", "false")
  git(repo, "checkout", "--quiet", "-B", "main", pre)
  git(repo, "remote", "remove", "origin")
  for (const f of ["FETCH_HEAD", "ORIG_HEAD"]) fs.rmSync(path.join(repo, ".git", f), { force: true })
  git(repo, "reflog", "expire", "--expire=now", "--all")
  git(repo, "gc", "--quiet", "--prune=now")
  const index = ids.indexOf(s.task)
  const later = ids.slice(index).map((id) => commitsOf[id].post)
  const leaked = later.filter((c) => gitOk(repo, "cat-file", "-e", `${c}^{commit}`))
  if (leaked.length > 0) throw new Error(`${s.name}: the clone still has later commits ${leaked.join(", ")}`)
  if (git(repo, "status", "--porcelain") !== "") throw new Error(`${s.name}: the clone isn't clean`)
  fs.symlinkSync(path.join(opts.source, "node_modules"), path.join(repo, "node_modules"), "junction")
  // Memory: the source pass's, with the records of the tasks before this one only.
  const home = homeOf(s)
  const src = opts["source-home"]
  const records = path.join(src, "tenants", "local", "records", "arm-with-p1")
  const earlier = new Set(ids.slice(0, index).map((id) => commitsOf[id].post.slice(0, 12)))
  const kept = fs.readdirSync(records).filter((f) => earlier.has(f.replace(/^arm-with-p1-/, "").replace(/\.json$/, "")))
  if (kept.length !== index) throw new Error(`${s.name}: expected ${index} earlier records, found ${kept.length}`)
  fs.mkdirSync(path.join(home, "tenants", "local", "records", "arm-with-p1"), { recursive: true })
  fs.copyFileSync(path.join(src, "config.json"), path.join(home, "config.json"))
  fs.copyFileSync(path.join(src, "tenants", "local", "subjects.json"), path.join(home, "tenants", "local", "subjects.json"))
  for (const f of kept) fs.copyFileSync(path.join(records, f), path.join(home, "tenants", "local", "records", "arm-with-p1", f))
  return { pre, records: kept.length }
}

// The `singularity` command on a session's PATH: the frozen code, the session's memory (SINGULARITY_HOME).
const launcherDir = path.join(out, "bin")
fs.mkdirSync(launcherDir, { recursive: true })
const cli = path.join(app, "apps", "cli", "src", "singularity.ts")
fs.writeFileSync(path.join(launcherDir, "singularity"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 })
fs.writeFileSync(path.join(launcherDir, "singularity.cmd"), `@"${process.execPath}" "${cli}" %*\r\n`)

// A shell command that writes into the repo, roughly: redirection into a file, sed -i, PowerShell's
// writers, a script's writeFileSync or open(..., "w"), tee, git apply. Agents here often write files
// through Bash heredocs and Python rather than Edit (the first session did).
const SHELL_WRITE = /(^|[^0-9&>=-])>{1,2}\s*(?!\/dev\/null|&|\$null|nul\b)["']?[\w./\\-]+\.(m?js|cjs|json|jsonc|md|ts|mts|cts|yml|yaml|txt)\b|\bsed\s+-i\b|\bperl\s+-\w*i|\b(Set-Content|Add-Content|Out-File)\b|writeFileSync|\.write_text\(|open\([^)]*['"][wa]\+?['"]|\btee\s+(-a\s+)?\S|\bgit\s+apply\b/

// The first edit ends the session: an Edit-family call, or a shell command that writes. The edit
// itself lands (the throwaway clone's). Node exits on its own (no process.exit).
const stopHook = path.join(out, "stop-at-first-edit.mjs")
fs.writeFileSync(stopHook, [
  "// The note test's stop rule: the first edit ends the session, whether an Edit-family call or a shell command that writes a file.",
  `const WRITE = ${SHELL_WRITE}`,
  "let input = \"\"",
  "process.stdin.on(\"data\", (d) => (input += d))",
  "process.stdin.on(\"end\", () => {",
  "  let tool = \"?\"",
  "  let command = \"\"",
  "  try {",
  "    const j = JSON.parse(input)",
  "    tool = j.tool_name",
  "    command = String(j.tool_input?.command ?? \"\")",
  "  } catch {}",
  "  const editing = tool === \"Bash\" || tool === \"PowerShell\" ? WRITE.test(command) : true",
  "  if (editing) process.stdout.write(JSON.stringify({ continue: false, stopReason: `note test: stopped at the first edit (${tool})` }) + \"\\n\")",
  "})",
  ""
].join("\n"))
const slashed = (p) => p.replace(/\\/g, "/")
const settingsFile = path.join(out, "stop-settings.json")
fs.writeFileSync(settingsFile, JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell", hooks: [{ type: "command", command: `"${slashed(process.execPath)}" "${slashed(stopHook)}"`, timeout: 30 }] }] }
}, null, 2) + "\n")

// The variables a parent Claude Code session sets for its children (src/eval/Agent.ts SESSION_VARS).
const SESSION_VARS = new Set([
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID"
])
const envFor = (home) => {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SESSION_VARS.has(k) && !k.startsWith("SINGULARITY_")) env[k] = v
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"
  env.DISABLE_AUTOUPDATER = "1"
  // No hooks of memory's (nothing handed over, nothing stored); recall reads the session's own memory.
  env.SINGULARITY_HOOKS = "off"
  env.SINGULARITY_HOME = home
  env.PATH = `${launcherDir}${path.delimiter}${env.PATH ?? ""}`
  return env
}

const run = (cmd, args, { cwd, env, input, timeoutMs }) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: false })
    const outChunks = []
    const errChunks = []
    child.stdout.on("data", (d) => outChunks.push(d))
    child.stderr.on("data", (d) => errChunks.push(d))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
        else child.kill("SIGKILL")
      } catch {}
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(outChunks).toString("utf8"), stderr: Buffer.concat(errChunks).toString("utf8"), timedOut, ms: Date.now() - started })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })

const parseResult = (stdout) => {
  for (const text of [stdout.trim(), ...stdout.split(/\r?\n/).reverse().map((l) => l.trim())]) {
    if (!text.startsWith("{")) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && parsed.type === "result") return parsed
    } catch {}
  }
  return undefined
}

const transcriptOf = (cwd, sessionId) =>
  path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`)

const claudeArgs = (sessionId, note) => [
  "-p", "--output-format", "json", "--session-id", sessionId,
  "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--strict-mcp-config",
  "--model", "sonnet", "--effort", "medium", "--max-budget-usd", opts.budget, "--max-turns", opts["max-turns"],
  "--allowed-tools", "Bash,PowerShell,Read,Edit,Write,Glob,Grep",
  "--setting-sources", "project,local",
  "--settings", settingsFile,
  "--append-system-prompt-file", notes[note]
]

const promptOf = (taskId) => `This is our fork of markdownlint. ${tasks.find((t) => t.id === taskId).prompt}`

// The account's usage limit: stop (exit 75); the rest runs again later.
const limitHit = (result) => result && (result.api_error_status === 429 || result.api_error === "usage_limit_reached" || /hit your .*limit/i.test(String(result.result ?? "")))

// --- scoring, from a session's transcript ---

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const RECALL = /(^|[\s;&|(])singularity(\.cmd)?\s+recall\b/
const HISTORY = /\bgit\b(\s+-C\s+\S+)?\s+(log|show|blame|whatchanged)\b|\bgit\b(\s+-C\s+\S+)?\s+diff\b[^\n]*(HEAD[~^]|\b[0-9a-f]{7,40}\b|\.\.)/

export const scoreTranscript = (file) => {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
  const results = new Map()
  for (const o of lines) {
    if (o.type !== "user" || !Array.isArray(o.message?.content)) continue
    for (const c of o.message.content) {
      if (c.type === "tool_result") results.set(c.tool_use_id, typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join(""))
    }
  }
  const calls = []
  for (const o of lines) {
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue
    for (const c of o.message.content) {
      if (c.type !== "tool_use") continue
      const command = c.name === "Bash" || c.name === "PowerShell" ? String(c.input?.command ?? "") : ""
      calls.push({ name: c.name, command, target: c.input?.file_path ?? c.input?.path ?? c.input?.pattern ?? "", result: results.get(c.id) ?? null })
    }
  }
  const firstEdit = calls.findIndex((c) => EDIT_TOOLS.has(c.name) || (c.command !== "" && SHELL_WRITE.test(c.command)))
  const before = firstEdit < 0 ? calls : calls.slice(0, firstEdit)
  const recalls = calls.map((c, i) => ({ ...c, i })).filter((c) => RECALL.test(c.command))
  const stopped = lines.some((o) => JSON.stringify(o).includes("note test: stopped at the first edit"))
  // What the session cost by its tokens, at Sonnet 5.5's prices: for a session cut short, which reports no cost.
  const seen = new Set()
  let usd = 0
  for (const o of lines) {
    const u = o.type === "assistant" ? o.message?.usage : undefined
    if (!u || seen.has(o.message.id)) continue
    seen.add(o.message.id)
    const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const fiveMin = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - hour)
    usd += ((u.input_tokens ?? 0) * 2 + fiveMin * 2.5 + hour * 4 + (u.cache_read_input_tokens ?? 0) * 0.2 + (u.output_tokens ?? 0) * 10) / 1e6
  }
  return {
    cost_from_tokens_usd: Math.round(usd * 1e4) / 1e4,
    tool_calls: calls.length,
    first_edit: firstEdit < 0 ? null : { index: firstEdit, tool: calls[firstEdit].name, target: calls[firstEdit].target || calls[firstEdit].command.slice(0, 120) },
    stopped_by_hook: stopped,
    calls_before_first_edit: before.length,
    recall_before_first_edit: recalls.filter((c) => firstEdit < 0 || c.i < firstEdit).length,
    recalls: recalls.map((c) => ({ index: c.i, command: c.command.slice(0, 300), found: c.result === null ? null : !/memory has nothing/.test(c.result), result_head: (c.result ?? "").slice(0, 400) })),
    history_before_first_edit: before.filter((c) => HISTORY.test(c.command)).map((c) => c.command.slice(0, 160)),
    reads_before_first_edit: before.filter((c) => c.name === "Read").length,
    searches_before_first_edit: before.filter((c) => c.name === "Grep" || c.name === "Glob").length
  }
}

const summarize = () => {
  const file = path.join(out, "results.jsonl")
  if (!fs.existsSync(file)) return
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l))
  for (const note of ["A", "B"]) {
    const mine = rows.filter((r) => r.note === note && r.score)
    const n = mine.length
    const count = (f) => mine.filter(f).length
    // A session cut short reports no cost: its tokens' then.
    const cost = mine.reduce((a, r) => a + (r.cost_usd || r.score.cost_from_tokens_usd || 0), 0)
    const median = (xs) => {
      const s = [...xs].sort((a, b) => a - b)
      return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    }
    log(`note ${note}: ${n} sessions; recall before the first edit ${count((r) => r.score.recall_before_first_edit > 0)}, recall at all ${count((r) => r.score.recalls.length > 0)}, recall found a change ${count((r) => r.score.recalls.some((c) => c.found))}; git history before the first edit ${count((r) => r.score.history_before_first_edit.length > 0)}; reached an edit ${count((r) => r.score.first_edit !== null)}; median tool calls before it ${median(mine.map((r) => r.score.calls_before_first_edit))}; cost $${cost.toFixed(2)}`)
  }
}

// --- modes ---

if (opts.clean) {
  for (const s of sessions) {
    const repo = repoOf(s)
    const modules = path.join(repo, "node_modules")
    // The junction itself first, never what it points to.
    if (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink()) fs.rmdirSync(modules)
    if (fs.existsSync(path.join(repo, "node_modules"))) throw new Error(`${modules} is still there: not removing ${repo}`)
    fs.rmSync(repo, { recursive: true, force: true })
  }
  log("clones removed")
  process.exit(0)
}

if (opts.score) {
  const file = path.join(out, "results.jsonl")
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l))
  const rescored = rows.map((r) => (r.transcript && fs.existsSync(r.transcript) ? { ...r, score: scoreTranscript(r.transcript) } : r))
  fs.writeFileSync(file, rescored.map((r) => JSON.stringify(r)).join("\n") + "\n")
  summarize()
  process.exit(0)
}

if (opts.probe) {
  // A scratch repo and a one-line task: the session should end at its Write, with a result and no file.
  const repo = path.join(out, "probe", "repo")
  fs.rmSync(path.join(out, "probe"), { recursive: true, force: true })
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, "README.md"), "# probe\n")
  git(repo, "init", "--quiet")
  git(repo, "add", "-A")
  git(repo, "-c", "user.name=probe", "-c", "user.email=probe@example.com", "commit", "--quiet", "-m", "probe")
  const home = path.join(out, "probe", "home")
  fs.mkdirSync(home, { recursive: true })
  const sessionId = randomUUID()
  const r = await run(opts.claude, [...claudeArgs(sessionId, "A").map((a) => (a === opts.budget ? "0.10" : a))], {
    cwd: repo, env: envFor(home), input: "Create a file hello.txt in this folder containing the word hi. Don't read anything first.", timeoutMs: 5 * 60000
  })
  const result = parseResult(r.stdout)
  const transcript = transcriptOf(repo, sessionId)
  log(`probe: exit ${r.code} in ${r.ms} ms; result ${JSON.stringify(result ? { subtype: result.subtype, is_error: result.is_error, stop_reason: result.stop_reason, result: String(result.result ?? "").slice(0, 200), num_turns: result.num_turns, total_cost_usd: result.total_cost_usd } : null)}; hello.txt written: ${fs.existsSync(path.join(repo, "hello.txt"))}; transcript ${fs.existsSync(transcript) ? "found" : "missing"}`)
  if (fs.existsSync(transcript)) log(`probe score: ${JSON.stringify(scoreTranscript(transcript))}`)
  if (r.stderr.trim()) log(`probe stderr: ${r.stderr.trim().slice(0, 500)}`)
  process.exit(0)
}

if (opts["dry-run"]) {
  log(`dry run: ${sessions.length} sessions, app ${app}, claude ${opts.claude}`)
  for (const s of sessions) {
    const { pre, records } = prepare(s)
    const started = Date.now()
    const r = await run(process.execPath, [cli, "recall", QUERIES[s.task]], { cwd: repoOf(s), env: envFor(homeOf(s)), timeoutMs: 60000 })
    const ms = Date.now() - started
    const head = r.stdout.split(/\r?\n/).filter((l) => /^#|^- |singularity:/.test(l)).slice(0, 4).join(" | ")
    log(`${s.name}: repo at ${pre.slice(0, 8)}, ${records} records; recall "${QUERIES[s.task]}" exit ${r.code} in ${ms} ms, ${r.stdout.length} chars: ${head || r.stdout.slice(0, 200).replace(/\s+/g, " ")}${r.stderr.trim() ? ` (stderr: ${r.stderr.trim().slice(0, 200)})` : ""}`)
    fs.writeFileSync(path.join(sessionDir(s), "dry-run-recall.txt"), r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""))
  }
  log(`would run: "${opts.claude}" ${claudeArgs("<session-id>", "A").join(" ")}`)
  process.exit(0)
}

// The run: every session prepared by the dry run, one at a time, in the plan's order.
let spent = 0
const resultsFile = path.join(out, "results.jsonl")
const done = new Set(fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).name) : [])
for (const row of fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []) spent += row.cost_usd ?? 0
log(`run: ${sessions.length - done.size} sessions to go, $${spent.toFixed(2)} spent before, cap $${opts.cap}`)
for (const s of sessions) {
  if (done.has(s.name)) continue
  if (spent >= Number(opts.cap)) {
    log(`cap reached ($${spent.toFixed(2)}): stopping before ${s.name}`)
    break
  }
  const repo = repoOf(s)
  if (!fs.existsSync(repo) || git(repo, "status", "--porcelain") !== "") throw new Error(`${s.name}: not prepared or not clean; run --dry-run after --clean`)
  const sessionId = randomUUID()
  const at = new Date().toISOString()
  log(`${s.name}: session ${sessionId}`)
  const r = await run(opts.claude, claudeArgs(sessionId, s.note), { cwd: repo, env: envFor(homeOf(s)), input: promptOf(s.task), timeoutMs: Number(opts["timeout-min"]) * 60000 })
  const dir = sessionDir(s)
  fs.writeFileSync(path.join(dir, "claude.stdout"), r.stdout)
  fs.writeFileSync(path.join(dir, "claude.stderr"), r.stderr)
  const result = parseResult(r.stdout)
  if (limitHit(result)) {
    log(`usage limit reached at ${s.name} (${String(result.result ?? result.api_error)}): stopping; run again later to finish`)
    process.exit(75)
  }
  const source = transcriptOf(repo, sessionId)
  const transcript = path.join(dir, "transcript.jsonl")
  if (fs.existsSync(source)) fs.copyFileSync(source, transcript)
  const score = fs.existsSync(transcript) ? scoreTranscript(transcript) : null
  const cost = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0
  spent += cost
  const row = {
    name: s.name, task: s.task, note: s.note, session_id: sessionId, at, ms: r.ms, exit_code: r.code, timed_out: r.timedOut,
    cost_usd: cost, num_turns: result?.num_turns ?? null, subtype: result?.subtype ?? null, stop_reason: result?.stop_reason ?? null,
    transcript: fs.existsSync(transcript) ? transcript : null, score
  }
  fs.appendFileSync(resultsFile, JSON.stringify(row) + "\n")
  log(`${s.name}: exit ${r.code}${r.timedOut ? " (timed out)" : ""}, ${(r.ms / 60000).toFixed(1)} min, $${cost.toFixed(3)}; recall before the first edit ${score?.recall_before_first_edit ?? "?"}, git history before it ${score?.history_before_first_edit.length ?? "?"}, first edit ${score?.first_edit ? `#${score.first_edit.index} ${score.first_edit.tool}` : "none"}; spent $${spent.toFixed(2)}`)
}
summarize()
log(`done; spent $${spent.toFixed(2)}`)
