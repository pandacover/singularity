/**
 * What memory's known mistakes did, and which of them to keep: the rules a
 * learning round applies to pitfalls without a model call (Learn.ts).
 *
 * The tally of a pitfall:
 * - happened: in a stored change, its trigger matched one of the change's
 *   calls (a failure that printed its message, its risky command), or the
 *   change is one it was learned from; in a session, the hook warned of it;
 * - warned: the hand-over log's `trigger` lines (HookTool.ts), once a session;
 * - made anyway: its `again` lines, its trigger matching again after the
 *   warning in the same session.
 *
 * A pitfall is let go when its mistake hasn't happened in the repo's last
 * `DORMANT_AFTER` stored changes (about a month here), or when it names a
 * package script or a file the repo doesn't have (another repo's lesson:
 * `yarn test:update` where nothing defines `test:update`). The agent's own instructions in the repo (CLAUDE.md,
 * AGENTS.md) go to the model, which leaves out pitfalls that repeat them.
 */
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { git } from "../local/Git.ts"
import { relativizer } from "../records/Extract.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { mainSegments, splitCommand } from "../records/Shell.ts"
import { eventOfCall, matchTrigger, type ToolEvent } from "../records/Triggers.ts"
import type { RunEvidence } from "./Evidence.ts"
import { callOf, PackageJson } from "./Finish.ts"
import { type CodeSource, pathExists, textAt } from "./Locate.ts"
import { type Pitfall, triggersOf, type WorkflowMemory } from "./Models.ts"

/** Stored changes of a repo after which a pitfall whose mistake hasn't happened again is let go. */
export const DORMANT_AFTER = 100

/** A stored change, as the tally reads it: when it started, and its calls as trigger events. */
export interface TalliedChange {
  readonly record: string
  readonly at: string
  readonly events: ReadonlyArray<ToolEvent>
}

/** A line of the hand-over log about a pitfall that fired. */
export const TriggerLine = Schema.Struct({
  at: Schema.String,
  session_id: Schema.String,
  moment: Schema.String,
  pitfalls: Schema.Array(Schema.String)
})
export type TriggerLine = typeof TriggerLine.Type

export interface PitfallTally {
  readonly pitfall: string
  /** Stored changes in which its mistake happened. */
  readonly happened: number
  /** When it last happened: a stored change it happened in, or a warning. */
  readonly last_happened: string | null
  readonly warned: number
  readonly last_warned: string | null
  /** Times its trigger matched again, in a session it had warned. */
  readonly anyway: number
  /** Stored changes of its repo since it last happened. */
  readonly changes_since: number | null
}

const latest = (xs: ReadonlyArray<string>): string | null => (xs.length === 0 ? null : xs.reduce((a, b) => (b > a ? b : a)))

/** Each pitfall's tally, from the repo's stored changes (any order) and the hand-over log. */
export const tallyPitfalls = (
  pitfalls: ReadonlyArray<Pitfall>,
  changes: ReadonlyArray<TalliedChange>,
  log: ReadonlyArray<TriggerLine>
): Array<PitfallTally> =>
  pitfalls.map((p) => {
    const triggers = triggersOf(p)
    const learnedFrom = new Set(p.evidence)
    const hit = changes.filter((c) => learnedFrom.has(c.record) || c.events.some((e) => triggers.some((t) => matchTrigger(t, e))))
    const fired = log.filter((l) => l.pitfalls.includes(p.id))
    const warnings = fired.filter((l) => l.moment === "trigger").map((l) => l.at)
    const again = fired.filter((l) => l.moment === "again").map((l) => l.at)
    const last = latest([...hit.map((c) => c.at), ...warnings, ...again])
    return {
      pitfall: p.id,
      happened: hit.length,
      last_happened: last,
      warned: warnings.length,
      last_warned: latest(warnings),
      anyway: again.length,
      changes_since: last === null ? null : changes.filter((c) => c.at > last).length
    }
  })

