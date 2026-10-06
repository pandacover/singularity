/**
 * The finish: after its last edit, a run checks its work. Runs handed the
 * workflows' checks one by one (and a workflow of "run the tests, run the
 * typecheck, review the snapshots") spent a turn on each, then another
 * reading snapshot diffs to see whether the changes were expected. Runs
 * handed the list of snapshot files a past run regenerated didn't read them.
 *
 * So memory folds the finish into one command: the checks of the workflows a
 * task gets, in one line, the formatters first and the tests last, and says
 * which snapshot files earlier runs of those workflows regenerated. Both are
 * learned from runs: the checks by the inducing model from the commands runs
 * passed, the snapshot files mechanically from their diffs (every run a
 * workflow was learned from regenerated them). No model call at task start.
 *
 * A finishing workflow (one with no step at a place, leading only to the
 * end, with checks) is that finish: it isn't handed over as steps, its checks
 * and pitfalls go into the one command's section.
 */
import { classifyKey, commandKeys } from "../records/Shell.ts"
import type { RunEvidence } from "./Evidence.ts"
import { END, type Workflow, type WorkflowMemory } from "./Models.ts"

/** Memory that keeps what its workflows' checks rewrite hands over the finish as one command. */
export const hasFinish = (m: WorkflowMemory): boolean => m.workflows.some((w) => w.snapshots !== undefined)

/** A workflow that only checks: no step at a place, edges only to the end, and commands to run. */
export const isFinishing = (m: WorkflowMemory, w: Workflow): boolean =>
  w.checks.length > 0 &&
  w.steps.every((s) => s.place === null) &&
  m.edges.some((e) => e.from === w.id) &&
  m.edges.filter((e) => e.from === w.id).every((e) => e.to === END)

/** Formatters and linters first (they change files), then the typecheck, builds, tests, the rest. */
const ORDER = ["lint", "typecheck", "build", "test", "other", "install"] as const

const rank = (command: string): number => {
  const kinds = commandKeys(command).map(classifyKey)
  const ranks = kinds.map((k) => ORDER.indexOf(k)).filter((i) => i >= 0)
  return ranks.length === 0 ? ORDER.indexOf("other") : Math.min(...ranks)
}

export interface Finish {
  /** One line that runs every check, `;`-separated so each runs whatever the one before it did, in Bash and PowerShell alike. */
  readonly command: string
  /** Snapshot files earlier runs of these workflows regenerated. */
  readonly snapshots: ReadonlyArray<string>
  /** The finishing workflows folded into it. */
  readonly folded: ReadonlyArray<string>
}

/** The finish of a task given these workflows, in the order given; undefined when none of them has a check. */
export const finishOf = (m: WorkflowMemory, chosen: ReadonlyArray<Workflow>): Finish | undefined => {
  const seen = new Set<string>()
  const checks: Array<string> = []
  for (const w of chosen) {
    for (const c of w.checks) {
      const line = c.trim().replace(/\s+/g, " ")
      if (line === "" || seen.has(line)) continue
      seen.add(line)
      checks.push(line)
    }
  }
  if (checks.length === 0) return undefined
  const ordered = checks.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c)
  const snapshots = [...new Set(chosen.flatMap((w) => w.snapshots ?? []))].sort()
  // With snapshots to expect, the same call lists what changed.
  const command = [...ordered, ...(snapshots.length > 0 ? ["git status --short"] : [])].join("; ")
  return { command, snapshots, folded: chosen.filter((w) => isFinishing(m, w)).map((w) => w.id) }
}

/**
 * What each workflow's checks rewrite: the snapshot files that every run it
 * was learned from (at least two of `runs`) regenerated. Every workflow gets
 * the key, empty when the runs don't agree or are too few.
 */
export const withSnapshots = (m: WorkflowMemory, runs: ReadonlyArray<RunEvidence>): WorkflowMemory => {
  const byRecord = new Map(runs.map((r) => [r.record, r]))
  return {
    ...m,
    workflows: m.workflows.map((w) => {
      const own = w.evidence.flatMap((id) => byRecord.get(id) ?? [])
      if (own.length < 2) return { ...w, snapshots: [] }
      const [first, ...rest] = own.map((r) => new Set(r.snapshots))
      const always = [...first].filter((s) => rest.every((x) => x.has(s))).sort()
      return { ...w, snapshots: always }
    })
  }
}
