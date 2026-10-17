// The markdownlint tasks as a day of work, in one arm: four conversations
// (tasks 1-2, 3-5, 6-8 and 9-12 of tasks-day.json, so each opens on a task of
// another kind than the one before), the way a person works with an agent in
// a long thread, then each committed result checked in a throwaway clone of
// it (the checks of driver.mjs, with the type declarations compared whether
// or not they type-check).
//
//   node day-driver.mjs --arm with|without --repo <clone> --out <dir>
//     [--home <memory home>] [--app <dir>] [--claude <exe>] [--noise 8] [--fake <dir>]
//
// A conversation is one Claude Code session, each prompt a `claude -p` turn
// that resumes it:
// - it opens by pointing the agent at the repo to look around, changing nothing;
// - each task is asked for in its own prompt, without the list of what every
//   change of its kind needs or the instruction to commit; a `plan_first`
//   task asks for a plan, approved in the next prompt ("sounds good, go ahead");
// - then "looks good, commit it", and the next task's request follows in the
//   same session.
// Between tasks the driver commits `--noise` unrelated changes (CI and
// dependabot settings, files no task touches), as a repo's other work does,
// so a task's look-alike lies deeper than the last few commits.
//
// The arms differ only in singularity, as in driver.mjs (--app runs a copy of
// memory's code through the hooks setup installs). Claude Code fires
// SessionEnd after every `-p` turn, where a session in T3 Code or an editor
// goes on between prompts: the arms' hooks leave SessionEnd out, so a file
// watch lasts the conversation as it does there.
//
// --fake <dir> applies <dir>/<task-id>.patch at the request and commits it at
// "commit it" instead of running Claude Code, to try the driver for free.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const here = path.dirname(fileURLToPath(import.meta.url))
const { values: opts } = parseArgs({
  options: {
    arm: { type: "string" },
    repo: { type: "string" },
    out: { type: "string" },
    home: { type: "string" },
    app: { type: "string" },
    claude: { type: "string", default: "C:/singularity-workspaces/_claude/2.1.296/claude.exe" },
    // Conversations whose first tasks are of different kinds (a new rule, a rule's option, a rename, an option).
    threads: { type: "string", default: "1-2,3-5,6-8,9-12" },
    noise: { type: "string", default: "8" },
    fake: { type: "string" },
    // A session's cost limit, over all of its turns (a resumed session's cost is its running total).
    budget: { type: "string", default: "12.0" },
    "setting-sources": { type: "string", default: "project,local" },
    "timeout-min": { type: "string", default: "45" }
  }
})
if (!["with", "without"].includes(opts.arm) || !opts.repo || !opts.out) {
  console.error("usage: node day-driver.mjs --arm with|without --repo <clone> --out <dir> [--home <memory home>] [--app <dir>]")
  process.exit(2)
}
if (opts.arm === "with" && (!opts.home || !opts.app || !fs.existsSync(path.join(opts.app, "apps", "cli", "src", "workflows", "hook.ts")))) {
  console.error("--arm with needs --home <memory home> and --app <a folder holding apps/cli/src/workflows/hook.ts>")
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
const { tasks } = JSON.parse(fs.readFileSync(path.join(here, "tasks-day.json"), "utf8"))
fs.mkdirSync(out, { recursive: true })

const ORIENT = "Morning! We'll make a few changes to our markdownlint fork today. Have a look around first (README.md, CONTRIBUTING.md, lib/ and test/) so you know your way around; don't change anything yet."
const PLAN = "\n\nBefore you change anything, tell me in a few lines how you'd go about it."
const APPROVE = "sounds good, go ahead"
const COMMIT = "looks good, commit it"

// The hooks setup writes for Claude Code (src/setup/Agents.ts), run on <app>'s code by run-hook.mjs; no SessionEnd (above).
const settingsFile = path.join(out, "hooks-settings.json")
if (app) {
  const slashed = (p) => p.replace(/\\/g, "/")
  const hook = (args, timeout) => ({ type: "command", command: `"${slashed(process.execPath)}" "${slashed(path.join(here, "run-hook.mjs"))}" "${slashed(app)}" ${args}`, timeout })
  const TOOLS = "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit"
  const hooks = {
    UserPromptSubmit: [{ hooks: [hook("user-prompt-submit", 90)] }],
    PostToolUse: [{ matcher: TOOLS, hooks: [hook("post-tool-use", 15)] }],
    PostToolUseFailure: [{ matcher: TOOLS, hooks: [hook("post-tool-use", 15)] }]
  }
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2) + "\n")
}

