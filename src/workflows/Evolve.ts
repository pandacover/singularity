/**
 * Learning from results: the Procedural Graphs paper's self-evolution, on
 * what runs show.
 *
 * 1. Results. For each new run: what memory showed it (when it ran with
 *    memory) or would have shown it (a run without memory: the selection is
 *    made for its task now), against where its edits went. A place shown and
 *    left alone, an edit at a place memory didn't show, a pitfall that fired
 *    and was made anyway: each says something memory got wrong.
 * 2. Refine. The inducing model revises the current memory from the new runs,
 *    those results, and the revisions rejected before (rejection memory).
 * 3. Gate. The revision is kept only if, replayed over the runs (the new ones
 *    and those memory already learned from), it shows at least as many of the
 *    places runs edited, less the places they left alone, as the current
 *    memory does. Otherwise it is rejected, with the reason, for next time.
 */
import { Effect } from "effect"
import type { WorkflowRecord } from "../records/Models.ts"
import type { Evidence, RunEvidence } from "./Evidence.ts"
import { describePlace, type InduceConfig, induce } from "./Induce.ts"
import type { Place, WorkflowMemory } from "./Models.ts"
import { selectWorkflows, type SelectorConfig } from "./Select.ts"
import type { ReplayNumbers, WorkflowCandidate } from "./WorkflowStore.ts"

/** What a run was shown, or would have been. */
export interface Shown {
  readonly workflows: ReadonlyArray<string>
  readonly places: ReadonlyArray<string>
  /** True when the run had memory; false when this is what memory would have shown it. */
  readonly handed: boolean
}

/** What memory showed a run, from its record: v1's own feedback (sessions) or the eval setup's info. */
export const shownInRecord = (r: WorkflowRecord): Shown | undefined => {
  if (r.memory === null || !["workflows", "workflows-draft", "workflows-cues"].includes(r.memory.setup)) return undefined
  return {
    workflows: r.memory.items.filter((i) => i.kind === "workflow").map((i) => i.id),
    places: r.memory.items.filter((i) => i.kind === "place").map((i) => i.id),
    handed: true
  }
}

/** The places a memory would show for a task: its chosen workflows' steps, skipped steps aside. */
export const wouldShow = Effect.fn("wouldShow")(function*(memory: WorkflowMemory, prompt: string, selector: SelectorConfig | undefined) {
  const s = yield* selectWorkflows(memory, prompt, selector)
  const places = [...new Set(s.chosen.flatMap((c) => c.workflow.steps.flatMap((step, i) => (c.skip.includes(i + 1) || step.place === null ? [] : [step.place]))))]
  return { shown: { workflows: s.chosen.map((c) => c.workflow.id), places, handed: false } satisfies Shown, costUsd: s.call?.costUsd ?? 0 }
})

/** How well what was shown fits what the run did. */
export const fit = (run: RunEvidence, shown: Shown) => {
  const edited = new Set(run.uses.map((u) => u.place))
  const places = new Set(shown.places)
  return {
    edited: edited.size,
    hit: [...edited].filter((p) => places.has(p)),
    missed: [...edited].filter((p) => !places.has(p)),
    unused: [...places].filter((p) => !edited.has(p))
  }
}

/** The results, in words, for the refining model. */
export const resultsText = (runs: ReadonlyArray<{ readonly run: RunEvidence; readonly shown: Shown }>, places: ReadonlyMap<string, Place>, memory: WorkflowMemory): string => {
  const known = new Set(memory.places.map((p) => p.id))
  const name = (id: string) => {
    const p = places.get(id)
    return p === undefined ? id : `${id} (${describePlace(p)})`
  }
  const lines = [
    "## How memory did on these runs",
    "",
    "For each run: the workflows memory handed over (or, for a run that had no memory, would have), the places it showed that the run edited, " +
    "those it showed that the run left alone, and where the run edited that memory didn't show (a place memory has but didn't pick, or one it lacks).",
    ""
  ]
  for (const { run, shown } of runs) {
    const f = fit(run, shown)
    lines.push(
      `- Run ${run.record} (task ${JSON.stringify(run.task)}), ${shown.handed ? "handed" : "would have been handed"}: ${shown.workflows.join(", ") || "nothing"}.`,
      `  Shown and edited: ${f.hit.length}. Shown, left alone: ${f.unused.map(name).join("; ") || "none"}.`,
      `  Edited, not shown: ${f.missed.map((p) => `${name(p)}${known.has(p) ? ", which memory has" : ", which memory lacks"}`).join("; ") || "none"}.`
    )
  }
  return lines.join("\n")
}

/** Rejected revisions, for the refining model to avoid proposing again. */
export const rejectionsText = (rejected: ReadonlyArray<WorkflowCandidate>): string =>
  rejected.length === 0
    ? ""
    : [
      "## Revisions rejected before",
      "",
      "Each was tried and did worse when replayed over the runs; don't propose the same again.",
      "",
      ...rejected.slice(-5).map((c) => `- ${c.id}: ${c.reason}. It had ${c.memory.workflows.map((w) => w.id).join(", ")}. Its rationale: ${c.rationale.slice(0, 400)}`)
    ].join("\n")

