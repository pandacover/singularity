/**
 * The model's reading of a record: the task's kind, the steps the run took
 * (each marked asked for, needed or chosen), landmarks in the codebase, and
 * what each detour teaches, with an exact trigger where one can be written.
 *
 * The model sees the record, the diff and a condensed log, plus the kinds and
 * steps already named in this tenant, so the same step gets the same name
 * across runs. Then every claim is checked before it's kept:
 *
 * - a step's files must be files the run changed, and its check a command
 *   the run ran successfully;
 * - a landmark's or false lead's file must exist at the run's base commit (or
 *   be added by the run), and each of its anchors must be in that file (or
 *   in the lines the run added to it);
 * - a trigger must be specific, match the call that failed (for edits: an
 *   edit at or before the failure) and not match the call that fixed it.
 *
 * Claims that fail are dropped and listed in the record, with the reason.
 */
import { DateTime, Effect, FileSystem, Path, Schema } from "effect"
import { fileAt, git, hasCommit } from "../local/Git.ts"
import type { ToolCall, Trace } from "../traces/index.ts"
import { condenseTrace, EDIT_TOOLS, parseSession, SHELL_TOOLS } from "../traces/index.ts"
import { callStructured } from "../eval/Llm.ts"
import { relativizer } from "./Extract.ts"
import type { ModelPart, WorkflowRecord } from "./Models.ts"
import { FalseLead, Landmark, StepOrigin } from "./Models.ts"
import { RecordStore } from "./RecordStore.ts"
import { classifyKey, commandKeys } from "./Shell.ts"
import { describeTrigger, eventOfCall, matchTrigger, Trigger, triggerProblem } from "./Triggers.ts"

/** What the model answers. */
export const Reading = Schema.Struct({
  kind: Schema.Struct({ name: Schema.String, description: Schema.String }),
  asked: Schema.Array(Schema.String),
  ruled_out: Schema.Array(Schema.String),
  values: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  steps: Schema.Array(Schema.Struct({
    name: Schema.String,
    purpose: Schema.String,
    origin: StepOrigin,
    files: Schema.Array(Schema.String),
    check: Schema.NullOr(Schema.String),
    landmarks: Schema.Array(Landmark)
  })),
  lessons: Schema.Array(Schema.Struct({
    detour: Schema.Int,
    lesson: Schema.String,
    step: Schema.NullOr(Schema.String),
    trigger: Schema.NullOr(Trigger)
  })),
  false_leads: Schema.Array(FalseLead),
  tests: Schema.Array(Schema.Struct({ file: Schema.String, covers: Schema.String }))
})
export type Reading = typeof Reading.Type

