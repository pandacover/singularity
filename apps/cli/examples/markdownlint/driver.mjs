// Runs the markdownlint long task (tasks.json) in one arm: each task in a
// fresh headless Claude Code session in the arm's own clone, in order, then
// checks the committed result in a throwaway clone of it.
//
//   node driver.mjs --arm with|without --repo <clone> --out <dir>
//     [--home <memory home>] [--app <dir>] [--claude <exe>] [--from 1] [--to 12] [--fake <dir>]
//
// The two arms differ only in singularity:
// - without: SINGULARITY_HOOKS=off (the installed hooks exit at once) and
//   SINGULARITY_HOME points at an empty folder, so the skill or command, if
//   an agent reached for them, would find nothing;
// - with: the installed hooks fire as in daily use, with SINGULARITY_HOME
//   pointing at a memory home of the experiment's own (config.json as setup
//   writes it, learning on its own on), and learning runs the same Claude
//   Code as the agents (SINGULARITY_CLAUDE). Between tasks the driver waits
//   until singularity's background storing and learning are done, the pause
//   a user leaves between tasks.
// Claude Code's own auto-memory is off in both, as in every eval here.
//
// --app <dir> runs the memory code in <dir> (a copy of this repo's apps/cli/src
// and package files, with node_modules) instead of the installed one: the
// installed hooks are silenced as in the without arm, and the sessions get
// the same hooks (events, matchers, timeouts) through --settings, run by
// run-hook.mjs on <dir>'s code.
//
// --fake <dir> applies <dir>/<task-id>.patch and records it instead of
// running Claude Code, to try the driver and the checks for free.
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const here = path.dirname(fileURLToPath(import.meta.url))
const { values: opts } = parseArgs({
  options: {
    arm: { type: "string" },
    repo: { type: "string" },
    out: { type: "string" },
    home: { type: "string" },
    app: { type: "string" },
    claude: { type: "string", default: "C:/singularity-workspaces/long/claude/claude-2.1.295.exe" },
    from: { type: "string", default: "1" },
    to: { type: "string", default: "99" },
    fake: { type: "string" },
    budget: { type: "string", default: "5.0" },
    "timeout-min": { type: "string", default: "60" }
  }
})
if (!["with", "without"].includes(opts.arm) || !opts.repo || !opts.out) {
  console.error("usage: node driver.mjs --arm with|without --repo <clone> --out <dir> [--home <memory home>]")
  process.exit(2)
}
if (opts.arm === "with" && !opts.home) {
  console.error("--arm with needs --home <memory home>")
  process.exit(2)
}
if (opts.app && (opts.arm !== "with" || !fs.existsSync(path.join(opts.app, "apps", "cli", "src", "workflows", "hook.ts")))) {
  console.error("--app needs --arm with and a folder holding apps/cli/src/workflows/hook.ts")
  process.exit(2)
}

// Everything this starts runs below normal priority, so the user can keep working.
try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
} catch {}

const repo = path.resolve(opts.repo)
const out = path.resolve(opts.out)
const home = opts.home ? path.resolve(opts.home) : undefined
const app = opts.app ? path.resolve(opts.app) : undefined
const hidden = path.join(here, "hidden")
const { tasks } = JSON.parse(fs.readFileSync(path.join(here, "tasks.json"), "utf8"))
fs.mkdirSync(out, { recursive: true })

// With --app: singularity's hooks as setup installed them in the user's
// settings, rewritten to run <app>'s code through run-hook.mjs.
const INSTALLED_HOOK = /^("[^"]+") "[^"]*[\\/]\.singularity[\\/]app[\\/]apps[\\/]cli[\\/]src[\\/]workflows[\\/]hook\.ts"( .*)?$/
const settingsFile = path.join(out, "hooks-settings.json")
if (app) {
  const userSettings = path.join(os.homedir(), ".claude", "settings.json")
  const installed = JSON.parse(fs.readFileSync(userSettings, "utf8")).hooks ?? {}
  const slashed = (p) => p.replace(/\\/g, "/")
  const hooks = {}
  for (const [event, groups] of Object.entries(installed)) {
    const mine = groups.flatMap((g) => {
      const rewritten = (g.hooks ?? []).flatMap((h) => {
        const m = INSTALLED_HOOK.exec(h.command ?? "")
        return m ? [{ ...h, command: `${m[1]} "${slashed(path.join(here, "run-hook.mjs"))}" "${slashed(app)}"${m[2] ?? ""}` }] : []
      })
      return rewritten.length === 0 ? [] : [{ ...g, hooks: rewritten }]
    })
    if (mine.length > 0) hooks[event] = mine
  }
  if (!["UserPromptSubmit", "PostToolUse", "SessionEnd"].every((e) => e in hooks)) {
    console.error(`--app: singularity's hooks weren't found in ${userSettings}`)
    process.exit(2)
  }
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2) + "\n")
}

