/**
 * Learning across tasks of a kind: what runs of different tasks did alike.
 *
 * Induction (Induce.ts) learns from the tasks one by one, and keeps what each
 * did: from two bug fixes, a workflow for each bug, cued by its own words,
 * which no other bug can use. What different bug fixes in one repository
 * share is not where their fixes went but how they got there: where a
 * regression test goes, how a test sets up the app and presses keys with the
 * repository's helpers, how runs showed the test failed without the fix, the
 * commands that check the work, the mistakes made on the way.
 *
 * So this pass reads the runs of several tasks of one kind and keeps only
 * what runs of at least two of the tasks did: each workflow, and each place a
 * step names, must come from two tasks' runs (checked mechanically, with the
 * rest of induction's checks). Places include those runs read without
 * changing (Reads.ts), which the hand-over shows as an outline of the block:
 * a helper class's first line and its members'. The workflows join memory as
 * the kind's own, next to what single tasks taught; a later pass for the same
 * kind replaces them.
 */
import { Effect } from "effect"
import { callStructured } from "../eval/Llm.ts"
import type { Evidence, RunEvidence } from "./Evidence.ts"
import { type Checked, checkAnswer, describeDetour, describePlace, type InduceConfig, InductionAnswer } from "./Induce.ts"
import { type Edge, END, isReadPlace, type Place, START, type WorkflowMemory } from "./Models.ts"

/** How many different tasks' runs a workflow, and a place a step names, must come from. */
export const MIN_TASKS = 2

export const COMMON_PROMPT = `You build procedural memory for a coding agent from its past runs in one repository.

The runs you are given did different tasks of one kind (named below). Find what runs of different tasks did alike: the procedure tasks of this kind share in this repository, which a new task of the kind will need too, wherever its own change goes. For bug fixes, that is how a bug is reproduced in a test here and how the fix is checked: where a regression test goes, how a test sets up the app and acts on it with this repository's test helpers, how to show that the test fails without the fix, the commands that check the work, and the mistakes runs made on the way. Leave out what only one task needed: where its fix went, its own files, names and values. Memory already keeps what single tasks taught; this is what holds across them. A new task of the kind gets your workflows at its start, with the places they name found in the code as it is then.

## Workflows

- A workflow is a small sub-routine, its steps written with blanks in braces for each task's own values: {test file}, {fixed files}, {key}. List each blank with what it stands for. Each task lists its own values: never write any of them, in any spelling or case.
- Every workflow must be something runs of at least two of the tasks did. \`from_runs\`: the ids of the runs it comes from, of at least two tasks.
- Each step says what to do, and where:
  - \`place\`: the id of a listed place that runs of at least two tasks edited or read. A place runs read is shown to the agent as an outline (the block's first line and its members' first lines, from the code as it is then): name one in the step that tells the agent to use it ("press keys with the Keyboard helper").
  - \`place: null\` when the spot is the task's own (the test file next to the code it fixes) or isn't listed; then say how to find it.
  - \`when\`: if a step applies only in some cases, say when, in words a new task's text can decide ("if the test presses keys"). Null if it always applies.
- Give the knowledge runs had to find out on their own, so the next run doesn't have to: which helpers set up a scene, select a tool, press keys or move the pointer; what a test must render so that key presses reach the app; how runs showed that their test failed without the fix; which test file covers which kind of code. Name helpers and say how they are used, but never write a task's code: no test bodies, no fixes.
- \`use_when\`: what in a task's text means the workflow is needed: the words tasks of this kind use, not one task's subject.
- \`checks\`: the commands that check the work, in their simplest form as runs ran them successfully, with blanks for a task's own files ("yarn vitest run {test file}"). When runs showed that their test fails without the fix, keep that as one command ("git stash push {fixed files}; yarn vitest run {test file}; git stash pop"). The checks of all your workflows are joined into one command the agent runs once at the end, in order: list each command once, never alternatives, and the whole test suite at most once, in the form runs ran it most. Leave out pipes into head, tail or grep, and one-off debugging commands.
- \`only_if_asked\`: true for a workflow learned from what runs did unasked, handed over only when a task explicitly asks for that very thing; false otherwise.

## The graph

\`edges\` connect your workflows from "start" to "end", in the order tasks of the kind take them. An edge's \`condition\` says when a task takes it (null if always); \`guidance\` how to go on, and \`pitfalls\` what to avoid at that point (each may be null). Relations: LEADS_TO, TRIGGERS, PROVIDES_INPUT_FOR, CONVERGES_TO. Connect only your own workflows, "start" and "end".

## Pitfalls

From the detours of all runs (a call that failed, and what it cost until fixed), keep the mistakes another task of this kind could make again, in general words: what goes wrong and what to do instead. One run's detour is enough when the mistake isn't about that task's own change. Memory's current pitfalls are listed: to attach one to a workflow, list it by its id with \`detours\` empty (or the detours these runs made of it). Leave out failures that were the task's work in progress (a test failing until the fix was in). Refer to detours as "<run id>#<detour number>", and list a pitfall's id in the workflows it belongs to.

A pitfall may have an exact \`trigger\` that tells it is happening, checked on every tool call: plain substrings, never regular expressions, and never a task's own values.
- \`on: "command"\`: a shell command containing every string in \`all\` and none in \`none\` (\`file\` null).
- \`on: "edit"\`: an edit (to a file whose path ends with \`file\`, if given) writing text that contains every string in \`all\` and none in \`none\`.
- \`on: "error"\`: a failed tool call whose output contains every string in \`all\` (\`file\` null).
It must match the call that failed and not the call that fixed it. Use null when there are no such strings.

\`entries\`: leave it empty.

Ids: short kebab-case names in general words ("reproduce-bug-in-test"), none of memory's current workflow ids.`

