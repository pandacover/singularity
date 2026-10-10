/**
 * The "new job" benchmark's harness (DESIGN-one-layer.md, part 2).
 *
 * The benchmark is sealed: it is reached only through its runner's commands
 * (`manifest`, `start --ui`, `reset`, `prompt`, `check`, `guide`, `reveal`),
 * through the launcher in its public folder. This harness never prints a
 * chore's text or its feedback; they go into the run's files.
 *
 * Each run: reset the apps to the chore's start, give the agent the chore
 * with the app's address (Claude Code with Playwright's browser tools only:
 * no shell, no files), check the result. Conditions:
 *
 * - `none`: no memory.
 * - `memory`: the memory layer through its hooks; after each run the layer's
 *   `end` records it with the check's outcome and feedback, and its `learn`
 *   runs when it is time, except in the test phase, where memory is frozen.
 * - `guide`: the company's onboarding guide at the first prompt (static hook).
 * - `awm`: Agent Workflow Memory's workflows for the app at the first prompt.
 * - `memory-frozen`: the layer's memory from a home copied from another
 *   condition, without learning (the stand-in for another agent: another model).
 *
 * Runs are one at a time: every chore resets the same app servers.
 */
import { Effect, FileSystem, Path } from "effect"
import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { hooksSettings } from "../handover/Install.ts"
import * as Api from "../layer/Api.ts"
import { addUsage, emptyUsage, findTranscript, metricsToJson, parseSession, traceMetrics, usageFromModelUsage, usageToJson, type Usage } from "../traces/index.ts"
import { buildCommand, runAgent } from "../eval/Agent.ts"
import { claudeCli } from "../eval/Llm.ts"
import type { AgentConfig } from "../eval/Suite.ts"
import { isoNow } from "../eval/Time.ts"
import { WORKFLOWS_HOOK_SCRIPT } from "../eval/WorkflowsMemory.ts"
import { browserTool } from "./Extract.ts"
import { originOf, webSubjectId } from "./Places.ts"

export const STATIC_HOOK_SCRIPT = fileURLToPath(new URL("./StaticHook.ts", import.meta.url))
export const PLAYWRIGHT_MCP = "C:/singularity-workspaces/tools/playwright-mcp/node_modules/@playwright/mcp/cli.js"

export type Condition = "none" | "memory" | "guide" | "awm" | "memory-frozen"

export interface BenchOptions {
  readonly runner: string
  readonly out: string
  readonly condition: Condition
  readonly phases: ReadonlyArray<string>
  readonly chores?: ReadonlyArray<string> | undefined
  readonly claude: string
  readonly model: string
  readonly effort: string
  /** The memory home (memory, memory-frozen). */
  readonly home?: string | undefined
  /** The static hand-over file (guide, awm). */
  readonly handover?: string | undefined
  readonly learner: { readonly model: string; readonly effort: string; readonly cwd: string }
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  readonly timeoutS: number
  /** Label for the results (default: the condition). */
  readonly setup?: string | undefined
}

export interface Manifest {
  readonly apps: ReadonlyArray<{ readonly id: string; readonly url: string }>
  readonly phases: ReadonlyArray<{ readonly id: string; readonly chores: ReadonlyArray<string> }>
  readonly ui_for_phase: Readonly<Record<string, string>>
  readonly hash: string
}