const log = (msg) => {
  const line = `${new Date().toISOString()} [${opts.arm}] ${msg}`
  console.log(line)
  fs.appendFileSync(path.join(out, "driver.log"), line + "\n")
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

// The variables a parent Claude Code session sets for its children (src/eval/Agent.ts SESSION_VARS).
const SESSION_VARS = new Set([
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID"
])

const emptyHome = path.join(path.dirname(out), "empty-singularity-home")

const agentEnv = () => {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SESSION_VARS.has(k) && !k.startsWith("SINGULARITY_")) env[k] = v
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"
  env.DISABLE_AUTOUPDATER = "1"
  if (opts.arm === "without") {
    fs.mkdirSync(emptyHome, { recursive: true })
    env.SINGULARITY_HOOKS = "off"
    env.SINGULARITY_HOME = emptyHome
  } else {
    env.SINGULARITY_HOME = home
    env.SINGULARITY_CLAUDE = opts.claude
    // The installed hooks stay silent; the run's own clear this again (run-hook.mjs).
    if (app) env.SINGULARITY_HOOKS = "off"
  }
  return env
}

const run = (cmd, args, { cwd, env, input, timeoutMs, stdoutFile, stderrFile }) =>
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
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      } catch {}
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(outChunks).toString("utf8")
      const stderr = Buffer.concat(errChunks).toString("utf8")
      if (stdoutFile) fs.writeFileSync(stdoutFile, stdout)
      if (stderrFile) fs.writeFileSync(stderrFile, stderr)
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })

// npm on Windows is a .cmd shim: run it through cmd.exe.
const npm = (args, cwd, timeoutMs, env = process.env) =>
  run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args}`], { cwd, env, timeoutMs })

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

const transcriptOf = (sessionId) => {
  const slug = repo.replace(/[^A-Za-z0-9]/g, "-")
  return path.join(os.homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`)
}

// --- singularity's background work (with arm) ---

