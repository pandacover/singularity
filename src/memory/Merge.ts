/**
 * Merge the records into the memory graph, as one candidate.
 *
 * Builds the graph from every record (Build.ts), has a model write the
 * conditions still missing (optional), and runs the replay check against the
 * graph it would replace. The candidate is committed if the check passes and
 * rejected, with the reason, if it doesn't. A build that changes nothing
 * makes no candidate.
 */
import { Effect } from "effect"
import type { ToolCall, Trace } from "../traces/index.ts"
import { parseSession } from "../traces/index.ts"
import { triggerMismatch } from "../records/Annotate.ts"
import { relativizer } from "../records/Extract.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { eventOfCall, type Trigger } from "../records/Triggers.ts"
import { applyAliases, decideCloseCalls, type MergeConfig, noAliases } from "./Aliases.ts"
import { buildGraph } from "./Build.ts"
import { type ConditionsConfig, writeConditions } from "./Conditions.ts"
import { diffGraphs, items, type MemoryGraph } from "./Models.ts"
import { MemoryStore, type ReplaySummary } from "./MemoryStore.ts"
import { judge, replay, type ReplayReport, type Verdict } from "./Replay.ts"

export const summary = (r: ReplayReport): ReplaySummary => ({
  tasks: r.cases.length,
  wrong_kind: r.wrongKind,
  extra: r.extra,
  unasked: r.unasked,
  missing: r.missing,
  detours: r.detours,
  warned: r.warned,
  false_alarms: r.falseAlarms
})

/** Whether a trigger fits a detour, read from the run's log: it matches the failure (or an edit before it) and not the fix. */
export const traceFit = (traces: ReadonlyMap<string, Trace>) => (t: Trigger, r: WorkflowRecord, detour: number): boolean | undefined => {
  const trace = traces.get(r.id)
  const d = r.detours[detour]
  if (trace === undefined || d === undefined) return undefined
  const main: ReadonlyArray<ToolCall> = trace.toolCalls.filter((c) => c.agentId === undefined)
  const relative = relativizer(trace.cwd)
  return triggerMismatch(t, main, d.failed.call, d.fixed.call, (c) => (c === undefined ? undefined : eventOfCall(c, relative))) === undefined
}

/** Logs of the records with detours, for checking triggers against them. Records whose log is gone are left out. */
export const loadTraces = Effect.fn("loadTraces")(function*(records: ReadonlyArray<WorkflowRecord>) {
  const traces = new Map<string, Trace>()
  for (const r of records) {
    if (r.detours.length === 0) continue
    const trace = yield* parseSession(r.run.log).pipe(Effect.option)
    if (trace._tag === "Some") traces.set(r.id, trace.value)
  }
  return traces
})

export interface MergeResult {
  readonly graph: MemoryGraph
  readonly report: ReplayReport
  readonly verdict: Verdict
  /** Undefined when nothing changed, or on a dry run. */
  readonly candidate: string | undefined
  readonly version: number
  readonly changed: number
  readonly costUsd: number
}

export const mergeRecords = Effect.fn("mergeRecords")(function*(options: {
  /** Where close-call decisions are kept (the memory store's directory). */
  readonly memoryDir?: string | undefined
  /** A model to write the conditions of optional steps. */
  readonly conditions?: ConditionsConfig | undefined
  /** A model to decide close calls between step names. */
  readonly closeCalls?: MergeConfig | undefined
  readonly dryRun?: boolean | undefined
} = {}) {
  const recordStore = yield* RecordStore
  const memory = yield* MemoryStore
  const stored = yield* recordStore.find()
  const headVersion = yield* memory.head()
  const current = yield* memory.graph()
  let costUsd = 0
  let aliases = noAliases
  if (options.memoryDir !== undefined) {
    const decided = yield* decideCloseCalls(options.memoryDir, stored, options.dryRun === true ? undefined : options.closeCalls)
    aliases = decided.aliases
    costUsd += decided.costUsd
  }
  const records = applyAliases(stored, aliases)
  const traces = yield* loadTraces(records)
  let graph = buildGraph(records, { tenant: memory.tenant, previous: current, fits: traceFit(traces) })
  if (options.conditions !== undefined) {
    const written = yield* writeConditions(graph, records, options.conditions)
    graph = written.graph
    costUsd += written.costUsd
  }
  const report = replay(graph, records)
  const verdict = judge(report, headVersion === 0 ? undefined : replay(current, records))
  const edits = diffGraphs(current, graph)
  const changed = edits.upsert.length + edits.remove.length
  if (options.dryRun === true || changed === 0) {
    return { graph, report, verdict, candidate: undefined, version: headVersion, changed, costUsd } satisfies MergeResult
  }
  const candidate = yield* memory.propose(edits, {
    baseVersion: headVersion,
    rationale: `merge of ${records.length} records into ${items(graph).length} items`,
    records: records.map((r) => r.id),
    replay: summary(report)
  })
  if (!verdict.commit) {
    yield* memory.reject(candidate.id, verdict.reason)
    return { graph, report, verdict, candidate: candidate.id, version: headVersion, changed, costUsd } satisfies MergeResult
  }
  const version = yield* memory.commit(candidate.id)
  return { graph, report, verdict, candidate: candidate.id, version, changed, costUsd } satisfies MergeResult
})