const MAX_TEST_TEXT = 300

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ")
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"
const isTestFile = (file: string) => /\.(test|spec)\.[jt]sx?$/.test(file) || /(^|\/)(tests?|__tests__)\//.test(file)

const listPlace = (p: Place, did: string) =>
  `- ${p.id} ${describePlace(p)}: ${did} by ${p.evidence.length} runs of ${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"} (${p.tasks.join(", ")})` +
  (p.tasks.length < MIN_TASKS ? ". Not for a step: one task only" : "")

/** What one run did, for the model: its changes (the text of test edits), what it read, its checks and detours. */
const describeRun = (r: RunEvidence, places: ReadonlyMap<string, Place>): Array<string> => {
  const tokens = r.tokens === null ? "" : `; ${Math.round(r.tokens / 1000)}k tokens`
  const lines = [`#### Run ${r.record} (${r.turns} turns${tokens})`, ""]
  const byFile = new Map<string, Array<string>>()
  for (const u of r.uses) {
    const texts = byFile.get(u.file) ?? []
    if (isTestFile(u.file) && u.added.trim() !== "") texts.push(clip(oneLine(u.added), MAX_TEST_TEXT))
    byFile.set(u.file, texts)
  }
  if (byFile.size > 0) {
    lines.push("Files it changed, in the order made:")
    for (const [file, texts] of byFile) {
      lines.push(`- ${code(file)}${isTestFile(file) ? " (a test)" : ""}`)
      for (const t of texts) lines.push(`  wrote: ${code(t)}`)
    }
  }
  const reads = r.reads.filter((x) => places.has(x.place))
  if (reads.length > 0) {
    lines.push("Read, of the places listed above:")
    for (const x of reads) lines.push(`- turn ${x.turn}: ${x.place} (${describePlace(places.get(x.place)!)})`)
  }
  if (r.checks.length > 0) {
    const ran = r.checks.map((c) => (c.line === c.key ? code(c.key) : `${code(c.key)} (ran as ${code(clip(c.line, 160))})`))
    lines.push(`Checks that passed: ${ran.join("; ")}`)
  }
  if (r.detours.length > 0) lines.push("Detours:", ...r.detours.map((_, i) => describeDetour(r, i)))
  lines.push("")
  return lines
}

/** What the model reads: the kind, memory's current workflows and pitfalls, the places, and each task with its runs. */
export const commonPrompt = (
  evidence: Evidence,
  kind: string,
  current: WorkflowMemory | undefined,
  notes: ReadonlyArray<string> = [],
  previous?: InductionAnswer
): string => {
  const lines = [`## The kind of task: ${kind}`, ""]
  if (current !== undefined && current.workflows.length > 0) {
    lines.push("## Memory's current workflows (learned from single tasks; don't repeat them, and use other ids)", "")
    for (const w of current.workflows.filter((x) => x.kind !== kind)) lines.push(`- ${w.id}: ${w.name}`)
    lines.push("")
  }
  if (current !== undefined && current.pitfalls.length > 0) {
    lines.push("## Memory's current pitfalls (attach one by its id)", "")
    for (const p of current.pitfalls) lines.push(`- ${p.id}: ${p.text}`)
    lines.push("")
  }
  const edited = evidence.places.filter((p) => p.tasks.length >= MIN_TASKS)
  if (edited.length > 0) {
    lines.push("## Places runs of several tasks edited", "")
    for (const p of edited) lines.push(listPlace(p, "edited"))
    lines.push("")
  }
  // Only places runs of several tasks read can carry a step: the rest would only crowd the runs.
  const read = evidence.readPlaces.filter((p) => p.tasks.length >= MIN_TASKS)
  if (read.length > 0) {
    lines.push("## Places runs of several tasks read in files they didn't change", "", "A step can name one; the hand-over shows it as an outline.", "")
    for (const p of read) lines.push(listPlace(p, "read"))
    lines.push("")
  }
  lines.push("## Tasks and their runs", "")
  const places = new Map([...evidence.places, ...read].map((p) => [p.id, p]))
  for (const task of [...new Set(evidence.runs.map((r) => r.task))]) {
    const runs = evidence.runs.filter((r) => r.task === task)
    const values = [...new Set(runs.flatMap((r) => r.values))]
    lines.push(`### Task ${JSON.stringify(task)} (${runs.length} successful run${runs.length === 1 ? "" : "s"})`, "", "Prompt:", "")
    for (const l of runs[0].prompt.trim().split(/\r?\n/)) lines.push(`> ${l}`)
    lines.push("", `Its own values, never to be written in memory: ${values.map(code).join(", ") || "(none found)"}`, "")
    for (const r of runs) lines.push(...describeRun(r, places))
  }
  if (previous !== undefined) lines.push("## Your previous answer", "", "```json", JSON.stringify(previous, null, 1), "```", "")
  if (notes.length > 0) {
    lines.push("## Problems in your previous answer", "", "Answer again in full, with these fixed and everything else kept:", "", ...notes.map((n) => `- ${n}`), "")
  }
  return lines.join("\n")
}