/** Whether a tally says a pitfall's mistake hasn't happened in a long time. */
export const isDormant = (t: PitfallTally): boolean => t.changes_since !== null && t.changes_since >= DORMANT_AFTER

/** The tally in words, for the model that revises memory and for people. */
export const describeTally = (t: PitfallTally): string => {
  const day = (iso: string | null) => (iso === null ? "never" : iso.slice(0, 10))
  return `- ${t.pitfall}: happened in ${t.happened} stored change${t.happened === 1 ? "" : "s"}, last ${day(t.last_happened)}` +
    `${t.changes_since === null ? "" : ` (${t.changes_since} changes ago)`}; warned ${t.warned} time${t.warned === 1 ? "" : "s"}` +
    `${t.anyway > 0 ? `, made anyway ${t.anyway} time${t.anyway === 1 ? "" : "s"} after the warning` : ""}`
}

/** The hand-over log's lines about pitfalls that fired: warned, or made again after the warning. */
export const readTriggerLog = Effect.fn("readTriggerLog")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(tenantDir, "workflows", "handovers.jsonl")
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  const out: Array<TriggerLine> = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("\"trigger\"") && !line.includes("\"again\"")) continue
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(TriggerLine))(line))
    if (decoded !== undefined && (decoded.moment === "trigger" || decoded.moment === "again")) out.push(decoded)
  }
  return out
})