export const ANNOTATE_PROMPT = `You read one recorded run of a coding agent and describe how its task got done, so that future tasks in the same repository can be helped: not only repeats of this task, but other tasks that share some of its steps.

You get the task, the files the run changed with the diff, its checks, its detours (a call that failed, the later call that fixed it, and what that cost), and a condensed log. Everything you return is checked against the code and the log afterwards, and claims that don't hold are dropped, so copy names, paths and strings exactly.

## Kind

Name the kind of task in general words, without this task's own values: "change an action's keyboard shortcut", "add a toggle setting to the app". If the task is one of the existing kinds listed, use that name exactly. Description: one sentence.

## What the task asked

- asked: each thing the task asks for, in short items.
- ruled_out: anything it says not to do or not to change.
- values: what belongs to this task only: the feature's name, the old and new key, a label, a file the task names. Future tasks will have different ones.

## Steps

The steps the run took, in order, at the level of a developer's checklist ("add the key code to the key table", "list the shortcut in the help dialog", "update the test snapshots"), not tool calls. Steps change something or check something; looking around (searching, reading files) is not a step. If a step is one of the existing steps listed, use its name exactly.

- name: general words, with none of this task's values.
- purpose: one sentence: what the step achieves and why it's needed.
- origin: "asked" if the task asked for it; "needed" if the change required it though the task didn't say so (a second place to register something, updating snapshots, running the checks); "chosen" if the agent did it on its own and the task didn't need it (a test nobody asked for, a refactor). Adding something new is "asked" only if the task asks for that new thing: "update everything that shows or tests X" asks to update what exists, not to write a new test.
- files: the changed files this step edited, exactly as listed under "Files changed". Empty for steps that edit nothing.
- check: the command from the log that verified this step, copied exactly, if one did; otherwise null.
- landmarks: facts about the codebase that another kind of task could use, each with the file it is in (a repository path) and anchors: exact strings from that file as it was before the run, such as identifiers or keys, that prove the fact. For example "keyboard shortcuts are also spelled out, separately, in the help dialog". Not where this task's own edit went, and no anchors from this task's own change: a fact earns its place only if other tasks need it too. At most two per step; often none.

## Lessons

For each detour that teaches something a future run should know: its number, the lesson in general words (what went wrong, why, and what to do instead), the name of the step it happened in, and a trigger if one can be written. Skip detours that teach nothing.

A trigger says with exact strings when the mistake is being made, so a hook can warn the agent at that moment:

- on "command": a shell command containing every string in "all" and none of the strings in "none".
- on "edit": an edit to a file whose path ends with "file" (any file if null), writing text that contains every string in "all" and none in "none".
- on "error": a failed call whose output contains every string in "all".

Strings are plain text, not regular expressions. The trigger must match the call that failed (for "edit": the edit that caused the failure) and must not match the call that fixed it. Copy short strings from the log, specific enough not to fire on harmless calls. "file" is only for "edit" triggers; use null otherwise.

The earlier a warning arrives, the more it saves. When a detour cost many turns, look for the edit or command that caused it, and write the trigger for that moment rather than for the error at the end: for instance an edit that writes a test without the setup the test needs.

## False leads and tests

- false_leads: searches or files that looked relevant and weren't (a match for a different feature), with the file and an anchor string from it.
- tests: the test files that cover this change, and what each covers.

Write plainly. Leave a list empty rather than guess.`

/** Names already used in this tenant, so the same kind or step keeps its name. */
export interface Vocabulary {
  readonly kinds: ReadonlyArray<{ readonly name: string; readonly description: string }>
  readonly steps: ReadonlyArray<{ readonly name: string; readonly purpose: string }>
}

/** Kinds and steps named in `records`, most used first. */
export const vocabularyOf = (records: ReadonlyArray<WorkflowRecord>, maxKinds = 20, maxSteps = 60): Vocabulary => {
  const kinds = new Map<string, { name: string; description: string; n: number }>()
  const steps = new Map<string, { name: string; purpose: string; n: number }>()
  for (const r of records) {
    if (r.model === null) continue
    const k = kinds.get(r.model.kind.name) ?? { ...r.model.kind, n: 0 }
    k.n++
    kinds.set(k.name, k)
    for (const s of r.model.steps) {
      const e = steps.get(s.name) ?? { name: s.name, purpose: s.purpose, n: 0 }
      e.n++
      steps.set(s.name, e)
    }
  }
  const top = <A extends { n: number; name: string }>(m: Map<string, A>, max: number) =>
    [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, max)
  return {
    kinds: top(kinds, maxKinds).map(({ description, name }) => ({ name, description })),
    steps: top(steps, maxSteps).map(({ name, purpose }) => ({ name, purpose }))
  }
}

const MAX_DIFF_CHARS = 14_000
const MAX_LOG_CHARS = 30_000

const k = (n: number) => `${Math.round(n / 1000)}k`

