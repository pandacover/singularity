/**
 * Memory v1 at task start, one step further: the change itself. A model reads
 * the task, the workflows picked for it (steps with blanks) and the code as it
 * is now at their places, and fills the blanks in the only way that leaves
 * nothing open: it writes every edit the task needs there, as exact
 * replacements, and every new file, whole. The agent then applies a complete
 * change, as with a saved script, instead of filling in the blanks and
 * looking around for what the steps leave open; that is where its turns went
 * (the v1 measurement, and the example test after it).
 *
 * Memory still keeps no code. The change is written from the code as it is,
 * for this task, and checked here before it is handed over: each
 * replacement's old lines must be in their file exactly once (made unique
 * with the line above them when they are in a place shown and elsewhere too),
 * edits mustn't overlap, new files must be new. What fails is left out and
 * said so.
 */
import { Effect, Schema } from "effect"
import { callStructured } from "../eval/Llm.ts"
import type { Usage } from "../traces/index.ts"
import { shapeOf } from "./Evidence.ts"
import type { Located, Sibling } from "./Locate.ts"
import type { Pitfall, WorkflowMemory } from "./Models.ts"
import { describeChain, type Region } from "./Places.ts"
import type { Selected } from "./Select.ts"

export const DRAFT_PROMPT = `You write the complete code change for a coding task, so that a coding agent can apply it as it is, without looking anything up.

You get the task; the workflows memory picked for it, learned from earlier tasks in this repository (steps with blanks in braces, which stand for this task's own names and values); and the code as it is now at the places those steps go to, with line numbers. For new files you get some of the files already there that are named alike.

Write every edit the task needs at the places shown, and every new file whole:
- An edit replaces lines of a file: \`old\` is lines copied exactly from the code shown (whole lines, with their indentation, without the "N| " line numbers), enough of them to be found in that file only once, usually the line you insert after; \`new\` is what replaces them: the same lines with yours added or changed. Several edits in one file must not share lines.
- Only edit the files shown, and only lines you were shown. A step whose place isn't shown, or that needs code you weren't shown, goes in \`after\` as a short instruction.
- A new file goes in \`files\`, with its path from the repository's root and its whole content.

The task decides; the workflows are what earlier tasks needed. Leave out what this task doesn't need (a step whose condition doesn't hold, a menu entry it doesn't want), and add what it asks for that no step covers, where the code shown lets you. Use its own names and texts exactly: a label it quotes is the label, and the names it gives are the names. Write new code the way the code next to it is written: take a neighbouring entry's shape, not its details (an icon, extra conditions, other flags) unless the task asks for them.

In \`after\`, what remains once the edits are applied, in order: commands to run (snapshot updates, checks) from the workflows' steps and checks, and anything you couldn't write. In \`unsure\`, anything the task or the code shown didn't settle and you had to guess. Keep both short; leave them empty when there is nothing to say.`

export const DraftAnswer = Schema.Struct({
  edits: Schema.Array(Schema.Struct({ file: Schema.String, old: Schema.String, new: Schema.String })),
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  after: Schema.Array(Schema.String),
  unsure: Schema.Array(Schema.String)
})
export type DraftAnswer = typeof DraftAnswer.Type

/** An edit that passed the checks: replace `old` (lines of `file`, starting at line `line`, counted from 1) with `new`. */
export interface DraftEdit {
  readonly file: string
  readonly line: number
  readonly old: ReadonlyArray<string>
  readonly new: ReadonlyArray<string>
}

export interface Draft {
  readonly edits: ReadonlyArray<DraftEdit>
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>
  readonly after: ReadonlyArray<string>
  readonly unsure: ReadonlyArray<string>
  /** What the checks left out, and why. */
  readonly dropped: ReadonlyArray<string>
}

/** Places shown to the model: whole when short, else their first lines and their end. */
const WHOLE_LINES = 70
const HEAD_LINES = 2
const TAIL_LINES = 40
/** Files already there, shown whole, for each new-file place. */
const SIBLINGS_SHOWN = 3

