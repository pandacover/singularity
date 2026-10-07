/**
 * The hand-over at task start: the route for this task (its steps, where each
 * happens, how each is checked) and the warnings on those steps, and nothing
 * else: no records, counts or other kinds of task.
 *
 * Word search over the task kinds proposes up to three; a model reads the
 * task and their routes with their conditions, picks the kind and decides
 * step by step what applies (one call, a cent or so). Without a model, the
 * best-matching kind's required steps are handed over, if the match is clear.
 *
 * Where a step happens is checked against the repo as it is now: a landmark
 * whose anchors are gone isn't handed over. Files are listed only when most
 * runs of the step edited them; the rest belong to one task's feature.
 *
 * The places themselves come along as they are now (Excerpts.ts): the lines
 * around each spot where the kind's runs made a step's edits, read from the
 * working tree, so the agent doesn't have to read for them. Memory holds only
 * which lines to look for; a spot the code no longer has shows nothing. A
 * file whose lines are shown for a step isn't listed with the step as well.
 *
 * The warnings with exact triggers that the subject may get are kept in the
 * session's state, so hooks can match them on every tool call without asking.
 */
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { callStructured } from "../eval/Llm.ts"
import { identifyRepo } from "../local/Git.ts"
import type { Kind, Step, Warning } from "../memory/Models.ts"
import { MemoryStore } from "../memory/MemoryStore.ts"
import { rankKinds } from "../memory/Replay.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { type Usage, usageToJson } from "../traces/index.ts"
import { type ExampleSource, type Excerpts, makeExcerpts, type SpotSource } from "./Excerpts.ts"
import { logHandover, type SessionState, writeSession } from "./Session.ts"
import { repoTools } from "./Tools.ts"

/**
 * The most a hand-over may hold. Claude Code cuts a hook's text off at 10,000
 * characters and hands the agent a file path and the first 2,000 instead.
 */
export const MAX_HANDOVER_CHARS = 9800
/** Without a model to confirm, a kind is taken only on a clearer match. */
export const MIN_COVERAGE_ALONE = 0.4
/** A file is "usually edited" by a step when at least this share of its runs edited it (and at least two). */
export const STABLE_FILE_SHARE = 0.6
const MAX_LANDMARKS = 2
const MAX_WARNINGS = 6

export const SELECT_PROMPT = `You match a coding task to procedures learned from earlier tasks in the same repository, and decide which of their steps the task needs.

You get the task and up to three kinds of task seen before, each with its steps in their usual order. A step is "usual" when every earlier task of that kind took it, or "optional" with the condition under which a task takes it.

First pick the kind this task is: the one whose procedure fits what the task asks. If none fits, answer null and no steps.

Then decide, for every step of that kind, whether this task needs it, with a reason of a few words:

- A step applies when the task needs it, even if the task doesn't name it: a second place that must be updated, snapshot updates, the final checks.
- It doesn't apply when the task doesn't involve what it does, or says not to do it, or when its condition clearly doesn't hold. A usual step can still not apply, when the task rules it out.
- If the task can't tell you whether a condition holds (it depends on what the code already contains), the step applies: the agent can check.
- A step whose condition is "only when the task asks for it" applies only if the task asks for that.`

export const SelectionAnswer = Schema.Struct({
  kind: Schema.NullOr(Schema.String),
  why: Schema.String,
  steps: Schema.Array(Schema.Struct({ id: Schema.String, why: Schema.String, applies: Schema.Boolean }))
})
export type SelectionAnswer = typeof SelectionAnswer.Type

/** Kinds a task may be, by word search, best first. */
export const proposeKinds = (kinds: ReadonlyArray<Kind>, prompt: string, max = 3) => {
  const byId = new Map(kinds.map((k) => [k.id, k]))
  return rankKinds(kinds, prompt, max).map((h) => ({ kind: byId.get(h.id)!, coverage: h.coverage }))
}

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ")

