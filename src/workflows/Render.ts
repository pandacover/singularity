/**
 * The hand-over text: the workflows a task needs, in order, each step with its
 * place found in the code as it is now (file, current lines, the blocks
 * around it, and a short excerpt to edit against), the checks, and the
 * pitfalls on those workflows.
 *
 * Memory holds no code. Everything quoted comes from the working tree at task
 * start; a place the code no longer has is left out quietly, and its step
 * stays, so a change to the code makes memory say less, not something wrong.
 *
 * Claude Code cuts a hook's text at 10,000 characters, so the hand-over keeps
 * to a budget: when it doesn't fit, excerpts get shorter, then go.
 *
 * Memory that knows what its checks rewrite (Finish.ts) ends with one command
 * that checks everything, instead of checks under each workflow and a
 * finishing workflow of its own.
 */
import { applyFills, mergedValues, type PartUse } from "./Cues.ts"
import { shapeOf } from "./Evidence.ts"
import { finishOf, hasFinish } from "./Finish.ts"
import type { Located } from "./Locate.ts"
import type { Pitfall, Place, WorkflowMemory } from "./Models.ts"
import { continues, describeChain, indentOf, type Region } from "./Places.ts"
import type { Selected } from "./Select.ts"

/** Claude Code cuts a hook's text at 10,000 characters. */
export const MAX_HANDOVER_CHARS = 9800

/** What steps that name a folded finishing workflow point to instead: the one command, last in the hand-over. */
const FINISH_NAME = "the last section"

/** A place as found now, for the log: which lines of which file were shown. */
export interface Shown {
  readonly place: string
  readonly file: string
  /** Lines from 1, inclusive; for new-file places, 0 and 0. */
  readonly from: number
  readonly to: number
  /** The lines its excerpt showed, from 1; for new-file places, those of the sibling shown, if one was. */
  readonly lines?: ReadonlyArray<number>
  /** New-file places shown with an existing file of their kind: that file. */
  readonly sibling?: string
}

export interface Handover {
  /** All of it; `parts` is the same cut for hooks that each carry one. */
  readonly text: string
  readonly parts: ReadonlyArray<string>
  readonly shown: ReadonlyArray<Shown>
  /** Places of the chosen steps the code no longer has. */
  readonly missing: ReadonlyArray<string>
  readonly pitfalls: ReadonlyArray<string>
}

const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"
const numbered = (lines: ReadonlyArray<string>, at: number) => `${String(at + 1).padStart(5)}| ${lines[at]}`

/** Lines of an excerpt (from 0), with gaps. */
type Row = number | "gap"

const format = (lines: ReadonlyArray<string>, rows: ReadonlyArray<Row>): Array<string> =>
  rows.map((r) => (r === "gap" ? "     ⋮" : numbered(lines, r)))

const shownLines = (rows: ReadonlyArray<Row>): Array<number> => rows.flatMap((r) => (r === "gap" ? [] : [r + 1]))

const excerptRows = (lines: ReadonlyArray<string>, r: Region, max: number): Array<Row> => {
  if (max <= 0) return []
  if (r.members.length > 0) {
    const last = r.members.slice(-Math.max(1, max - 1))
    return [...(r.members.length > last.length ? ["gap" as const] : []), ...last]
  }
  const all: Array<number> = []
  for (let i = r.from; i <= r.to; i++) all.push(i)
  if (all.length <= max) return all
  // The block's first line says which block it is (`const APP_STATE_STORAGE_CONF = (<`, not its closing `>(config) =>`).
  const open = r.openLine ?? r.from
  const close = r.closeLine
  const tail = all.filter((i) => i > open && i !== close && lines[i].trim() !== "").slice(-(max - (close === null ? 1 : 2)))
  return [r.from, "gap", ...tail, ...(close === null ? [] : [close])]
}

/** An excerpt of a found block, at most `max` lines: its opening line, the end of its contents, its closing line. */
export const excerpt = (lines: ReadonlyArray<string>, r: Region, max: number): Array<string> => format(lines, excerptRows(lines, r, max))

const blankOrComment = (line: string) => line.trim() === "" || /^(\/\/|\/\*|\*)/.test(line.trim())

