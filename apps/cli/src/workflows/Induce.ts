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
 * one that fixed it); edges must lead from `start` to `end`. What only the
 * model can fix (a task's own value written in, a pitfall from no detour of
 * the runs) goes back to it once, alone; the checks fix the rest themselves,
 * and whatever still fails is dropped and reported.
 *
 * Revising memory, the model reads it in a compact form (`memoryText`) and
 * answers with what changes only (`RevisionAnswer`, `applyRevision`).
 */
import { Effect, Schema } from "effect"
import type { ModelCli } from "../eval/Llm.ts"
import { callModel } from "../eval/ModelCall.ts"
import { triggerMismatch, triggerValue } from "../records/Annotate.ts"
import { relativizer } from "../records/Extract.ts"
import type { Detour } from "../records/Models.ts"
import { describeTrigger, eventOfCall, matchTrigger, Trigger, triggerKey, triggerProblem } from "../records/Triggers.ts"
import type { ToolCall } from "../traces/index.ts"
import { type Evidence, type RunEvidence, shapeOf } from "./Evidence.ts"
import {
  Blank,
  Edge,
  END,
  FORMAT,
  graphOrder,
  isReadPlace,
  type Pitfall,
  type Place,
  START,
  triggersOf,
  withShow,
  withTriggers,
  type Workflow,
  type WorkflowMemory
} from "./Models.ts"
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
  trigger: Schema.NullOr(Trigger),
  /** More triggers for the same mistake, one per other way it shows; any of them fires it. */
  also: Schema.Array(Trigger)
})
export type ProposedPitfall = typeof ProposedPitfall.Type

export const InductionAnswer = Schema.Struct({
  workflows: Schema.Array(ProposedWorkflow),
  edges: Schema.Array(Edge),
  pitfalls: Schema.Array(ProposedPitfall),
  /** Places the hand-over shows as one whole entry rather than the end of their block. */
  entries: Schema.Array(Schema.String),
  rationale: Schema.String
})
export type InductionAnswer = typeof InductionAnswer.Type

/**
 * A revision's answer: what changes in current memory, the rest staying as
 * it is (`applyRevision`). Rewriting all of memory twice was a quarter of a
 * learning round's bill, and grows with memory.
 */
export const RevisionAnswer = Schema.Struct({
  /** Workflows added or changed, each in full. */
  workflows: Schema.Array(ProposedWorkflow),
  /** Ids of current workflows to take out. */
  removed_workflows: Schema.Array(Schema.String),
  /** The edges from and to each workflow added or changed (they replace its old ones), and edges added or changed between others. */
  edges: Schema.Array(Edge),
  /** Pitfalls added or changed, each in full. */
  pitfalls: Schema.Array(ProposedPitfall),
  /** Ids of current pitfalls to take out. */
  removed_pitfalls: Schema.Array(Schema.String),
  /** All of them, as they should be. */
  entries: Schema.Array(Schema.String),
  rationale: Schema.String
})
export type RevisionAnswer = typeof RevisionAnswer.Type

/** The parts of an answer that were flagged, fixed (`fixPrompt`). */
export const FixAnswer = Schema.Struct({
  workflows: Schema.Array(ProposedWorkflow),
  pitfalls: Schema.Array(ProposedPitfall),
  edges: Schema.Array(Edge)
})
export type FixAnswer = typeof FixAnswer.Type

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

