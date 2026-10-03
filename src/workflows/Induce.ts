/**
 * Inducing memory v1: a model reads what runs did (Evidence.ts) and proposes
 * small workflows with blanks, the graph that connects them, and the pitfalls
 * worth a warning. This is the Agent Workflow Memory paper's induction ("find
 * the repetitive sub-routines, replace the non-fixed values with variable
 * names"), done by the Procedural Graphs paper's refiner, which builds from
 * nothing or revises the current graph.
 *
 * Then every claim is checked against the evidence, mechanically: a step's
 * place must be one runs edited; no text may carry a task's own values; a
 * trigger must single out its mistake (match the call that failed, not the
 * one that fixed it); edges must lead from `start` to `end`. Problems go back
 * to the model once; whatever still fails is dropped and reported.
 */
import { Effect, Schema } from "effect"
import { callStructured } from "../eval/Llm.ts"
import { triggerMismatch, triggerValue } from "../records/Annotate.ts"
import { relativizer } from "../records/Extract.ts"
import { describeTrigger, eventOfCall, Trigger, triggerProblem } from "../records/Triggers.ts"
import type { ToolCall } from "../traces/index.ts"
import { type Evidence, type RunEvidence, shapeOf } from "./Evidence.ts"
import { Blank, Edge, END, FORMAT, type Pitfall, type Place, START, type Workflow, type WorkflowMemory } from "./Models.ts"
import { describeChain } from "./Places.ts"

export const ProposedStep = Schema.Struct({
  do: Schema.String,
  place: Schema.NullOr(Schema.String),
  when: Schema.NullOr(Schema.String)
})

export const ProposedWorkflow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  use_when: Schema.String,
  blanks: Schema.Array(Blank),
  steps: Schema.Array(ProposedStep),
  checks: Schema.Array(Schema.String),
  pitfalls: Schema.Array(Schema.String),
  /** The runs it was learned from. */
  from_runs: Schema.Array(Schema.String),
  /** Learned from what runs did unasked: handed over only when a task explicitly asks for it. */
  only_if_asked: Schema.Boolean
})
export type ProposedWorkflow = typeof ProposedWorkflow.Type

export const ProposedPitfall = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  /** "<run id>#<detour number>" */
  detours: Schema.Array(Schema.String),
  trigger: Schema.NullOr(Trigger)
})
export type ProposedPitfall = typeof ProposedPitfall.Type

export const InductionAnswer = Schema.Struct({
  workflows: Schema.Array(ProposedWorkflow),
  edges: Schema.Array(Edge),
  pitfalls: Schema.Array(ProposedPitfall),
  rationale: Schema.String
})
export type InductionAnswer = typeof InductionAnswer.Type

