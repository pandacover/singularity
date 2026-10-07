/**
 * Writing cues (Cues.ts), once, when memory is built: a model reads the
 * workflows and the tasks memory learned from, and writes for each workflow
 * the phrases that say a task needs it, cues for its conditional steps, and
 * where a task states its blanks' values.
 *
 * Then the answer is checked mechanically: no phrase may name a task's own
 * value; a fill must use a placeholder its workflow's steps have, and find a
 * value in the tasks memory learned from; the cues must pick, for each of
 * those tasks, exactly the workflows the model says it needs. Problems go back
 * to the model once; what still fails is dropped and reported.
 *
 * A refinement (Evolve.ts) writes workflows without cues; cues are written
 * again after it.
 */
import { Effect, Schema } from "effect"
import { callStructured } from "../eval/Llm.ts"
import { cueChoice, fillValue } from "./Cues.ts"
import type { RunEvidence } from "./Evidence.ts"
import { namedValue } from "./Induce.ts"
import { Fill, graphOrder, StepCue, type Workflow, type WorkflowCues, type WorkflowMemory } from "./Models.ts"

export const CuesAnswer = Schema.Struct({
  workflows: Schema.Array(Schema.Struct({
    id: Schema.String,
    any: Schema.Array(Schema.String),
    none: Schema.Array(Schema.String),
    steps: Schema.Array(StepCue),
    fills: Schema.Array(Fill)
  })),
  /** For each task memory learned from, the workflows it needs. */
  tasks: Schema.Array(Schema.Struct({ task: Schema.String, needs: Schema.Array(Schema.String) })),
  rationale: Schema.String
})
export type CuesAnswer = typeof CuesAnswer.Type

export const CUES_PROMPT = `You add cues to a coding agent's procedural memory, so that a new task can be given the right parts of it without a model.

Memory holds workflows: small reusable sub-routines, with blanks in braces for a task's own values. When a new task starts, its text is matched against your cues exactly: plain phrases, in any case, never regular expressions. Before matching, the task's negated clauses are taken out (from "not", "n't", "never", "no" or "without" to the next comma, period, semicolon, colon or parenthesis), so write cues for what a task asks for, not for what it rules out.

For each workflow:
- \`any\`: phrases of which a task's text contains at least one when it needs the workflow. Use the general words tasks of that kind use, as the example tasks show; short phrases ("right-click menu", "keyboard shortcut", "from Alt+") match more tasks than whole sentences. Never a task's own values (its names, labels, fields or keys: "Alt+" is fine, "Alt+M" is not).
- \`none\`: phrases that mean the workflow isn't needed even though an \`any\` phrase appears (often empty).
- A workflow marked only_if_asked was learned from work no task asked for: its \`any\` phrases must be explicit asks for that very thing ("add a test"), never words every task has ("make sure the tests pass").
- A workflow that every task of these kinds needs (the final checks, test snapshots) may have broad phrases.
- \`steps\`: for each step that has a condition ("when") a task's text can decide, the phrases that say it applies (\`any\`) and those that say it doesn't (\`none\`). A step whose condition depends on the code, not the task, gets no entry: it is always handed over, with its condition.
- \`fills\`: where a task's text states a placeholder's value exactly as the step writes it, same spelling and case. \`from\`: "code" (the n-th name in backticks), "quoted" (the n-th text in double quotes), "key" (the n-th key combination, such as Alt+M), "key-letter" (the key of the n-th combination: M), "after" (the word right after \`phrase\`, such as the value after "default"). Count n from 1 in the order the text states them; \`phrase\` is null unless \`from\` is "after". \`placeholder\` is written as in the steps, braces included ("{field}"), or another placeholder the steps use ("<text>"). A placeholder whose value a task doesn't state as written (it must be derived, re-cased or chosen) gets no fill: the agent fills it.

Then say, for each example task, which workflows it needs. Your cues must pick exactly those for it.`