const numbered = (lines: ReadonlyArray<string>, from: number, to: number) => {
  const out: Array<string> = []
  for (let i = from; i <= to && i < lines.length; i++) out.push(`${i + 1}| ${lines[i]}`)
  return out
}

/** A place's code as the model sees it. */
const view = (lines: ReadonlyArray<string>, r: Region): Array<string> => {
  if (r.to - r.from + 1 <= WHOLE_LINES) return numbered(lines, r.from, r.to)
  return [...numbered(lines, r.from, r.from + HEAD_LINES - 1), "⋮", ...numbered(lines, r.to - TAIL_LINES + 1, r.to)]
}

const partsOf = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter((p) => p !== "").map((p) => p.toLowerCase())

/** Whether `text` names the sibling: its name's distinctive part, as words (`grid-mode` for actionToggleGridMode.tsx). */
const mentions = (text: string, stem: string) => {
  const words = ` ${partsOf(text).join(" ")} `
  const parts = partsOf(stem)
  return parts.length > 0 && words.includes(` ${parts.join(" ")} `)
}

/** The siblings to show whole: the ones the steps name first, then the shortest. */
const siblingsToShow = (at: Extract<Located, { kind: "new-file" }>, stepsText: string): Array<Sibling> => {
  const stem = (s: Sibling) => s.name.slice(at.prefix.length).replace(/\.[^.]*$/, "")
  return [...at.siblings]
    .sort((a, b) => Number(mentions(stepsText, stem(b))) - Number(mentions(stepsText, stem(a))) || a.lines.length - b.lines.length)
    .slice(0, SIBLINGS_SHOWN)
}

/** The steps that apply, in order, as the model reads them: workflow by workflow, with their places by number. */
export const draftPrompt = (
  task: string,
  memory: WorkflowMemory,
  chosen: ReadonlyArray<Selected>,
  located: ReadonlyMap<string, Located>
): string => {
  const places = new Map(memory.places.map((p) => [p.id, p]))
  const pitfalls = new Map(memory.pitfalls.map((p) => [p.id, p]))
  const numberOf = new Map<string, number>()
  const out = ["## Task", "", task.trim(), "", "## Workflows", ""]
  const stepsText: Array<string> = []
  for (const c of chosen) {
    const w = c.workflow
    out.push(`### ${w.name}`)
    if (w.blanks.length > 0) out.push(`Blanks: ${w.blanks.map((b) => `{${b.name}} ${b.meaning}`).join("; ")}`)
    let n = 0
    w.steps.forEach((s, i) => {
      if (c.skip.includes(i + 1)) return
      n++
      const at = s.place === null ? undefined : located.get(s.place)
      if (s.place !== null && at !== undefined && !numberOf.has(s.place)) numberOf.set(s.place, numberOf.size + 1)
      const where = s.place === null ? "" : at === undefined ? " (its place isn't in the code any more)" : ` [place ${numberOf.get(s.place)}]`
      out.push(`${n}. ${s.do}${s.when === null ? "" : ` (${s.when})`}${where}`)
      stepsText.push(s.do)
    })
    if (w.checks.length > 0) out.push(`Checks: ${w.checks.join("; ")}`)
    for (const id of w.pitfalls) {
      const p = pitfalls.get(id)
      if (p !== undefined) out.push(`Pitfall: ${p.text}`)
    }
    out.push("")
  }
  out.push("## The code at the places, as it is now", "")
  for (const [id, k] of numberOf) {
    const p = places.get(id)
    const at = located.get(id)
    if (p === undefined || at === undefined) continue
    if (at.kind === "new-file") {
      const shown = siblingsToShow(at, stepsText.join("\n"))
      out.push(
        `### Place ${k}: a new file in \`${at.dir}/\`, named like the ${at.siblings.length} there that start with \`${at.prefix}\` ` +
          `(${at.siblings.map((s) => s.name).join(", ")}); ${shown.length === 1 ? "one of them" : `${shown.length} of them`}:`,
        ""
      )
      for (const s of shown) out.push(`\`${at.dir}/${s.name}\`:`, "```", ...s.lines.filter((l, i) => i < s.lines.length - 1 || l !== ""), "```", "")
      continue
    }
    const where = p.chain.length > 0 ? `in ${describeChain(shapeOf(p), 4)}` : describeChain(shapeOf(p))
    out.push(`### Place ${k}: \`${at.file}\`, lines ${at.region.from + 1}-${at.region.to + 1}, ${where}`, "```", ...view(at.lines, at.region), "```", "")
  }
  return out.join("\n")
}

