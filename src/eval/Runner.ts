/**
 * Run a suite under one memory setup and record one result per run.
 *
 * Each run: reset the workspace to the task's base commit, run setup commands,
 * let the memory setup prepare, run Claude Code on the prompt, save its
 * transcript and diff, then run the task's checks. Output layout:
 *
 *     <out>/meta.json
 *     <out>/results.jsonl          one record per run
 *     <out>/runs/<run id>/         transcript, diff, agent output, command logs
 */
import { Effect, FileSystem, Path } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { parse as parsePath } from "node:path"
import type { Trace, Usage } from "../traces/index.ts"
import {
  addUsage,
  emptyUsage,
  findTranscript,
  metricsToJson,
  parseSession,
  traceMetrics,
  traceModels,
  traceUsage,
  usageFromModelUsage,
  usageToJson
} from "../traces/index.ts"
import type { AgentRun } from "./Agent.ts"
import { buildCommand, runAgent } from "./Agent.ts"
import type { ProcResult } from "./Proc.ts"
import { procOk, runProcess, runShell } from "./Proc.ts"
import { pyFixed } from "./PyFormat.ts"
import type { RunRecord } from "./Report.ts"
import type { MemorySetup } from "./Setups.ts"
import type { Suite, Task } from "./Suite.ts"
import { suiteTask } from "./Suite.ts"
import { isoNow } from "./Time.ts"
import type { Workspace } from "./Workspace.ts"
import { makeWorkspace, overlayWorkspace, resetWorkspace, resolveRef, workspaceDiff } from "./Workspace.ts"

/**
 * Where workspace clones live: outside the repo (and OneDrive), because they
 * hold large dependency trees, and outside the home folder, so runs don't pick
 * up a CLAUDE.md that sits there (Claude Code loads every CLAUDE.md from the
 * cwd up to the root).
 */
export const defaultWorkspaces = (): string => {
  if (process.env.SINGULARITY_WORKSPACES) return process.env.SINGULARITY_WORKSPACES
  if (process.platform === "win32") return parsePath(homedir()).root + "singularity-workspaces"
  return `${homedir()}/.singularity/workspaces`
}

export interface RunSuiteOptions {
  readonly workspaces?: string | undefined
  readonly reps?: number | undefined
  /** Number of the first pass, for adding passes to an existing output dir. Default 0. */
  readonly firstRep?: number | undefined
  readonly taskIds?: ReadonlyArray<string> | undefined
  readonly onRecord?: ((record: RunRecord, done: number, total: number) => Effect.Effect<void>) | undefined
}

export const runSuite = Effect.fn("runSuite")(function*(
  suite: Suite,
  setup: MemorySetup,
  outDir: string,
  claude: ReadonlyArray<string>,
  options: RunSuiteOptions = {}
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const reps = options.reps ?? 1
  const tasks = options.taskIds?.length
    ? yield* Effect.forEach(options.taskIds, (id) => suiteTask(suite, id))
    : suite.tasks
  const ws = makeWorkspace(suite.repo, path.join(options.workspaces ?? defaultWorkspaces(), suite.name), suite.keep)
  // Resolve every base before spending anything, so a bad ref fails fast.
  const shas = new Map<string, string>()
  for (const t of tasks) shas.set(t.id, yield* resolveRef(ws, t.base))

  // Absolute: paths under it are passed to the agent, which runs in the workspace.
  const out = path.resolve(outDir)
  yield* fs.makeDirectory(out, { recursive: true })
  const version = yield* runProcess(claude[0], [...claude.slice(1), "--version"], { cwd: out, timeoutS: 60, env: process.env })
  const meta = {
    suite: suite.name,
    suite_path: suite.path,
    setup: setup.name,
    reps,
    tasks: tasks.map((t) => t.id),
    claude_version: version.stdout.trim(),
    started_at: isoNow()
  }
  yield* fs.writeFileString(path.join(out, "meta.json"), JSON.stringify(meta, null, 2) + "\n")

  const records: Array<RunRecord> = []
  const total = reps * tasks.length
  const firstRep = options.firstRep ?? 0
  // Rep-major order: each pass runs every task once, so a slow stretch of API
  // latency is spread across tasks instead of landing on one.
  for (let rep = firstRep; rep < firstRep + reps; rep++) {
    for (const task of tasks) {
      const record = yield* runTask(suite, task, shas.get(task.id)!, setup, ws, rep, out, claude)
      yield* fs.writeFileString(path.join(out, "results.jsonl"), JSON.stringify(record) + "\n", { flag: "a" })
      records.push(record)
      if (options.onRecord) yield* options.onRecord(record, records.length, total)
    }
  }
  return records
})

