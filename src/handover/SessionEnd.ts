/**
 * When a session ends, its record, if it counts as successful: its change is
 * committed and its tests pass (the rule outside evals).
 *
 * - Committed: the repo's HEAD moved since the task started (kept in the
 *   session's state), or, for a session that has no state, the branch got
 *   commits while it ran. The change is the diff between the two.
 * - Tests pass: the last command in the session that ran tests worked.
 *
 * The record says, without any model, what became of the memory the session
 * was given: a warning whose trigger still matched after it was handed over
 * was ignored; one whose trigger never matched again was followed. The
 * model's reading is added later, in batches (`record annotate`).
 */
import { DateTime, Effect } from "effect"
import { git, identifyRepo } from "../local/Git.ts"
import { buildRecord, recordId } from "../records/Build.ts"
import { extractMechanical, parseDiff, relativizer } from "../records/Extract.ts"
import type { MemoryItem, MemoryUse } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { classifyKey } from "../records/Shell.ts"
import { eventOfCall, matchTrigger } from "../records/Triggers.ts"
import type { Trace } from "../traces/index.ts"
import { parseSession, traceUsage, usageTotal } from "../traces/index.ts"
import { MemoryStore } from "../memory/MemoryStore.ts"
import { readFired, readSession, type SessionState } from "./Session.ts"
import { STABLE_FILE_SHARE } from "./TaskStart.ts"

export interface SessionOutcome {
  /** The record's id, when one was made (or existed already). */
  readonly record: string | undefined
  readonly reason: string
}

/**
 * What became of each piece of memory the session got, judged from its log
 * and its change. A step whose usual files the change touched was followed;
 * one with usual files it didn't touch, ignored; one without, unknown.
 */
export const memoryFeedback = (
  state: SessionState,
  fired: ReadonlyArray<{ readonly warning: string; readonly at: string }>,
  trace: Trace,
  stepFiles: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  changed: ReadonlyArray<string> = []
): MemoryUse => {
  const relative = relativizer(trace.cwd)
  const events = trace.toolCalls.filter((c) => c.agentId === undefined).map((c) => ({ call: c, event: eventOfCall(c, relative) }))
  const byId = new Map(state.triggers.map((w) => [w.id, w]))
  const items: Array<MemoryItem> = []
  if (state.kind !== null) items.push({ id: state.kind, kind: "route", moment: "start", outcome: "unknown", note: null })
  for (const s of state.steps) {
    const files = stepFiles.get(s) ?? []
    const touched = files.filter((f) => changed.includes(f))
    items.push({
      id: s,
      kind: "step",
      moment: "start",
      outcome: files.length === 0 ? "unknown" : touched.length > 0 ? "followed" : "ignored",
      note: files.length === 0 ? null : touched.length > 0 ? `changed ${touched.join(", ")}` : `changed none of ${files.join(", ")}`
    })
  }
  for (const id of state.warnings) {
    const w = byId.get(id)
    if (w?.trigger == null) {
      items.push({ id, kind: "warning", moment: "start", outcome: "unknown", note: null })
      continue
    }
    const made = events.some((e) => matchTrigger(w.trigger!, e.event))
    items.push({ id, kind: "warning", moment: "start", outcome: made ? "ignored" : "followed", note: made ? "its trigger matched anyway" : null })
  }
  for (const f of fired) {
    const w = byId.get(f.warning)
    if (w?.trigger == null) continue
    const at = Date.parse(f.at)
    const again = events.some((e) =>
      e.call.startedAt !== undefined && DateTime.toEpochMillis(e.call.startedAt) > at && matchTrigger(w.trigger!, e.event)
    )
    items.push({
      id: f.warning,
      kind: "warning",
      moment: "trigger",
      outcome: again ? "ignored" : "followed",
      note: again ? "the same mistake came again after the warning" : null
    })
  }
  return { setup: "hooks", version: state.version, items }
}