const linesOf = (s: string): Array<string> => {
  const lines = s.replace(/\r\n?/g, "\n").split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Where a block of lines is in a file: the start of every place it matches, counted from 0. */
const findAll = (file: ReadonlyArray<string>, block: ReadonlyArray<string>, same: (a: string, b: string) => boolean): Array<number> => {
  const out: Array<number> = []
  for (let i = 0; i + block.length <= file.length; i++) {
    let ok = true
    for (let j = 0; j < block.length && ok; j++) ok = same(file[i + j], block[j])
    if (ok) out.push(i)
  }
  return out
}

const exact = (a: string, b: string) => a === b
const trimmedEnd = (a: string, b: string) => a.trimEnd() === b.trimEnd()

export interface CodeState {
  /** The lines of files shown, by path. */
  readonly files: ReadonlyMap<string, ReadonlyArray<string>>
  /** The regions shown, by file. */
  readonly regions: ReadonlyMap<string, ReadonlyArray<Region>>
  /** Whether a path (file or directory) exists in the repository. */
  readonly exists: (path: string) => boolean
}

const cleanPath = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "")
const insideRepo = (p: string) => p !== "" && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.split("/").includes("..")

/**
 * The checks a drafted change must pass before an agent is handed it: each
 * edit's old lines are in a file that was shown, exactly once (or once in a
 * place shown, then widened upward until they are unique), and don't overlap
 * another edit's; new files are new, in a directory that exists. Lines copied
 * with their "N| " numbers lose them first.
 */