const backgroundBusy = () => {
  if (!home) return false
  const lock = path.join(home, "learn.lock")
  if (fs.existsSync(lock)) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(lock, "utf8"))
      process.kill(pid, 0)
      return "learning"
    } catch {}
  }
  const queue = path.join(home, "learn-queue")
  if (fs.existsSync(queue) && fs.readdirSync(queue).length > 0) return "learning queued"
  // A storing run for this clone: `cli.ts record commits --background ... --cwd <repo>`.
  try {
    const procs = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8" })
    const mine = procs.split(/\r?\n/).filter((l) => /record commits/.test(l) && l.toLowerCase().includes(repo.toLowerCase().replace(/\//g, "\\")))
    if (mine.length > 0) return "storing"
    const mine2 = procs.split(/\r?\n/).filter((l) => /record commits/.test(l) && l.toLowerCase().includes(repo.toLowerCase().replace(/\\/g, "/")))
    if (mine2.length > 0) return "storing"
  } catch {}
  return false
}

const waitForBackground = async () => {
  const started = Date.now()
  let idleChecks = 0
  let last = ""
  await new Promise((r) => setTimeout(r, 5000))
  while (idleChecks < 2) {
    const busy = backgroundBusy()
    if (busy) {
      idleChecks = 0
      if (busy !== last) log(`waiting for singularity: ${busy}`)
      last = busy
    } else {
      idleChecks++
    }
    await new Promise((r) => setTimeout(r, 10000))
    if (Date.now() - started > 60 * 60 * 1000) {
      log("singularity still busy after 60 min; going on")
      break
    }
  }
  return Date.now() - started
}

// --- checks, on the committed state, in a throwaway clone ---

const check = async (task, sha, dir) => {
  const tmp = path.join(path.dirname(out), "check", `${opts.arm}-${task.id}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--shared", "--no-checkout", repo, tmp])
  git(tmp, "config", "core.autocrlf", "false")
  git(tmp, "checkout", "--quiet", sha)
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(tmp, "node_modules"), "junction")
  const results = {}
  const save = (name, r) => {
    fs.writeFileSync(path.join(dir, `check-${name}.log`), `exit ${r.code}${r.timedOut ? " (timed out)" : ""}, ${r.ms} ms\n\n${r.stdout}\n${r.stderr}`)
    results[name] = r.code === 0 && !r.timedOut
  }
  const hiddenFile = path.join(hidden, `${task.id}.test.mjs`)
  save("hidden", await run(process.execPath, ["--test", hiddenFile], { cwd: tmp, env: { ...process.env, REPO: tmp }, timeoutMs: 180000 }))
  save("test", await npm("test", tmp, 600000))
  save("lint", await npm("run lint", tmp, 600000))
  const regen = await npm("run build-config && npm run build-docs", tmp, 600000)
  // The declaration build also type-checks lib/ with tsc, which the prompts
  // don't ask for: its result is reported (`types`), not counted. When it
  // succeeds, the declarations it writes must match the committed ones.
  const types = await npm("run build-declaration", tmp, 600000)
  fs.writeFileSync(path.join(dir, "check-types.log"), `exit ${types.code}${types.timedOut ? " (timed out)" : ""}, ${types.ms} ms\n\n${types.stdout}\n${types.stderr}`)
  fs.rmSync(path.join(tmp, "dts"), { recursive: true, force: true })
  const status = git(tmp, "status", "--porcelain")
  save("regenerate", { ...regen, code: regen.code === 0 && status === "" ? 0 : 1, stdout: `${regen.stdout}\n--- git status after regenerating ---\n${status}` })
  // Remove the junction itself first, never what it points to.
  fs.rmdirSync(path.join(tmp, "node_modules"))
  fs.rmSync(tmp, { recursive: true, force: true })
  return { counted: results, types: types.code === 0 && !types.timedOut }
}

// --- one task ---

const doTask = async (task, index) => {
  const dir = path.join(out, task.id)
  fs.mkdirSync(dir, { recursive: true })
  const pre = git(repo, "rev-parse", "HEAD")
  const sessionId = randomUUID()
  const started = new Date()
  log(`task ${index} ${task.id}: start (HEAD ${pre.slice(0, 8)}, session ${sessionId})`)
  let agent
  if (opts.fake) {
    const patch = path.join(opts.fake, `${task.id}.patch`)
    execFileSync("git", ["-C", repo, "apply", "--whitespace=nowarn", patch])
    execFileSync("git", ["-C", repo, "add", "-A"])
    execFileSync("git", ["-C", repo, "-c", "user.name=fake", "-c", "user.email=fake@example.com", "commit", "-q", "-m", `fake ${task.id}`])
    agent = { code: 0, stdout: "", stderr: "", timedOut: false, ms: 0 }
  } else {
    const args = [
      "-p", "--output-format", "json", "--session-id", sessionId,
      "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--strict-mcp-config",
      "--model", "sonnet", "--effort", "medium", "--max-budget-usd", opts.budget,
      "--allowed-tools", "Bash,PowerShell,Read,Edit,Write,Glob,Grep"
    ]
    if (app) args.push("--settings", settingsFile)
    agent = await run(opts.claude, args, {
      cwd: repo, env: agentEnv(), input: task.prompt, timeoutMs: Number(opts["timeout-min"]) * 60000,
      stdoutFile: path.join(dir, "agent.stdout"), stderrFile: path.join(dir, "agent.stderr")
    })
  }
  const ended = new Date()
  const result = parseResult(agent.stdout)
  const transcript = transcriptOf(sessionId)
  if (fs.existsSync(transcript)) fs.copyFileSync(transcript, path.join(dir, "transcript.jsonl"))
  const post = git(repo, "rev-parse", "HEAD")
  const commits = pre === post ? [] : git(repo, "log", "--format=%H %s", `${pre}..${post}`).split("\n")
  const dirty = git(repo, "status", "--porcelain")
  if (dirty !== "") {
    // Left uncommitted: kept for the record, then cleared so the next session starts clean.
    fs.writeFileSync(path.join(dir, "uncommitted.diff"), execFileSync("git", ["-C", repo, "diff", "HEAD"], { encoding: "utf8" }) + "\n--- status ---\n" + dirty)
    git(repo, "reset", "--quiet", "--hard", "HEAD")
    git(repo, "clean", "-fdq")
    log(`task ${index}: uncommitted changes left; saved and cleared`)
  }
  let waitedMs = 0
  if (opts.arm === "with" && !opts.fake) waitedMs = await waitForBackground()
  const { counted: checks, types } = await check(task, post, dir)
  const record = {
    task: task.id, kind: task.kind, index, arm: opts.arm, session_id: sessionId,
    started_at: started.toISOString(), ended_at: ended.toISOString(), wall_ms: ended - started,
    exit_code: agent.code, timed_out: agent.timedOut,
    result: result === undefined ? null : {
      subtype: result.subtype, is_error: result.is_error, num_turns: result.num_turns,
      duration_ms: result.duration_ms, duration_api_ms: result.duration_api_ms,
      total_cost_usd: result.total_cost_usd, usage: result.usage, model_usage: result.modelUsage
    },
    pre, post, commits, left_uncommitted: dirty !== "",
    background_wait_ms: waitedMs,
    checks, types, passed: post !== pre && Object.values(checks).every(Boolean)
  }
  fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify(record, null, 2) + "\n")
  fs.appendFileSync(path.join(out, "records.jsonl"), JSON.stringify(record) + "\n")
  log(`task ${index} ${task.id}: ${record.passed ? "PASSED" : "FAILED"} ${JSON.stringify(checks)} types ${types ? "ok" : "errors"} cost $${record.result?.total_cost_usd?.toFixed(3) ?? "?"} turns ${record.result?.num_turns ?? "?"} ${(record.wall_ms / 60000).toFixed(1)} min${waitedMs ? `, waited ${(waitedMs / 60000).toFixed(1)} min for singularity` : ""}`)
  return record
}

const from = Number(opts.from)
const to = Number(opts.to)
log(`arm ${opts.arm}, repo ${repo}, tasks ${from}-${Math.min(to, tasks.length)}${home ? `, memory home ${home}` : ""}${app ? `, memory code ${app}` : ""}${opts.fake ? ", FAKE agent" : ""}`)
for (const [i, task] of tasks.entries()) {
  const index = i + 1
  if (index < from || index > to) continue
  await doTask(task, index)
}
log("done")