/** Changed source files only: snapshot files are listed, not shown. */
const sourceDiff = (diff: string): string =>
  diff.replace(/\r\n?/g, "\n").split(/^(?=diff --git )/m)
    .filter((c) => c.startsWith("diff --git ") && !/\.snap\b|\/__snapshots__\//.test(c.split("\n", 1)[0]))
    .join("")

export const readingPrompt = (record: WorkflowRecord, trace: Trace, diff: string, vocabulary: Vocabulary): string => {
  let source = sourceDiff(diff)
  if (source.length > MAX_DIFF_CHARS) source = source.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)\n"
  const changed = record.files.filter((f) => !f.snapshot)
  const snapshots = record.files.filter((f) => f.snapshot)
  const lines = [`Repository: ${record.subject}`, ""]
  lines.push("## Existing kinds of task", "")
  if (vocabulary.kinds.length === 0) lines.push("(none yet)")
  for (const kind of vocabulary.kinds) lines.push(`- ${kind.name}: ${kind.description}`)
  lines.push("", "## Existing steps", "")
  if (vocabulary.steps.length === 0) lines.push("(none yet)")
  for (const s of vocabulary.steps) lines.push(`- ${s.name}: ${s.purpose}`)
  lines.push("", "## The run", "", "Task given to the agent:", "", record.task.prompt)
  for (const f of record.task.followups) lines.push("", "Then:", "", f)
  const outcome = record.run.outcome === "success" ? "it succeeded" : "it failed"
  lines.push("", `Outcome: ${outcome}, after ${record.run.turns} turns and ${record.run.tool_calls} tool calls.`)
  if (record.checks.length > 0) {
    lines.push("Checks run after it finished: " + record.checks.map((c) => `\`${c.command}\` ${c.ok ? "passed" : "failed"}`).join("; "))
  }
  lines.push("", "### Files changed", "")
  for (const f of changed) lines.push(`- ${f.path} (${f.status}, +${f.added} -${f.removed})`)
  if (changed.length === 0) lines.push("(none)")
  if (snapshots.length > 0) lines.push("", `Snapshot files regenerated (not shown): ${snapshots.map((f) => f.path).join(", ")}`)
  lines.push("", "```diff", source.replace(/\n+$/, ""), "```", "", "### Detours", "")
  if (record.detours.length === 0) lines.push("(none)")
  record.detours.forEach((d, i) => {
    const failed = d.failed.command ?? `${d.failed.tool} ${d.failed.file ?? ""}`
    const fixed = d.fixed.command ?? `${d.fixed.tool} ${d.fixed.file ?? ""}`
    lines.push(`Detour ${i}: ${d.kind}, ${d.cost.turns} turns and ${k(d.cost.tokens)} tokens until fixed${d.failures > 1 ? `, failing ${d.failures} times` : ""}.`)
    lines.push(`- failed: \`${failed}\``)
    lines.push(`- it said: ${d.symptom.replace(/\n/g, " | ")}`)
    lines.push(`- fixed by: \`${fixed}\``)
    if (d.removed.length + d.added.length > 0) {
      lines.push(`- the command lost ${d.removed.map((w) => `\`${w}\``).join(" ") || "nothing"} and gained ${d.added.map((w) => `\`${w}\``).join(" ") || "nothing"}`)
    }
    if (d.files_edited.length > 0) lines.push(`- files edited in between: ${d.files_edited.join(", ")}`)
  })
  lines.push("", "### What it did (condensed log: the agent's messages, then each tool call and its result)", "")
  lines.push(condenseTrace(trace, { maxChars: MAX_LOG_CHARS }))
  return lines.join("\n")
}

/** Everything the checks need to know about the run. */
export interface Evidence {
  readonly record: WorkflowRecord
  readonly trace: Trace
  readonly diff: string
  /** A file's text at the run's base commit; undefined if it didn't exist (or there's no repo to ask). */
  readonly fileAtBase: (path: string) => string | undefined
}

/** Lines the diff adds, per file. */
export const addedLines = (diff: string): Map<string, string> => {
  const out = new Map<string, string>()
  for (const chunk of diff.replace(/\r\n?/g, "\n").split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue
    const header = chunk.split("\n", 1)[0]
    const at = header.lastIndexOf(" b/")
    const path = at >= 0 ? header.slice(at + 3) : header
    const added = chunk.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))
    out.set(path, added.join("\n"))
  }
  return out
}

const slash = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "")

/** Keep what holds, drop what doesn't, and say why. */
export const verifyReading = (reading: Reading, evidence: Evidence): { readonly part: Omit<ModelPart, "model" | "created_at" | "cost_usd">; readonly dropped: Array<string> } => {
  const { record, trace } = evidence
  const dropped: Array<string> = []
  const changed = new Set(record.files.map((f) => f.path))
  const added = addedLines(evidence.diff)
  const fileExists = (p: string) => changed.has(p) || evidence.fileAtBase(p) !== undefined
  // An anchor must be code that was there before the run, so later tasks find
  // it too; only a file the run created can be proven by the lines it added.
  const contains = (p: string, anchor: string) => {
    const base = evidence.fileAtBase(p)
    return base !== undefined ? base.includes(anchor) : (added.get(p) ?? "").includes(anchor)
  }
  const okCommands = record.commands.filter((c) => c.ok)
  /**
   * A check worked if a call ran it and didn't fail the way that check fails:
   * `yarn tsc && yarn test --bad-flag` failed, but not with type errors, so
   * the typecheck passed.
   */
  const keyWorked = (key: string): boolean =>
    record.commands.some((c) => {
      if (!c.keys.includes(key)) return false
      if (c.ok) return true
      const error = c.error ?? ""
      const cls = classifyKey(key)
      if (cls === "typecheck") return !/error TS\d+/.test(error)
      if (cls === "test") return !/\bFAIL\b|failed|AssertionError|×|✗|mismatched/.test(error)
      return false
    })

  /** Why a file-and-anchors claim fails, or undefined if it holds. */
  const anchored = (file: string | null, anchors: ReadonlyArray<string>): string | undefined => {
    if (file === null) return anchors.length > 0 ? "anchors without a file" : undefined
    if (!fileExists(file)) return `${file} doesn't exist at the base commit`
    if (anchors.length === 0) return "no anchors to check it by"
    const short = anchors.find((a) => a.trim().length < 3)
    if (short !== undefined) return `anchor ${JSON.stringify(short)} is too short to prove anything`
    const missing = anchors.find((a) => !contains(file, a))
    return missing === undefined ? undefined : `${JSON.stringify(missing)} isn't in ${file}`
  }

  const valueTexts = reading.values.map((v) => v.value.trim()).filter((v) => v.length >= 2)
  const steps = reading.steps.map((s) => {
    const files = s.files.map(slash).filter((f) => {
      if (changed.has(f)) return true
      dropped.push(`step "${s.name}": file ${f} wasn't changed by the run`)
      return false
    })
    let check = s.check
    if (check !== null) {
      const keys = commandKeys(check)
      const ran = okCommands.some((c) => c.command.includes(check!.trim()) || (keys.length > 0 && keys.every((key) => c.keys.includes(key)))) ||
        record.checks.some((c) => c.ok && c.command.trim() === check!.trim()) ||
        (keys.length > 0 && keys.every(keyWorked))
      if (!ran) {
        dropped.push(`step "${s.name}": check \`${check}\` isn't a command that worked in the run`)
        check = null
      }
    }
    const landmarks = s.landmarks.map((l) => ({ ...l, file: slash(l.file) })).filter((l) => {
      const problem = anchored(l.file, l.anchors)
      if (problem !== undefined) dropped.push(`landmark "${l.fact}": ${problem}`)
      return problem === undefined
    })
    const leaked = valueTexts.find((v) => s.name.toLowerCase().includes(v.toLowerCase()))
    if (leaked !== undefined) dropped.push(`step "${s.name}" names this task's own value "${leaked}" (kept; rename it in the graph)`)
    return { ...s, files, check, landmarks }
  })

  const main = trace.toolCalls.filter((c) => c.agentId === undefined)
  const relative = relativizer(trace.cwd)
  const event = (c: ToolCall | undefined) => (c === undefined ? undefined : eventOfCall(c, relative))
  const stepNames = new Set(steps.map((s) => s.name))
  const lessons = reading.lessons.flatMap((l) => {
    const d = record.detours[l.detour]
    if (d === undefined) {
      dropped.push(`lesson "${l.lesson}": there is no detour ${l.detour}`)
      return []
    }
    let trigger = l.trigger
    if (trigger !== null) {
      const problem = triggerProblem(trigger) ?? triggerMismatch(trigger, main, d.failed.call, d.fixed.call, event)
      if (problem !== undefined) {
        dropped.push(`trigger (${describeTrigger(trigger)}) for "${l.lesson}": ${problem}`)
        trigger = null
      }
    }
    return [{ ...l, step: l.step !== null && stepNames.has(l.step) ? l.step : null, trigger }]
  })

  const falseLeads = reading.false_leads.map((f) => ({ ...f, file: f.file === null ? null : slash(f.file) })).filter((f) => {
    const problem = anchored(f.file, f.anchors)
    if (problem !== undefined) dropped.push(`false lead "${f.what}": ${problem}`)
    return problem === undefined
  })
  const tests = reading.tests.map((t) => ({ ...t, file: slash(t.file) })).filter((t) => {
    if (fileExists(t.file)) return true
    dropped.push(`test file ${t.file} doesn't exist`)
    return false
  })

  return {
    part: {
      kind: reading.kind,
      asked: reading.asked,
      ruled_out: reading.ruled_out,
      values: reading.values,
      steps,
      lessons,
      false_leads: falseLeads,
      tests,
      dropped
    },
    dropped
  }
}

/**
 * Why a trigger doesn't single out the mistake, or undefined if it does. It
 * must match the call that failed (an edit trigger: some edit at or before
 * it) and not the call that fixed it.
 */
export const triggerMismatch = (
  trigger: Trigger,
  calls: ReadonlyArray<ToolCall>,
  failedAt: number,
  fixedAt: number,
  event: (c: ToolCall | undefined) => ReturnType<typeof eventOfCall> | undefined
): string | undefined => {
  const failed = event(calls[failedAt])
  const fixed = event(calls[fixedAt])
  if (failed === undefined || fixed === undefined) return "the detour's calls aren't in the log"
  if (trigger.on === "edit") {
    const edits = calls.slice(0, failedAt + 1).filter((c) => EDIT_TOOLS.has(c.name) || SHELL_TOOLS.has(c.name))
    if (!edits.some((c) => matchTrigger(trigger, event(c)!))) return "no edit before the failure matches it"
  } else if (!matchTrigger(trigger, failed)) {
    return "it doesn't match the call that failed"
  }
  if (matchTrigger(trigger, fixed)) return "it also matches the call that fixed it"
  return undefined
}

/** The run's diff: the eval run's diff.patch, or the session's commits. */
export const recordDiff = Effect.fn("recordDiff")(function*(record: WorkflowRecord, repo: string | undefined) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (record.run.run_dir !== null && record.run.run_id !== null) {
    const file = path.join(record.run.run_dir, "runs", record.run.run_id, "diff.patch")
    if (yield* fs.exists(file)) return (yield* fs.readFileString(file)).replace(/\r\n?/g, "\n")
  }
  if (repo !== undefined && record.run.base_commit !== null && record.run.head_commit !== null) {
    return yield* git(repo, ["diff", "--binary", record.run.base_commit, record.run.head_commit]).pipe(
      Effect.map((s) => s.replace(/\r\n?/g, "\n")),
      Effect.orElseSucceed(() => "")
    )
  }
  return ""
})