const log = (msg) => {
  const line = `${new Date().toISOString()} [${opts.arm}${app ? ` ${path.basename(app)}` : ""}] ${msg}`
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

// What setup gives an agent besides hooks: the recall note (in the system
// prompt, the user's settings being left out) and the `singularity` command on
// PATH, running <app>'s code with the arm's memory.
const launcherDir = path.join(out, "bin")
let noteFile
if (app) {
  fs.mkdirSync(launcherDir, { recursive: true })
  const cli = path.join(app, "apps", "cli", "src", "singularity.ts")
  fs.writeFileSync(path.join(launcherDir, "singularity"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(launcherDir, "singularity.cmd"), `@"${process.execPath}" "${cli}" %*\r\n`)
  const instructions = path.join(app, "apps", "cli", "src", "setup", "Instructions.ts")
  if (fs.existsSync(instructions)) {
    const { RECALL_NOTE } = await import(pathToFileURL(instructions).href)
    noteFile = path.join(out, "recall-note.md")
    fs.writeFileSync(noteFile, RECALL_NOTE + "\n")
  }
}

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
    env.SINGULARITY_HOOKS = "off"
    env.PATH = `${launcherDir}${path.delimiter}${env.PATH ?? ""}`
  }
  return env
}

const run = (cmd, args, { cwd, env, input, timeoutMs, stdoutFile, stderrFile }) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: false, detached: process.platform !== "win32" })
    const outChunks = []
    const errChunks = []
    child.stdout.on("data", (d) => outChunks.push(d))
    child.stderr.on("data", (d) => errChunks.push(d))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
        else process.kill(-child.pid, "SIGKILL")
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

// npm on Windows is a .cmd shim: run it through cmd.exe; elsewhere through sh.
const npm = (args, cwd, timeoutMs, env = process.env) =>
  process.platform === "win32"
    ? run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args}`], { cwd, env, timeoutMs })
    : run("sh", ["-c", `npm ${args}`], { cwd, env, timeoutMs })

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

const transcriptOf = (sessionId) =>
  path.join(os.homedir(), ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`)

// --- singularity's background work (with arm), as driver.mjs waits for it ---

