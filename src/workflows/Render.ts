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
 */
import { shapeOf } from "./Evidence.ts"
import type { Located } from "./Locate.ts"
import type { Pitfall, Place, WorkflowMemory } from "./Models.ts"
import { describeChain, type Region } from "./Places.ts"
import type { Selected } from "./Select.ts"

/** Claude Code cuts a hook's text at 10,000 characters. */
export const MAX_HANDOVER_CHARS = 9800

/** A place as found now, for the log: which lines of which file were shown. */
export interface Shown {
  readonly place: string
  readonly file: string
  /** Lines from 1, inclusive; for new-file places, 0 and 0. */
  readonly from: number
  readonly to: number
}

export interface Handover {
  readonly text: string
  readonly shown: ReadonlyArray<Shown>
  /** Places of the chosen steps the code no longer has. */
  readonly missing: ReadonlyArray<string>
  readonly pitfalls: ReadonlyArray<string>
}

const code = (s: string) => "`" + s.replace(/`/g, "'") + "`"
const numbered = (lines: ReadonlyArray<string>, at: number) => `${String(at + 1).padStart(5)}| ${lines[at]}`

/** An excerpt of a found block, at most `max` lines: its opening line, the end of its contents, its closing line. */
export const excerpt = (lines: ReadonlyArray<string>, r: Region, max: number): Array<string> => {
  if (max <= 0) return []
  if (r.members.length > 0) {
    const last = r.members.slice(-Math.max(1, max - 1))
    return [...(r.members.length > last.length ? ["     ⋮"] : []), ...last.map((i) => numbered(lines, i))]
  }
  const all: Array<number> = []
  for (let i = r.from; i <= r.to; i++) all.push(i)
  if (all.length <= max) return all.map((i) => numbered(lines, i))
  // The block's first line says which block it is (`const APP_STATE_STORAGE_CONF = (<`, not its closing `>(config) =>`).
  const open = r.openLine ?? r.from
  const close = r.closeLine
  const tail = all.filter((i) => i > open && i !== close && lines[i].trim() !== "").slice(-(max - (close === null ? 1 : 2)))
  return [numbered(lines, r.from), "     ⋮", ...tail.map((i) => numbered(lines, i)), ...(close === null ? [] : [numbered(lines, close)])]
}

interface Rendered {
  readonly header: string
  readonly excerpt: ReadonlyArray<string>
  readonly shown: Shown
}

/** A step's place as found (Locate.ts): where it is now and an excerpt of up to `max` lines. */
const renderPlace = (p: Place, at: Located, max: number): Rendered => {
  if (at.kind === "new-file") {
    const short = [...at.siblings].sort((a, b) => a.lines - b.lines)
    const names = short.slice(0, 6).map((f) => `${f.name} (${f.lines} lines)`).join(", ")
    return {
      header: `a new file in ${code(at.dir + "/")}, named like the ${at.siblings.length} there that start with ${code(at.prefix)}; shortest first: ${names}`,
      excerpt: [],
      shown: { place: p.id, file: at.dir, from: 0, to: 0 }
    }
  }
  const r = at.region
  const where = p.chain.length > 0 ? `in ${describeChain(shapeOf(p), 3)}` : describeChain(shapeOf(p))
  const moved = at.moved ? ` (moved from ${code(p.file)})` : ""
  return {
    header: `${code(`${at.file}:${r.from + 1}-${r.to + 1}`)} ${where}${moved}`,
    excerpt: excerpt(at.lines, r, max),
    shown: { place: p.id, file: at.file, from: r.from + 1, to: r.to + 1 }
  }
}

const HEADER = [
  "# Workflows from earlier work in this repository",
  "",
  "Reusable steps learned from earlier tasks here. Blanks in braces stand for your task's own names and values. " +
  "Places are found in the code as it is now (current line numbers); the lines shown are excerpts.",
  ""
].join("\n")

export const renderHandover = (
  memory: WorkflowMemory,
  chosen: ReadonlyArray<Selected>,
  located: ReadonlyMap<string, Located>,
  budget = MAX_HANDOVER_CHARS
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

  const build = (maxLines: number) => {
    const out: Array<string> = [HEADER]
    const shown: Array<Shown> = []
    const missing: Array<string> = []
    const warned = new Set<string>()
    chosen.forEach((c, k) => {
      const w = c.workflow
      out.push(`## ${k + 1}. ${w.name}`)
      if (w.blanks.length > 0) out.push(`Blanks: ${w.blanks.map((b) => `{${b.name}} ${b.meaning}`).join("; ")}`)
      let n = 0
      w.steps.forEach((s, i) => {
        if (c.skip.includes(i + 1)) return
        n++
        out.push(`${n}. ${s.do}${s.when === null ? "" : ` (${s.when})`}`)
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
      if (w.checks.length > 0) out.push(`Check with ${w.checks.map(code).join(" or ")}.`)
      for (const id of w.pitfalls) {
        const p = pitfalls.get(id)
        if (p === undefined || warned.has(id)) continue
        warned.add(id)
        out.push(`Watch out: ${p.text}`)
      }
      out.push("")
    })
    return { text: out.join("\n"), shown, missing }
  }

  // The longest excerpts that fit; at worst, none.
  for (const max of [8, 6, 4, 3, 0]) {
    const h = build(max)
    if (h.text.length <= budget || max === 0) {
      return { ...h, text: h.text.length <= budget ? h.text : h.text.slice(0, budget), pitfalls: attached.map((p) => p.id) }
    }
  }
  return { text: "", shown: [], missing: [], pitfalls: [] }
}
