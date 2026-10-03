/**
 * The SessionEnd hook for memory v1: record the session if it counts as
 * successful (its change is committed and its last test run passed, the rule
 * outside evals), with what became of the memory it was handed (Feedback.ts).
 * Prints nothing: the session is over.
 */
import { NodeServices } from "@effect/platform-node"
import { DateTime, Effect, Layer, Path } from "effect"
import { decodeHookInput } from "../handover/HookInput.ts"
import { git, identifyRepo } from "../local/Git.ts"
import { loadHome } from "../local/Home.ts"
import { buildRecord, recordId } from "../records/Build.ts"
import { extractMechanical, relativizer } from "../records/Extract.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { classifyKey } from "../records/Shell.ts"
import { eventOfCall } from "../records/Triggers.ts"
import { parseSession, traceUsage, usageTotal } from "../traces/index.ts"
import { gatherEvidence } from "./Evidence.ts"
import { feedbackOf } from "./Feedback.ts"
import * as JsonWorkflowStore from "./JsonWorkflowStore.ts"
import { readFired, readSession } from "./Session.ts"
import { WorkflowStore } from "./WorkflowStore.ts"

export interface SessionOutcome {
  /** The record's id, when one was made (or existed already). */
  readonly record: string | undefined
  readonly reason: string
}

/** Commits made on the current branch since `since`: the base before them, or undefined if there are none. */
const baseSince = Effect.fn("workflows.baseSince")(function*(repo: string, since: DateTime.Utc) {
  const out = yield* git(repo, ["log", "--format=%H", `--since=${DateTime.formatIso(since)}`]).pipe(Effect.orElseSucceed(() => ""))
  const commits = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
  if (commits.length === 0) return undefined
  return yield* git(repo, ["rev-parse", `${commits[commits.length - 1]}^`]).pipe(Effect.map((s) => s.trim()), Effect.orElseSucceed(() => undefined))
})

export const recordWorkflowSession = Effect.fn("recordWorkflowSession")(function*(
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
  const last = m.commands.filter((c) => c.keys.some((k) => classifyKey(k) === "test")).at(-1)
  if (last === undefined) return { record: undefined, reason: "no tests were run" } satisfies SessionOutcome
  if (!last.ok) return { record: undefined, reason: "the last test run failed" } satisfies SessionOutcome

  const diff = yield* git(repo.root, ["diff", "--binary", base, repo.head]).pipe(Effect.map((s) => s.replace(/\r\n?/g, "\n")))
  const cost = trace.costState?.totalCostUSD
  const record = buildRecord({
    tenant: store.tenant,
    subject: subject.id,
    trace,
    diff,
    outcome: "success",
    checks: [{ command: last.command, ok: true, exit_code: 0 }],
    memory: null,
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

  // What became of the memory it was handed: the places its edits went, against those shown.
  let memory = record.memory
  if (state !== undefined) {
    const evidence = yield* gatherEvidence([record], { repo: repo.root })
    const run = evidence.runs[0]
    const edited = new Map((run?.uses ?? []).map((u) => [u.place, u.file] as const))
    const workflows = yield* WorkflowStore
    const handedMemory = yield* workflows.memory(state.version).pipe(Effect.orElseSucceed(() => undefined))
    const placesOf = (wid: string) => handedMemory?.workflows.find((w) => w.id === wid)?.steps.flatMap((s) => (s.place === null ? [] : [s.place])) ?? []
    const relative = relativizer(trace.cwd)
    const fired = yield* readFired(tenantDir, input.sessionId)
    memory = feedbackOf(
      {
        version: state.version,
        workflows: state.workflows.map((w) => ({ id: w.id, places: placesOf(w.id) })),
        shown: state.shown.map((s) => s.place),
        pitfalls: state.pitfalls,
        fired: fired.map((f) => ({ pitfall: f.pitfall, at: Date.parse(f.at) })),
        triggers: state.triggers
      },
      {
        edited,
        events: trace.toolCalls.filter((c) => c.agentId === undefined).map((c) => ({
          event: eventOfCall(c, relative),
          at: c.startedAt === undefined ? undefined : DateTime.toEpochMillis(c.startedAt)
        }))
      }
    )
  }
  yield* store.put({ ...record, memory })
  return { record: record.id, reason: "recorded" } satisfies SessionOutcome
})

export const sessionEnd = (stdin: string): Promise<SessionOutcome | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.transcript_path === undefined) return undefined
      const home = yield* loadHome()
      const path = yield* Path.Path
      return yield* recordWorkflowSession(
        { sessionId: input.session_id, transcript: input.transcript_path, cwd: input.cwd ?? process.cwd() },
        home.tenantDir
      ).pipe(Effect.provide(Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
      )))
    }).pipe(Effect.provide(NodeServices.layer))
  )