/** One runner command; its JSON answer. `start`/`stop` start servers in the background, so they run without pipes. */
export const runner = (launcher: string, args: ReadonlyArray<string>, timeoutS = 120): Record<string, unknown> => {
  const background = args[0] === "start" || args[0] === "stop"
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${launcher}" ${args.join(" ")}`], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: timeoutS * 1000,
    stdio: background ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: true
  })
  if (background) return { ok: r.status === 0 }
  const out = (r.stdout ?? "").trim()
  const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"))
  if (line === undefined) throw new Error(`runner ${args[0]} printed no JSON (exit ${r.status})`)
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
        // not up yet
      }
      if (Date.now() > until) throw new Error(`app ${a.id} didn't answer at ${a.url}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

export const startApps = async (launcher: string, manifest: Manifest, ui: string) => {
  runner(launcher, ["start", "--ui", ui])
  await waitForApps(manifest.apps)
}

const sumModelUsage = (modelUsage: Record<string, unknown>): Usage =>
  Object.values(modelUsage).reduce<Usage>((acc, v) => addUsage(acc, usageFromModelUsage(v)), emptyUsage)

/** The agent's request: the manager's words, then where the app is. The address is also how memory knows the app. */
export const agentPrompt = (prompt: string, url: string): string => `${prompt.trim()}\n\nThe app is at ${url}. Do this in the browser.`

const browserSpec = (event: string) => ({ event, arg: "post-tool-use", matcher: "mcp__playwright__.*", timeout: 15 })

export const runBench = Effect.fn("runBench")(function*(o: BenchOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const out = path.resolve(o.out)
  yield* fs.makeDirectory(path.join(out, "runs"), { recursive: true })
  const manifest = runner(o.runner, ["manifest"]) as unknown as Manifest
  const setup = o.setup ?? o.condition
  yield* fs.writeFileString(path.join(out, "meta.json"), JSON.stringify({ setup, condition: o.condition, model: o.model, effort: o.effort, phases: o.phases, hash: manifest.hash, claude: o.claude, started_at: isoNow() }, null, 2) + "\n")
  const done = new Set<string>()
  const results = path.join(out, "results.jsonl")
  if (yield* fs.exists(results)) {
    for (const l of (yield* fs.readFileString(results)).split(/\r?\n/)) {
      try {
        const r = JSON.parse(l) as { task_id?: string; phase?: string }
        if (r.task_id !== undefined) done.add(`${r.phase}/${r.task_id}`)
      } catch {
        // a partial line
      }
    }
  }
  const memoryHome = o.home === undefined ? undefined : path.resolve(o.home)
  if (memoryHome !== undefined) {
    yield* fs.makeDirectory(memoryHome, { recursive: true })
    if (!(yield* fs.exists(path.join(memoryHome, "config.json")))) yield* fs.writeFileString(path.join(memoryHome, "config.json"), JSON.stringify({ tenant: "local" }, null, 2) + "\n")
  }
  const settingsFile = path.join(out, "hooks.json")
  if (o.condition === "memory" || o.condition === "memory-frozen") {
    const hooks = hooksSettings(process.execPath, WORKFLOWS_HOOK_SCRIPT, [browserSpec("PostToolUse"), browserSpec("PostToolUseFailure")], true)
    yield* fs.writeFileString(settingsFile, JSON.stringify(hooks, null, 2) + "\n")
  } else if (o.condition === "guide" || o.condition === "awm") {
    const command = `"${process.execPath.replace(/\\/g, "/")}" "${STATIC_HOOK_SCRIPT.replace(/\\/g, "/")}"`
    yield* fs.writeFileString(settingsFile, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 30 }] }] } }, null, 2) + "\n")
  }

  for (const phaseId of o.phases) {
    const phase = manifest.phases.find((p) => p.id === phaseId)
    if (phase === undefined) continue
    const ui = manifest.ui_for_phase[phaseId] ?? "v1"
    const chores = phase.chores.filter((c) => o.chores === undefined || o.chores.includes(c)).filter((c) => !done.has(`${phaseId}/${c}`))
    if (chores.length === 0) continue
    yield* Effect.promise(() => startApps(o.runner, manifest, ui))
    for (const chore of chores) {
      const runId = `${chore}-${randomBytes(3).toString("hex")}`
      const runDir = path.join(out, "runs", runId)
      const work = path.join(runDir, "work")
      yield* fs.makeDirectory(work, { recursive: true })
      const reset = runner(o.runner, ["reset", chore])
      const ask = runner(o.runner, ["prompt", chore])
      const url = String(ask.url ?? reset.url ?? "")
      const prompt = agentPrompt(String(ask.prompt ?? ""), url)
      yield* fs.writeFileString(path.join(runDir, "prompt.txt"), prompt)
      const mcp = path.join(runDir, "mcp.json")
      yield* fs.writeFileString(mcp, JSON.stringify({ mcpServers: { playwright: { command: process.execPath, args: [PLAYWRIGHT_MCP, "--browser", "chrome", "--headless", "--isolated", "--output-dir", path.join(runDir, "pw")] } } }))
      const cfg: AgentConfig = {
        model: o.model,
        effort: o.effort,
        permissionMode: "acceptEdits",
        allowedTools: ["mcp__playwright"],
        disallowedTools: [],
        maxTurns: o.maxTurns,
        maxBudgetUsd: o.maxBudgetUsd,
        timeoutS: o.timeoutS,
        extraArgs: ["--tools", "", "--mcp-config", mcp]
      }
      const sessionId = randomUUID()
      const extra = o.condition === "none" ? [] : ["--settings", settingsFile]
      const command = [...buildCommand([o.claude], cfg, sessionId), ...extra]
      const env: Record<string, string> =
        o.condition === "memory" || o.condition === "memory-frozen"
          ? { SINGULARITY_HOOKS: "off", SINGULARITY_AUTOLEARN: "off", SINGULARITY_HOME: memoryHome!, SINGULARITY_SELECTOR: "cues", SINGULARITY_HANDOVER_PARTS: "1" }
          : o.condition === "guide" || o.condition === "awm"
          ? { SINGULARITY_STATIC_HANDOVER: path.resolve(o.handover!) }
          : {}
      const startedAt = isoNow()
      const agent = yield* runAgent(command, sessionId, prompt, work, o.timeoutS, env)
      yield* fs.writeFileString(path.join(runDir, "agent.stdout.json"), agent.proc.stdout)
      yield* fs.writeFileString(path.join(runDir, "agent.stderr.txt"), agent.proc.stderr)
      const check = runner(o.runner, ["check", chore])
      yield* fs.writeFileString(path.join(runDir, "check.json"), JSON.stringify(check, null, 2))
      // The transcript, copied: Claude Code deletes old ones.
      const src = yield* findTranscript(sessionId)
      let transcript: string | undefined
      let metrics: Record<string, unknown> | null = null
      let browserCalls = 0
      if (src !== undefined) {
        transcript = path.join(runDir, path.basename(src))
        yield* fs.copyFile(src, transcript)
        const trace = yield* parseSession(transcript)
        metrics = metricsToJson(traceMetrics(trace)) as unknown as Record<string, unknown>
        browserCalls = trace.toolCalls.filter((c) => c.agentId === undefined && browserTool(c.name) !== undefined).length
      }
      const success = check.success === true
      let learned: Record<string, unknown> | null = null
      let recorded: Record<string, unknown> | null = null
      if (o.condition === "memory" && transcript !== undefined) {
        {
          recorded = (yield* Effect.promise(() =>
            Api.end({ home: memoryHome, sessionId, transcript: transcript!, cwd: work, outcome: { success, feedback: typeof check.feedback === "string" ? check.feedback : null }, taskId: chore, prompt })
          )) as unknown as Record<string, unknown>
          const origin = originOf(url)
          if (phaseId !== "test" && origin !== undefined) {
            learned = yield* Effect.promise(() =>
              Api.learn({ home: memoryHome, subject: webSubjectId(origin), config: { cli: claudeCli([o.claude]), cwd: o.learner.cwd, model: o.learner.model, effort: o.learner.effort } })
            ).pipe(Effect.catchCause((cause) => Effect.succeed({ kind: "error", reason: String(cause).slice(0, 400) } as Record<string, unknown>)))
          }
        }
      }
      const result = agent.result ?? {}
      const usage = typeof result.modelUsage === "object" && result.modelUsage !== null ? sumModelUsage(result.modelUsage as Record<string, unknown>) : undefined
      const record = {
        run_id: runId,
        suite: "new-job",
        setup,
        condition: o.condition,
        phase: phaseId,
        task_id: chore,
        model: o.model,
        started_at: startedAt,
        session_id: sessionId,
        status: agent.proc.timedOut ? "timeout" : agent.result === undefined ? "agent_crashed" : String(result.subtype ?? "unknown"),
        success,
        feedback: check.feedback ?? null,
        traps_hit: check.traps_hit ?? [],
        moves: check.moves ?? null,
        fewest_moves: check.fewest_moves ?? null,
        cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
        tokens: usage === undefined ? null : usageToJson(usage),
        num_turns: typeof result.num_turns === "number" ? result.num_turns : null,
        browser_calls: browserCalls,
        wall_time_s: Math.round(agent.proc.durationS * 1000) / 1000,
        trace: metrics,
        recorded,
        learned
      }
      yield* fs.writeFileString(results, JSON.stringify(record) + "\n", { flag: "a" })
      // Ids and numbers only: the chore's text and feedback stay in the files.
      yield* Effect.sync(() =>
        console.log(`${isoNow()} ${setup} ${phaseId} ${chore}: ${success ? "pass" : "FAIL"}, ${record.num_turns ?? "?"} turns, $${record.cost_usd?.toFixed(3) ?? "?"}${learned !== null ? `, learn: ${String(learned.kind)}` : ""}`)
      )
    }
  }
})