/** A working tree that has the record's base commit: where it ran, or another clone of its subject. */
export const repoWithBase = Effect.fn("repoWithBase")(function*(record: WorkflowRecord, subjectPaths: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const base = record.run.base_commit
  if (base === null) return undefined
  for (const dir of [record.run.repo, ...subjectPaths]) {
    if (dir === null || !(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) continue
    if (yield* hasCommit(dir, base)) return dir
  }
  return undefined
})

export interface ReaderConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
  readonly effort: string | undefined
}

export const DEFAULT_READER_MODEL = "sonnet"
export const DEFAULT_READER_EFFORT = "medium"

/** Read one record with the model, check the reading, and store what holds. */
export const annotateRecord = Effect.fn("annotateRecord")(function*(
  config: ReaderConfig,
  id: string,
  options: { readonly replace?: boolean; readonly vocabulary?: Vocabulary } = {}
) {
  const store = yield* RecordStore
  const record = yield* store.get(id)
  const subject = (yield* store.subjects()).find((s) => s.id === record.subject)
  const repo = yield* repoWithBase(record, subject?.paths ?? [])
  const trace = yield* parseSession(record.run.log)
  const diff = yield* recordDiff(record, repo)
  const vocabulary = options.vocabulary ?? vocabularyOf(yield* store.find({ subject: record.subject, annotated: true }))
  const answer = yield* callStructured({
    claude: config.claude,
    system: ANNOTATE_PROMPT,
    prompt: readingPrompt(record, trace, diff, vocabulary),
    schema: Reading,
    model: config.model,
    effort: config.effort,
    cwd: config.cwd,
    maxBudgetUsd: 1
  })
  // Fetch every file the reading cites, once.
  const cited = new Set<string>()
  for (const s of answer.value.steps) for (const l of s.landmarks) cited.add(slash(l.file))
  for (const f of answer.value.false_leads) if (f.file !== null) cited.add(slash(f.file))
  for (const t of answer.value.tests) cited.add(slash(t.file))
  const texts = new Map<string, string | undefined>()
  for (const file of cited) {
    texts.set(file, repo === undefined || record.run.base_commit === null ? undefined : yield* fileAt(repo, record.run.base_commit, file))
  }
  const { part } = verifyReading(answer.value, { record, trace, diff, fileAtBase: (p) => texts.get(p) })
  const reading: ModelPart = {
    model: config.model,
    created_at: DateTime.formatIso(yield* DateTime.now),
    cost_usd: answer.costUsd,
    ...part,
    dropped: repo === undefined ? [...part.dropped, "no repo with the base commit: landmarks couldn't be checked"] : part.dropped
  }
  return yield* store.annotate(id, reading, { replace: options.replace ?? false })
})