export const INDUCE_PROMPT = `You build procedural memory for a coding agent from its past runs in one repository.

From the runs you are given, extract reusable workflows: small sub-routines that different tasks in this repository share. Connect them in a graph, and keep the mistakes worth a warning. Later, when a new task starts, memory picks the workflows it needs and hands them to the agent, with the places they name found in the code as it is then.

## Workflows

- A workflow is finer than a task. Not "add a minimap toggle", but the parts such a task is made of, each of which another task could need on its own or combined with others: "add a field to the app state", "create a toggle action", "give an action a keyboard shortcut", "add an action to the canvas right-click menu", "add a preference to the main menu", "update test snapshots". A later task may need only one of them, or a mix from different past tasks.
- Abstract the task away. Where a run used its own values (the feature's name, its field, its key, its label, a file named after the feature), write a blank: a descriptive name in braces, such as {field}, {action}, {key}, {label}, and list each blank with what it stands for. Each task lists its own values: never write any of them, in any spelling or case.
- Each step says what to do and where:
  - \`place\`: the id of one of the listed places where the runs made that kind of edit. The hand-over finds the place in the code as it is when used and shows it there, so say what to add or change in it ("add {field} with the storage rules the task asks for"), not which line it goes after.
  - \`place: null\` when the spot is the task's own (the file of the very action a task changes, named after it) or isn't among the listed places; then say how to find it ("in the action's own file, its keyTest").
  - \`when\`: if a step applies only in some cases, say when, in words a new task's text can decide ("only if the setting is also offered in view mode"). Null if it always applies within its workflow.
- A place the runs used only because their task asked for something (a right-click menu entry, a keyboard shortcut, a preference) belongs to a workflow that is taken only when a task asks for that.
- Make each workflow complete for its purpose: a later task that needs only that part must find in it every step the part takes, including the names, keys or registrations it depends on, even when another workflow also has some of those steps for when the two come together.
- \`use_when\`: what in a task's text means the workflow is needed.
- \`checks\`: commands that verify the workflow's work, in their simplest form as the runs ran them successfully (\`yarn test:typecheck\`). Leave out pipes into head, tail or grep, and one-off debugging commands.
- Tell apart what a task asked for, what the change needed although the task didn't say so (a second place to register something, snapshots to regenerate), and what a run chose to do on its own (a new test or an icon the task didn't ask for). Leave out what a run chose on its own, unless it is worth keeping for a task that does ask for it: then it is a workflow of its own with \`only_if_asked: true\`, handed over only when a task explicitly asks for that very thing, never when a task only asks to update or keep passing what already exists. Every other workflow has \`only_if_asked: false\`.
- Keep a workflow's steps in the order they are best done. \`from_runs\`: the ids of the runs it was learned from.

## The graph

\`edges\` connect the workflows from "start" to "end", in the order tasks usually take them. An edge's \`condition\` says when a task takes it (null if always); \`guidance\` how to go on, and \`pitfalls\` what to avoid at that point (each may be null). Every workflow must be reachable from "start" and lead to "end". Relations: LEADS_TO (the usual next one), TRIGGERS (one makes the other necessary, as a new app-state field makes test snapshots change), PROVIDES_INPUT_FOR, CONVERGES_TO.

## Pitfalls

From the detours (a call that failed, and what it cost until fixed), keep the mistakes another task could make again, in general words: what goes wrong and what to do instead. Leave out failures that were simply the task's work in progress (a test failing until the feature was done). Refer to the detours a pitfall comes from as "<run id>#<detour number>", and list its id in the workflows it belongs to.

A pitfall may have an exact \`trigger\` that tells it is happening, checked on every tool call: plain substrings, never regular expressions, and never a task's own values.
- \`on: "command"\`: a shell command containing every string in \`all\` and none in \`none\` (\`file\` null).
- \`on: "edit"\`: an edit (to a file whose path ends with \`file\`, if given) writing text that contains every string in \`all\` and none in \`none\`.
- \`on: "error"\`: a failed tool call whose output contains every string in \`all\` (\`file\` null).
It must match the call that failed and not the call that fixed it. Use null when there are no such strings.

Ids: short kebab-case names in general words ("add-app-state-field", "test-update-watch-flag").`

const MAX_ADDED = 160
const MAX_CREATED_LINES = 40

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ")
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"

export const describePlace = (p: Place): string => {
  if (p.new_file !== null) {
    return `new files in ${code(p.new_file.dir + "/")} named like ${code(`${p.new_file.prefix}…${p.new_file.ext}`)}`
  }
  const where = describeChain(shapeOf(p), 4)
  const close = p.chain[p.chain.length - 1]?.close
  return `${code(p.file)}, in: ${where}${close ? ` … ${close}` : ""}`
}

const MAX_FIX_EDITS = 4

