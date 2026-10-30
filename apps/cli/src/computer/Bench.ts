/**
 * The computer-use benchmark's harness (computer-use-memory.md, plan step 4).
 *
 * The benchmark is sealed: built by another agent and reached only through
 * its runner (`manifest`, `start --ui`, `stop`, `reset`, `prompt`, `check`,
 * `guide`, `reveal`). This harness never prints a chore's text or its
 * feedback; they go into the run's files.
 *
 * Each run: reset the apps to the chore's start, give the agent the chore and
 * the app's address (Claude Code with Playwright MCP 0.0.83's browser tools
 * only, headless Chrome with an in-memory profile; no shell, no files; the
 * user's settings, hooks and auto memory left out), check the result. Arms:
 *
 * - `none`: no memory.
 * - `memory`: computer-use memory through its own hook (hook.ts), in a memory
 *   home of the run's own; after each run the session is stored, as the
 *   hook's background store does in daily use. Memory learns in every phase.
 * - `guide`: the benchmark's one-page onboarding guide at the first prompt,
 *   through a hook, the channel the card uses (StaticHook.ts).
 *
 * Chores run one at a time per runner instance (each resets the same app
 * servers); instances on other port bases (`CU_BENCH_PORT_BASE`) run side by side.
 */
import { Effect, FileSystem, Path } from "effect"
import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { buildCommand, runAgent } from "../eval/Agent.ts"
import type { AgentConfig } from "../eval/Suite.ts"
import { isoNow } from "../eval/Time.ts"
import { addUsage, emptyUsage, findTranscript, metricsToJson, parseSession, traceMetrics, usageFromModelUsage, usageToJson, type Usage } from "../traces/index.ts"
import { captureSession, sessionFromLog } from "./Capture.ts"
import { familyOf } from "./Calls.ts"

export const COMPUTER_HOOK_SCRIPT = fileURLToPath(new URL("./hook.ts", import.meta.url))
export const STATIC_HOOK_SCRIPT = fileURLToPath(new URL("./StaticHook.ts", import.meta.url))
export const PLAYWRIGHT_CLI = "C:/singularity-workspaces/tools/playwright-mcp/node_modules/@playwright/mcp/cli.js"

export type Arm = "none" | "memory" | "guide"

export interface BenchOptions {
  readonly runner: string
  readonly portBase: number
  readonly out: string
  readonly arm: Arm
  readonly claude: string
  readonly model: string
  readonly effort: string
  /** The memory arm's home. */
  readonly home?: string | undefined
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  readonly timeoutS: number
  /** Label for the results (default: the arm). */
  readonly setup?: string | undefined
  /** Only these chores (a smoke run). */
  readonly chores?: ReadonlyArray<string> | undefined
}

export interface Manifest {
  readonly apps: ReadonlyArray<{ readonly id?: string; readonly url: string }>
  readonly phases: ReadonlyArray<{ readonly id: string; readonly chores: ReadonlyArray<string> }>
  readonly ui_for_phase: Readonly<Record<string, string>>
  readonly hash?: string
}

/** One runner command on a port base; its JSON answer. `start`/`stop` start servers in the background, so they run without pipes. */
export const runner = (launcher: string, portBase: number, args: ReadonlyArray<string>, timeoutS = 120): Record<string, unknown> => {
  const background = args[0] === "start" || args[0] === "stop"
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${launcher}" ${args.join(" ")}`], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: timeoutS * 1000,
    stdio: background ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: true,
    env: { ...process.env, CU_BENCH_PORT_BASE: String(portBase) }
  })
  if (background) return { ok: r.status === 0 }
  const out = (r.stdout ?? "").trim()
  const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"))
  if (line === undefined) throw new Error(`runner ${args[0]} printed no JSON (exit ${r.status}): ${(r.stderr ?? "").slice(0, 300)}`)
  return JSON.parse(line) as Record<string, unknown>
}