/** Commits made on the current branch since `since`: the base before them, or undefined if there are none. */
const baseSince = Effect.fn("baseSince")(function*(repo: string, since: DateTime.Utc) {
  const out = yield* git(repo, ["log", "--format=%H", `--since=${DateTime.formatIso(since)}`]).pipe(Effect.orElseSucceed(() => ""))
  const commits = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
  if (commits.length === 0) return undefined
  const oldest = commits[commits.length - 1]
  return yield* git(repo, ["rev-parse", `${oldest}^`]).pipe(Effect.map((s) => s.trim()), Effect.orElseSucceed(() => undefined))
})

export const recordSession = Effect.fn("recordSession")(function*(
  input: { readonly sessionId: string; readonly transcript: string; readonly cwd: string },
  tenantDir: string
) {
  const store = yield* RecordStore
  const state = yield* readSession(tenantDir, input.sessionId)
  const trace = yield* parseSession(input.transcript)
  const repo = yield* identifyRepo(state?.repo ?? input.cwd)
  if (repo === undefined || repo.head === undefined) return { record: undefined, reason: "not in a git repo with commits" } satisfies SessionOutcome
  const subject = yield* store.subjectFor(repo, { create: true })
  if (subject === undefined) return { record: undefined, reason: "no subject" } satisfies SessionOutcome
  const id = recordId(subject.id, trace.sessionId)
  if (yield* store.has(id)) return { record: id, reason: "already recorded" } satisfies SessionOutcome

  const base = state?.head ?? (trace.startedAt === undefined ? undefined : yield* baseSince(repo.root, trace.startedAt))
  if (base === undefined || base === repo.head) return { record: undefined, reason: "nothing was committed" } satisfies SessionOutcome
  const m = extractMechanical(trace, "", { succeeded: true })
  const tests = m.commands.filter((c) => c.keys.some((k) => classifyKey(k) === "test"))
  const last = tests[tests.length - 1]
  if (last === undefined) return { record: undefined, reason: "no tests were run" } satisfies SessionOutcome
  if (!last.ok) return { record: undefined, reason: "the last test run failed" } satisfies SessionOutcome

  const diff = yield* git(repo.root, ["diff", "--binary", base, repo.head]).pipe(Effect.map((s) => s.replace(/\r\n?/g, "\n")))
  const fired = yield* readFired(tenantDir, input.sessionId)
  // The usual files of the steps it was handed, as the memory had them then.
  const stepFiles = new Map<string, ReadonlyArray<string>>()
  if (state !== undefined && state.steps.length > 0) {
    const memory = yield* Effect.serviceOption(MemoryStore)
    if (memory._tag === "Some") {
      const steps = yield* memory.value.steps(state.steps, state.version).pipe(Effect.orElseSucceed(() => []))
      for (const s of steps) {
        const p = s.where[subject.id]
        if (p !== undefined) stepFiles.set(s.id, p.files.filter((f) => f.seen >= 2 && f.seen / Math.max(1, p.runs) >= STABLE_FILE_SHARE).map((f) => f.path))
      }
    }
  }
  const cost = trace.costState?.totalCostUSD
  const record = buildRecord({
    tenant: store.tenant,
    subject: subject.id,
    trace,
    diff,
    outcome: "success",
    checks: [{ command: last.command, ok: true, exit_code: 0 }],
    memory: state === undefined ? null : memoryFeedback(state, fired, trace, stepFiles, parseDiff(diff).map((f) => f.path)),
    run: {
      source: "session",
      log: input.transcript,
      run_dir: null,
      run_id: null,
      setup: null,
      task_id: null,
      repo: repo.root,
      base_commit: base,
      head_commit: repo.head,
      started_at: trace.startedAt === undefined ? null : DateTime.formatIso(trace.startedAt),
      cost_usd: typeof cost === "number" ? cost : null,
      tokens: usageTotal(traceUsage(trace))
    },
    createdAt: DateTime.formatIso(yield* DateTime.now)
  })
  yield* store.put(record)
  return { record: record.id, reason: "recorded" } satisfies SessionOutcome
})