export const runTask = Effect.fn("runTask")(function*(
  suite: Suite,
  task: Task,
  sha: string,
  setup: MemorySetup,
  ws: Workspace,
  rep: number,
  outDir: string,
  claude: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const runId = `${task.id}-r${rep}-${randomBytes(3).toString("hex")}`
  const runDir = path.join(outDir, "runs", runId)
  yield* fs.makeDirectory(runDir, { recursive: true })
  const record = {
    run_id: runId,
    suite: suite.name,
    setup: setup.name,
    task_id: task.id,
    family: task.family ?? null,
    rep,
    base_sha: sha,
    started_at: isoNow()
  }
  const env = { ...process.env, ...suite.env }
  const shell = (command: string) =>
    runShell(command, { cwd: ws.path, timeoutS: suite.commandTimeoutS, env }).pipe(
      Effect.map((r) => [command, r] as const)
    )

  yield* resetWorkspace(ws, sha)
  const setupResults = yield* Effect.forEach(suite.setup, shell)
  yield* writeLogs(path.join(runDir, "setup.log"), setupResults)
  if (!setupResults.every(([, r]) => procOk(r))) {
    return { ...record, status: "setup_failed", success: null } as RunRecord
  }

  const injection = yield* setup.beforeRun(task, ws.path)
  let promptFile: string | undefined
  if (injection.systemPrompt) {
    promptFile = path.join(runDir, "injected.md")
    yield* fs.writeFileString(promptFile, injection.systemPrompt)
  }

  const sessionId = randomUUID()
  const command = buildCommand(claude, suite.agent, sessionId, promptFile)
  const agent = yield* runAgent(command, sessionId, task.prompt, ws.path, suite.agent.timeoutS, suite.env)
  yield* fs.writeFileString(path.join(runDir, "agent.stdout.json"), agent.proc.stdout)
  yield* fs.writeFileString(path.join(runDir, "agent.stderr.txt"), agent.proc.stderr)

  const trace = yield* saveTrace(sessionId, path.join(runDir, "transcript"))
  const diff = yield* workspaceDiff(ws, sha)
  yield* fs.writeFileString(path.join(runDir, "diff.patch"), diff)

  if (task.checkFiles !== undefined) yield* overlayWorkspace(ws, task.checkFiles)
  const checkResults = yield* Effect.forEach(task.checks, shell)
  yield* writeLogs(path.join(runDir, "checks.log"), checkResults)
  const success = checkResults.length > 0 ? checkResults.every(([, r]) => procOk(r)) : null

  yield* setup.afterRun({ task, success, trace, diff })

  const [agentUsage, usageSource] = headlineUsage(agent.result, trace)
  const agentCost = cost(agent.result, trace)
  // Memory that called a model to prepare (the graph's step selection) pays for it here.
  const spent = injection.spent
  const usage = agentUsage !== undefined && spent !== undefined ? addUsage(agentUsage, spent.usage) : agentUsage
  return {
    ...record,
    status: status(agent),
    success,
    session_id: sessionId,
    models: trace ? traceModels(trace) : null,
    cost_usd: agentCost !== null && spent !== undefined ? agentCost + spent.costUsd : agentCost,
    tokens: usage ? usageToJson(usage) : null,
    tokens_source: usageSource,
    wall_time_s: round3(agent.proc.durationS),
    agent: agentInfo(agent),
    trace: trace ? metricsToJson(traceMetrics(trace)) : null,
    checks: checkResults.map(([c, r]) => ({
      command: c,
      exit_code: r.exitCode ?? null,
      timed_out: r.timedOut,
      duration_s: round3(r.durationS)
    })),
    injection: injection.info,
    ...(spent === undefined ? {} : { memory_spent: { cost_usd: spent.costUsd, tokens: usageToJson(spent.usage) } }),
    diff_lines: diffLines(diff),
    // From the diff, so it covers edits made through the shell too.
    files_changed: changedFiles(diff)
  } as RunRecord
})

