/**
 * Learning from results: the Procedural Graphs paper's self-evolution, on
 * what runs show.
 *
 * 1. Results. For each new run: what memory showed it (when it ran with
 *    memory) or would have shown it (a run without memory: the selection is
 *    made for its task now), against where its edits went. A place shown and
 *    left alone, an edit at a place memory didn't show, a pitfall that fired
 *    and was made anyway: each says something memory got wrong.
 *    And what each run still had to look up before its first edit
 *    (Lookups.ts): the reads and searches memory's hand-over left to it, told
 *    against memory's places and the lines the hand-over showed of them.
 * 2. Refine. The inducing model revises the current memory from the new runs,
 *    those results, and the revisions rejected before (rejection memory).
 * 3. Gate. The revision is kept only if, replayed over the runs (the new ones
 *    and those memory already learned from), it shows at least as many of the
 *    places runs edited, less the places they left alone, as the current
 *    memory does. Otherwise it is rejected, with the reason, for next time.
 *    Memory picked by cues is replayed with cues: they are written again for
 *    the revision first (CueWriter.ts), so the gate judges what tasks will get.
 */
import { Effect, FileSystem, Path } from "effect"
import type { WorkflowRecord } from "../records/Models.ts"
import { choiceByCues, hasCues } from "./Cues.ts"
import type { Evidence, RunEvidence } from "./Evidence.ts"
import { describePlace, type InduceConfig, induce } from "./Induce.ts"
import { type CodeSource, type Located, locatePlaces } from "./Locate.ts"
import { describeLookup } from "./Lookups.ts"
import type { Place, WorkflowMemory } from "./Models.ts"
import { selectWorkflows, type SelectorConfig, wordChoice } from "./Select.ts"
import type { ReplayNumbers, WorkflowCandidate } from "./WorkflowStore.ts"

/** How workflows are picked when replaying: by a model call, or by memory's cues with none (local first). */
export type Picker = SelectorConfig | "cues" | undefined

/** What a run was shown, or would have been. */
export interface Shown {
  readonly workflows: ReadonlyArray<string>
  readonly places: ReadonlyArray<string>
  /** True when the run had memory; false when this is what memory would have shown it. */
  readonly handed: boolean
}

/** What memory showed a run, from its record: v1's own feedback (sessions) or the eval setup's info. */
export const shownInRecord = (r: WorkflowRecord): Shown | undefined => {
  if (r.memory === null || !["workflows", "workflows-draft", "workflows-cues", "workflows-split"].includes(r.memory.setup)) return undefined
  return {
    workflows: r.memory.items.filter((i) => i.kind === "workflow").map((i) => i.id),
    places: r.memory.items.filter((i) => i.kind === "place").map((i) => i.id),
    handed: true
  }
}