/** What the cue-writing model reads: the workflows and edges, and the tasks memory learned from. */
export const cuesPrompt = (
  memory: WorkflowMemory,
  seeds: ReadonlyArray<RunEvidence>,
  notes: ReadonlyArray<string> = [],
  previous?: CuesAnswer
): string => {
  const lines = ["## Workflows", ""]
  for (const w of graphOrder(memory)) {
    lines.push(`### ${w.id}: ${w.name}`, `Use when: ${w.use_when}${w.only_if_asked ? " (only_if_asked: only if the task explicitly asks for it)" : ""}`)
    if (w.blanks.length > 0) lines.push(`Blanks: ${w.blanks.map((b) => `{${b.name}} ${b.meaning}`).join("; ")}`)
    w.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.do}${s.when === null ? "" : ` [when: ${s.when}]`}`))
    lines.push("")
  }
  const conditional = memory.edges.filter((e) => e.condition !== null)
  if (conditional.length > 0) {
    lines.push("## Edges with conditions", "")
    for (const e of conditional) lines.push(`- ${e.from} -> ${e.to}: ${e.condition}`)
    lines.push("")
  }
  lines.push("## Example tasks (memory was learned from their runs)", "")
  for (const task of [...new Set(seeds.map((r) => r.task))]) {
    const runs = seeds.filter((r) => r.task === task)
    const values = [...new Set(runs.flatMap((r) => r.values))]
    lines.push(`### ${JSON.stringify(task)}`, "")
    for (const l of runs[0].prompt.trim().split(/\r?\n/)) lines.push(`> ${l}`)
    lines.push("", `Its own values, never to be written as cues: ${values.map((v) => "`" + v + "`").join(", ") || "(none found)"}`, "")
  }
  if (previous !== undefined) lines.push("## Your previous answer", "", "```json", JSON.stringify(previous, null, 1), "```", "")
  if (notes.length > 0) {
    lines.push("## Problems in your previous answer", "", "Answer again in full, with these fixed and everything else kept:", "", ...notes.map((n) => `- ${n}`), "")
  }
  return lines.join("\n")
}

export interface CheckedCues {
  readonly memory: WorkflowMemory
  readonly problems: ReadonlyArray<string>
}

const withoutCues = (w: Workflow): Workflow => Object.fromEntries(Object.entries(w).filter(([k]) => k !== "cues")) as Workflow