const backgroundBusy = () => {
  if (!home) return false
  for (const lock of [path.join(home, "learn.lock"), path.join(home, "store.lock")]) if (fs.existsSync(lock)) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(lock, "utf8"))
      process.kill(pid, 0)
      return "storing"
    } catch {}
  }
  try {
    const procs = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8" })
      : execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
    const lower = procs.toLowerCase()
    const mine = lower.split(/\r?\n/).filter((l) => /record commits/.test(l) && (l.includes(repo.toLowerCase().replace(/\//g, "\\")) || l.includes(repo.toLowerCase().replace(/\\/g, "/"))))
    if (mine.length > 0) return "storing"
  } catch {}
  return false
}

const waitForBackground = async () => {
  const started = Date.now()
  let idle = 0
  await new Promise((r) => setTimeout(r, 5000))
  while (idle < 2) {
    if (backgroundBusy()) idle = 0
    else idle++
    await new Promise((r) => setTimeout(r, 10000))
    if (Date.now() - started > 30 * 60 * 1000) {
      log("singularity still busy after 30 min; going on")
      break
    }
  }
  return Date.now() - started
}

// --- checks, on the committed state, in a throwaway clone ---

const DECLARATIONS = ["exports.d.mts", "exports-async.d.mts", "exports-promise.d.mts", "exports-sync.d.mts", "markdownlint.d.mts", "resolve-module.d.cts"]

const check = async (task, sha, dir) => {
  const tmp = path.join(path.dirname(out), "check", `${path.basename(out)}-${task.id}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--shared", "--no-checkout", repo, tmp])
  git(tmp, "config", "core.autocrlf", "false")
  git(tmp, "checkout", "--quiet", sha)
  const modules = path.join(tmp, "node_modules")
  fs.symlinkSync(path.join(repo, "node_modules"), modules, "junction")
  const results = {}
  const save = (name, r) => {
    fs.writeFileSync(path.join(dir, `check-${name}.log`), `exit ${r.code}${r.timedOut ? " (timed out)" : ""}, ${r.ms} ms\n\n${r.stdout}\n${r.stderr}`)
    results[name] = r.code === 0 && !r.timedOut
  }
  let types = false
  try {
    save("hidden", await run(process.execPath, ["--test", path.join(hidden, `${task.id}.test.mjs`)], { cwd: tmp, env: { ...process.env, REPO: tmp }, timeoutMs: 180000 }))
    save("test", await npm("test", tmp, 600000))
    save("lint", await npm("run lint", tmp, 600000))
    const regen = await npm("run build-config && npm run build-docs", tmp, 600000)
    // The declarations, whether or not lib/ type-checks (the prompts don't ask
    // for that): tsc writes them anyway, and they must match the committed ones.
    const tsc = spawnSync(process.execPath, [path.join(repo, "node_modules", "typescript", "bin", "tsc"), "--project", "./declaration/tsconfig.json"], { cwd: tmp, encoding: "utf8" })
    types = tsc.status === 0
    fs.writeFileSync(path.join(dir, "check-types.log"), `exit ${tsc.status}\n\n${tsc.stdout}\n${tsc.stderr}`)
    const stale = DECLARATIONS.filter((f) => {
      const built = path.join(tmp, "dts", "lib", f)
      const committed = path.join(tmp, "lib", f)
      return fs.existsSync(built) && (!fs.existsSync(committed) || !fs.readFileSync(built).equals(fs.readFileSync(committed)))
    })
    fs.rmSync(path.join(tmp, "dts"), { recursive: true, force: true })
    const status = git(tmp, "status", "--porcelain")
    save("regenerate", { ...regen, code: regen.code === 0 && status === "" && stale.length === 0 ? 0 : 1, stdout: `${regen.stdout}\n--- git status after regenerating ---\n${status}\n--- stale declarations ---\n${stale.join("\n")}` })
  } finally {
    // Remove the junction itself first, never what it points to.
    if (process.platform === "win32") fs.rmdirSync(modules)
    else fs.unlinkSync(modules)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return { counted: results, types }
}

// --- the repo's other work between tasks: unrelated, the same in every arm ---

const NOISE_FILES = [".github/workflows/ci.yml", ".github/workflows/checkers.yml", ".github/dependabot.yml", ".github/workflows/codeql-analysis.yml", ".github/codeql-config.yaml"]
const NOISE_TITLES = [
  "CI: run the checks on Node 24 too", "Dependabot: group the GitHub Actions updates", "CI: cache npm between jobs",
  "CodeQL: leave the test fixtures out", "Checkers: pin the link checker's version", "CI: cancel superseded runs",
  "Dependabot: check npm weekly, not daily", "CI: name the jobs after what they check", "CodeQL: run on pull requests only",
  "Checkers: retry flaky link checks once"
]
const noise = (index, count) => {
  for (let j = 0; j < count; j++) {
    const k = index * count + j
    const file = NOISE_FILES[k % NOISE_FILES.length]
    const title = NOISE_TITLES[k % NOISE_TITLES.length]
    fs.appendFileSync(path.join(repo, file), `# ${title} (${index}.${j})\n`)
    execFileSync("git", ["-C", repo, "add", file])
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", title])
  }
}

// --- a conversation ---

const turn = async (sessionId, first, label, prompt, dir) => {
  const at = new Date().toISOString()
  if (opts.fake) return { label, at, ms: 0, code: 0, result: undefined }
  const args = [
    "-p", "--output-format", "json", ...(first ? ["--session-id", sessionId] : ["--resume", sessionId]),
    "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--strict-mcp-config",
    "--model", "sonnet", "--effort", "medium", "--max-budget-usd", opts.budget,
    "--allowed-tools", "Bash,PowerShell,Read,Edit,Write,Glob,Grep",
    "--setting-sources", opts["setting-sources"]
  ]
  if (app) args.push("--settings", settingsFile)
  if (noteFile) args.push("--append-system-prompt-file", noteFile)
  const r = await run(opts.claude, args, {
    cwd: repo, env: agentEnv(), input: prompt, timeoutMs: Number(opts["timeout-min"]) * 60000,
    stdoutFile: path.join(dir, `${label}.stdout`), stderrFile: path.join(dir, `${label}.stderr`)
  })
  const result = parseResult(r.stdout)
  // The account's usage limit: the turn never reached the model, but its prompt is in the
  // conversation and the hooks saw it, so nothing after it would measure anything. Stop the
  // arm (exit 75); the launcher starts no further pass, and the pass is run again later.
  if (result && (result.api_error_status === 429 || result.api_error === "usage_limit_reached" || /hit your .*limit/i.test(String(result.result ?? "")))) {
    log(`usage limit reached at ${label} (${String(result.result ?? result.api_error)}): stopping; this pass is incomplete`)
    process.exit(75)
  }
  return { label, at, ms: r.ms, code: r.code, timedOut: r.timedOut, result }
}

const threads = opts.threads.split(",").map((s) => s.split("-").map(Number)).map(([a, b]) => tasks.slice(a - 1, b).map((t, i) => ({ ...t, index: a + i })))
log(`arm ${opts.arm}, repo ${repo}, ${threads.length} conversations${home ? `, memory home ${home}` : ""}${app ? `, memory code ${app}` : ""}${opts.fake ? ", FAKE agent" : ""}`)
let spent = 0
for (const [t, thread] of threads.entries()) {
  const sessionId = randomUUID()
  const tdir = path.join(out, `thread-${t + 1}`)
  fs.mkdirSync(tdir, { recursive: true })
  log(`conversation ${t + 1}: session ${sessionId}, tasks ${thread.map((x) => x.index).join(", ")}`)
  let cumulative = 0
  const costOf = (r) => {
    const total = r.result?.total_cost_usd
    if (typeof total !== "number") return null
    const own = total - cumulative
    cumulative = total
    return own
  }
  const orient = await turn(sessionId, true, "orient", ORIENT, tdir)
  const orientCost = costOf(orient)
  spent += orientCost ?? 0
  for (const task of thread) {
    const dir = path.join(out, task.id)
    fs.mkdirSync(dir, { recursive: true })
    const pre = git(repo, "rev-parse", "HEAD")
    const started = new Date()
    log(`task ${task.index} ${task.id}: start (HEAD ${pre.slice(0, 8)})`)
    const turns = []
    const ask = await turn(sessionId, false, "request", task.prompt + (task.plan_first ? PLAN : ""), dir)
    turns.push(ask)
    // The reference patches don't all apply one after the other: a fake task whose patch doesn't commits nothing.
    const fakely = (args) => {
      try {
        execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
      } catch {
        log(`task ${task.index}: fake step git ${args[0]} did nothing`)
      }
    }
    if (opts.fake) fakely(["apply", "--whitespace=nowarn", path.join(opts.fake, `${task.id}.patch`)])
    if (task.plan_first) turns.push(await turn(sessionId, false, "approve", APPROVE, dir))
    turns.push(await turn(sessionId, false, "commit", COMMIT, dir))
    if (opts.fake) {
      fakely(["add", "-A"])
      fakely(["commit", "-q", "-m", `fake ${task.id}`])
    }
    const ended = new Date()
    const shown = turns.map((x) => ({ label: x.label, at: x.at, ms: x.ms, exit_code: x.code, timed_out: x.timedOut ?? false, cost_usd: costOf(x), num_turns: x.result?.num_turns ?? null, cumulative_cost_usd: x.result?.total_cost_usd ?? null, usage: x.result?.usage ?? null }))
    const cost = shown.reduce((a, x) => a + (x.cost_usd ?? 0), 0)
    spent += cost
    const post = git(repo, "rev-parse", "HEAD")
    const commits = pre === post ? [] : git(repo, "log", "--format=%H %s", `${pre}..${post}`).split("\n")
    const dirty = git(repo, "status", "--porcelain")
    if (dirty !== "") {
      // Left uncommitted: kept for the record, then cleared so the next task starts clean.
      fs.writeFileSync(path.join(dir, "uncommitted.diff"), execFileSync("git", ["-C", repo, "diff", "HEAD"], { encoding: "utf8" }) + "\n--- status ---\n" + dirty)
      git(repo, "reset", "--quiet", "--hard", "HEAD")
      git(repo, "clean", "-fdq")
      log(`task ${task.index}: uncommitted changes left; saved and cleared`)
    }
    const waited = opts.arm === "with" && !opts.fake ? await waitForBackground() : 0
    const { counted: checks, types } = await check(task, post, dir)
    const record = {
      task: task.id, kind: task.kind, index: task.index, thread: t + 1, arm: opts.arm, app: app ? path.basename(app) : null,
      session_id: sessionId, plan_first: task.plan_first,
      started_at: started.toISOString(), ended_at: ended.toISOString(), wall_ms: ended - started,
      turns: shown, cost_usd: cost, orient_cost_usd: task === thread[0] ? orientCost : null, orient_at: task === thread[0] ? orient.at : null, orient_ms: task === thread[0] ? orient.ms : null,
      pre, post, commits, left_uncommitted: dirty !== "", background_wait_ms: waited,
      checks, types, passed: post !== pre && Object.values(checks).every(Boolean)
    }
    fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify(record, null, 2) + "\n")
    fs.appendFileSync(path.join(out, "records.jsonl"), JSON.stringify(record) + "\n")
    log(`task ${task.index} ${task.id}: ${record.passed ? "PASSED" : "FAILED"} ${JSON.stringify(checks)} types ${types ? "ok" : "errors"} cost $${cost.toFixed(3)} (${shown.map((x) => `${x.label} ${x.cost_usd?.toFixed(3) ?? "?"}`).join(", ")}) ${(record.wall_ms / 60000).toFixed(1)} min; spent $${spent.toFixed(2)}`)
    noise(task.index, Number(opts.noise))
  }
  const transcript = transcriptOf(sessionId)
  if (fs.existsSync(transcript)) fs.copyFileSync(transcript, path.join(tdir, "transcript.jsonl"))
}
if (home) {
  const handovers = path.join(home, "tenants", "local", "workflows", "handovers.jsonl")
  if (fs.existsSync(handovers)) fs.copyFileSync(handovers, path.join(out, "handovers.jsonl"))
}
log(`done; spent $${spent.toFixed(2)}`)