/**
 * Check an answer: induction's checks (no task values, real places, triggers
 * that single out their mistake), with every workflow and every place a step
 * names coming from runs of at least two tasks. The workflows get the kind.
 */
export const checkCommon = (answer: InductionAnswer, evidence: Evidence, tenant: string, kind: string, current?: WorkflowMemory): Checked => {
  const all: Evidence = { ...evidence, places: [...evidence.places, ...evidence.readPlaces] }
  const checked = checkAnswer(answer, all, tenant, current, { minTasks: MIN_TASKS })
  const taken = new Set((current?.workflows ?? []).filter((w) => w.kind !== kind).map((w) => w.id))
  const problems = [...checked.problems]
  const workflows = checked.memory.workflows.filter((w) => {
    if (!taken.has(w.id)) return true
    problems.push(`workflow ${w.id} has the id of one memory already has; dropped`)
    return false
  })
  const ids = new Set(workflows.map((w) => w.id))
  const edges = checked.memory.edges.filter((e) => (e.from === START || ids.has(e.from)) && (e.to === END || ids.has(e.to)))
  const used = new Set(workflows.flatMap((w) => w.steps.flatMap((s) => (s.place === null ? [] : [s.place]))))
  return {
    ...checked,
    problems,
    entries: [],
    memory: {
      ...checked.memory,
      workflows: workflows.map((w) => ({ ...w, kind })),
      edges,
      places: checked.memory.places.filter((p) => used.has(p.id))
    }
  }
}

/**
 * Memory with a kind's workflows in place of those it had for that kind: the
 * other workflows, their places, edges and pitfalls stay; the kind's
 * pitfalls are added, or replace those of the same id.
 */
export const withKind = (current: WorkflowMemory, learned: WorkflowMemory, kind: string): WorkflowMemory => {
  const kept = current.workflows.filter((w) => w.kind !== kind)
  const workflows = [...kept, ...learned.workflows]
  const ids = new Set(workflows.map((w) => w.id))
  const known = (x: string) => x === START || x === END || ids.has(x)
  const dropped = new Set(current.workflows.filter((w) => w.kind === kind).map((w) => w.id))
  const edges: Array<Edge> = [
    ...current.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to) && known(e.from) && known(e.to)),
    ...learned.edges
  ]
  const used = new Set(workflows.flatMap((w) => w.steps.flatMap((s) => (s.place === null ? [] : [s.place]))))
  const places = new Map([...current.places, ...learned.places].map((p) => [p.id, p]))
  const pitfalls = new Map([...current.pitfalls, ...learned.pitfalls].map((p) => [p.id, p]))
  return {
    ...current,
    workflows,
    edges,
    places: [...places.values()].filter((p) => used.has(p.id)),
    pitfalls: [...pitfalls.values()]
  }
}

export interface Learned extends Checked {
  readonly rationale: string
  readonly costUsd: number
  readonly calls: number
}

/**
 * Learn what runs of different tasks of one kind did alike: one model call,
 * and one more to fix what the checks found.
 */
export const learnCommon = Effect.fn("learnCommon")(function*(
  config: InduceConfig,
  evidence: Evidence,
  tenant: string,
  kind: string,
  current?: WorkflowMemory
) {
  let notes: ReadonlyArray<string> = []
  let previous: InductionAnswer | undefined
  let costUsd = 0
  let calls = 0
  let result: Checked | undefined
  let rationale = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = yield* callStructured({
      claude: config.claude,
      system: COMMON_PROMPT,
      prompt: commonPrompt(evidence, kind, current, notes, previous),
      schema: InductionAnswer,
      model: config.model,
      effort: config.effort,
      cwd: config.cwd,
      maxBudgetUsd: 3,
      timeoutS: 1200
    })
    calls++
    costUsd += answer.costUsd ?? 0
    rationale = answer.value.rationale
    result = checkCommon(answer.value, evidence, tenant, kind, current)
    const fixable = result.problems.filter((p) => !p.includes("is in no workflow"))
    if (fixable.length === 0) break
    notes = fixable
    previous = answer.value
  }
  return { ...result!, rationale, costUsd, calls } satisfies Learned
})

/** Read places among a memory's places, for people: how many runs of how many tasks read each. */
export const describeReadPlaces = (places: ReadonlyArray<Place>): Array<string> =>
  places.filter(isReadPlace).map((p) => `${p.id} ${describePlace(p)}: read by ${p.evidence.length} runs of ${p.tasks.length} tasks`)