export const selectionPrompt = (prompt: string, kinds: ReadonlyArray<Kind>, steps: ReadonlyMap<string, Step>): string => {
  const lines = ["## Task", "", prompt.trim(), "", "## Kinds of task seen before", ""]
  for (const k of kinds) {
    lines.push(`### ${k.id}: ${k.name}`, "", k.description, "", "Earlier tasks of this kind:")
    for (const e of k.examples.slice(0, 3)) lines.push(`- ${oneLine(e).slice(0, 240)}`)
    lines.push("", "Steps:")
    for (const e of k.route) {
      const s = steps.get(e.step)
      const when = e.required ? "usual" : `optional: ${e.condition ?? "when the task needs it"}`
      lines.push(`- ${e.step}: ${s?.name ?? e.step}. ${s?.purpose ?? ""} [${when}]`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

export interface SelectorConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
}

/** Without a model, optional steps that at least this share of the kind's runs needed are handed over too. */
export const TYPICAL_SHARE = 0.6

/**
 * The steps handed over: the ones the model said apply. A step it didn't
 * answer for is handed over if required; with no answer at all, also if most
 * runs of the kind needed it.
 */
export const chosenSteps = (kind: Kind, answer: SelectionAnswer | undefined): Array<string> => {
  const said = new Map((answer?.steps ?? []).map((s) => [s.id, s.applies]))
  const typical = (e: Kind["route"][number]) =>
    answer === undefined && (e.asked + e.needed) / Math.max(1, kind.evidence.length) >= TYPICAL_SHARE
  return kind.route.filter((e) => said.get(e.step) ?? (e.required || typical(e))).map((e) => e.step)
}

/** What a step looks like in the repo now: its landmarks whose anchors are still there, its usual files and checks. */
export interface LivePlace {
  readonly landmarks: ReadonlyArray<{ readonly fact: string; readonly file: string }>
  readonly files: ReadonlyArray<string>
  readonly checks: ReadonlyArray<string>
}

export const renderHandover = (
  kind: Kind,
  steps: ReadonlyArray<Step>,
  places: ReadonlyMap<string, LivePlace>,
  warnings: ReadonlyArray<Warning>
): string => {
  const lines = [
    "# Notes from earlier tasks in this repository",
    "",
    `Earlier tasks like this one (${kind.name}) went through the steps below, in this order. ` +
    "Names, keys and values differ between tasks, so check details in the code.",
    ""
  ]
  const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"
  steps.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.name}**: ${s.purpose}`)
    const p = places.get(s.id)
    for (const l of p?.landmarks ?? []) lines.push(`   - ${l.fact} (${code(l.file)})`)
    if (p !== undefined && p.files.length > 0) lines.push(`   - Usually edits ${p.files.map(code).join(", ")}`)
    if (p !== undefined && p.checks.length > 0) lines.push(`   - Checked with ${p.checks.map(code).join(" or ")}`)
    for (const w of warnings.filter((w) => w.step === s.id)) lines.push(`   - Watch out: ${w.lesson}`)
  })
  const general = warnings.filter((w) => w.step === null)
  if (general.length > 0) {
    lines.push("", "Also:")
    for (const w of general) lines.push(`- ${w.lesson}`)
  }
  return lines.join("\n") + "\n"
}

export interface TaskStartInput {
  readonly sessionId: string
  readonly prompt: string
  readonly cwd: string
}

export interface TaskStartResult {
  /** What the agent gets; undefined when memory has nothing for this task. */
  readonly text: string | undefined
  readonly state: SessionState | undefined
  /** The kinds word search proposed, and the model's reason for each step. */
  readonly proposals?: ReadonlyArray<{ readonly kind: string; readonly coverage: number }>
  readonly reasons?: ReadonlyArray<string>
  /** The code that went along: which lines of which files. */
  readonly excerpts?: Excerpts | undefined
}

export const taskStart = Effect.fn("taskStart")(function*(
  input: TaskStartInput,
  options: {
    readonly tenantDir: string
    readonly selector?: SelectorConfig | undefined
    /** false: a preview; nothing is kept for the session or logged. */
    readonly persist?: boolean | undefined
  }
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const records = yield* RecordStore
  const memory = yield* MemoryStore
  const now = DateTime.formatIso(yield* DateTime.now)
  const repo = yield* identifyRepo(input.cwd)
  const subject = repo === undefined ? undefined : yield* records.subjectFor(repo)
  if (repo === undefined || subject === undefined) return { text: undefined, state: undefined } satisfies TaskStartResult

  const version = yield* memory.head()
  const tools = yield* repoTools(repo.root)
  const kinds = yield* memory.kinds(subject.id, { tools })
  const warnings = yield* memory.warnings(subject.id, { tools })
  const proposed = proposeKinds(kinds, input.prompt)

  let kind: Kind | undefined
  let answer: SelectionAnswer | undefined
  let selection: SessionState["selection"] = null
  let selectionUsage: Usage | undefined
  if (proposed.length > 0 && options.selector !== undefined) {
    const allSteps = new Map((yield* memory.steps(proposed.flatMap((p) => p.kind.route.map((e) => e.step)))).map((s) => [s.id, s]))
    yield* fs.makeDirectory(options.selector.cwd, { recursive: true })
    const called = yield* Effect.result(callStructured({
      claude: options.selector.claude,
      system: SELECT_PROMPT,
      prompt: selectionPrompt(input.prompt, proposed.map((p) => p.kind), allSteps),
      schema: SelectionAnswer,
      model: options.selector.model,
      thinking: false,
      cwd: options.selector.cwd,
      maxBudgetUsd: 0.25,
      timeoutS: 90
    }))
    if (called._tag === "Success") {
      answer = called.success.value
      kind = proposed.find((p) => p.kind.id === answer!.kind)?.kind
      selection = { model: options.selector.model, cost_usd: called.success.costUsd, error: null }
      selectionUsage = called.success.usage
    } else {
      // A failed call shouldn't cost the task its memory: fall back to word search alone.
      selection = { model: options.selector.model, cost_usd: null, error: called.failure.message }
    }
  }
  if (selection === null || selection.error !== null) {
    kind = proposed[0] !== undefined && proposed[0].coverage >= MIN_COVERAGE_ALONE ? proposed[0].kind : undefined
    answer = undefined
  }

  const stepIds = kind === undefined ? [] : chosenSteps(kind, answer)
  const steps = yield* memory.steps(stepIds)
  const ordered = stepIds.map((id) => steps.find((s) => s.id === id)).filter((s): s is Step => s !== undefined)

  // Landmarks still in the code, read from the working tree. Memory names files inside the repo only.
  const texts = new Map<string, string | undefined>()
  const textOf = Effect.fnUntraced(function*(file: string) {
    if (!texts.has(file)) {
      const inside = !path.isAbsolute(file) && !file.split(/[\\/]/).includes("..")
      texts.set(file, inside ? Option.getOrUndefined(yield* fs.readFileString(path.join(repo.root, file)).pipe(Effect.option)) : undefined)
    }
    return texts.get(file)
  })
  const places = new Map<string, LivePlace>()
  for (const s of ordered) {
    const p = s.where[subject.id]
    if (p === undefined) continue
    const landmarks: Array<{ fact: string; file: string }> = []
    for (const l of p.landmarks) {
      if (landmarks.length >= MAX_LANDMARKS) break
      const text = yield* textOf(l.file)
      if (text !== undefined && l.anchors.every((a) => text.includes(a))) landmarks.push({ fact: l.fact, file: l.file })
    }
    const files = p.files.filter((f) => f.seen >= 2 && f.seen / Math.max(1, p.runs) >= STABLE_FILE_SHARE).map((f) => f.path)
    places.set(s.id, { landmarks, files, checks: p.checks.slice(0, 2) })
  }

  const atStart = warnings
    .filter((w) => w.moment !== "trigger" && ((w.step !== null && stepIds.includes(w.step)) || (w.kind !== null && w.kind === kind?.id)))
    .sort((a, b) => b.cost.tokens - a.cost.tokens)
    .slice(0, MAX_WARNINGS)
  const routeKind = ordered.length === 0 ? undefined : kind
  /** The route's text. A file whose lines are shown for a step isn't listed with that step as well. */
  const renderRoute = (shown: ReadonlySet<string> = new Set()) =>
    routeKind === undefined ? undefined : renderHandover(
      routeKind,
      ordered,
      new Map(ordered.flatMap((s, i) => {
        const p = places.get(s.id)
        return p === undefined ? [] : [[s.id, { ...p, files: p.files.filter((f) => !shown.has(`${i + 1} ${f}`)) }] as const]
      })),
      atStart
    )
  let route = renderRoute()

  // The code at the route's places, as the working tree has it now, in the room the route leaves.
  let excerpts: Excerpts | undefined
  if (route !== undefined && kind !== undefined) {
    const ofKind = new Set(kind.evidence)
    const spots: Array<SpotSource> = []
    const examples: Array<ExampleSource> = []
    ordered.forEach((s, i) => {
      const p = s.where[subject.id]
      if (p === undefined) return
      // Counted over this kind's runs: another kind's runs of a shared step edit other places.
      const runs = s.evidence.filter((id) => ofKind.has(id)).length
      for (const spot of p.spots ?? []) {
        const records = spot.records.filter((id) => ofKind.has(id))
        if (records.length > 0) spots.push({ step: i + 1, file: spot.file, above: spot.above, below: spot.below, records, runs })
      }
      for (const e of p.examples ?? []) {
        const records = e.records.filter((id) => ofKind.has(id))
        if (records.length > 0) examples.push({ step: i + 1, path: e.path, records, runs })
      }
    })
    const live = new Map<string, string>()
    for (const file of new Set([...spots.map((s) => s.file), ...examples.map((e) => e.path)])) {
      const text = yield* textOf(file)
      if (text !== undefined) live.set(file, text.replace(/\r\n?/g, "\n"))
    }
    excerpts = makeExcerpts(spots, examples, live, MAX_HANDOVER_CHARS - route.length)
    // What the shorter route frees goes to the code, as long as every file dropped from the route is still shown.
    const pairs = (e: Excerpts) => new Set(e.shown.flatMap((x) => x.steps.map((step) => `${step} ${x.file}`)))
    const shown = pairs(excerpts)
    const shorter = renderRoute(shown)
    if (shorter !== undefined && shorter.length < route.length) {
      const more = makeExcerpts(spots, examples, live, MAX_HANDOVER_CHARS - shorter.length)
      const still = pairs(more)
      if ([...shown].every((pair) => still.has(pair))) {
        route = shorter
        excerpts = more
      }
    }
  }
  const text = route === undefined ? undefined : route + (excerpts?.text ?? "")

  const state: SessionState = {
    session_id: input.sessionId,
    tenant: memory.tenant,
    subject: subject.id,
    repo: repo.root,
    head: repo.head ?? null,
    started_at: now,
    prompt: input.prompt,
    version,
    kind: kind?.id ?? null,
    steps: stepIds,
    warnings: atStart.map((w) => w.id),
    triggers: warnings.filter((w) => w.trigger !== null),
    selection
  }
  const reasons = answer?.steps.map((s) => `${s.applies ? "" : "not "}${s.id}: ${s.why}`) ?? []
  const proposals = proposed.map((p) => ({ kind: p.kind.id, coverage: Math.round(p.coverage * 1000) / 1000 }))
  if (options.persist === false) return { text, state, proposals, reasons, excerpts } satisfies TaskStartResult
  yield* writeSession(options.tenantDir, state)
  yield* logHandover(options.tenantDir, {
    at: now,
    session_id: input.sessionId,
    moment: "start",
    subject: subject.id,
    version,
    proposed: proposals,
    kind: kind?.id ?? null,
    steps: stepIds,
    warnings: atStart.map((w) => w.id),
    reasons,
    selection,
    // What the selection's model call used, so a measurement can count it with the run.
    selection_tokens: selectionUsage === undefined ? null : usageToJson(selectionUsage),
    // The code that went along: which lines of which files, and what was found but didn't fit.
    excerpts: excerpts?.shown ?? [],
    examples: excerpts?.examples ?? [],
    left_out: excerpts?.leftOut ?? 0,
    chars: text?.length ?? 0,
    text: text ?? null
  })
  return { text, state, proposals, reasons, excerpts } satisfies TaskStartResult
})