/** The places a memory would show for a task: its chosen workflows' steps, skipped steps aside. */
export const wouldShow = Effect.fn("wouldShow")(function*(memory: WorkflowMemory, prompt: string, selector: Picker) {
  const s = selector === "cues"
    ? { chosen: hasCues(memory) ? choiceByCues(memory, prompt) : wordChoice(memory, prompt), call: null }
    : yield* selectWorkflows(memory, prompt, selector)
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
export const replay = Effect.fn("replayWorkflows")(function*(memory: WorkflowMemory, runs: ReadonlyArray<RunEvidence>, selector: Picker) {
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
  selector: Picker,
  current: WorkflowMemory,
  evidence: Evidence,
  records: ReadonlyMap<string, WorkflowRecord>,
  rejected: ReadonlyArray<WorkflowCandidate>,
  /** To tell what runs looked up: a clone to find memory's places in at each run's base commit, and the hand-over texts runs got, by record. */
  looked?: { readonly repo: string | undefined; readonly texts: ReadonlyMap<string, string> }
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
  // The new runs count for places memory has; how memory shows each stays until the model says otherwise.
  const shows = new Set(current.places.filter((p) => p.show === "entry").map((p) => p.id))
  const places = new Map([...current.places, ...evidence.places].map((p) => [p.id, withShow(p, shows.has(p.id))]))
  const merged: Evidence = { ...evidence, places: [...places.values()] }
  const lookups = looked === undefined ? "" : yield* lookupsText(current, results, looked.repo, looked.texts)
  const notes = [resultsText(results, places, current), lookups, rejectionsText(rejected)].filter((t) => t !== "")
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
  const entries = new Set(induced.entries)
  // A pitfall with a trigger warns on its own when its mistake comes back; one the revision left out stays.
  const kept = new Set(induced.memory.pitfalls.map((p) => p.id))
  const carried = current.pitfalls.filter((p) => p.trigger !== null && !kept.has(p.id))
  const memory: WorkflowMemory = {
    ...induced.memory,
    pitfalls: [...induced.memory.pitfalls, ...carried],
    workflows,
    places: [...places.values()].filter((p) => used.has(p.id)).map((p) => withShow(p, entries.has(p.id)))
  }
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

/** A place shown as a whole entry, or as the end of its block. */
export const withShow = (p: Place, entry: boolean): Place => {
  const { show: _show, ...rest } = p
  return entry ? { ...rest, show: "entry" } : rest
}

/** The lines of each file a hand-over showed: the numbered excerpt lines under each place. */
export const shownInText = (text: string): Map<string, Set<number>> => {
  const out = new Map<string, Set<number>>()
  let file: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const header = /`([^`\s]+):(\d+)-(\d+)`/.exec(line) ?? /The shortest, `([^`\s]+)`:/.exec(line)
    if (header !== null) {
      file = header[1]
      continue
    }
    const numbered = /^\s+(\d+)\| /.exec(line)
    if (numbered !== null && file !== undefined) {
      const set = out.get(file) ?? new Set<number>()
      set.add(Number(numbered[1]))
      out.set(file, set)
    }
  }
  return out
}

const LOOKUPS_INTRO = [
  "Every turn before a run's first edit rereads everything so far, so each of these reads and searches is knowledge the hand-over left the agent to find.",
  "Revise memory so a run needs fewer of them, by giving knowledge, never code to copy:",
  "- Where runs read an existing file of the kind a step creates, or read a place wider than the hand-over showed to see one whole entry there (a component, a tag with its attributes), list the place's id in `entries`: the hand-over then shows the last whole entry at that place (for new files, the shortest existing file of the kind), read from the code when used. Only where an entry takes several lines and runs read one before writing theirs.",
  "- Where a step sends the agent to an existing feature to model on (\"like the grid-mode toggle\"), say instead what it needs to know from it, in general words with blanks: its parts, names and registrations. Naming one existing feature sends the agent to read it, and everywhere it appears.",
  "- Where runs searched the repository to be sure they had every place something goes, and the workflow already has them all, say so in its steps.",
  "- Where runs checked something in the code a step depends on (whether a value already exists), say in the step where to see it.",
  "- Don't add steps or places for what runs looked at and didn't need.",
  ""
]

/**
 * What the new runs that were handed memory still looked up before their
 * first edit, each lookup told against memory's places (found in the code at
 * the run's base commit) and the lines of them the run's hand-over showed.
 */
export const lookupsText = Effect.fn("lookupsText")(function*(
  memory: WorkflowMemory,
  runs: ReadonlyArray<{ readonly run: RunEvidence; readonly shown: Shown }>,
  repo: string | undefined,
  texts: ReadonlyMap<string, string>
) {
  const handed = runs.filter((x) => x.shown.handed && x.run.looking !== null && x.run.looking.lookups.length > 0)
  if (handed.length === 0) return ""
  const lines = ["## What runs still looked up before their first edit", "", ...LOOKUPS_INTRO]
  const byBase = new Map<string, ReadonlyMap<string, Located>>()
  for (const { run, shown } of handed) {
    const looking = run.looking!
    let located: ReadonlyMap<string, Located> = new Map()
    if (repo !== undefined && run.base !== null) {
      const cached = byBase.get(run.base)
      const source: CodeSource = { kind: "commit", repo, commit: run.base }
      located = cached ?? (yield* locatePlaces(source, memory.places))
      byBase.set(run.base, located)
    }
    const seen = shownInText(texts.get(run.record) ?? "")
    const shownLines = new Map<string, ReadonlyArray<number>>()
    for (const id of shown.places) {
      const at = located.get(id)
      if (at === undefined) continue
      if (at.kind === "new-file") {
        shownLines.set(id, [...seen.entries()].filter(([f]) => f.startsWith(`${at.dir}/`)).flatMap(([, n]) => [...n]))
        continue
      }
      shownLines.set(id, [...(seen.get(at.file) ?? [])].filter((n) => n >= at.region.from + 1 && n <= at.region.to + 1))
    }
    lines.push(
      `- Run ${run.record} (task ${JSON.stringify(run.task)}), handed ${shown.workflows.join(", ") || "nothing"}: ` +
        `${looking.turns} of its ${run.turns} turns (${Math.round(looking.tokens / 1000)}k tokens) before its first edit.`
    )
    for (const l of looking.lookups) lines.push(`  - turn ${l.turn}: ${describeLookup(l, memory.places, located, shownLines)}`)
  }
  return lines.join("\n")
})

/** The hand-over each eval run got, by record: the text its run directory keeps (injected.md). */
export const handedTexts = Effect.fn("handedTexts")(function*(records: ReadonlyArray<WorkflowRecord>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const out = new Map<string, string>()
  for (const r of records) {
    if (r.run.run_dir === null || r.run.run_id === null) continue
    const file = path.join(r.run.run_dir, "runs", r.run.run_id, "injected.md")
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    if (text !== "") out.set(r.id, text)
  }
  return out as ReadonlyMap<string, string>
})
