/**
 * Memory v1 at task start: pick the workflows the task needs (Select.ts, or
 * without a model by memory's cues, Cues.ts, which also fill the blanks the
 * task states), find their places in the code as it is (the working tree, or
 * a commit for previews and checks), and hand them over (Render.ts); or, with a drafter,
 * hand over the change those workflows make for this task, written from that
 * code (Draft.ts), when it passes its checks and fits. What was handed over
 * is kept for the session, so tool-call hooks can match pitfall triggers and
 * the session's record can say what each piece of memory did.
 */
import { DateTime, Effect, FileSystem } from "effect"
import { identifyRepo } from "../local/Git.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { type Usage, usageToJson } from "../traces/index.ts"
import { cueChoice, fillsOfChosen, hasCues, partsChoice } from "./Cues.ts"
import { type DraftCall, draftChange, type DrafterConfig, renderDraft } from "./Draft.ts"
import { END, START, type WorkflowMemory } from "./Models.ts"
import { type CodeSource, locatePlaces, pathExists } from "./Locate.ts"
import { MAX_HANDOVER_CHARS, renderHandover, type Shown } from "./Render.ts"
import { type Selection, selectWorkflows, type SelectorConfig, wordChoice } from "./Select.ts"
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
  /** The same in parts, one per hook that carries it (a drafted change comes whole). */
  readonly parts: ReadonlyArray<string>
  readonly state: WorkflowSession | undefined
  readonly reasons: ReadonlyArray<string>
  readonly shown: ReadonlyArray<Shown>
  /** The drafted change, when one was asked for: what became of it. */
  readonly draft: DraftLog | null
}

/** What the hand-over log keeps of a drafted change. */
export interface DraftLog {
  readonly model: string
  readonly cost_usd: number | null
  readonly duration_s: number | null
  readonly error: string | null
  /** Whether the agent got the change (else the workflows: no draft, nothing in it, or too long). */
  readonly used: boolean
  readonly edits: number
  readonly files: ReadonlyArray<string>
  readonly dropped: ReadonlyArray<string>
  readonly unsure: ReadonlyArray<string>
}

const draftLog = (call: DraftCall, used: boolean, draft: { edits: ReadonlyArray<unknown>; files: ReadonlyArray<{ path: string }>; dropped: ReadonlyArray<string>; unsure: ReadonlyArray<string> } | undefined): DraftLog => ({
  model: call.model,
  cost_usd: call.costUsd,
  duration_s: call.durationS,
  error: call.error,
  used,
  edits: draft?.edits.length ?? 0,
  files: draft?.files.map((f) => f.path) ?? [],
  dropped: draft?.dropped ?? [],
  unsure: draft?.unsure ?? []
})

export const startTask = Effect.fn("startTask")(function*(
  input: StartInput,
  options: {
    readonly tenantDir: string
    readonly selector?: SelectorConfig | undefined
    /** Hand over the change itself, written at task start by this model (Draft.ts). */
    readonly drafter?: DrafterConfig | undefined
    /**
     * Pick without a model, by memory's cues (by words when it has none), and
     * fill the blanks the task states (Cues.ts). `selector` is then unused.
     */
    readonly cues?: boolean | undefined
    /** false: a preview; nothing is kept for the session or logged. */
    readonly persist?: boolean | undefined
    /** Read the code at this commit instead of the working tree (previews, checks). */
    readonly at?: string | undefined
    /** Characters per part, and how many hooks carry a part each (Render.ts). */
    readonly budget?: number | undefined
    readonly parts?: number | undefined
  }
) {
  const records = yield* RecordStore
  const store = yield* WorkflowStore
  const nothing: StartResult = { text: undefined, parts: [], state: undefined, reasons: [], shown: [], draft: null }
  const repo = yield* identifyRepo(input.cwd)
  const subject = repo === undefined ? undefined : yield* records.subjectFor(repo)
  if (repo === undefined || subject === undefined) return nothing
  const version = yield* store.head()
  const memory = forSubject(yield* store.memory(), subject.id)
  if (memory.workflows.length === 0) return nothing

  const byCues = options.cues === true && hasCues(memory)
  // A task that lists several changes is picked and filled change by change.
  const inParts = byCues ? partsChoice(memory, input.prompt) : undefined
  const withoutModel = (): Selection => {
    const chosen = inParts?.chosen ?? (byCues ? cueChoice(memory, input.prompt) : wordChoice(memory, input.prompt))
    return { chosen, call: null, reasons: chosen.map((c) => `${c.workflow.id}: ${c.why}`) }
  }
  const selection: Selection = options.cues === true ? withoutModel() : yield* selectWorkflows(memory, input.prompt, options.selector)
  const fills = byCues && inParts === undefined ? fillsOfChosen(input.prompt, selection.chosen) : undefined
  const places = new Map(memory.places.map((p) => [p.id, p]))
  const needed = selection.chosen.flatMap((c) => c.workflow.steps.flatMap((s, i) => (c.skip.includes(i + 1) || s.place === null ? [] : [places.get(s.place)])))
    .filter((p) => p !== undefined)
  const source: CodeSource = options.at === undefined ? { kind: "tree", root: repo.root } : { kind: "commit", repo: repo.root, commit: options.at }
  const located = yield* locatePlaces(source, needed)
  const budget = options.budget ?? MAX_HANDOVER_CHARS
  const handover = renderHandover(memory, selection.chosen, located, budget, fills, options.parts ?? 1, inParts)
  let text = selection.chosen.length === 0 ? undefined : handover.text
  let parts = selection.chosen.length === 0 ? [] : handover.parts
  let draft: DraftLog | null = null
  let draftUsage: Usage | undefined
  if (options.drafter !== undefined && selection.chosen.length > 0) {
    // The model runs in a directory of its own, with no CLAUDE.md above it.
    yield* (yield* FileSystem.FileSystem).makeDirectory(options.drafter.cwd, { recursive: true }).pipe(Effect.ignore)
    const drafted = yield* draftChange(input.prompt, memory, selection.chosen, located, (p) => pathExists(source, p), options.drafter)
    const d = drafted.draft
    const written = d === undefined || d.edits.length + d.files.length === 0 ? undefined : renderDraft(memory, selection.chosen, d, budget)
    if (written !== undefined) {
      text = written
      parts = [written]
    }
    draft = draftLog(drafted.call, written !== undefined, d)
    draftUsage = drafted.call.usage ?? undefined
  }

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
  const result: StartResult = { text, parts, state, reasons: selection.reasons, shown: handover.shown, draft }
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
    ...(draft === null ? {} : { draft, draft_tokens: draftUsage === undefined ? null : usageToJson(draftUsage) }),
    ...(options.cues === true
      ? { picked_by: byCues ? "cues" : "words", fills: Object.fromEntries([...(fills ?? new Map())].map(([w, v]) => [w, Object.fromEntries(v)])) }
      : {}),
    // For a task that lists several changes: how many, and each workflow's changes with their values.
    ...(inParts === undefined ? {} : {
      changes: inParts.count,
      change_fills: Object.fromEntries([...inParts.uses].map(([w, uses]) => [w, Object.fromEntries(uses.map((u) => [u.label, Object.fromEntries(u.values)]))]))
    }),
    chars: text?.length ?? 0,
    ...(parts.length > 1 ? { parts: parts.length } : {}),
    text: text ?? null
  })
  return result
})