/** The edits a run made between a detour's failure and its fix: what fixed it. */
const fixEdits = (r: RunEvidence, failedAt: number, fixedAt: number): Array<string> => {
  const relative = relativizer(r.cwd)
  const out: Array<string> = []
  for (const c of r.calls.slice(failedAt + 1, fixedAt + 1)) {
    const file = typeof c.input.file_path === "string" ? relative(c.input.file_path) : undefined
    if (file === undefined) continue
    if (c.name === "Edit" && typeof c.input.new_string === "string") {
      const before = typeof c.input.old_string === "string" ? c.input.old_string : ""
      out.push(`${file.split("/").pop()}: ${code(clip(oneLine(before), 100))} -> ${code(clip(oneLine(c.input.new_string), 160))}`)
    } else if (c.name === "Write") {
      out.push(`${file.split("/").pop()}: rewrote the file`)
    }
  }
  return out.length > MAX_FIX_EDITS ? [...out.slice(0, MAX_FIX_EDITS - 1), `… and ${out.length - MAX_FIX_EDITS + 1} more edits`, out[out.length - 1]] : out
}

const describeDetour = (r: RunEvidence, i: number): string => {
  const d = r.detours[i]
  const call = (c: typeof d.failed) => c.command !== null ? `${c.tool} ${code(clip(oneLine(c.command), 160))}` : `${c.tool}${c.file ? ` ${c.file}` : ""}`
  const edits = fixEdits(r, d.failed.call, d.fixed.call)
  const between = edits.length > 0
    ? `; edits in between: ${edits.join("; ")}`
    : d.files_edited.length > 0 ? `; edited ${d.files_edited.join(", ")} in between` : ""
  return `- #${i} (${d.kind}, cost ${Math.round(d.cost.tokens / 1000)}k tokens): ${call(d.failed)} failed: "${clip(oneLine(d.symptom), 220)}". ` +
    `Fixed by ${call(d.fixed)}${between}.`
}