/** Check a cue answer against memory and the tasks it learned from; keep what holds. */
export const checkCues = (answer: CuesAnswer, memory: WorkflowMemory, seeds: ReadonlyArray<RunEvidence>): CheckedCues => {
  const problems: Array<string> = []
  const values = [...new Set(seeds.flatMap((r) => r.values))]
  const clean = (where: string, phrases: ReadonlyArray<string>) =>
    phrases.map((p) => p.trim()).filter((p) => {
      if (p === "") return false
      const v = namedValue(p, values)
      if (v !== undefined) problems.push(`${where}: the phrase ${JSON.stringify(p)} names a task's own value ${JSON.stringify(v)}; dropped`)
      return v === undefined
    })
  const byId = new Map(answer.workflows.map((w) => [w.id, w]))
  for (const id of byId.keys()) if (!memory.workflows.some((w) => w.id === id)) problems.push(`${id} is no workflow in memory`)

  const workflows = memory.workflows.map((w): Workflow => {
    const a = byId.get(w.id)
    if (a === undefined) {
      problems.push(`${w.id} has no cues, so it is never picked`)
      return withoutCues(w)
    }
    const any = clean(w.id, a.any)
    if (any.length === 0) problems.push(`${w.id} has no phrase in \`any\`, so it is never picked`)
    const steps = a.steps.flatMap((s) => {
      const step = w.steps[s.step - 1]
      if (step === undefined || step.when === null) {
        problems.push(`${w.id} has cues for step ${s.step}, which isn't a step with a condition; dropped`)
        return []
      }
      const stepAny = clean(`step ${s.step} of ${w.id}`, s.any)
      if (stepAny.length === 0) {
        problems.push(`step ${s.step} of ${w.id} has no phrase in \`any\`, so it would always be left out; dropped its cues`)
        return []
      }
      return [{ step: s.step, any: stepAny, none: clean(`step ${s.step} of ${w.id}`, s.none) }]
    })
    const texts = w.steps.flatMap((s) => [s.do, s.when ?? ""]).join("\n")
    const fills = a.fills.flatMap((f) => {
      if (!texts.includes(f.placeholder)) {
        problems.push(`${w.id} fills ${JSON.stringify(f.placeholder)}, which its steps don't use; dropped`)
        return []
      }
      if (f.from === "after" && !f.phrase?.trim()) {
        problems.push(`${w.id} fills ${f.placeholder} from the word after a phrase, but gives no phrase; dropped`)
        return []
      }
      if (f.from !== "after" && (!Number.isInteger(f.n) || f.n < 1)) {
        problems.push(`${w.id} fills ${f.placeholder} from number ${f.n}, but counting starts at 1; dropped`)
        return []
      }
      if (f.from === "after" && namedValue(f.phrase!, values) !== undefined) {
        problems.push(`${w.id} fills ${f.placeholder} after ${JSON.stringify(f.phrase)}, which names a task's own value; dropped`)
        return []
      }
      return [{ ...f, phrase: f.from === "after" ? f.phrase!.trim() : null }]
    })
    const cues: WorkflowCues = { any, none: clean(w.id, a.none), steps, fills }
    return { ...withoutCues(w), cues }
  })
  const withCues: WorkflowMemory = { ...memory, workflows }

  // On the tasks memory learned from: the picks the model said, and fills that find their task's values.
  const needs = new Map(answer.tasks.map((t) => [t.task, new Set(t.needs)]))
  for (const task of [...new Set(seeds.map((r) => r.task))]) {
    const prompt = seeds.find((r) => r.task === task)!.prompt
    const want = needs.get(task)
    if (want === undefined) {
      problems.push(`you didn't say which workflows task ${JSON.stringify(task)} needs`)
      continue
    }
    const got = new Set(cueChoice(withCues, prompt).map((c) => c.workflow.id))
    for (const id of got) if (!want.has(id)) problems.push(`the cues pick ${id} for task ${JSON.stringify(task)}, which you say doesn't need it`)
    for (const id of want) if (!got.has(id)) problems.push(`the cues don't pick ${id} for task ${JSON.stringify(task)}, which you say needs it`)
    const own = [...new Set(seeds.filter((r) => r.task === task).flatMap((r) => r.values))]
    for (const w of workflows) {
      if (!want.has(w.id)) continue
      for (const f of w.cues?.fills ?? []) {
        const v = fillValue(prompt, f)
        if (v === undefined) problems.push(`the fill of ${f.placeholder} in ${w.id} finds nothing in task ${JSON.stringify(task)}`)
        else if ((f.from === "code" || f.from === "quoted" || f.from === "key") && !own.includes(v)) {
          problems.push(`the fill of ${f.placeholder} in ${w.id} finds ${JSON.stringify(v)} in task ${JSON.stringify(task)}, which isn't one of its own values`)
        }
      }
    }
  }
  return { memory: withCues, problems }
}

export interface CuesConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
  readonly effort?: string | undefined
}

export interface WrittenCues extends CheckedCues {
  readonly rationale: string
  readonly costUsd: number
  readonly calls: number
}

/** Write cues for memory from the tasks it learned from: one model call, and one more to fix what the checks found. */
export const writeCues = Effect.fn("writeCues")(function*(config: CuesConfig, memory: WorkflowMemory, seeds: ReadonlyArray<RunEvidence>) {
  let notes: ReadonlyArray<string> = []
  let previous: CuesAnswer | undefined
  let costUsd = 0
  let calls = 0
  let result: CheckedCues | undefined
  let rationale = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = yield* callStructured({
      claude: config.claude,
      system: CUES_PROMPT,
      prompt: cuesPrompt(memory, seeds, notes, previous),
      schema: CuesAnswer,
      model: config.model,
      effort: config.effort,
      cwd: config.cwd,
      maxBudgetUsd: 1,
      timeoutS: 600
    })
    calls++
    costUsd += answer.costUsd ?? 0
    rationale = answer.value.rationale
    result = checkCues(answer.value, memory, seeds)
    if (result.problems.length === 0) break
    notes = result.problems
    previous = answer.value
  }
  return { ...result!, rationale, costUsd, calls } satisfies WrittenCues
})