export interface Replayed extends ReplayNumbers {
  readonly costUsd: number
}

/** Replay a memory over runs: per task, what it would show; per run, how that fits. */
export const replay = Effect.fn("replayWorkflows")(function*(memory: WorkflowMemory, runs: ReadonlyArray<RunEvidence>, selector: SelectorConfig | undefined) {
  let costUsd = 0
  let edited = 0
  let shownAndEdited = 0
  let shownUnused = 0
  let workflows = 0
  const byPrompt = new Map<string, Shown>()
  for (const run of runs) {
    let shown = byPrompt.get(run.prompt)
    if (shown === undefined) {
      const w = yield* wouldShow(memory, run.prompt, selector)
      costUsd += w.costUsd
      shown = w.shown
      byPrompt.set(run.prompt, shown)
    }
    const f = fit(run, shown)
    edited += f.edited
    shownAndEdited += f.hit.length
    shownUnused += f.unused.length
    workflows += shown.workflows.length
  }
  return { runs: runs.length, edited, shown_and_edited: shownAndEdited, shown_unused: shownUnused, workflows, costUsd } satisfies Replayed
})

/** The gate: at least as many edited places shown, less those left alone, as the current memory; never fewer shown places that runs edited by more than it gains. */
export const passes = (candidate: ReplayNumbers, current: ReplayNumbers): { readonly commit: boolean; readonly reason: string } => {
  const score = (r: ReplayNumbers) => r.shown_and_edited - r.shown_unused
  const describe = (r: ReplayNumbers) => `${r.shown_and_edited} edited places shown, ${r.shown_unused} shown and left alone`
  if (score(candidate) < score(current)) return { commit: false, reason: `fits the runs worse: ${describe(candidate)}, against ${describe(current)}` }
  return { commit: true, reason: `${describe(candidate)}, against ${describe(current)}` }
}

export interface EvolveResult {
  readonly memory: WorkflowMemory
  readonly problems: ReadonlyArray<string>
  readonly rationale: string
  readonly costUsd: number
  /** The model calls the refinement and the results took. */
  readonly calls: number
}

/**
 * Revise `current` from new runs: what they did, and what memory showed them
 * or would have. Evidence ids of a workflow that keeps its id are kept.
 */
export const refine = Effect.fn("refine")(function*(
  config: InduceConfig,
  selector: SelectorConfig | undefined,
  current: WorkflowMemory,
  evidence: Evidence,
  records: ReadonlyMap<string, WorkflowRecord>,
  rejected: ReadonlyArray<WorkflowCandidate>
) {
  let costUsd = 0
  let calls = 0
  const results: Array<{ run: RunEvidence; shown: Shown }> = []
  const byPrompt = new Map<string, Shown>()
  // (Its own selection calls are counted in `calls`; the refinement's in `induced.calls`.)
  for (const run of evidence.runs) {
    const recorded = records.get(run.record)
    const shown = recorded === undefined ? undefined : shownInRecord(recorded)
    if (shown !== undefined) {
      results.push({ run, shown })
      continue
    }
    // Runs of one task are shown the same: one selection per prompt.
    let would = byPrompt.get(run.prompt)
    if (would === undefined) {
      const w = yield* wouldShow(current, run.prompt, selector)
      costUsd += w.costUsd
      calls++
      would = w.shown
      byPrompt.set(run.prompt, would)
    }
    results.push({ run, shown: would })
  }
  // The model may keep using memory's places, and use the new runs' places.
  const places = new Map([...current.places, ...evidence.places].map((p) => [p.id, p]))
  const merged: Evidence = { ...evidence, places: [...places.values()] }
  const notes = [resultsText(results, places, current), rejectionsText(rejected)].filter((t) => t !== "")
  const induced = yield* induce(config, merged, current.tenant, current, notes)
  // A workflow that keeps its id keeps the runs it was learned from.
  const before = new Map(current.workflows.map((w) => [w.id, w]))
  const workflows = induced.memory.workflows.map((w) => {
    const old = before.get(w.id)
    return old === undefined ? w : {
      ...w,
      evidence: [...new Set([...old.evidence, ...w.evidence])].sort(),
      tasks: [...new Set([...old.tasks, ...w.tasks])].sort()
    }
  })
  const used = new Set(workflows.flatMap((w) => w.steps.flatMap((s) => (s.place === null ? [] : [s.place]))))
  const memory: WorkflowMemory = { ...induced.memory, workflows, places: [...places.values()].filter((p) => used.has(p.id)) }
  return {
    memory,
    problems: induced.problems,
    rationale: induced.rationale,
    costUsd: costUsd + induced.costUsd,
    calls: induced.calls + calls
  } satisfies EvolveResult
})

/** A summary line of a replay, for people. */
export const describeReplay = (r: ReplayNumbers): string =>
  `${r.runs} runs: ${r.shown_and_edited} of ${r.edited} edited places shown, ${r.shown_unused} shown and left alone, ` +
  `${r.runs === 0 ? 0 : (r.workflows / r.runs).toFixed(1)} workflows per run`