From the detours (a call that failed, and how many turns it took until fixed), keep the mistakes another task could make again, in general words: what goes wrong and what to do instead. When revising current memory, its pitfalls stay unless you take one out: runs that no longer hit a pitfall show it works, not that it is wrong. Leave out:
- failures that were simply the task's work in progress (a test failing until the feature was done);
- bugs in the code that the change itself fixed: the code has the fix now, so no task meets them again;
- what the agent's own instructions in this repository already say (shown below, when it has them): the agent reads them in every session. Take such pitfalls out of current memory too.
Keep one pitfall per remedy: mistakes another task avoids the same way (scripted edits that broke on quotes, on an anchor they didn't find, or on line endings: use the editor tool) are one pitfall, with a trigger for each way it shows. Refer to the detours a pitfall comes from as "<run id>#<detour number>", and list its id in the workflows it belongs to.

Every pitfall needs a trigger, checked after every tool call, so that its warning comes when the mistake is made; a pitfall without one is dropped. Plain substrings, never regular expressions, and never a task's own values.
- \`on: "error"\`: a call that failed printed every string in \`all\` (\`file\` null). Use the exact words of the message the failing call printed, as its detour shows them, specific enough that no other failure prints them ('Unterminated string literal', not 'error'). It never fires on a read or a search, nor on a call that worked.
- \`on: "command"\`: a shell command containing every string in \`all\` and none in \`none\` (\`file\` null), for a mistake that prints no message of its own: the risky command itself. There is no hook before a call, so the warning comes right after the command it matches; for something to do before committing, trigger on \`git add\`, which comes before the commit. It never fires on a command that only reads.
- \`on: "edit"\`: an edit (to a file whose path ends with \`file\`, if given) writing text that contains every string in \`all\` and none in \`none\`.
\`trigger\` is the first; \`also\` lists more for the same mistake, one per other message or command it shows as, any of which fires it. Each must match the call that failed in one of its detours and not the call that fixed it.

## Entries

The hand-over shows each step's place as the end of its block (its last lines), found in the code when used. \`entries\` lists the ids of places it should show as one whole entry instead: the last component, the last tag with its attributes, or for places where new files go, the shortest existing file of the kind. Only for places where an entry takes several lines and runs had to read one before they could write theirs (when you are told what runs looked up). Keep the current memory's entries unless runs show they aren't needed; leave the list empty otherwise.

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

/** The most turns a detour's cost is shown as ("30+ turns"). */
export const MAX_TURNS_SHOWN = 30

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

export const describeDetour = (r: RunEvidence, i: number): string => {
  const d = r.detours[i]
  const call = (c: typeof d.failed) => c.command !== null ? `${c.tool} ${code(clip(oneLine(c.command), 160))}` : `${c.tool}${c.file ? ` ${c.file}` : ""}`
  const edits = fixEdits(r, d.failed.call, d.fixed.call)
  const between = edits.length > 0
    ? `; edits in between: ${edits.join("; ")}`
    : d.files_edited.length > 0 ? `; edited ${d.files_edited.join(", ")} in between` : ""
  // Its cost in turns: summed tokens count the whole conversation again every turn, so a long thread's look huge.
  // A fix found much later is mostly other work in between: the cost shown stops at MAX_TURNS_SHOWN; the record keeps it all.
  const turns = d.cost.turns > MAX_TURNS_SHOWN ? `${MAX_TURNS_SHOWN}+ turns` : `${d.cost.turns} turn${d.cost.turns === 1 ? "" : "s"}`
  return `- #${i} (${d.kind}, ${turns} until fixed): ${call(d.failed)} failed: "${clip(oneLine(d.symptom), 220)}". ` +
    `Fixed by ${call(d.fixed)}${between}.`
}

/**
 * Current memory as the model reads it to revise it: every field it may write
 * back, without what memory keeps for itself (cues, the runs a workflow came
 * from, snapshots) or JSON's quoting, in under half the characters.
 */