const waitForApps = async (apps: Manifest["apps"], seconds = 60) => {
  const until = Date.now() + seconds * 1000
  for (const a of apps) {
    for (;;) {
      try {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(3000) })
        if (res.status > 0) break
      } catch {
        // Not up yet.
      }
      if (Date.now() > until) throw new Error(`app ${a.id ?? a.url} didn't answer at ${a.url}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

const sumModelUsage = (modelUsage: Record<string, unknown>): Usage =>
  Object.values(modelUsage).reduce<Usage>((acc, v) => addUsage(acc, usageFromModelUsage(v)), emptyUsage)

/** The agent's request: the worker's words, then where the app is, as new-job asked. */
export const agentPrompt = (prompt: string, url: string): string => `${prompt.trim()}\n\nThe app is at ${url}. Do this in the browser.`

const command = (script: string, arg?: string) => `"${process.execPath.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}"${arg === undefined ? "" : ` ${arg}`}`

/** The run's own hooks: memory's for the browser tools and the prompt (storing is the harness's), or the guide's. */
export const benchHooks = (arm: Arm): Record<string, unknown> | undefined => {
  if (arm === "memory") {
    const tool = (arg: string) => [{ matcher: "mcp__playwright__.*", hooks: [{ type: "command", command: command(COMPUTER_HOOK_SCRIPT, arg), timeout: 15 }] }]
    return {
      hooks: {
        PostToolUse: tool("post-tool-use"),
        PostToolUseFailure: tool("post-tool-use"),
        UserPromptSubmit: [{ hooks: [{ type: "command", command: command(COMPUTER_HOOK_SCRIPT, "user-prompt-submit"), timeout: 30 }] }]
      }
    }
  }
  if (arm === "guide") return { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: command(STATIC_HOOK_SCRIPT), timeout: 30 }] }] } }
  return undefined
}

/** The texts memory or the guide handed over in a session, as its log holds them: hook context starting "singularity:", once each. */
export const handedTexts = (log: string): Array<string> => {
  const out = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.startsWith("singularity:")) out.add(v)
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk)
  }
  for (const line of log.split(/\r?\n/)) {
    try {
      walk(JSON.parse(line))
    } catch {
      // A partial line.
    }
  }
  return [...out]
}

export const runBench = Effect.fn("computer.runBench")(function*(o: BenchOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const out = path.resolve(o.out)
  yield* fs.makeDirectory(path.join(out, "runs"), { recursive: true })
  const manifest = runner(o.runner, o.portBase, ["manifest"]) as unknown as Manifest
  const setup = o.setup ?? o.arm
  yield* fs.writeFileString(path.join(out, "meta.json"), JSON.stringify({ setup, arm: o.arm, model: o.model, effort: o.effort, hash: manifest.hash ?? null, claude: o.claude, port_base: o.portBase, started_at: isoNow() }, null, 2) + "\n")

  // Resuming: chores done already are skipped.
  const results = path.join(out, "results.jsonl")
  const done = new Set<string>()
  if (yield* fs.exists(results)) {
    for (const l of (yield* fs.readFileString(results)).split(/\r?\n/)) {
      try {
        const r = JSON.parse(l) as { task_id?: string; phase?: string }
        if (r.task_id !== undefined) done.add(`${r.phase}/${r.task_id}`)
      } catch {
        // A partial line.
      }
    }
  }

  const home = o.home === undefined ? undefined : path.resolve(o.home)
  if (o.arm === "memory") {
    if (home === undefined) return yield* Effect.die(new Error("the memory arm needs --home"))
    yield* fs.makeDirectory(home, { recursive: true })
    if (!(yield* fs.exists(path.join(home, "config.json")))) yield* fs.writeFileString(path.join(home, "config.json"), JSON.stringify({ tenant: "local" }, null, 2) + "\n")
  }
  const hooks = benchHooks(o.arm)
  const settingsFile = path.join(out, "hooks.json")
  if (hooks !== undefined) yield* fs.writeFileString(settingsFile, JSON.stringify(hooks, null, 2) + "\n")
  const guideFile = path.join(out, "guide.txt")
  if (o.arm === "guide") yield* fs.writeFileString(guideFile, String(runner(o.runner, o.portBase, ["guide"]).guide ?? ""))
  const tenantDir = home === undefined ? undefined : path.join(home, "tenants", "local")

  for (const phase of manifest.phases) {
    const ui = manifest.ui_for_phase[phase.id] ?? "v1"
    const chores = phase.chores.filter((c) => !done.has(`${phase.id}/${c}`) && (o.chores === undefined || o.chores.length === 0 || o.chores.includes(c)))
    if (chores.length === 0) continue
    runner(o.runner, o.portBase, ["start", "--ui", ui])
    const apps = (runner(o.runner, o.portBase, ["manifest"]) as unknown as Manifest).apps
    yield* Effect.promise(() => waitForApps(apps))
    for (const chore of chores) {
      const runId = `${chore}-${randomBytes(3).toString("hex")}`
      const runDir = path.join(out, "runs", runId)
      const work = path.join(runDir, "work")
      yield* fs.makeDirectory(work, { recursive: true })
      const reset = runner(o.runner, o.portBase, ["reset", chore])
      const ask = runner(o.runner, o.portBase, ["prompt", chore])
      const url = String(ask.url ?? reset.url ?? "")
      const prompt = agentPrompt(String(ask.prompt ?? ""), url)
      yield* fs.writeFileString(path.join(runDir, "prompt.txt"), prompt)
      const mcp = path.join(runDir, "mcp.json")
      yield* fs.writeFileString(mcp, JSON.stringify({ mcpServers: { playwright: { command: process.execPath, args: [PLAYWRIGHT_CLI, "--browser", "chrome", "--headless", "--isolated", "--output-dir", path.join(runDir, "pw")] } } }))
      const cfg: AgentConfig = {
        model: o.model,
        effort: o.effort,
        permissionMode: "acceptEdits",
        allowedTools: ["mcp__playwright"],
        disallowedTools: [],
        maxTurns: o.maxTurns,
        maxBudgetUsd: o.maxBudgetUsd,
        timeoutS: o.timeoutS,
        // No shell or files; the user's own settings (their hooks, skills, CLAUDE.md) stay out.
        extraArgs: ["--tools", "", "--mcp-config", mcp, "--setting-sources", "project,local", ...(hooks === undefined ? [] : ["--settings", settingsFile])]
      }
      const sessionId = randomUUID()
      const env: Record<string, string> = o.arm === "memory"
        ? { SINGULARITY_HOOKS: "on", SINGULARITY_HOME: home! }
        : o.arm === "guide"
        ? { SINGULARITY_STATIC_HANDOVER: guideFile }
        : {}
      const startedAt = isoNow()
      const agent = yield* runAgent(buildCommand([o.claude], cfg, sessionId), sessionId, prompt, work, o.timeoutS, env)
      yield* fs.writeFileString(path.join(runDir, "agent.stdout.json"), agent.proc.stdout)
      yield* fs.writeFileString(path.join(runDir, "agent.stderr.txt"), agent.proc.stderr)
      const check = runner(o.runner, o.portBase, ["check", chore])
      yield* fs.writeFileString(path.join(runDir, "check.json"), JSON.stringify(check, null, 2))
      // The transcript, copied: Claude Code deletes old ones.
      const src = yield* findTranscript(sessionId)
      let metrics: Record<string, unknown> | null = null
      let browserCalls = 0
      let handed = 0
      if (src !== undefined) {
        const transcript = path.join(runDir, path.basename(src))
        yield* fs.copyFile(src, transcript)
        const trace = yield* parseSession(transcript)
        metrics = metricsToJson(traceMetrics(trace)) as unknown as Record<string, unknown>
        browserCalls = trace.toolCalls.filter((c) => c.agentId === undefined && familyOf(c.name) !== undefined).length
        if (o.arm === "memory" && tenantDir !== undefined) {
          // As the hook's background store does at a session's end, in order.
          yield* captureSession(yield* sessionFromLog(sessionId, src), tenantDir)
        }
        handed = handedTexts(yield* fs.readFileString(transcript)).length
      }
      const result = agent.result ?? {}
      const usage = typeof result.modelUsage === "object" && result.modelUsage !== null ? sumModelUsage(result.modelUsage as Record<string, unknown>) : undefined
      const success = check.success === true
      const record = {
        run_id: runId,
        suite: "cu-bench",
        setup,
        arm: o.arm,
        phase: phase.id,
        task_id: chore,
        model: o.model,
        started_at: startedAt,
        session_id: sessionId,
        status: agent.proc.timedOut ? "timeout" : agent.result === undefined ? "agent_crashed" : String(result.subtype ?? "unknown"),
        success,
        traps_hit: check.traps_hit ?? [],
        moves: check.moves ?? null,
        fewest_moves: check.fewest_moves ?? null,
        cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
        tokens: usage === undefined ? null : usageToJson(usage),
        num_turns: typeof result.num_turns === "number" ? result.num_turns : null,
        browser_calls: browserCalls,
        handed,
        wall_time_s: Math.round(agent.proc.durationS * 1000) / 1000,
        trace: metrics
      }
      yield* fs.writeFileString(results, JSON.stringify(record) + "\n", { flag: "a" })
      // Ids and numbers only: the chore's text and feedback stay in the files.
      yield* Effect.sync(() =>
        console.log(`${isoNow()} ${setup} ${phase.id} ${chore}: ${success ? "pass" : "FAIL"}, ${record.num_turns ?? "?"} turns, $${record.cost_usd?.toFixed(3) ?? "?"}${o.arm === "memory" ? `, handed ${handed}` : ""}`)
      )
    }
  }
  runner(o.runner, o.portBase, ["stop"])
})