/**
 * The last whole entry of a found block, for places where an entry takes
 * more than a line (a component, a tag with its attributes): the block's
 * first line, its last direct child from start to end, its closing line; for
 * a group of statements, its last statement. At most `max` lines of the entry.
 */
const entryRows = (lines: ReadonlyArray<string>, r: Region, max: number): Array<Row> => {
  if (max <= 0) return []
  let start: number
  let end = r.to
  if (r.members.length > 0) {
    start = r.members[r.members.length - 1]
  } else {
    const open = r.openLine ?? r.from
    if (r.closeLine !== null) end = r.closeLine - 1
    const inner: Array<number> = []
    for (let i = open + 1; i <= end; i++) if (!blankOrComment(lines[i])) inner.push(i)
    if (inner.length === 0) return excerptRows(lines, r, max)
    const depth = Math.min(...inner.map((i) => indentOf(lines[i])))
    const starts = inner.filter((i) => indentOf(lines[i]) === depth && !continues(lines[i]) && !/^(\}|\]|\)|<\/)/.test(lines[i].trim()))
    start = starts[starts.length - 1] ?? inner[0]
  }
  while (end > start && lines[end].trim() === "") end--
  const entry: Array<Row> = []
  for (let i = start; i <= end; i++) entry.push(i)
  const body: Array<Row> = entry.length <= max ? entry : [...entry.slice(0, max - 1), "gap", entry[entry.length - 1]]
  if (r.members.length > 0) return [...(start > r.from ? ["gap" as const] : []), ...body]
  return [r.from, ...(start > (r.openLine ?? r.from) + 1 ? ["gap" as const] : []), ...body, ...(r.closeLine === null ? [] : [r.closeLine])]
}

/** Entries are longer than the ends of blocks: at each budget step, this many times the excerpt's lines. */
const ENTRY_FACTOR = 3

interface Rendered {
  readonly header: string
  readonly excerpt: ReadonlyArray<string>
  readonly shown: Shown
}

/** A step's place as found (Locate.ts): where it is now and an excerpt of up to `max` lines (whole entries a few times that). */
const renderPlace = (p: Place, at: Located, max: number): Rendered => {
  const entry = p.show === "entry"
  if (at.kind === "new-file") {
    const short = [...at.siblings].sort((a, b) => a.lines.length - b.lines.length)
    const names = short.slice(0, 6).map((f) => `${f.name} (${f.lines.length} lines)`).join(", ")
    const header = `a new file in ${code(at.dir + "/")}, named like the ${at.siblings.length} there that start with ${code(at.prefix)}; shortest first: ${names}`
    const first = short[0]
    if (!entry || first === undefined || max <= 0) return { header, excerpt: [], shown: { place: p.id, file: at.dir, from: 0, to: 0 } }
    const all: Array<Row> = first.lines.map((_, i) => i).filter((i) => i < first.lines.length - 1 || first.lines[i].trim() !== "")
    const cap = max * ENTRY_FACTOR
    const rows: Array<Row> = all.length <= cap ? all : [...all.slice(0, cap - 1), "gap", all[all.length - 1]]
    return {
      header: `${header}. The shortest, ${code(`${at.dir}/${first.name}`)}:`,
      excerpt: format(first.lines, rows),
      shown: { place: p.id, file: at.dir, from: 0, to: 0, lines: shownLines(rows), sibling: `${at.dir}/${first.name}` }
    }
  }
  const r = at.region
  const where = p.chain.length > 0 ? `in ${describeChain(shapeOf(p), 3)}` : describeChain(shapeOf(p))
  const moved = at.moved ? ` (moved from ${code(p.file)})` : ""
  const rows = entry ? entryRows(at.lines, r, max * ENTRY_FACTOR) : excerptRows(at.lines, r, max)
  return {
    header: `${code(`${at.file}:${r.from + 1}-${r.to + 1}`)} ${where}${moved}`,
    excerpt: format(at.lines, rows),
    shown: { place: p.id, file: at.file, from: r.from + 1, to: r.to + 1, lines: shownLines(rows) }
  }
}

const HEADER = [
  "# Workflows from earlier work in this repository",
  "",
  "Reusable steps learned from earlier tasks here. Blanks in braces stand for your task's own names and values. " +
  "Places are found in the code as it is now (current line numbers); the lines shown are excerpts.",
  ""
].join("\n")

