/**
 * Learning web memory: a model reads a web app's recorded sessions (actions
 * with their places, how each session went and what the manager said, what
 * pages showed) and proposes workflows with blanks, the graph between them,
 * and pitfalls, in the same format as code memory (src/workflows/Induce.ts).
 *
 * Sessions that failed count: their feedback and the pages' messages are
 * where an app's rules are learned, including rules it never states.
 *
 * Then the answer is checked mechanically, as for code: no text may carry a
 * task's own values; a step's place must be one where two sessions acted; a
 * pitfall must come from something sessions showed; a trigger must be
 * specific. Problems go back to the model once; what still fails is dropped.
 */
import { Effect } from "effect"
import { callStructured } from "../eval/Llm.ts"
import { describeTrigger, triggerProblem } from "../records/Triggers.ts"
import { type InduceConfig, type InductionAnswer, InductionAnswer as InductionAnswerSchema, namedValue } from "../workflows/Induce.ts"
import { type Edge, END, FORMAT, type Pitfall, type Place, START, type Workflow, type WorkflowMemory } from "../workflows/Models.ts"
import { describeWebPlace, webPlace } from "./Places.ts"
import type { WebRecord } from "./Records.ts"

export interface WebRun {
  readonly record: string
  readonly task: string
  readonly prompt: string
  readonly values: ReadonlyArray<string>
  readonly success: boolean | null
  readonly feedback: string | null
  readonly actions: WebRecord["actions"]
  readonly messages: WebRecord["messages"]
  readonly turns: number | null
}

export interface WebEvidence {
  readonly subject: string
  readonly places: ReadonlyArray<Place>
  readonly runs: ReadonlyArray<WebRun>
}

export const taskOf = (r: WebRecord): string => r.task_id ?? r.prompt.trim().replace(/\s+/g, " ").slice(0, 60)

/** A subject's records as evidence: places pooled across sessions, each with the sessions that acted there. */
export const webEvidence = (subject: string, records: ReadonlyArray<WebRecord>): WebEvidence => {
  const pooled = new Map<string, { page: string; chain: ReadonlyArray<{ role: string; name: string }>; evidence: Set<string>; tasks: Set<string>; uses: number }>()
  for (const r of records) {
    for (const a of r.actions) {
      if (a.failed || a.place === null || a.page === null || a.chain === null) continue
      const p = pooled.get(a.place) ?? { page: a.page, chain: a.chain, evidence: new Set(), tasks: new Set(), uses: 0 }
      p.evidence.add(r.id)
      p.tasks.add(taskOf(r))
      p.uses++
      pooled.set(a.place, p)
    }
  }
  const places = [...pooled.values()].map((p) => webPlace(subject, p.page, p.chain, [...p.evidence].sort(), [...p.tasks].sort(), p.uses))
  const runs = records.map((r): WebRun => ({
    record: r.id,
    task: taskOf(r),
    prompt: r.prompt,
    values: r.values,
    success: r.success,
    feedback: r.feedback,
    actions: r.actions,
    messages: r.messages,
    turns: r.turns
  }))
  return { subject, places, runs }
}