// Every line break Python's `str.splitlines()` recognizes (built from a string so
// the source holds no raw line-separator characters).
const PY_LINE_BREAKS = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]")

/** Python's `str.splitlines()`: every line break Python knows, and no trailing empty line. */
const splitlines = (text: string): Array<string> => {
  const lines = text.split(PY_LINE_BREAKS)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Added and removed lines. Like the Python version, it also counts empty
 * lines (which appear in binary patches), so the numbers stay comparable.
 */
export const diffLines = (diff: string): number =>
  splitlines(diff).filter((l) => (l === "" || l[0] === "+" || l[0] === "-") && !l.startsWith("+++") && !l.startsWith("---")).length

export const changedFiles = (diff: string): Array<string> =>
  splitlines(diff)
    .filter((l) => l.startsWith("diff --git "))
    .map((l) => {
      const at = l.lastIndexOf(" b/")
      return at >= 0 ? l.slice(at + 3) : l
    })

const status = (agent: AgentRun): string => {
  if (agent.proc.timedOut) return "timeout"
  if (agent.result === undefined) return "agent_crashed"
  const subtype = agent.result.subtype
  return subtype === "success" ? "completed" : String(subtype || "agent_error")
}

const agentInfo = (agent: AgentRun) => {
  const r = agent.result ?? {}
  const denials = r.permission_denials
  return {
    exit_code: agent.proc.exitCode ?? null,
    subtype: r.subtype ?? null,
    num_turns: r.num_turns ?? null,
    duration_ms: r.duration_ms ?? null,
    duration_api_ms: r.duration_api_ms ?? null,
    permission_denials: Array.isArray(denials) ? denials.length : 0,
    command: agent.command
  }
}

const isNonEmptyObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0

/** Tokens for the whole run, preferring sources that include side calls. */
const headlineUsage = (
  result: Readonly<Record<string, unknown>> | undefined,
  trace: Trace | undefined
): [Usage | undefined, string | null] => {
  if (isNonEmptyObject(result?.modelUsage)) return [sumModelUsage(result.modelUsage), "result"]
  if (isNonEmptyObject(trace?.costState?.modelUsage)) return [sumModelUsage(trace.costState.modelUsage), "cost-state"]
  if (trace) return [traceUsage(trace), "transcript"]
  return [undefined, null]
}

const sumModelUsage = (modelUsage: Record<string, unknown>): Usage =>
  Object.values(modelUsage).reduce<Usage>((acc, v) => addUsage(acc, usageFromModelUsage(v)), emptyUsage)

const cost = (result: Readonly<Record<string, unknown>> | undefined, trace: Trace | undefined): number | null => {
  if (result?.total_cost_usd !== undefined && result.total_cost_usd !== null) return Number(result.total_cost_usd)
  const fromState = trace?.costState?.totalCostUSD
  if (fromState !== undefined && fromState !== null) return Number(fromState)
  return null
}

/**
 * Copy the run's transcript out of Claude Code's config dir and parse it.
 * Claude Code deletes old transcripts after a while, so results keep a copy.
 */
const saveTrace = Effect.fn("saveTrace")(function*(sessionId: string, dest: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const src = yield* findTranscript(sessionId)
  if (src === undefined) return undefined
  yield* fs.makeDirectory(dest, { recursive: true })
  const main = path.join(dest, path.basename(src))
  yield* fs.copyFile(src, main)
  const subagents = path.join(src.replace(/\.jsonl$/, ""), "subagents")
  if (yield* fs.exists(subagents)) {
    yield* fs.copy(subagents, path.join(dest, sessionId, "subagents"))
  }
  return yield* parseSession(main)
})

const writeLogs = Effect.fn("writeLogs")(function*(
  file: string,
  results: ReadonlyArray<readonly [string, ProcResult]>
) {
  if (results.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const parts = results.map(([command, r]) => {
    const state = r.timedOut ? "timed out" : `exit ${r.exitCode}`
    return `$ ${command}\n[${state}, ${pyFixed(r.durationS, 1)}s]\n${r.stdout}${r.stderr}\n`
  })
  yield* fs.writeFileString(file, parts.join("\n"))
})

const round3 = (x: number): number => Math.round(x * 1000) / 1000