/** Eval setups whose runs show what agents do on their own come first: memory steers the others. */
const SETUP_ORDER = ["no-memory", "saved-scripts", "saved-scripts-top2", "saved-scripts-warnings", "graph"]

/**
 * Successful records without the model's reading, at most `perTask` per eval
 * task counting those already read (sessions have no task, so all of them).
 * Runs without memory first, then by time.
 */
export const unread = (records: ReadonlyArray<WorkflowRecord>, perTask: number | undefined): Array<WorkflowRecord> => {
  const seen = new Map<string, number>()
  for (const r of records) if (r.model !== null && r.run.task_id !== null) seen.set(r.run.task_id, (seen.get(r.run.task_id) ?? 0) + 1)
  const rank = (r: WorkflowRecord) => {
    const i = SETUP_ORDER.indexOf(r.run.setup ?? "no-memory")
    return i < 0 ? SETUP_ORDER.length : i
  }
  const ordered = [...records].sort((a, b) => rank(a) - rank(b))
  const out: Array<WorkflowRecord> = []
  for (const r of ordered) {
    if (r.model !== null || r.run.outcome !== "success") continue
    const task = r.run.task_id
    if (task !== null && perTask !== undefined) {
      const n = seen.get(task) ?? 0
      if (n >= perTask) continue
      seen.set(task, n + 1)
    }
    out.push(r)
  }
  return out
}