export const WEB_INDUCE_PROMPT = `You build procedural memory for a computer-use agent from its past sessions in one web application (an internal business tool). The agent works only through a browser: it reads each page as an accessibility snapshot (roles and names) and clicks, types, selects and presses keys.

From the sessions you are given, extract reusable workflows: small sub-routines that different tasks in this app share. Connect them in a graph, and keep the mistakes and rules worth a warning. Later, when a new task starts, memory picks the workflows the task needs by their purpose, and hands them to the agent with each step's place. Write for that agent: what to do and where, in general words.

## Workflows

- A workflow is finer than a task: not "refund order 4821", but the parts such tasks are made of, each of which another task could need on its own: "find an order", "issue a refund", "add a note to a customer".
- Abstract the task away. Where a session used the task's own values (an order number, a customer's name, an amount, a date, a reason), write a blank: a descriptive name in braces, such as {order_number}, {customer}, {amount}, and list it in \`blanks\` with its meaning. Never write a task's own values.
- Each step says what to do and where:
  - \`place\`: the id of one of the listed places where sessions acted (a control, with the page and the regions around it). At use, memory looks for the place in the page the agent has open and points to it there. Say what to do with it ("open More actions, then choose Refund").
  - \`place: null\` when the control isn't among the listed places, or is only usable through one session; then say how to find it.
  - \`when\`: if a step applies only in some cases, say when, in words a new task's text can decide. Null if always.
- Tell apart what tasks asked for, what the app needed although the task didn't say so (a required field, a confirmation, a reason code), and what a session did that turned out wrong. Learn from failed sessions too: a step that failed or a check that failed says what not to do.
- Keep each workflow complete for its purpose, its steps in the order they are best done. \`from_runs\`: ids of the sessions it was learned from.
- \`use_when\`: what in a task's text means the workflow is needed.
- \`checks\`: how the agent can confirm the work in the app (what a page should show afterwards), in plain words. May be empty.

## The graph

\`edges\` connect workflows from "start" to "end", in the order tasks usually take them. An edge's \`condition\` says when a task takes it (null if always), \`guidance\` how to go on, \`pitfalls\` what to avoid at that point. Relations: LEADS_TO, TRIGGERS, PROVIDES_INPUT_FOR or CONVERGES_TO.

## Pitfalls and rules

From what went wrong, keep what another task could run into again, in general words: what goes wrong and what to do instead. Sources, which you cite in \`detours\` (the field's name is historical):
- "<session id>#<action number>": an action that failed, or that a later message or the feedback shows was wrong;
- "<session id>#feedback": what the manager said after the session (the app's rules, including ones it never shows on screen);
- "<session id>#message<k>": a message a page showed (an alert, an error, a status line), numbered from 1 as listed.
When revising current memory, keep its pitfalls unless the sessions show them wrong (sessions that avoided a mistake don't make it wrong); list a kept pitfall with its id and empty detours.

A pitfall may have an exact \`trigger\` that tells it is about to happen, checked after every browser call: plain substrings, never regular expressions, never a task's own values, at least one of 5 characters or more.
- \`on: "page"\`: the page the agent just read shows every string in \`all\` and none in \`none\` (words of a dialog, a form's label, a heading), so the warning comes before the agent acts on it.
- \`on: "action"\`: the control an action used is named with every string in \`all\`.
- \`on: "error"\`: a failed browser call whose output contains every string in \`all\`.
\`file\` is always null. Use a null trigger when there are no such strings; a pitfall without a trigger is handed over at the start with its workflow, or as a rule of the app when no workflow carries it.

\`entries\` is always an empty list here. Ids: short kebab-case names in general words ("find-order", "refund-needs-manager-note").`

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ")
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"

const describeAction = (a: WebRecord["actions"][number]): string => {
  const where = a.place !== null ? `${a.place}` : a.chain !== null ? `${a.page ?? "?"} › ${a.chain.map((c) => (c.name === "" ? c.role : `${c.role} "${c.name}"`)).join(" › ")}` : a.page ?? ""
  const what = a.kind === "navigate" ? `went to ${a.page ?? "?"}` : `${a.kind} ${where}`
  const text = a.text === null ? "" : ` with ${code(clip(oneLine(a.text), 120))}`
  const failed = a.failed ? `; FAILED: ${clip(oneLine(a.error ?? ""), 200)}` : ""
  return `#${a.index} ${what}${text}${failed}`
}

