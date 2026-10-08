/**
 * The replay check, free of any model: for each past task, would this graph
 * hand over what the task needed, and nothing else?
 *
 * For each record the model has read: find the task's kind from its words
 * alone (word search over the kinds, leaving the task's own wording out; the
 * right kind counts as found if it is among the three proposed, since a
 * model confirms one of them at task start), take that kind's route (its
 * required steps, and the optional steps the task did need, standing in for
 * the model that picks them), and compare with the steps the record says the
 * task asked for or needed.
 *
 * - extra: handed over, not needed. Worst of these, `unasked`: steps the run
 *   took only on its own initiative, such as a test nobody asked for, which
 *   agents follow when told.
 * - missing: needed, not handed over.
 * - warnings: of the detours with a lesson, how many a warning would have
 *   reached in time: through its trigger, or at the start with a step or
 *   kind that was handed over.
 *
 * A build is committed only if no task is handed a step it didn't ask for,
 * and it isn't worse than the graph it replaces.
 */
import type { WorkflowRecord } from "../records/Models.ts"
import { buildIndex, search } from "../search/Lexical.ts"
import { causes, kindIdOf, kindNames, stepIdOf, storedFit } from "./Build.ts"
import type { Kind, MemoryGraph } from "./Models.ts"
import { reaches } from "./Models.ts"
import { matchTrigger } from "../records/Triggers.ts"

/**
 * A kind is proposed for a task that shares at least two distinct words with
 * it, or this much of the task's (weighted) wording: a low bar, since a
 * model confirms, and missing the right kind costs the whole hand-over.
 */
export const MIN_KIND_COVERAGE = 0.1
export const MIN_SHARED_WORDS = 2

/**
 * Kinds ranked by how well a task's words match them, best first, at most
 * `max`, each sharing enough with the task (MIN_SHARED_WORDS or
 * MIN_KIND_COVERAGE). A kind scores as its best-matching text: its name and
 * description, or one of its example tasks; a kind with many examples isn't
 * a long document to be penalized. `leaveOut` drops an example (the task's
 * own wording, when replaying it).
 */
export const rankKinds = (kinds: ReadonlyArray<Kind>, prompt: string, max = 3, leaveOut?: string) => {
  const docs = kinds.flatMap((k) => [
    { id: `${k.id}\u0000name`, text: `${k.name}\n${k.description}` },
    ...k.examples.filter((e) => e.trim() !== leaveOut?.trim()).map((e, i) => ({ id: `${k.id}\u0000${i}`, text: e }))
  ])
  const best = new Map<string, { id: string; score: number; coverage: number; matched: number }>()
  for (const h of search(buildIndex(docs), prompt, docs.length)) {
    const id = h.id.split("\u0000")[0]
    const seen = best.get(id)
    best.set(id, {
      id,
      score: Math.max(h.score, seen?.score ?? 0),
      coverage: Math.max(h.coverage, seen?.coverage ?? 0),
      matched: Math.max(h.matched, seen?.matched ?? 0)
    })
  }
  return [...best.values()]
    .filter((h) => h.coverage >= MIN_KIND_COVERAGE || h.matched >= MIN_SHARED_WORDS)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, max)
}

/** The kinds a task looks like, among those `subject` may get. */
export const pickKind = (graph: MemoryGraph, prompt: string, subject: string, leaveOut?: string) =>
  rankKinds(graph.kinds.filter((k) => reaches(k.reach, subject)), prompt, 3, leaveOut)

export interface ReplayCase {
  readonly record: string
  /** The record's own kind and the kind word search picked. */
  readonly kind: string | null
  readonly picked: string | null
  readonly needed: ReadonlyArray<string>
  readonly handed: ReadonlyArray<string>
  readonly extra: ReadonlyArray<string>
  readonly unasked: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  /** Detours with a lesson, and how many of them a warning would have reached. */
  readonly detours: number
  readonly warned: number
  /** Commands that worked, on which a warning's trigger would still have fired. */
  readonly falseAlarms: number
}

export interface ReplayReport {
  readonly cases: ReadonlyArray<ReplayCase>
  readonly wrongKind: number
  readonly extra: number
  readonly unasked: number
  readonly missing: number
  readonly detours: number
  readonly warned: number
  readonly falseAlarms: number
}