const FILLED_HEADER = [
  "# Workflows from earlier work in this repository",
  "",
  "Reusable steps learned from earlier tasks here. Values your task states are filled in; blanks in braces stand for " +
  "the rest of your task's own names and values. " +
  "Places are found in the code as it is now (current line numbers); the lines shown are excerpts.",
  ""
].join("\n")

const PARTS_HEADER = [
  "# Workflows from earlier work in this repository",
  "",
  "Reusable steps learned from earlier tasks here. Your task lists several changes: a workflow or step only some of them " +
  "need says which, by their numbers in your list. Values your task states are filled in, change by change where they " +
  "differ; blanks in braces stand for the rest of your task's own names and values. " +
  "Places are found in the code as it is now (current line numbers); the lines shown are excerpts.",
  ""
].join("\n")

/** Changes of a task by their labels: "1", "1 and 3", "1, 2 and 3". */
const changes = (uses: ReadonlyArray<PartUse>): string => {
  const labels = uses.map((u) => u.label)
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/**
 * The hand-over. `fills`, when given (Cues.ts), holds for each workflow the
 * values the task states for its placeholders: they are written into its
 * steps, and only the blanks left are listed. `inParts`, for a task that
 * lists several changes (Cues.ts: partsChoice), says which changes each
 * workflow is for and their values: where changes give a blank different
 * values, each change's are listed and the steps keep their blanks.
 */
export const renderHandover = (
  memory: WorkflowMemory,
  chosen: ReadonlyArray<Selected>,
  located: ReadonlyMap<string, Located>,
  budget = MAX_HANDOVER_CHARS,
  fills?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  /** How many hooks carry it, each up to `budget` characters (splitHandover). */
  parts = 1,
  inParts?: { readonly uses: ReadonlyMap<string, ReadonlyArray<PartUse>>; readonly count: number }
): Handover => {
  const places = new Map(memory.places.map((p) => [p.id, p]))
  const pitfalls = new Map(memory.pitfalls.map((p) => [p.id, p]))
  const attached: Array<Pitfall> = []
  for (const c of chosen) {
    for (const id of c.workflow.pitfalls) {
      const p = pitfalls.get(id)
      if (p !== undefined && !attached.includes(p)) attached.push(p)
    }
  }

  const finish = hasFinish(memory) ? finishOf(memory, chosen.map((c) => c.workflow)) : undefined
  const folded = new Set(finish?.folded ?? [])
  const steps = chosen.filter((c) => !folded.has(c.workflow.id))

  const build = (maxLines: number) => {
    const out: Array<string> = [inParts !== undefined ? PARTS_HEADER : fills === undefined ? HEADER : FILLED_HEADER]
    const shown: Array<Shown> = []
    const missing: Array<string> = []
    const warned = new Set<string>()
    const warn = (id: string) => {
      const p = pitfalls.get(id)
      if (p === undefined || warned.has(id)) return
      warned.add(id)
      out.push(`Watch out: ${p.text}`)
    }
    steps.forEach((c, k) => {
      const w = c.workflow
      // For a task in parts: the changes that need this workflow, and their values as one set unless they differ.
      const uses = inParts?.uses.get(w.id)
      const merged = uses === undefined ? undefined : mergedValues(uses)
      const own = uses === undefined ? fills?.get(w.id) : merged
      const values = new Map([...(own ?? []), ...[...folded].map((id) => [id, FINISH_NAME] as const)])
      const fill = (text: string) => (values.size === 0 ? text : applyFills(text, values))
      const some = uses !== undefined && inParts !== undefined && uses.length < inParts.count
      out.push(`## ${k + 1}. ${w.name}${some ? ` (for ${changes(uses)} in your list)` : ""}`)
      const stated = [...values].filter(([b]) => !folded.has(b))
      if (stated.length > 0) out.push(`Filled from your task: ${stated.map(([b, v]) => `${b} = ${code(v)}`).join(", ")}`)
      const byChange = uses !== undefined && merged === undefined ? uses.filter((u) => u.values.size > 0) : []
      if (byChange.length > 0) {
        out.push(`Filled from your task, change by change: ${byChange.map((u) => `${u.label}: ${[...u.values].map(([b, v]) => `${b} = ${code(v)}`).join(", ")}`).join("; ")}`)
      }
      const filled = (b: string) => (byChange.length > 0 ? uses?.every((u) => u.values.has(b)) === true : values.has(b))
      const open = w.blanks.filter((b) => !filled(`{${b.name}}`))
      if (open.length > 0) out.push(`Blanks: ${open.map((b) => `{${b.name}} ${b.meaning}`).join("; ")}`)
      let n = 0
      w.steps.forEach((s, i) => {
        if (c.skip.includes(i + 1)) return
        n++
        const need = uses?.filter((u) => !u.skip.includes(i + 1)) ?? []
        const only = uses !== undefined && need.length < uses.length ? ` (for ${changes(need)} only)` : ""
        out.push(`${n}. ${fill(s.do)}${s.when === null ? "" : ` (${fill(s.when)})`}${only}`)
        const p = s.place === null ? undefined : places.get(s.place)
        if (p === undefined) return
        const at = located.get(p.id)
        if (at === undefined) {
          missing.push(p.id)
          return
        }
        const r = renderPlace(p, at, maxLines)
        out.push(`   ${r.header}`)
        if (r.excerpt.length > 0) out.push("   ```", ...r.excerpt.map((l) => `   ${l}`), "   ```")
        shown.push(r.shown)
      })
      if (finish === undefined && w.checks.length > 0) out.push(`Check with ${w.checks.map(code).join(" or ")}.`)
      for (const id of w.pitfalls) warn(id)
      out.push("")
    })
    if (finish !== undefined) {
      out.push(
        "## Last: check it all with one command",
        `When all your edits are in, run once: ${code(finish.command)}`,
        "These are the checks earlier runs of these workflows passed, in one call. Its output is long: keep its last 60 lines " +
          "(`2>&1 | tail -n 60` in Bash, `2>&1 | Select-Object -Last 60` in PowerShell), or Claude Code saves it to a file you then have to read."
      )
      if (finish.snapshots.length > 0) {
        out.push(`In those runs the checks rewrote these test snapshots, as expected for this kind of change: ${finish.snapshots.map(code).join(", ")}.`)
      }
      for (const c of chosen) if (folded.has(c.workflow.id)) for (const id of c.workflow.pitfalls) warn(id)
      out.push("")
    }
    return { text: out.join("\n"), shown, missing }
  }

  // The longest excerpts that fit; at worst, none.
  for (const max of [8, 6, 4, 3, 0]) {
    const h = build(max)
    const cut = splitHandover(h.text, budget)
    if (cut.length <= parts || max === 0) {
      const kept = cut.slice(0, parts).map((t) => (t.length <= budget ? t : t.slice(0, budget)))
      return { ...h, text: kept.join("\n"), parts: kept, pitfalls: attached.map((p) => p.id) }
    }
  }
  return { text: "", parts: [], shown: [], missing: [], pitfalls: [] }
}

const CONTINUED = "# Workflows from earlier work in this repository (continued)\n\n"

/** Units joined by line ends into as few chunks of at most `room` characters as go in order. */
const pack = (units: ReadonlyArray<string>, room: number): Array<string> => {
  const out: Array<string> = []
  let current = ""
  for (const unit of units) {
    const joined = current === "" ? unit : `${current}\n${unit}`
    if (joined.length > room && current !== "") {
      out.push(current)
      current = unit
    } else {
      current = joined
    }
  }
  if (current !== "") out.push(current)
  return out
}

/**
 * A hand-over cut into parts of at most `max` characters, each starting at a
 * workflow (or the last section), so that hooks can carry one each: Claude
 * Code cuts each hook's text at 10,000 characters on its own. The header goes
 * with the first workflow; a workflow too long for a part is cut at line ends.
 */
export const splitHandover = (text: string, max = MAX_HANDOVER_CHARS): Array<string> => {
  if (text.length <= max) return [text]
  const [header, ...rest] = text.split(/\n(?=## )/)
  const sections = rest.length === 0 ? [header] : [`${header}\n${rest[0]}`, ...rest.slice(1)]
  const room = max - CONTINUED.length
  const units = sections.flatMap((s) => (s.length <= room ? [s] : pack(s.split("\n"), room)))
  return pack(units, room).map((part, i) => (i === 0 ? part : CONTINUED + part))
}