/** What the model reads: the places, then each task with its runs; on a second try, its answer and what was wrong with it. */
export const inductionPrompt = (
  evidence: Evidence,
  current: WorkflowMemory | undefined,
  notes: ReadonlyArray<string> = [],
  previous?: InductionAnswer,
  extra: ReadonlyArray<string> = []
): string => {
  const lines: Array<string> = []
  if (current !== undefined && current.workflows.length > 0) {
    lines.push(
      "## Current memory",
      "",
      "Revise it rather than starting over: keep what the runs still support, change what they show is wrong or missing.",
      "",
      "```json",
      JSON.stringify({ workflows: current.workflows, edges: current.edges, pitfalls: current.pitfalls }, null, 1),
      "```",
      ""
    )
  }
  lines.push("## Places where the runs edited", "", "Use these ids in steps. Each is a block found by the blocks around it, a group of top-level statements that start alike, or a directory new files go in.", "")
  for (const p of evidence.places) {
    const counts = [p.edits.add > 0 ? `added ${p.edits.add}` : "", p.edits.change > 0 ? `changed ${p.edits.change}` : "", p.edits.create > 0 ? `created ${p.edits.create}` : ""].filter(Boolean).join(", ")
    const weak = placeProblem(p, evidence.families)
    lines.push(
      `- ${p.id} ${describePlace(p)}: ${p.evidence.length} runs of ${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"} (${p.tasks.join(", ")}); ${counts}` +
        (weak === undefined ? "" : `. Not for a step: ${weak}`)
    )
  }
  lines.push("", "## Tasks and their runs", "")
  const tasks = [...new Set(evidence.runs.map((r) => r.task))]
  for (const task of tasks) {
    const runs = evidence.runs.filter((r) => r.task === task)
    const values = [...new Set(runs.flatMap((r) => r.values))]
    lines.push(`### Task ${JSON.stringify(task)} (${runs.length} successful run${runs.length === 1 ? "" : "s"})`, "", "Prompt:", "")
    for (const l of runs[0].prompt.trim().split(/\r?\n/)) lines.push(`> ${l}`)
    lines.push("", `Its own values, never to be written in memory: ${values.map(code).join(", ") || "(none found)"}`, "")
    runs.forEach((r, k) => {
      const tokens = r.tokens === null ? "" : `; ${Math.round(r.tokens / 1000)}k tokens`
      lines.push(`#### Run ${r.record} (${r.turns} turns${tokens})`, "", "Edits, in the order made:")
      r.uses.forEach((u, i) => {
        const name = u.file.split("/").pop()
        if (u.kind === "create") {
          const read = r.readFirst.find((f) => f.created === u.file)?.read ?? []
          lines.push(`${i + 1}. created ${code(u.file)} at ${u.place}${read.length > 0 ? `, after reading ${read.map((f) => f.split("/").pop()).join(", ")}` : ""}`)
          if (k === 0) {
            const content = u.added.split("\n")
            lines.push("   ```", ...content.slice(0, MAX_CREATED_LINES).map((l) => `   ${l}`), ...(content.length > MAX_CREATED_LINES ? ["   …"] : []), "   ```")
          }
        } else {
          const what = u.kind === "add"
            ? `added ${code(clip(oneLine(u.added), MAX_ADDED))}`
            : u.kind === "remove"
            ? `removed ${code(clip(oneLine(u.removed), MAX_ADDED))}`
            : `changed ${code(clip(oneLine(u.removed), MAX_ADDED / 2))} to ${code(clip(oneLine(u.added), MAX_ADDED / 2))}`
          lines.push(`${i + 1}. at ${u.place} (${name}): ${what}`)
        }
      })
      if (r.snapshots.length > 0) lines.push(`Test snapshots it regenerated: ${r.snapshots.map((s) => s.split("/").pop()).join(", ")}`)
      if (r.checks.length > 0) {
        const ran = r.checks.map((c) => (c.line === c.key ? code(c.key) : `${code(c.key)} (ran as ${code(clip(c.line, 140))})`))
        lines.push(`Checks that passed: ${ran.join("; ")}`)
      }
      if (r.detours.length > 0) lines.push("Detours:", ...r.detours.map((_, i) => describeDetour(r, i)))
      lines.push("")
    })
  }
  for (const section of extra) lines.push(section, "")
  if (previous !== undefined) lines.push("## Your previous answer", "", "```json", JSON.stringify(previous, null, 1), "```", "")
  if (notes.length > 0) {
    lines.push("## Problems in your previous answer", "", "Answer again in full, with these fixed and everything else kept:", "", ...notes.map((n) => `- ${n}`), "")
  }
  return lines.join("\n")
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item"

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The task value a text names, if any: whole words, any case; key combinations exactly. Paths don't count. */
export const namedValue = (text: string, values: ReadonlyArray<string>): string | undefined =>
  values.find((v) => {
    if (v.includes("/") && !/^(Alt|Ctrl|Cmd|Shift|Meta|CtrlOrCmd)\+/.test(v)) return false
    if (/\+/.test(v)) return text.includes(v)
    if (v.length < 3) return false
    return new RegExp(`(^|[^A-Za-z0-9_$])${escape(v)}(?=$|[^A-Za-z0-9_$])`, "i").test(text)
  })

export interface Checked {
  readonly memory: WorkflowMemory
  /** Problems the model should fix, then what was dropped. */
  readonly problems: ReadonlyArray<string>
}

const median = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

/**
 * Why a place can't carry a step, or undefined if it can: one run is too
 * little to go on, and a file that is one of many named alike
 * (`actionToggle…`), edited by one task only, is that task's own instance.
 */
export const placeProblem = (p: Place, families: ReadonlyMap<string, string>): string | undefined => {
  if (p.evidence.length < 2) return "which only one run edited"
  const family = p.new_file === null ? families.get(p.file) : undefined
  if (family !== undefined && p.tasks.length < 2) return `whose file is one of several named ${JSON.stringify(family + "…")} that only one task edited: that task's own file`
  return undefined
}

/** Check a model's answer against the evidence; keep what holds. */
export const checkAnswer = (answer: InductionAnswer, evidence: Evidence, tenant: string): Checked => {
  const problems: Array<string> = []
  const places = new Map(evidence.places.map((p) => [p.id, p]))
  const placeProblem_ = (p: Place) => placeProblem(p, evidence.families)
  const runs = new Map(evidence.runs.map((r) => [r.record, r]))
  const values = [...new Set(evidence.runs.flatMap((r) => r.values))]
  const subject = evidence.runs[0]?.subject ?? evidence.places[0]?.subject ?? ""
  const leak = (where: string, text: string | null) => {
    if (text === null) return false
    const v = namedValue(text, values)
    if (v !== undefined) problems.push(`${where} names a task's own value ${JSON.stringify(v)}: write a blank instead`)
    return v !== undefined
  }

  // Pitfalls: real detours, general words, a trigger that singles out the mistake.
  const pitfalls: Array<Pitfall> = []
  for (const p of answer.pitfalls) {
    const id = slug(p.id)
    if (pitfalls.some((x) => x.id === id)) continue
    const detours = p.detours.flatMap((ref) => {
      const m = /^(.+)#(\d+)$/.exec(ref.trim())
      const run = m === null ? undefined : runs.get(m[1])
      const d = run?.detours[Number(m?.[2])]
      if (run === undefined || d === undefined) {
        problems.push(`pitfall ${id} refers to ${JSON.stringify(ref)}, which is no detour of these runs`)
        return []
      }
      return [{ run, index: Number(m![2]), detour: d }]
    })
    if (detours.length === 0) {
      problems.push(`pitfall ${id} comes from no detour of these runs; dropped`)
      continue
    }
    if (leak(`pitfall ${id}`, p.text)) continue
    let trigger = p.trigger
    if (trigger !== null) {
      const own = triggerValue(trigger, values.map((value) => ({ value })))
      const problem = triggerProblem(trigger) ??
        (own === undefined ? undefined : `it names a task's own value ${JSON.stringify(own)}`) ??
        detours.map((x) => mismatch(trigger!, x.run, x.detour.failed.call, x.detour.fixed.call)).find((m) => m !== undefined)
      if (problem !== undefined) {
        problems.push(`the trigger of pitfall ${id} (${describeTrigger(trigger)}): ${problem}; dropped the trigger`)
        trigger = null
      }
    }
    pitfalls.push({
      id,
      subject,
      text: p.text.trim(),
      trigger,
      evidence: [...new Set(detours.map((x) => x.run.record))].sort(),
      cost_tokens: median(detours.map((x) => x.detour.cost.tokens))
    })
  }
  const pitfallIds = new Set(pitfalls.map((p) => p.id))

  // Workflows: known places, blanks instead of values, real runs.
  const workflows: Array<Workflow> = []
  for (const w of answer.workflows) {
    const id = slug(w.id)
    if (workflows.some((x) => x.id === id)) {
      problems.push(`two workflows are named ${id}; kept the first`)
      continue
    }
    const where = `workflow ${id}`
    const texts = [w.name, w.use_when, ...w.blanks.map((b) => b.meaning), ...w.checks]
    if (texts.some((t) => leak(where, t))) continue
    const steps = w.steps.flatMap((s, i) => {
      if (leak(`step ${i + 1} of ${id}`, s.do) || leak(`step ${i + 1} of ${id}`, s.when)) return []
      if (s.place === null) return [s]
      const p = places.get(s.place)
      if (p === undefined) {
        problems.push(`step ${i + 1} of ${id} names ${JSON.stringify(s.place)}, which isn't a listed place; it now has none`)
        return [{ ...s, place: null }]
      }
      const weak = placeProblem_(p)
      if (weak !== undefined) {
        problems.push(`step ${i + 1} of ${id} names ${p.id}, ${weak}: use place null and say how to find the spot; it now has none`)
        return [{ ...s, place: null }]
      }
      return [s]
    })
    if (steps.length === 0) {
      problems.push(`${where} has no steps left; dropped`)
      continue
    }
    const fromRuns = w.from_runs.filter((r) => runs.has(r))
    const used = steps.flatMap((s) => (s.place === null ? [] : [places.get(s.place)!]))
    const evidence = [...new Set([...fromRuns, ...used.flatMap((p) => p.evidence)])].sort()
    workflows.push({
      id,
      subject,
      name: w.name.trim(),
      use_when: w.use_when.trim(),
      blanks: w.blanks.map((b) => ({ name: b.name.replace(/^\{+|\}+$/g, "").trim(), meaning: b.meaning.trim() })),
      steps,
      only_if_asked: w.only_if_asked,
      checks: w.checks.map((c) => c.trim()).filter((c) => c !== ""),
      pitfalls: w.pitfalls.map(slug).filter((p) => pitfallIds.has(p)),
      evidence,
      tasks: [...new Set(evidence.map((r) => runs.get(r)?.task).filter((t): t is string => t !== undefined))].sort()
    })
  }

  // Edges between known workflows; every workflow reachable from start and leading to end.
  const ids = new Set(workflows.map((w) => w.id))
  const known = (x: string) => x === START || x === END || ids.has(x)
  const edges: Array<Edge> = []
  for (const e of answer.edges) {
    const from = e.from === START || e.from === END ? e.from : slug(e.from)
    const to = e.to === START || e.to === END ? e.to : slug(e.to)
    if (!known(from) || !known(to) || from === END || to === START || from === to) {
      problems.push(`edge ${e.from} -> ${e.to} joins unknown workflows; dropped`)
      continue
    }
    if (leak(`edge ${from} -> ${to}`, e.condition) || leak(`edge ${from} -> ${to}`, e.guidance) || leak(`edge ${from} -> ${to}`, e.pitfalls)) continue
    if (edges.some((x) => x.from === from && x.to === to)) continue
    edges.push({ ...e, from, to })
  }
  for (const w of workflows) {
    if (!edges.some((e) => e.to === w.id)) edges.push({ from: START, to: w.id, relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null })
    if (!edges.some((e) => e.from === w.id)) edges.push({ from: w.id, to: END, relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null })
  }

  const usedPlaces = new Set(workflows.flatMap((w) => w.steps.flatMap((s) => (s.place === null ? [] : [s.place]))))
  const unused = evidence.places.filter((p) => !usedPlaces.has(p.id) && p.tasks.length > 1)
  for (const p of unused) problems.push(`place ${p.id} (${describePlace(p)}), edited by ${p.tasks.length} tasks, is in no workflow`)

  return {
    memory: {
      format: FORMAT,
      tenant,
      places: evidence.places.filter((p) => usedPlaces.has(p.id)),
      workflows,
      edges,
      // Pitfalls in no workflow still warn when their trigger fires.
      pitfalls
    },
    problems
  }
}

/** Why a trigger doesn't single out a detour's mistake in its run, or undefined if it does. */
const mismatch = (trigger: Trigger, run: RunEvidence, failedAt: number, fixedAt: number): string | undefined => {
  if (run.calls.length === 0) return undefined
  const relative = relativizer(run.cwd)
  return triggerMismatch(trigger, run.calls, failedAt, fixedAt, (c: ToolCall | undefined) => (c === undefined ? undefined : eventOfCall(c, relative)))
}

export interface InduceConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
  readonly effort?: string | undefined
}

export const DEFAULT_INDUCE_MODEL = "sonnet"
export const DEFAULT_INDUCE_EFFORT = "high"

export interface Induced extends Checked {
  readonly rationale: string
  readonly costUsd: number
  readonly calls: number
}

/**
 * Induce memory from evidence (revising `current`, when there is one): one
 * model call, and one more to fix what the checks found.
 */
export const induce = Effect.fn("induce")(function*(
  config: InduceConfig,
  evidence: Evidence,
  tenant: string,
  current?: WorkflowMemory,
  /** More sections for the model to read: how memory did on the runs, revisions rejected before. */
  extra: ReadonlyArray<string> = []
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
      system: INDUCE_PROMPT,
      prompt: inductionPrompt(evidence, current, notes, previous, extra),
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
    result = checkAnswer(answer.value, evidence, tenant)
    // Only problems the model can fix are worth a second call: values, places, triggers.
    const fixable = result.problems.filter((p) => !p.includes("is in no workflow"))
    if (fixable.length === 0) break
    notes = fixable
    previous = answer.value
  }
  return { ...result!, rationale, costUsd, calls } satisfies Induced
})