export const replay = (graph: MemoryGraph, records: ReadonlyArray<WorkflowRecord>): ReplayReport => {
  const kinds = new Map(graph.kinds.map((k) => [k.id, k]))
  const kindOf = kindNames(records)
  const cases: Array<ReplayCase> = []
  for (const r of records) {
    if (r.model === null || r.run.outcome !== "success") continue
    const steps = r.model.steps
    const needed = [...new Set(steps.filter((s) => s.origin !== "chosen").map((s) => stepIdOf(s.name)))]
    const chosen = new Set(steps.filter((s) => s.origin === "chosen").map((s) => stepIdOf(s.name)))
    // Word search proposes up to three kinds and a model confirms one at task
    // start; the replay assumes it confirms the right one when it is proposed.
    const proposed = pickKind(graph, r.task.prompt, r.subject, r.task.prompt)
    const own = kindIdOf(kindOf.get(r.id) ?? r.model.kind.name)
    const pick = proposed.find((h) => h.id === own) ?? proposed[0]
    const kind = pick === undefined ? undefined : kinds.get(pick.id)
    const handed = kind === undefined
      ? []
      : kind.route.filter((e) => e.required || needed.includes(e.step)).map((e) => e.step)
    const lessons = new Set(r.model.lessons.map((l) => l.detour))
    let warned = 0
    for (const i of lessons) {
      const d = r.detours[i]
      if (d === undefined) continue
      const arrives = graph.warnings.some((w) =>
        reaches(w.reach, r.subject) &&
        ((w.trigger !== null && causes(w.trigger, d) && storedFit(w.trigger, d)) ||
          (w.evidence.includes(r.id) && ((w.step !== null && handed.includes(w.step)) || (w.kind !== null && w.kind === kind?.id))))
      )
      if (arrives) warned++
    }
    const commandTriggers = graph.warnings.filter((w) => w.trigger?.on === "command" && reaches(w.reach, r.subject))
    const falseAlarms = r.commands.filter((c) =>
      c.ok && commandTriggers.some((w) => matchTrigger(w.trigger!, { tool: "Bash", command: c.command, file: undefined, text: undefined, output: undefined, failed: false }))
    ).length
    cases.push({
      record: r.id,
      kind: own,
      picked: kind?.id ?? null,
      needed,
      handed,
      extra: handed.filter((s) => !needed.includes(s)),
      unasked: handed.filter((s) => chosen.has(s) && !needed.includes(s)),
      missing: needed.filter((s) => !handed.includes(s)),
      detours: lessons.size,
      warned,
      falseAlarms
    })
  }
  const sum = (f: (c: ReplayCase) => number) => cases.reduce((n, c) => n + f(c), 0)
  return {
    cases,
    wrongKind: cases.filter((c) => c.picked !== c.kind).length,
    extra: sum((c) => c.extra.length),
    unasked: sum((c) => c.unasked.length),
    missing: sum((c) => c.missing.length),
    detours: sum((c) => c.detours),
    warned: sum((c) => c.warned),
    falseAlarms: sum((c) => c.falseAlarms)
  }
}

export interface Verdict {
  readonly commit: boolean
  readonly reason: string
}

/** Commit only if no task gets a step it didn't ask for, and the graph isn't worse than the one it replaces. */
export const judge = (candidate: ReplayReport, head: ReplayReport | undefined): Verdict => {
  if (candidate.unasked > 0) {
    const who = candidate.cases.filter((c) => c.unasked.length > 0).map((c) => `${c.record} (${c.unasked.join(", ")})`)
    return { commit: false, reason: `${candidate.unasked} steps handed to tasks that didn't ask for them: ${who.slice(0, 5).join("; ")}` }
  }
  const errors = (r: ReplayReport) => r.extra + r.missing
  if (head !== undefined && errors(candidate) > errors(head)) {
    return {
      commit: false,
      reason: `worse than the current graph: ${candidate.extra} extra and ${candidate.missing} missing steps, against ${head.extra} and ${head.missing}`
    }
  }
  if (head !== undefined && candidate.falseAlarms > head.falseAlarms) {
    return {
      commit: false,
      reason: `triggers would fire on ${candidate.falseAlarms} commands that worked, against ${head.falseAlarms} now`
    }
  }
  // Fewer detours warned is fine only when it comes with fewer false alarms: a trigger narrowed to fit.
  if (head !== undefined && candidate.warned < head.warned && candidate.falseAlarms === head.falseAlarms) {
    return { commit: false, reason: `warnings would reach ${candidate.warned} detours, against ${head.warned} now` }
  }
  return {
    commit: true,
    reason: `${candidate.cases.length} tasks: ${candidate.extra} extra and ${candidate.missing} missing steps, ` +
      `${candidate.wrongKind} matched to another kind; warnings reach ${candidate.warned} of ${candidate.detours} detours, ` +
      `with ${candidate.falseAlarms} false alarms`
  }
}