/** What the model reads: the places, then each task with its sessions; on a second try, its answer and what was wrong. */
export const webInductionPrompt = (evidence: WebEvidence, current: WorkflowMemory | undefined, notes: ReadonlyArray<string> = [], previous?: InductionAnswer): string => {
  const lines: Array<string> = []
  if (current !== undefined && (current.workflows.length > 0 || current.pitfalls.length > 0)) {
    lines.push(
      "## Current memory",
      "",
      "Revise it rather than starting over: keep what the sessions still support, change what they show is wrong or missing.",
      "",
      "```json",
      JSON.stringify({ workflows: current.workflows.map(({ cues: _c, ...w }) => w), edges: current.edges, pitfalls: current.pitfalls }, null, 1),
      "```",
      ""
    )
  }
  lines.push("## Places where sessions acted", "", "Use these ids in steps. Each is a control: the page (its address as a pattern) and the regions around it.", "")
  for (const p of evidence.places) {
    const weak = p.evidence.length < 2 ? ". Not for a step: only one session acted here" : ""
    lines.push(`- ${p.id} ${code(describeWebPlace(p))}: ${p.evidence.length} session${p.evidence.length === 1 ? "" : "s"} of ${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"}, used ${p.edits.change} times${weak}`)
  }
  lines.push("", "## Tasks and their sessions", "")
  for (const task of [...new Set(evidence.runs.map((r) => r.task))]) {
    const runs = evidence.runs.filter((r) => r.task === task)
    const values = [...new Set(runs.flatMap((r) => r.values))]
    lines.push(`### Task ${JSON.stringify(task)}`, "", "Request:", "")
    for (const l of runs[0].prompt.trim().split(/\r?\n/)) lines.push(`> ${l}`)
    lines.push("", `Its own values, never to be written in memory: ${values.map(code).join(", ") || "(none found)"}`, "")
    for (const r of runs) {
      const how = r.success === true ? "succeeded" : r.success === false ? "FAILED" : "outcome unknown"
      lines.push(`#### Session ${r.record} (${how}${r.turns === null ? "" : `, ${r.turns} turns`})`, "")
      if (r.feedback !== null) lines.push(`Feedback afterwards: ${JSON.stringify(r.feedback)}`)
      lines.push("Actions, in order:")
      const messagesAfter = new Map<number, Array<{ k: number; text: string }>>()
      r.messages.forEach((m, k) => messagesAfter.set(m.after, [...(messagesAfter.get(m.after) ?? []), { k: k + 1, text: m.text }]))
      for (const m of messagesAfter.get(-1) ?? []) lines.push(`  message${m.k}: the page showed ${JSON.stringify(clip(m.text, 200))}`)
      for (const a of r.actions) {
        lines.push(`- ${describeAction(a)}`)
        for (const m of messagesAfter.get(a.index) ?? []) lines.push(`  message${m.k}: the page showed ${JSON.stringify(clip(m.text, 200))}`)
      }
      lines.push("")
    }
  }
  if (previous !== undefined) lines.push("## Your previous answer", "", "```json", JSON.stringify(previous, null, 1), "```", "")
  if (notes.length > 0) lines.push("## Problems in your previous answer", "", "Answer again in full, with these fixed and everything else kept:", "", ...notes.map((n) => `- ${n}`), "")
  return lines.join("\n")
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item"

export interface WebChecked {
  readonly memory: WorkflowMemory
  readonly problems: ReadonlyArray<string>
}

/** Check an answer against the sessions; keep what holds. */
export const checkWebAnswer = (answer: InductionAnswer, evidence: WebEvidence, tenant: string, current?: WorkflowMemory): WebChecked => {
  const problems: Array<string> = []
  const places = new Map(evidence.places.map((p) => [p.id, p]))
  const runs = new Map(evidence.runs.map((r) => [r.record, r]))
  const values = [...new Set(evidence.runs.flatMap((r) => r.values))]
  const subject = evidence.subject
  const leak = (where: string, text: string | null) => {
    if (text === null) return false
    const v = namedValue(text, values)
    if (v !== undefined) problems.push(`${where} names a task's own value ${JSON.stringify(v)}: write a blank instead`)
    return v !== undefined
  }
  const refOk = (ref: string): string | undefined => {
    const m = /^(.+)#(feedback|message\d+|\d+)$/.exec(ref.trim())
    if (m === null) return undefined
    const r = runs.get(m[1])
    if (r === undefined) return undefined
    if (m[2] === "feedback") return r.feedback === null ? undefined : r.record
    if (m[2].startsWith("message")) return r.messages[Number(m[2].slice(7)) - 1] === undefined ? undefined : r.record
    return r.actions.some((a) => a.index === Number(m[2])) ? r.record : undefined
  }

  const pitfalls: Array<Pitfall> = []
  const learned = new Map((current?.pitfalls ?? []).map((x) => [x.id, x]))
  for (const p of answer.pitfalls) {
    const id = slug(p.id)
    if (pitfalls.some((x) => x.id === id)) continue
    const before = learned.get(id)
    const sources = p.detours.flatMap((ref) => {
      const r = refOk(ref)
      if (r === undefined && before === undefined) problems.push(`pitfall ${id} cites ${JSON.stringify(ref)}, which is no action, feedback or message of these sessions`)
      return r === undefined ? [] : [r]
    })
    if (sources.length === 0 && before === undefined) {
      problems.push(`pitfall ${id} comes from nothing these sessions showed; dropped`)
      continue
    }
    if (leak(`pitfall ${id}`, p.text)) {
      if (before !== undefined) pitfalls.push(before)
      continue
    }
    let trigger = p.trigger
    if (trigger !== null) {
      const own = trigger.all.concat(trigger.none).map((s) => namedValue(s, values)).find((v) => v !== undefined)
      const problem = (trigger.on === "command" || trigger.on === "edit" ? "web memory's triggers are on page, action or error" : undefined) ??
        triggerProblem({ ...trigger, file: null }) ??
        (own === undefined ? undefined : `it names a task's own value ${JSON.stringify(own)}`)
      if (problem !== undefined) {
        problems.push(`the trigger of pitfall ${id} (${describeTrigger(trigger)}): ${problem}; dropped the trigger`)
        trigger = null
      } else {
        trigger = { ...trigger, file: null }
      }
    }
    pitfalls.push({
      id,
      subject,
      text: p.text.trim(),
      trigger: trigger ?? before?.trigger ?? null,
      evidence: [...new Set([...(before?.evidence ?? []), ...sources])].sort(),
      cost_tokens: before?.cost_tokens ?? 0
    })
  }
  const pitfallIds = new Set(pitfalls.map((p) => p.id))

  const workflows: Array<Workflow> = []
  for (const w of answer.workflows) {
    const id = slug(w.id)
    if (workflows.some((x) => x.id === id)) {
      problems.push(`two workflows are named ${id}; kept the first`)
      continue
    }
    const where = `workflow ${id}`
    if ([w.name, w.use_when, ...w.blanks.map((b) => b.meaning), ...w.checks].some((t) => leak(where, t))) continue
    const steps = w.steps.flatMap((s, i) => {
      if (leak(`step ${i + 1} of ${id}`, s.do) || leak(`step ${i + 1} of ${id}`, s.when)) return []
      if (s.place === null) return [s]
      const p = places.get(s.place)
      if (p === undefined) {
        problems.push(`step ${i + 1} of ${id} names ${JSON.stringify(s.place)}, which isn't a listed place; it now has none`)
        return [{ ...s, place: null }]
      }
      if (p.evidence.length < 2) {
        problems.push(`step ${i + 1} of ${id} names ${p.id}, where only one session acted: use place null and say how to find the control; it now has none`)
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
    const evidenceIds = [...new Set([...fromRuns, ...used.flatMap((p) => p.evidence)])].sort()
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
      evidence: evidenceIds,
      tasks: [...new Set(evidenceIds.map((r) => runs.get(r)?.task).filter((t): t is string => t !== undefined))].sort()
    })
  }

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
  return {
    memory: { format: FORMAT, tenant, places: evidence.places.filter((p) => usedPlaces.has(p.id)), workflows, edges, pitfalls },
    problems
  }
}

export interface WebInduced extends WebChecked {
  readonly rationale: string
  readonly costUsd: number
  readonly calls: number
}

/** Induce web memory for one app: one model call, and one more to fix what the checks found. */
export const induceWeb = Effect.fn("induceWeb")(function*(config: InduceConfig, evidence: WebEvidence, tenant: string, current?: WorkflowMemory) {
  let notes: ReadonlyArray<string> = []
  let previous: InductionAnswer | undefined
  let costUsd = 0
  let calls = 0
  let result: WebChecked | undefined
  let rationale = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = yield* callStructured({
      claude: config.claude,
      system: WEB_INDUCE_PROMPT,
      prompt: webInductionPrompt(evidence, current, notes, previous),
      schema: InductionAnswerSchema,
      model: config.model,
      effort: config.effort,
      cwd: config.cwd,
      maxBudgetUsd: 3,
      timeoutS: 1200
    })
    calls++
    costUsd += answer.costUsd ?? 0
    rationale = answer.value.rationale
    result = checkWebAnswer(answer.value, evidence, tenant, current)
    if (result.problems.length === 0) break
    notes = result.problems
    previous = answer.value
  }
  return { ...result!, rationale, costUsd, calls } satisfies WebInduced
})