export const memoryText = (m: WorkflowMemory): string => {
  const lines: Array<string> = []
  for (const w of graphOrder(m)) {
    lines.push(`### ${w.id}${w.only_if_asked ? " (only_if_asked)" : ""}`, `Name: ${w.name}`, `Use when: ${w.use_when}`)
    if (w.blanks.length > 0) lines.push(`Blanks: ${w.blanks.map((b) => `{${b.name}} ${b.meaning}`).join("; ")}`)
    w.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.do}${s.place === null ? "" : ` [place: ${s.place}]`}${s.when === null ? "" : ` [when: ${s.when}]`}`))
    if (w.checks.length > 0) lines.push(`Checks: ${w.checks.map(code).join("; ")}`)
    if (w.pitfalls.length > 0) lines.push(`Pitfalls: ${w.pitfalls.join(", ")}`)
    lines.push("")
  }
  const edge = (e: Edge) =>
    `- ${e.from} -> ${e.to} (${e.relation})${e.condition === null ? "" : `, condition: ${e.condition}`}` +
    `${e.guidance === null ? "" : `, guidance: ${e.guidance}`}${e.pitfalls === null ? "" : `, pitfalls: ${e.pitfalls}`}`
  lines.push("Edges:", ...m.edges.map(edge), "")
  if (m.pitfalls.length > 0) {
    const triggers = (p: Pitfall) => {
      const [first, ...also] = triggersOf(p)
      return first === undefined ? " No trigger yet." : ` Trigger: ${JSON.stringify(first)}${also.length === 0 ? "" : ` Also: ${also.map((t) => JSON.stringify(t)).join(", ")}`}`
    }
    lines.push("Pitfalls:", ...m.pitfalls.map((p) => `- ${p.id}: ${p.text}${triggers(p)}`))
  }
  return lines.join("\n")
}

const REVISE = [
  "Revise it: keep what the runs still support, change what they show is wrong or missing. Answer with what changes, and only that:",
  "- `workflows`: each workflow you add or change, in full. One you leave out stays as it is.",
  "- `removed_workflows`: the ids of workflows to take out.",
  "- `edges`: every edge from or to a workflow you add or change (they replace its old edges), and any edge you add or change between others.",
  "- `pitfalls`: each pitfall you add or change, in full, with `detours` empty unless these runs made its mistake again. One you leave out stays as it is.",
  "- `removed_pitfalls`: the ids of pitfalls to take out.",
  "- `entries`: all of them, as they should be."
].join("\n")

/** What the model reads: current memory (to revise, with how to answer), the places, then each task with its runs. */
export const inductionPrompt = (evidence: Evidence, current: WorkflowMemory | undefined, extra: ReadonlyArray<string> = []): string => {
  const lines: Array<string> = []
  if (current !== undefined && current.workflows.length > 0) lines.push("## Current memory", "", REVISE, "", memoryText(current), "")
  lines.push("## Places where the runs edited", "", "Use these ids in steps. Each is a block found by the blocks around it, a group of top-level statements that start alike, or a directory new files go in.", "")
  const read = evidence.places.filter(isReadPlace)
  for (const p of evidence.places.filter((x) => !isReadPlace(x))) {
    const counts = [p.edits.add > 0 ? `added ${p.edits.add}` : "", p.edits.change > 0 ? `changed ${p.edits.change}` : "", p.edits.create > 0 ? `created ${p.edits.create}` : ""].filter(Boolean).join(", ")
    const weak = placeProblem(p, evidence.families)
    lines.push(
      `- ${p.id} ${describePlace(p)}: ${p.evidence.length} runs of ${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"} (${p.tasks.join(", ")}); ${counts}` +
        (weak === undefined ? "" : `. Not for a step: ${weak}`) +
        (p.show === "entry" ? ". Shown as a whole entry (in `entries`)" : "")
    )
  }
  if (read.length > 0) {
    lines.push(
      "",
      "## Places runs read",
      "",
      "Blocks in code runs read without changing it (a test helper's class); a step may name one where the agent should look, and the hand-over shows it as an outline: its first line and the first line of each member.",
      ""
    )
    for (const p of read) lines.push(`- ${p.id} ${describePlace(p)}: read by ${p.evidence.length} runs of ${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"} (${p.tasks.join(", ")})`)
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

/**
 * What of an answer a model call can fix, by the ids it proposed (as
 * slugs): what named a task's own value, and pitfalls whose detours aren't
 * these runs'. The rest the checks fix themselves (a place one run edited
 * goes from its step, a trigger that doesn't single out its mistake goes).
 */
export interface Flagged {
  readonly workflows: ReadonlyArray<string>
  readonly pitfalls: ReadonlyArray<string>
  /** Edges by their ends. */
  readonly edges: ReadonlyArray<readonly [string, string]>
}

export interface Checked {
  readonly memory: WorkflowMemory
  /** Problems the model should fix, then what was dropped. */
  readonly problems: ReadonlyArray<string>
  /** Places shown as a whole entry: the answer's `entries` that steps use. */
  readonly entries: ReadonlyArray<string>
  readonly flagged: Flagged
  /** Each pitfall's detours, in words, for a second call asked to give one its trigger. */
  readonly pitfallDetours: ReadonlyMap<string, ReadonlyArray<string>>
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
export const placeProblem = (p: Place, families: ReadonlyMap<string, string>, minTasks = 1): string | undefined => {
  const did = isReadPlace(p) ? "read" : "edited"
  if (p.evidence.length < 2) return `which only one run ${did}`
  if (minTasks > 1 && p.tasks.length < minTasks) return `which runs of only ${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"} ${did}: it must be shared by ${minTasks}`
  const family = p.new_file === null ? families.get(p.file) : undefined
  if (family !== undefined && p.tasks.length < 2) return `whose file is one of several named ${JSON.stringify(family + "…")} that only one task edited: that task's own file`
  return undefined
}

export interface CheckOptions {
  /**
   * For memory learned across tasks of a kind (Common.ts): how many tasks'
   * runs a workflow, and a place a step names, must come from.
   */
  readonly minTasks?: number
  /**
   * The runs memory learned from before these: a pitfall memory already has
   * is checked against the detours of the runs it came from.
   */
  readonly learnedRuns?: ReadonlyArray<RunEvidence>
}

/**
 * Check a model's answer against the evidence; keep what holds. When revising
 * `current`, a pitfall it already has may come back without new detours: the
 * runs that avoided its mistake don't make it wrong.
 */
export const checkAnswer = (answer: InductionAnswer, evidence: Evidence, tenant: string, current?: WorkflowMemory, options: CheckOptions = {}): Checked => {
  const problems: Array<string> = []
  const minTasks = options.minTasks ?? 1
  const places = new Map(evidence.places.map((p) => [p.id, p]))
  const placeProblem_ = (p: Place) => placeProblem(p, evidence.families, minTasks)
  const runs = new Map(evidence.runs.map((r) => [r.record, r]))
  const values = [...new Set(evidence.runs.flatMap((r) => r.values))]
  const subject = evidence.runs[0]?.subject ?? evidence.places[0]?.subject ?? ""
  const leak = (where: string, text: string | null) => {
    if (text === null) return false
    const v = namedValue(text, values)
    if (v !== undefined) problems.push(`${where} names a task's own value ${JSON.stringify(v)}: write a blank instead`)
    return v !== undefined
  }
  const flaggedWorkflows = new Set<string>()
  const flaggedPitfalls = new Set<string>()
  const flaggedEdges: Array<readonly [string, string]> = []

  // Pitfalls: real detours, general words, and triggers that fire where the mistake happened: one without any can't warn, and goes.
  const pitfalls: Array<Pitfall> = []
  const learned = new Map((current?.pitfalls ?? []).map((x) => [x.id, x]))
  // Memory's own pitfalls are checked against the runs memory learned them from, when the caller has them.
  const pastRuns = new Map([...(options.learnedRuns ?? []), ...evidence.runs].map((r) => [r.record, r]))
  const sitesOf: Map<string, ReadonlyArray<Site>> = new Map()
  for (const p of answer.pitfalls) {
    const id = slug(p.id)
    if (pitfalls.some((x) => x.id === id)) continue
    const before = learned.get(id)
    const detours = p.detours.flatMap((ref) => {
      const m = /^(.+)#(\d+)$/.exec(ref.trim())
      const run = m === null ? undefined : runs.get(m[1])
      const d = run?.detours[Number(m?.[2])]
      if (run === undefined || d === undefined) {
        if (before === undefined) problems.push(`pitfall ${id} refers to ${JSON.stringify(ref)}, which is no detour of these runs`)
        return []
      }
      return [{ run, index: Number(m![2]), detour: d }]
    })
    if (detours.length === 0 && before === undefined) {
      problems.push(`pitfall ${id} comes from no detour of these runs; dropped`)
      flaggedPitfalls.add(id)
      continue
    }
    const leaked = leak(`pitfall ${id}`, p.text)
    if (leaked && before === undefined) {
      flaggedPitfalls.add(id)
      continue
    }
    // Where its mistake happened: the detours it names, else (memory's own pitfall, which these runs didn't run into) those of the runs it was learned from.
    const sites: ReadonlyArray<Site> = detours.length > 0
      ? detours
      : (before?.evidence ?? []).flatMap((r) => {
        const run = pastRuns.get(r)
        return run === undefined ? [] : run.detours.map((detour, index) => ({ run, index, detour }))
      })
    sitesOf.set(id, sites)
    const fitting = (t: Trigger, from: string): boolean => {
      const own = triggerValue(t, values.map((value) => ({ value })))
      const problem = triggerProblem(t) ?? (own === undefined ? undefined : `it names a task's own value ${JSON.stringify(own)}`) ?? siteProblem(t, sites)
      if (problem !== undefined) problems.push(`${from} of pitfall ${id} (${describeTrigger(t)}): ${problem}; dropped the trigger`)
      return problem === undefined
    }
    const proposed = [...(p.trigger === null ? [] : [p.trigger]), ...p.also]
    // Memory's own triggers were checked when it learned them; only new ones are checked here.
    const had = new Set((before === undefined ? [] : triggersOf(before)).map(triggerKey))
    let triggers = proposed.filter((t) => had.has(triggerKey(t)) || fitting(t, "a trigger"))
    // None of the answer's fits: memory's own stay; else the messages it quotes that its failures printed.
    if (triggers.length === 0 && before !== undefined) triggers = triggersOf(before)
    if (triggers.length === 0) triggers = quotedTriggers(p.text, sites).filter((t) => fitting(t, "a trigger from its words"))
    if (triggers.length === 0) {
      problems.push(
        `pitfall ${id} has no trigger that fits its detours: give it the exact message its failing call printed (\`error\`), or the risky command (\`command\`); without one it is dropped`
      )
      flaggedPitfalls.add(id)
      continue
    }
    pitfalls.push(withTriggers({
      id,
      subject,
      text: leaked ? before!.text : p.text.trim(),
      trigger: null,
      evidence: [...new Set([...(before?.evidence ?? []), ...detours.map((x) => x.run.record)])].sort(),
      cost_tokens: detours.length > 0 ? median(detours.map((x) => x.detour.cost.tokens)) : before?.cost_tokens ?? 0
    }, triggers))
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
    const texts = [w.name, w.use_when, ...w.blanks.map((b) => b.meaning)]
    if (texts.some((t) => leak(where, t))) {
      flaggedWorkflows.add(id)
      continue
    }
    // A check that names a task's own value (the task's own test) is that task's: it goes, its workflow stays.
    const checks = w.checks.map((c) => c.trim()).filter((c) => c !== "" && !leak(`check ${JSON.stringify(c)} of ${id}`, c))
    const steps = w.steps.flatMap((s, i) => {
      if (leak(`step ${i + 1} of ${id}`, s.do) || leak(`step ${i + 1} of ${id}`, s.when)) {
        flaggedWorkflows.add(id)
        return []
      }
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
    const tasks = [...new Set(evidence.map((r) => runs.get(r)?.task).filter((t): t is string => t !== undefined))].sort()
    if (minTasks > 1 && tasks.length < minTasks) {
      problems.push(`${where} comes from runs of ${tasks.length === 0 ? "no task" : `only ${tasks.join(", ")}`}: it must be what runs of ${minTasks} different tasks did; dropped`)
      continue
    }
    workflows.push({
      id,
      subject,
      name: w.name.trim(),
      use_when: w.use_when.trim(),
      blanks: w.blanks.map((b) => ({ name: b.name.replace(/^\{+|\}+$/g, "").trim(), meaning: b.meaning.trim() })),
      steps,
      only_if_asked: w.only_if_asked,
      checks,
      pitfalls: w.pitfalls.map(slug).filter((p) => pitfallIds.has(p)),
      evidence,
      tasks
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
    if (leak(`edge ${from} -> ${to}`, e.condition) || leak(`edge ${from} -> ${to}`, e.guidance) || leak(`edge ${from} -> ${to}`, e.pitfalls)) {
      flaggedEdges.push([from, to])
      continue
    }
    if (edges.some((x) => x.from === from && x.to === to)) continue
    edges.push({ ...e, from, to })
  }
  for (const w of workflows) {
    if (!edges.some((e) => e.to === w.id)) edges.push({ from: START, to: w.id, relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null })
    if (!edges.some((e) => e.from === w.id)) edges.push({ from: w.id, to: END, relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null })
  }

  const usedPlaces = new Set(workflows.flatMap((w) => w.steps.flatMap((s) => (s.place === null ? [] : [s.place]))))
  const unused = evidence.places.filter((p) => !usedPlaces.has(p.id) && p.tasks.length > 1 && !isReadPlace(p))
  for (const p of unused) problems.push(`place ${p.id} (${describePlace(p)}), edited by ${p.tasks.length} tasks, is in no workflow`)
  const entries = [...new Set(answer.entries)].filter((id) => {
    if (usedPlaces.has(id)) return true
    problems.push(`entries names ${JSON.stringify(id)}, which no step's place is; dropped`)
    return false
  })

  return {
    memory: {
      format: FORMAT,
      tenant,
      places: evidence.places.filter((p) => usedPlaces.has(p.id)).map((p) => withShow(p, entries.includes(p.id))),
      workflows,
      edges,
      // Pitfalls in no workflow still warn when their trigger fires.
      pitfalls
    },
    problems,
    entries,
    flagged: { workflows: [...flaggedWorkflows], pitfalls: [...flaggedPitfalls], edges: flaggedEdges },
    pitfallDetours: new Map([...sitesOf].map(([id, sites]) => [id, sites.slice(0, MAX_SITES).map((s) => describeDetour(s.run, s.index).replace(/^- #\d+/, `- ${s.run.record}#${s.index}`))]))
  }
}

/** Why a trigger doesn't single out a detour's mistake in its run, or undefined if it does. */
const mismatch = (trigger: Trigger, run: RunEvidence, failedAt: number, fixedAt: number): string | undefined => {
  if (run.calls.length === 0) return undefined
  const relative = relativizer(run.cwd)
  return triggerMismatch(trigger, run.calls, failedAt, fixedAt, (c: ToolCall | undefined) => (c === undefined ? undefined : eventOfCall(c, relative)))
}

/** A detour where a pitfall's mistake happened, in the run that made it. */
export interface Site {
  readonly run: RunEvidence
  readonly index: number
  readonly detour: Detour
}

const FIXED_TOO = "it also matches the call that fixed it"

/** Detours of a pitfall shown to a second call that gives it a trigger. */
const MAX_SITES = 6

/**
 * Why a trigger doesn't fire where its mistake happened, or undefined if it
 * does: on the call that failed in one of its detours, and on no call that
 * fixed one. Detours whose log is gone can't tell, and don't object.
 */
const siteProblem = (t: Trigger, sites: ReadonlyArray<Site>): string | undefined => {
  if (sites.length === 0) return undefined
  const found = sites.map((s) => mismatch(t, s.run, s.detour.failed.call, s.detour.fixed.call))
  if (found.includes(FIXED_TOO)) return "it also matches a call that fixed its mistake"
  return found.some((m) => m === undefined) ? undefined : found[0]
}

/** Messages a text quotes, in single or double quotes ('unexpected EOF', "missing: …"), not words with an apostrophe. */
const QUOTED_MESSAGE = /(?<![A-Za-z])'([^'\n]{5,100})'(?![A-Za-z])|"([^"\n]{5,100})"/g

/**
 * Error triggers a pitfall's own words give: each message it quotes that a
 * failing call of its detours printed. Learned pitfalls often name their
 * errors and had no trigger written for them.
 */
export const quotedTriggers = (text: string, sites: ReadonlyArray<Site>): Array<Trigger> => {
  const out: Array<Trigger> = []
  for (const m of text.matchAll(QUOTED_MESSAGE)) {
    const phrase = (m[1] ?? m[2]).replace(/\s*…$/, "").trim()
    const t: Trigger = { on: "error", all: [phrase], none: [], file: null }
    if (triggerProblem(t) !== undefined || out.some((x) => x.all[0] === phrase)) continue
    const failed = (s: Site) => {
      const call = s.run.calls[s.detour.failed.call]
      return call !== undefined && matchTrigger(t, eventOfCall(call, relativizer(s.run.cwd)))
    }
    if (sites.some(failed)) out.push(t)
  }
  return out
}

const endOf = (x: string) => (x === START || x === END ? x : slug(x))
const edgeKey = (from: string, to: string) => `${endOf(from)} -> ${endOf(to)}`

/** A workflow of memory as an answer proposes one. */
const proposedOf = (w: Workflow): ProposedWorkflow => ({
  id: w.id,
  name: w.name,
  use_when: w.use_when,
  blanks: w.blanks,
  steps: w.steps,
  checks: w.checks,
  pitfalls: w.pitfalls,
  from_runs: [],
  only_if_asked: w.only_if_asked
})

/**
 * A revision's answer applied to current memory: the whole answer it stands
 * for, which the checks read as they read a first build's. Workflows keep
 * their order, new ones last; the edges from and to a workflow the answer
 * adds, changes or takes out are the answer's.
 */
export const applyRevision = (current: WorkflowMemory, r: RevisionAnswer): InductionAnswer => {
  const given = new Map(r.workflows.map((w) => [slug(w.id), w]))
  const removed = new Set(r.removed_workflows.map(slug))
  const known = new Set(current.workflows.map((w) => w.id))
  const workflows = [
    ...current.workflows.flatMap((w) => (removed.has(w.id) ? [] : [given.get(w.id) ?? proposedOf(w)])),
    ...r.workflows.filter((w) => !known.has(slug(w.id)))
  ]
  const touched = new Set([...given.keys(), ...removed])
  const answered = new Set(r.edges.map((e) => edgeKey(e.from, e.to)))
  const edges = [
    ...current.edges.filter((e) => !touched.has(e.from) && !touched.has(e.to) && !answered.has(edgeKey(e.from, e.to))),
    ...r.edges
  ]
  const changed = new Set(r.pitfalls.map((p) => slug(p.id)))
  const gone = new Set(r.removed_pitfalls.map(slug))
  const pitfalls = [
    ...current.pitfalls.filter((p) => !changed.has(p.id) && !gone.has(p.id)).map((p) => ({ id: p.id, text: p.text, detours: [], trigger: p.trigger, also: p.also ?? [] })),
    ...r.pitfalls
  ]
  return { workflows, edges, pitfalls, entries: r.entries, rationale: r.rationale }
}

const isFlagged = (f: Flagged) => f.workflows.length + f.pitfalls.length + f.edges.length > 0

/**
 * What a second call reads: only the parts of an answer the checks flagged,
 * what is wrong with each, the values memory may not hold, for a pitfall
 * that named no detour of the runs, their detours, and for one with no
 * trigger, the detours where its mistake happened.
 */
export const fixPrompt = (answer: InductionAnswer, checked: Checked, evidence: Evidence): string => {
  const f = checked.flagged
  const edges = new Set(f.edges.map(([from, to]) => edgeKey(from, to)))
  const parts: FixAnswer = {
    workflows: answer.workflows.filter((w) => f.workflows.includes(slug(w.id))),
    pitfalls: answer.pitfalls.filter((p) => f.pitfalls.includes(slug(p.id))),
    edges: answer.edges.filter((e) => edges.has(edgeKey(e.from, e.to)))
  }
  const names = [...f.workflows, ...f.pitfalls, ...[...edges]]
  const problems = checked.problems.filter((p) => names.some((n) => p.includes(n)))
  const values = [...new Set(evidence.runs.flatMap((r) => r.values))]
  const lines = [
    "## Parts of your answer to fix",
    "",
    "The checks found these problems in some parts of your answer. Answer with those parts only, fixed, under the same ids, with everything else in them kept:",
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    `The tasks' own values, never to be written in memory (write a blank in braces instead, listed in its workflow's blanks, or say it in general words): ${values.map(code).join(", ") || "(none)"}`,
    "",
    "```json",
    JSON.stringify(parts, null, 1),
    "```",
    ""
  ]
  if (problems.some((p) => p.includes("comes from no detour of these runs"))) {
    lines.push("## The runs' detours", "", "A pitfall names its detours as \"<run id>#<detour number>\".", "")
    for (const r of evidence.runs.filter((x) => x.detours.length > 0)) lines.push(`### Run ${r.record}`, ...r.detours.map((_, i) => describeDetour(r, i)), "")
  }
  const untriggered = f.pitfalls.filter((id) => problems.some((p) => p.startsWith(`pitfall ${id} has no trigger`)))
  if (untriggered.length > 0) {
    lines.push(
      "## Where the pitfalls without a trigger happened",
      "",
      "Write each trigger from these failures' own words, or leave the pitfall out of your answer if none of them shows its mistake.",
      ""
    )
    for (const id of untriggered) {
      const seen = checked.pitfallDetours.get(id) ?? []
      lines.push(`### ${id}`, ...(seen.length > 0 ? seen : ["(the logs of the runs it came from are gone)"]), "")
    }
  }
  return lines.join("\n")
}

/** An answer with its flagged parts replaced by those a second call fixed; anything else it gave is left out. */
export const applyFix = (answer: InductionAnswer, fix: FixAnswer, flagged: Flagged): InductionAnswer => {
  const workflows = new Map(fix.workflows.filter((w) => flagged.workflows.includes(slug(w.id))).map((w) => [slug(w.id), w]))
  const pitfalls = new Map(fix.pitfalls.filter((p) => flagged.pitfalls.includes(slug(p.id))).map((p) => [slug(p.id), p]))
  const flaggedEdges = new Set(flagged.edges.map(([from, to]) => edgeKey(from, to)))
  const edges = new Map(fix.edges.filter((e) => flaggedEdges.has(edgeKey(e.from, e.to))).map((e) => [edgeKey(e.from, e.to), e]))
  return {
    ...answer,
    workflows: answer.workflows.map((w) => workflows.get(slug(w.id)) ?? w),
    pitfalls: answer.pitfalls.map((p) => pitfalls.get(slug(p.id)) ?? p),
    edges: answer.edges.map((e) => edges.get(edgeKey(e.from, e.to)) ?? e)
  }
}

export interface InduceConfig {
  /** The agent whose model learns: Claude Code in the eval harness, the user's choice in daily use. */
  readonly cli: ModelCli
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  /** undefined: the model the agent is set to use (Claude Code's: Sonnet). */
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

export const DEFAULT_INDUCE_MODEL = "sonnet"
export const DEFAULT_INDUCE_EFFORT = "high"

export interface Induced extends Checked {
  readonly rationale: string
  readonly costUsd: number
  readonly calls: number
  /** What a revision took out of current memory, by its own answer (the checks drop more). */
  readonly removed: { readonly workflows: ReadonlyArray<string>; readonly pitfalls: ReadonlyArray<string> }
}

/**
 * Induce memory from evidence (revising `current`, when there is one): one
 * model call, which for a revision answers with what changes only. Then, if
 * the checks flagged parts a model can fix, one more call that reads just
 * those parts and answers with them fixed; the checks fix the rest
 * themselves. A second call that read everything again and rewrote all of
 * memory was 45% of a learning round's bill.
 */
export const induce = Effect.fn("induce")(function*(
  config: InduceConfig,
  evidence: Evidence,
  tenant: string,
  current?: WorkflowMemory,
  /** More sections for the model to read: how memory did on the runs, revisions rejected before. */
  extra: ReadonlyArray<string> = [],
  /** The runs memory learned from before, which its pitfalls are checked against. */
  options: CheckOptions = {}
) {
  const ask = <A>(prompt: string, schema: Schema.Decoder<A>, maxBudgetUsd: number) =>
    callModel({ cli: config.cli, system: INDUCE_PROMPT, prompt, schema, model: config.model, effort: config.effort, cwd: config.cwd, maxBudgetUsd, timeoutS: 1200 })
  const prompt = inductionPrompt(evidence, current, extra)
  let answer: InductionAnswer
  let costUsd = 0
  let removed: Induced["removed"] = { workflows: [], pitfalls: [] }
  if (current !== undefined && current.workflows.length > 0) {
    const revision = yield* ask(prompt, RevisionAnswer, 3)
    costUsd += revision.costUsd ?? 0
    answer = applyRevision(current, revision.value)
    removed = { workflows: revision.value.removed_workflows.map(slug), pitfalls: revision.value.removed_pitfalls.map(slug) }
  } else {
    const built = yield* ask(prompt, InductionAnswer, 3)
    costUsd += built.costUsd ?? 0
    answer = built.value
  }
  let calls = 1
  let result = checkAnswer(answer, evidence, tenant, current, options)
  if (isFlagged(result.flagged)) {
    const fixed = yield* ask(fixPrompt(answer, result, evidence), FixAnswer, 1)
    calls++
    costUsd += fixed.costUsd ?? 0
    answer = applyFix(answer, fixed.value, result.flagged)
    result = checkAnswer(answer, evidence, tenant, current, options)
  }
  return { ...result, rationale: answer.rationale, costUsd, calls, removed } satisfies Induced
})