export const checkDraft = (answer: DraftAnswer, code: CodeState): Draft => {
  const dropped: Array<string> = []
  const edits: Array<DraftEdit> = []
  for (const e of answer.edits) {
    const file = cleanPath(e.file)
    const lines = code.files.get(file)
    if (lines === undefined) {
      dropped.push(`an edit to ${file}, which wasn't shown`)
      continue
    }
    let old = linesOf(e.old)
    let neu = linesOf(e.new)
    const numberedLine = /^\s*\d+\| ?/
    if (old.length > 0 && old.every((l) => numberedLine.test(l))) {
      old = old.map((l) => l.replace(numberedLine, ""))
      neu = neu.map((l) => l.replace(numberedLine, ""))
    }
    if (old.length === 0 || old.every((l) => l.trim() === "")) {
      dropped.push(`an edit to ${file} with nothing to replace`)
      continue
    }
    if (old.length === neu.length && old.every((l, i) => l === neu[i])) {
      dropped.push(`an edit to ${file} that changes nothing`)
      continue
    }
    let at = findAll(lines, old, exact)
    if (at.length === 0) {
      at = findAll(lines, old, trimmedEnd)
      // Take the file's own lines, so the old text is exact.
      if (at.length === 1) old = lines.slice(at[0], at[0] + old.length)
    }
    if (at.length === 0) {
      dropped.push(`an edit to ${file}: its old lines aren't in the file (${JSON.stringify(old[0].trim().slice(0, 60))})`)
      continue
    }
    if (at.length > 1) {
      const shown = at.filter((i) => (code.regions.get(file) ?? []).some((r) => i >= r.from && i + old.length - 1 <= r.to))
      if (shown.length !== 1) {
        dropped.push(`an edit to ${file}: its old lines are in the file ${at.length} times (${JSON.stringify(old[0].trim().slice(0, 60))})`)
        continue
      }
      // Widen it upward, in the old and the new alike, until it is unique.
      let start = shown[0]
      while (start > 0 && findAll(lines, lines.slice(start, shown[0] + old.length), exact).length > 1) start--
      const above = lines.slice(start, shown[0])
      old = [...above, ...old]
      neu = [...above, ...neu]
      at = [start]
    }
    const from = at[0]
    const to = from + old.length - 1
    if (edits.some((x) => x.file === file && !(to < x.line - 1 || from > x.line - 1 + x.old.length - 1))) {
      dropped.push(`an edit to ${file} at line ${from + 1}, which overlaps another`)
      continue
    }
    edits.push({ file, line: from + 1, old, new: neu })
  }
  const files: Array<{ path: string; content: string }> = []
  for (const f of answer.files) {
    const path = cleanPath(f.path)
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
    if (!insideRepo(path)) dropped.push(`a new file at ${path}, outside the repository`)
    else if (code.exists(path)) dropped.push(`a new file at ${path}, which is there already`)
    else if (dir !== "" && !code.exists(dir)) dropped.push(`a new file at ${path}, in a directory that isn't there`)
    else if (files.some((x) => x.path === path)) dropped.push(`a second new file at ${path}`)
    else files.push({ path, content: f.content.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n") })
  }
  // Edits in file order, top to bottom, the way they read.
  edits.sort((a, b) => (a.file === b.file ? a.line - b.line : 0))
  return { edits, files, after: answer.after.map((s) => s.trim()).filter((s) => s !== ""), unsure: answer.unsure.map((s) => s.trim()).filter((s) => s !== ""), dropped }
}

/** An edit as a diff hunk: the lines kept around it, the lines it removes and adds. */
export const hunk = (e: DraftEdit): Array<string> => {
  let head = 0
  while (head < e.old.length && head < e.new.length && e.old[head] === e.new[head]) head++
  let tail = 0
  while (tail < e.old.length - head && tail < e.new.length - head && e.old[e.old.length - 1 - tail] === e.new[e.new.length - 1 - tail]) tail++
  return [
    ...e.old.slice(0, head).map((l) => ` ${l}`),
    ...e.old.slice(head, e.old.length - tail).map((l) => `-${l}`),
    ...e.new.slice(head, e.new.length - tail).map((l) => `+${l}`),
    ...e.old.slice(e.old.length - tail).map((l) => ` ${l}`)
  ]
}

const fence = (lines: ReadonlyArray<string>, lang = "") => {
  const ticks = lines.some((l) => l.includes("```")) ? "````" : "```"
  return [ticks + lang, ...lines, ticks]
}

/**
 * The hand-over when a drafted change passed its checks: the change, edit by
 * edit (grouped by file, in the order the workflows go), then what remains,
 * the checks and the pitfalls. Undefined when it doesn't fit the budget; the
 * workflows are handed over instead.
 */
export const renderDraft = (
  memory: WorkflowMemory,
  chosen: ReadonlyArray<Selected>,
  draft: Draft,
  budget: number
): string | undefined => {
  const pitfalls = new Map(memory.pitfalls.map((p) => [p.id, p]))
  const out: Array<string> = [
    "# The change for this task, from earlier work in this repository",
    "",
    "Written for this task at its start, by a model, from the workflows memory picked for it " +
    `(${chosen.map((c) => c.workflow.name).join("; ")}) and the code as it is now. ` +
    "Each edit's lines without + are in their file exactly once, as shown, from the line given. " +
    "Apply it as it is, then do what follows it. It can be wrong: where it disagrees with your task, the task wins.",
    "",
    "## Edits",
    ""
  ]
  const byFile = new Map<string, Array<DraftEdit>>()
  for (const e of draft.edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e])
  for (const [file, edits] of byFile) {
    for (const e of edits) out.push(`\`${file}\`, line ${e.line}:`, ...fence(hunk(e), "diff"), "")
  }
  for (const f of draft.files) {
    const ext = f.path.slice(f.path.lastIndexOf(".") + 1)
    out.push(`New file \`${f.path}\`:`, ...fence(linesOf(f.content), /^[a-z]+$/.test(ext) ? ext : ""), "")
  }
  const checks = [...new Set(chosen.flatMap((c) => c.workflow.checks))]
  const warned: Array<Pitfall> = []
  for (const c of chosen) {
    for (const id of c.workflow.pitfalls) {
      const p = pitfalls.get(id)
      if (p !== undefined && !warned.includes(p)) warned.push(p)
    }
  }
  if (draft.after.length > 0 || checks.length > 0 || warned.length > 0 || draft.unsure.length > 0) out.push("## Then", "")
  draft.after.forEach((a, i) => out.push(`${i + 1}. ${a}`))
  if (draft.after.length > 0) out.push("")
  if (checks.length > 0) out.push(`Check with ${checks.map((c) => `\`${c}\``).join(" or ")}.`)
  for (const p of warned) out.push(`Watch out: ${p.text}`)
  for (const u of draft.unsure) out.push(`Not settled by the draft: ${u}`)
  const text = out.join("\n").trimEnd() + "\n"
  return text.length <= budget ? text : undefined
}

export interface DrafterConfig {
  readonly claude: ReadonlyArray<string>
  /** Where the model runs: a directory with no CLAUDE.md above it. */
  readonly cwd: string
  readonly model: string
  /** Let the model think before it answers (default off). */
  readonly thinking?: boolean | undefined
}

export interface DraftCall {
  readonly model: string
  readonly costUsd: number | null
  readonly usage: Usage | null
  readonly durationS: number | null
  readonly error: string | null
}

/** The files and regions of the places found, for the checks. */
const codeOf = (located: ReadonlyMap<string, Located>) => {
  const files = new Map<string, ReadonlyArray<string>>()
  const regions = new Map<string, Array<Region>>()
  for (const at of located.values()) {
    if (at.kind !== "block") continue
    files.set(at.file, at.lines)
    regions.set(at.file, [...(regions.get(at.file) ?? []), at.region])
  }
  return { files, regions }
}

/**
 * The model call and the checks: a draft, or why there is none. `exists`
 * tells whether a path is in the repository (for new files).
 */
export const draftChange = Effect.fn("draftChange")(function*<R>(
  task: string,
  memory: WorkflowMemory,
  chosen: ReadonlyArray<Selected>,
  located: ReadonlyMap<string, Located>,
  exists: (path: string) => Effect.Effect<boolean, never, R>,
  config: DrafterConfig
) {
  const called = yield* Effect.result(callStructured({
    claude: config.claude,
    system: DRAFT_PROMPT,
    prompt: draftPrompt(task, memory, chosen, located),
    schema: DraftAnswer,
    model: config.model,
    thinking: config.thinking ?? false,
    cwd: config.cwd,
    maxBudgetUsd: 1,
    timeoutS: 240
  }))
  if (called._tag === "Failure") {
    return { draft: undefined, call: { model: config.model, costUsd: null, usage: null, durationS: null, error: called.failure.message } satisfies DraftCall }
  }
  const answer = called.success.value
  const known = new Set<string>()
  for (const f of answer.files) {
    const path = cleanPath(f.path)
    for (const p of [path, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""]) {
      if (p !== "" && insideRepo(p) && (yield* exists(p))) known.add(p)
    }
  }
  return {
    draft: checkDraft(answer, { ...codeOf(located), exists: (p) => known.has(p) }),
    call: { model: config.model, costUsd: called.success.costUsd, usage: called.success.usage, durationS: called.success.durationS, error: null } satisfies DraftCall
  }
})