/** Commands a pitfall's text names in backticks that a package manager runs: where a package script can be named. */
const namedCommands = (text: string): Array<string> =>
  [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((s) => /^(yarn|npm|pnpm|bun)\s/.test(s))

/** Files a pitfall's text names in backticks: a path with a directory and an extension. */
const namedFiles = (text: string): Array<string> =>
  [...text.matchAll(/`([\w@.-]+(?:\/[\w@.-]+)+\.\w+)`/g)].map((m) => m[1])

/** What a repo has, for telling another repo's pitfall: the scripts of every package.json in it, and the files git tracks. */
export interface RepoHas {
  readonly source: CodeSource
  /** Every tracked package.json's scripts; undefined when the repo has no package.json memory can read. */
  readonly scripts: Readonly<Record<string, string>> | undefined
  /** Tracked files, with forward slashes, in lower case. */
  readonly files: ReadonlyArray<string>
}

/** What the repo at `root` has (`RepoHas`): read once a round. */
export const repoHas = Effect.fn("repoHas")(function*(root: string) {
  const source: CodeSource = { kind: "tree", root }
  const tracked = (yield* git(root, ["ls-files"]).pipe(Effect.orElseSucceed(() => ""))).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
  const manifests = [...new Set(["package.json", ...tracked.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules/"))])]
  let scripts: Record<string, string> | undefined
  for (const file of manifests) {
    const text = yield* textAt(source, file)
    const pkg = text === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(PackageJson)(text))
    if (pkg !== undefined) scripts = { ...scripts, ...pkg.scripts }
  }
  return { source, scripts, files: tracked.map((f) => f.replace(/\\/g, "/").toLowerCase()) } satisfies RepoHas
})

/**
 * Why a pitfall belongs to another repo, or undefined: a package script it
 * names that no package.json here has (`yarn test:update` where nothing
 * defines `test:update`), or a file it names that is neither here as
 * written nor the end of a tracked file's path (`src/workflows/Learn.ts`,
 * the way CLAUDE.md writes paths from apps/cli, is here). What runs a file
 * or a tool (`node x.mjs`, `python fix.py`, `npx tsc`) isn't judged:
 * scratch scripts come and go. Nor is another package manager than the
 * repo's: a pitfall may say which one not to use.
 */
export const foreignTo = Effect.fn("foreignTo")(function*(p: Pitfall, has: RepoHas) {
  if (has.scripts !== undefined) {
    for (const line of namedCommands(p.text)) {
      for (const segment of mainSegments(splitCommand(line))) {
        const call = callOf(segment, has.scripts)
        if (call.kind === "script" && has.scripts[call.name] === undefined) return `it runs the script \`${call.name}\`, which no package.json in this repo has`
      }
    }
  }
  for (const f of namedFiles(p.text)) {
    const key = f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
    if (has.files.some((t) => t === key || t.endsWith(`/${key}`))) continue
    if (yield* pathExists(has.source, f)) continue
    return `it names \`${f}\`, which this repo doesn't have`
  }
  return undefined
})

/** A repo's stored changes for the tally: each with its calls when its run was read (Evidence.ts), else none. */
export const talliedChanges = (records: ReadonlyArray<WorkflowRecord>, runs: ReadonlyArray<RunEvidence>): Array<TalliedChange> => {
  const byRecord = new Map(runs.map((r) => [r.record, r]))
  return records.map((r) => {
    const run = byRecord.get(r.id)
    const relative = relativizer(run?.cwd)
    return { record: r.id, at: r.run.started_at ?? r.created_at, events: (run?.calls ?? []).map((c) => eventOfCall(c, relative)) }
  })
}

/**
 * Memory without the pitfalls to let go: those whose mistake hasn't happened
 * in a long time (`isDormant`), and those that belong to another repo
 * (`foreignTo`, when the repo can be read). Their ids leave the workflows that
 * listed them; why each went is said.
 */
export const tidyPitfalls = Effect.fn("tidyPitfalls")(function*(
  memory: WorkflowMemory,
  tally: ReadonlyArray<PitfallTally>,
  has: RepoHas | undefined
) {
  const byId = new Map(tally.map((t) => [t.pitfall, t]))
  const gone = new Map<string, string>()
  for (const p of memory.pitfalls) {
    const t = byId.get(p.id)
    if (t !== undefined && isDormant(t)) {
      gone.set(p.id, `its mistake hasn't happened in the last ${t.changes_since} stored changes`)
      continue
    }
    const foreign = has === undefined ? undefined : yield* foreignTo(p, has).pipe(Effect.orElseSucceed(() => undefined))
    if (foreign !== undefined) gone.set(p.id, foreign)
  }
  if (gone.size === 0) return { memory, dropped: [] as ReadonlyArray<string> }
  return {
    memory: {
      ...memory,
      pitfalls: memory.pitfalls.filter((p) => !gone.has(p.id)),
      workflows: memory.workflows.map((w) => (w.pitfalls.some((id) => gone.has(id)) ? { ...w, pitfalls: w.pitfalls.filter((id) => !gone.has(id)) } : w))
    },
    dropped: [...gone].map(([id, why]) => `pitfall ${id} let go: ${why}`) as ReadonlyArray<string>
  }
})

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"]
const MAX_INSTRUCTIONS = 16_000

/**
 * The agent's own instructions in a repo, as a section of the prompt that
 * revises memory: what it reads in every session, which a pitfall needn't
 * repeat. Empty when the repo has none.
 */
export const instructionsSection = Effect.fn("instructionsSection")(function*(repo: string | undefined) {
  if (repo === undefined) return ""
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parts: Array<string> = []
  for (const name of INSTRUCTION_FILES) {
    const text = yield* fs.readFileString(path.join(repo, name)).pipe(Effect.orElseSucceed(() => ""))
    if (Predicate.isString(text) && text.trim() !== "") parts.push(`### ${name}`, "", text.replace(/\r\n/g, "\n").trim(), "")
  }
  if (parts.length === 0) return ""
  const body = parts.join("\n")
  return [
    "## What the agent's own instructions in this repository say",
    "",
    "The agent reads these in every session here. A pitfall that says the same is no pitfall: leave it out, and take out such pitfalls memory has.",
    "",
    body.length > MAX_INSTRUCTIONS ? `${body.slice(0, MAX_INSTRUCTIONS)}\n…` : body
  ].join("\n")
})
