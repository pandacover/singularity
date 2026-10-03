/**
 * Memory v1 at task start: pick the workflows the task needs (Select.ts),
 * find their places in the code as it is (the working tree, or a commit for
 * previews and checks), and hand them over (Render.ts). What was handed over
 * is kept for the session, so tool-call hooks can match pitfall triggers and
 * the session's record can say what each piece of memory did.
 */
import { DateTime, Effect } from "effect"
import { identifyRepo } from "../local/Git.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { usageToJson } from "../traces/index.ts"
import { END, START, type WorkflowMemory } from "./Models.ts"
import { type CodeSource, locatePlaces } from "./Locate.ts"
import { MAX_HANDOVER_CHARS, renderHandover, type Shown } from "./Render.ts"
import { selectWorkflows, type SelectorConfig } from "./Select.ts"
import { logHandover, type WorkflowSession, writeSession } from "./Session.ts"
import { WorkflowStore } from "./WorkflowStore.ts"

/** Memory a subject may get: its own workflows, places and pitfalls, and the edges between them. */
export const forSubject = (m: WorkflowMemory, subject: string): WorkflowMemory => {
  const workflows = m.workflows.filter((w) => w.subject === subject)
  const ids = new Set(workflows.map((w) => w.id))
  const known = (x: string) => x === START || x === END || ids.has(x)
  return {
    ...m,
    workflows,
    places: m.places.filter((p) => p.subject === subject),
    pitfalls: m.pitfalls.filter((p) => p.subject === subject),
    edges: m.edges.filter((e) => known(e.from) && known(e.to))
  }
}

export interface StartInput {
  readonly sessionId: string
  readonly prompt: string
  readonly cwd: string
}

export interface StartResult {
  /** What the agent gets; undefined when memory has nothing for this task. */
  readonly text: string | undefined
  readonly state: WorkflowSession | undefined
  readonly reasons: ReadonlyArray<string>
  readonly shown: ReadonlyArray<Shown>
}

export const startTask = Effect.fn("startTask")(function*(
  input: StartInput,
  options: {
    readonly tenantDir: string
    readonly selector?: SelectorConfig | undefined
    /** false: a preview; nothing is kept for the session or logged. */
    readonly persist?: boolean | undefined
    /** Read the code at this commit instead of the working tree (previews, checks). */
    readonly at?: string | undefined
    readonly budget?: number | undefined
  }
) {
  const records = yield* RecordStore
  const store = yield* WorkflowStore
  const nothing: StartResult = { text: undefined, state: undefined, reasons: [], shown: [] }
  const repo = yield* identifyRepo(input.cwd)
  const subject = repo === undefined ? undefined : yield* records.subjectFor(repo)
  if (repo === undefined || subject === undefined) return nothing
  const version = yield* store.head()
  const memory = forSubject(yield* store.memory(), subject.id)
  if (memory.workflows.length === 0) return nothing

  const selection = yield* selectWorkflows(memory, input.prompt, options.selector)
  const places = new Map(memory.places.map((p) => [p.id, p]))
  const needed = selection.chosen.flatMap((c) => c.workflow.steps.flatMap((s, i) => (c.skip.includes(i + 1) || s.place === null ? [] : [places.get(s.place)])))
    .filter((p) => p !== undefined)
  const source: CodeSource = options.at === undefined ? { kind: "tree", root: repo.root } : { kind: "commit", repo: repo.root, commit: options.at }
  const located = yield* locatePlaces(source, needed)
  const handover = renderHandover(memory, selection.chosen, located, options.budget ?? MAX_HANDOVER_CHARS)
  const text = selection.chosen.length === 0 ? undefined : handover.text

  const now = DateTime.formatIso(yield* DateTime.now)
  const state: WorkflowSession = {
    session_id: input.sessionId,
    tenant: store.tenant,
    subject: subject.id,
    repo: repo.root,
    head: repo.head ?? null,
    started_at: now,
    prompt: input.prompt,
    version,
    workflows: selection.chosen.map((c) => ({ id: c.workflow.id, skip: [...c.skip] })),
    shown: [...handover.shown],
    missing: [...handover.missing],
    pitfalls: [...handover.pitfalls],
    triggers: memory.pitfalls.filter((p) => p.trigger !== null),
    selection: selection.call === null ? null : { model: selection.call.model, cost_usd: selection.call.costUsd, error: selection.call.error }
  }
  const result: StartResult = { text, state, reasons: selection.reasons, shown: handover.shown }
  if (options.persist === false) return result
  yield* writeSession(options.tenantDir, state)
  yield* logHandover(options.tenantDir, {
    at: now,
    session_id: input.sessionId,
    moment: "start",
    subject: subject.id,
    version,
    workflows: state.workflows,
    reasons: selection.reasons,
    shown: handover.shown,
    missing: handover.missing,
    pitfalls: handover.pitfalls,
    selection: state.selection,
    // What the selection's model call used, so a measurement can count it with the run.
    selection_tokens: selection.call?.usage == null ? null : usageToJson(selection.call.usage),
    chars: text?.length ?? 0,
    text: text ?? null
  })
  return result
})
