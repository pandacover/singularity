/**
 * `singularity visualise`: what memory stored in a repo, drawn for a
 * terminal. A calendar of the days changes were committed, the latest ones
 * with how much each changed and whether its check passed, the folders
 * memory knows most, how the checks before commits went, and the changes it
 * handed to most sessions. Where memory knows no repo, every repo it knows,
 * side by side. The data is `gatherChanges`' (Changes.ts) and the sessions'
 * notes of what they were given (scripts/History.ts); drawing it is plain
 * functions, and --json prints the data instead.
 *
 *       ◆ singularity  67 changes stored in singularity · 7 retired
 *         Oct 1 → Oct 23 · handed to 13 sessions
 *
 *       Where it knows the code ─────────────────────────────────
 *       Folders by how many stored changes touched them.
 *
 *         (top level)          ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆ 49
 *         apps/cli/src/setup   ▆▆▆▆▆▆▆▆▆ 21
 *                              └────────┴─────────┘
 *                     changes  0       25        49
 */
import { Console, Effect, FileSystem, Path } from "effect"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { type Change, type ChangesReport, gatherChanges } from "./Changes.ts"
import { makeStyle, plural, type Style } from "./Ui.ts"

export type CheckState = "passed" | "failed" | "none"

/** One repo's memory, as `visualise` draws it. */
export interface Visual {
  readonly repo: { readonly id: string; readonly name: string }
  readonly stored: number
  readonly retired: number
  /** The first and last day a change was committed, `YYYY-MM-DD`; null with none. */
  readonly first: string | null
  readonly last: string | null
  /** Sessions memory handed one of these changes to, at task start or on a `git show`. */
  readonly sessions: number
  /** Changes committed each day, from `first` to today. */
  readonly days: ReadonlyArray<{ readonly day: string; readonly changes: number }>
  /** Newest first. */
  readonly latest: ReadonlyArray<{
    readonly commit: string | null
    readonly title: string
    readonly day: string
    readonly added: number
    readonly removed: number
    readonly check: CheckState
    readonly handed: number
    readonly retired: boolean
  }>
  /** Changes older than `latest`. */
  readonly more: number
  /** The largest change's lines, added and removed: `latest`'s bars are drawn against it. */
  readonly most_lines: number
  /** Folders by how many changes touched them. */
  readonly folders: ReadonlyArray<{ readonly path: string; readonly changes: number }>
  /** How the last check before each commit went. */
  readonly checks: { readonly passed: number; readonly failed: number; readonly none: number }
  /** The changes handed to most sessions. */
  readonly handed: ReadonlyArray<{ readonly commit: string; readonly title: string; readonly sessions: number }>
}

/** Every repo memory knows, when the one asked for isn't one. */
export interface Overview {
  readonly repos: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly stored: number
    readonly retired: number
    readonly last: string | null
    /** Changes committed each of the last `WEEKS` weeks, oldest first. */
    readonly weeks: ReadonlyArray<number>
  }>
}

const LATEST = 10
const FOLDERS = 6
const HANDED = 5
const WEEKS = 12

/** A local day, `YYYY-MM-DD`. */
export const dayOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

const dateOf = (day: string): Date => {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y!, m! - 1, d!)
}

/** "Oct 22", for a local day. */
const dayLabel = (day: string): string => dateOf(day).toLocaleDateString("en", { month: "short", day: "numeric" })

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

const whenOf = (c: Change): Date => new Date(c.committed_at ?? c.stored_at)

/** How the last check before its commit went. */
const checkOf = (c: Change): CheckState => {
  const last = c.checks[c.checks.length - 1]
  return last === undefined ? "none" : last.ok ? "passed" : "failed"
}

const folderOf = (file: string): string => {
  const at = file.replace(/\\/g, "/").lastIndexOf("/")
  return at < 0 ? "(top level)" : file.slice(0, at)
}

/** How many sessions were given each commit: one list of commits per session. */
export const countGiven = (sessions: ReadonlyArray<ReadonlyArray<string>>): Map<string, number> => {
  const out = new Map<string, number>()
  for (const commits of sessions) for (const c of new Set(commits)) out.set(c, (out.get(c) ?? 0) + 1)
  return out
}

/** A repo's report drawn as data: `given` from `countGiven`, `now` for the calendar's end. */
export const summarise = (r: ChangesReport & { readonly repo: NonNullable<ChangesReport["repo"]> }, given: ReadonlyArray<ReadonlyArray<string>>, now: Date): Visual => {
  const counts = countGiven(given)
  const handedOf = (c: Change) => (c.commit === null ? 0 : counts.get(c.commit) ?? 0)
  const commits = new Set(r.changes.flatMap((c) => (c.commit === null ? [] : [c.commit])))
  const sessions = given.filter((s) => s.some((c) => commits.has(c))).length

  const byDay = new Map<string, number>()
  for (const c of r.changes) {
    const day = dayOf(whenOf(c))
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  const sorted = [...byDay.keys()].sort()
  const first = sorted[0] ?? null
  const last = sorted[sorted.length - 1] ?? null
  const days: Array<{ day: string; changes: number }> = []
  if (first !== null) {
    const end = dayOf(now) > last! ? dayOf(now) : last!
    for (let d = dateOf(first); dayOf(d) <= end; d = addDays(d, 1)) days.push({ day: dayOf(d), changes: byDay.get(dayOf(d)) ?? 0 })
  }

  const touched = new Map<string, number>()
  for (const c of r.changes) for (const f of new Set(c.files.map((x) => folderOf(x.path)))) touched.set(f, (touched.get(f) ?? 0) + 1)

  const lines = (c: Change) => c.files.reduce((n, f) => n + f.added + f.removed, 0)
  return {
    repo: { id: r.repo.id, name: r.repo.name },
    stored: r.changes.length,
    retired: r.changes.filter((c) => c.retired !== null).length,
    first,
    last,
    sessions,
    days,
    latest: r.changes.slice(0, LATEST).map((c) => ({
      commit: c.commit,
      title: c.title ?? c.task,
      day: dayOf(whenOf(c)),
      added: c.files.reduce((n, f) => n + f.added, 0),
      removed: c.files.reduce((n, f) => n + f.removed, 0),
      check: checkOf(c),
      handed: handedOf(c),
      retired: c.retired !== null
    })),
    more: Math.max(0, r.changes.length - LATEST),
    most_lines: Math.max(0, ...r.changes.map(lines)),
    folders: [...touched].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, FOLDERS).map(([path, changes]) => ({ path, changes })),
    checks: {
      passed: r.changes.filter((c) => checkOf(c) === "passed").length,
      failed: r.changes.filter((c) => checkOf(c) === "failed").length,
      none: r.changes.filter((c) => checkOf(c) === "none").length
    },
    handed: r.changes
      .filter((c) => c.commit !== null && handedOf(c) > 0)
      .sort((a, b) => handedOf(b) - handedOf(a))
      .slice(0, HANDED)
      .map((c) => ({ commit: c.commit!, title: c.title ?? c.task, sessions: handedOf(c) }))
  }
}

/** A repo's changes per week, the last `WEEKS` up to `now`, oldest first. */
export const weekly = (changes: ReadonlyArray<Change>, now: Date): Array<number> => {
  const weeks = new Array<number>(WEEKS).fill(0)
  const today = dateOf(dayOf(now)).getTime()
  for (const c of changes) {
    const ago = Math.floor((today - dateOf(dayOf(whenOf(c))).getTime()) / (7 * 86_400_000))
    if (ago >= 0 && ago < WEEKS) weeks[WEEKS - 1 - ago]! += 1
  }
  return weeks
}

// Drawing
//
// Every graph has a title over a rule to the right edge, a line saying what
// it shows, and its axes and units labelled. Bars are drawn in ▆, which
// leaves a gap above it, so bars on rows one under another stay apart; in
// color, neighbouring rows alternate two shades. Glyphs are the ones setup
// already prints (block elements, box drawing, ✓ ✗ ● ○ ◆), and every line
// is as long with color as without.

const ramp = (color: boolean, n: number) => (s: string) => (color ? `\u001b[38;5;${n}m${s}\u001b[39m` : s)

/** The calendar's shades, least to most; without color, by the glyph alone. */
const HEAT = [96, 133, 170, 207]
const HEAT_GLYPHS = ["░", "▒", "▓", "█"]
const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** A bar's cell. */
const CELL = "▆"
/** The cell of a change's lines removed, without color: lower, so added and removed read apart. */
const CELL_REMOVED = "▂"
/** Two shades of the same hue, for rows one under another. */
const ROW_SHADES = [170, 133]

/** The narrowest and widest `visualise` draws. */
export const MIN_WIDTH = 48
export const MAX_WIDTH = 110

const cut = (s: string, width: number) => (s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s)
const cutLeft = (s: string, width: number) => (s.length > width ? "…" + s.slice(s.length - width + 1) : s)

/** Words in lines of at most `width`. */
const wrapWords = (text: string, width: number): Array<string> => {
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line)
      line = ""
    }
    line = line === "" ? cut(word, width) : `${line} ${word}`
  }
  return line === "" ? lines : [...lines, line]
}

/** Parts of a line, each its plain text and how it is drawn, in lines of at most `width`, `gap` between parts. */
const flow = (parts: ReadonlyArray<readonly [plain: string, drawn: string]>, width: number, gap = "   "): Array<string> => {
  const lines: Array<string> = []
  let plain = ""
  let drawn = ""
  for (const [p, d] of parts) {
    if (plain !== "" && plain.length + gap.length + p.length > width) {
      lines.push(drawn)
      plain = drawn = ""
    }
    plain = plain === "" ? p : plain + gap + p
    drawn = drawn === "" ? d : drawn + gap + d
  }
  return plain === "" ? lines : [...lines, drawn]
}

/** A graph's head: a blank line, its title over a rule to the right edge, and what it shows. */
const heading = (s: Style, width: number, title: string, about: string): Array<string> => [
  "",
  `  ${s.bold(title)} ${s.dim("─".repeat(Math.max(1, width - 3 - title.length)))}`,
  ...wrapWords(about, width - 4).map((l) => `  ${s.dim(l)}`),
  ""
]

/** Cells a bar of `n` takes, of `width` for `max`: at least one for anything above zero. */
const cellsFor = (n: number, max: number, width: number) => (n <= 0 || max <= 0 ? 0 : Math.max(1, Math.round((n / max) * width)))

interface BarRow {
  readonly label: string
  readonly n: number
  /** After the bar: its value, in plain text. */
  readonly value: string
  /** How the bar is drawn; by default the row's shade. */
  readonly paint?: (cells: string) => string
}

/**
 * Horizontal bars against `max`, a row each: the label, the bar, its value.
 * Under them an axis from 0 to `max`, its ticks labelled by `tick`, the
 * unit under the labels.
 */
const barChart = (s: Style, color: boolean, rows: ReadonlyArray<BarRow>, o: {
  readonly width: number
  readonly max: number
  readonly ticks: ReadonlyArray<number>
  readonly tick: (v: number) => string
  readonly unit: string
}): Array<string> => {
  if (rows.length === 0) return [`    ${s.dim("none")}`]
  const lw = Math.min(36, Math.floor(o.width / 2.5), Math.max(o.unit.length, ...rows.map((r) => r.label.length)))
  const vw = Math.max(...rows.map((r) => r.value.length))
  const fw = Math.max(8, o.width - 4 - lw - 2 - 1 - vw)
  const out = rows.map((r, i) => {
    const paint = r.paint ?? ramp(color, ROW_SHADES[i % 2]!)
    return `    ${cutLeft(r.label, lw).padEnd(lw)}  ${paint(CELL.repeat(cellsFor(r.n, o.max, fw)))} ${r.value}`
  })
  // a tick where a bar of its value ends; its label centred on it, kept inside the axis and off its neighbours
  const at = (v: number) => Math.max(0, Math.min(fw - 1, cellsFor(v, o.max, fw) - 1))
  const axis = [..."─".repeat(fw)]
  const labels = new Array<string>(fw).fill(" ")
  let free = 0
  for (const v of o.ticks) {
    const p = at(v)
    axis[p] = p === 0 ? "└" : p === fw - 1 ? "┘" : "┴"
    const text = o.tick(v)
    const start = Math.max(0, Math.min(fw - text.length, p - Math.floor(text.length / 2)))
    if (start < free) continue
    for (let k = 0; k < text.length; k++) labels[start + k] = text[k]!
    free = start + text.length + 1
  }
  out.push(`    ${"".padEnd(lw)}  ${s.dim(axis.join(""))}`, `    ${s.dim(o.unit.padStart(lw))}  ${s.dim(labels.join("").trimEnd())}`)
  return out
}

const shade = (s: Style, color: boolean) => (n: number, most: number): string => {
  if (n === 0) return s.dim("·")
  const level = Math.min(3, Math.ceil((n / most) * 4) - 1)
  return color ? ramp(true, HEAT[level]!)("■") : HEAT_GLYPHS[level]!
}

/** The calendar: a column a week, Monday to Sunday, as many weeks as fit, ending this week. */
const calendar = (v: Visual, s: Style, color: boolean, width: number): Array<string> => {
  if (v.days.length === 0) return []
  const most = Math.max(...v.days.map((d) => d.changes))
  const counts = new Map(v.days.map((d) => [d.day, d.changes]))
  const end = dateOf(v.days[v.days.length - 1]!.day)
  const fit = Math.max(4, Math.floor((width - 12) / 2))
  const span = Math.ceil((v.days.length + ((dateOf(v.days[0]!.day).getDay() + 6) % 7)) / 7)
  const weeks = Math.min(fit, Math.max(8, span))
  const monday = addDays(end, -((end.getDay() + 6) % 7) - (weeks - 1) * 7)
  const shadeOf = shade(s, color)

  // a month's name over the first week that holds its first day, or the first week shown
  let head = ""
  for (let w = 0; w < weeks; w++) {
    const start = addDays(monday, w * 7)
    const turns = w === 0 || addDays(start, 6).getMonth() !== addDays(start, -1).getMonth()
    const month = MONTHS[addDays(start, 6).getMonth()]!
    if (turns && (head === "" || head.length < w * 2)) head = head.padEnd(w * 2) + month
  }
  const out = [`    ${"".padEnd(4)}${s.dim(head)}`]
  for (let row = 0; row < 7; row++) {
    const cells: Array<string> = []
    for (let w = 0; w < weeks; w++) {
      const day = addDays(monday, w * 7 + row)
      cells.push(day > end ? " " : shadeOf(counts.get(dayOf(day)) ?? 0, most))
    }
    const label = row % 2 === 0 ? ["Mon", "", "Wed", "", "Fri", "", "Sun"][row]! : ""
    out.push(`    ${s.dim(label.padEnd(4))}${cells.join(" ")}`.trimEnd())
  }
  const legend = [1, 2, 3, 4].map((k) => shadeOf(k, 4)).join(" ")
  out.push(
    "",
    ...flow([
      [`· none  less ${"░ ▒ ▓ █"} more`, `${s.dim("·")} ${s.dim("none")}  ${s.dim("less")} ${legend} ${s.dim("more")}`],
      [`busiest day: ${plural(most, "change")}`, s.dim(`busiest day: ${plural(most, "change")}`)]
    ], width - 4).map((l) => `    ${l}`)
  )
  return out
}

/** A change's lines on a log scale against the largest, added then removed. */
const linesBar = (s: Style, color: boolean, added: number, removed: number, most: number, width: number): string => {
  const total = added + removed
  if (total === 0 || most === 0) return s.dim("·").padEnd(width)
  const len = Math.max(1, Math.round((width * Math.log10(1 + total)) / Math.log10(1 + most)))
  const plus = Math.round((len * added) / total)
  const minus = len - plus
  const text = color ? s.green(CELL.repeat(plus)) + s.red(CELL.repeat(minus)) : CELL.repeat(plus) + CELL_REMOVED.repeat(minus)
  return text + " ".repeat(width - len)
}

const checkMark = (s: Style, c: CheckState) => (c === "passed" ? s.green("✓") : c === "failed" ? s.red("✗") : s.dim("·"))

/** The latest changes: a node each, then (when it fits) the date, the commit, the title, its lines, its check, the sessions given it. */
const latestTable = (v: Visual, s: Style, color: boolean, width: number): Array<string> => {
  const dated = width >= 72
  const bw = width >= 72 ? 10 : 7
  // indent and node, date, commit, then after the title: lines, check, given
  const fixed = 4 + 2 + (dated ? 9 : 0) + 9 + 2 + bw + 2 + 5 + 2 + 5
  const tw = Math.max(10, width - fixed)
  const head = `${dated ? "date".padEnd(9) : ""}${"commit".padEnd(9)}${"change".padEnd(tw)}  ${"lines".padEnd(bw)}  check  given`
  const out = [`      ${s.dim(head)}`]
  for (const c of v.latest) {
    const node = c.retired ? s.dim("○") : s.magenta("●")
    const date = dated ? `${dayLabel(c.day).padEnd(7)}  ` : ""
    const sha = `${(c.commit?.slice(0, 7) ?? "").padEnd(7)}  `
    const title = cut(c.title, tw).padEnd(tw)
    const lines = c.retired ? "retired".padEnd(bw) : linesBar(s, color, c.added, c.removed, v.most_lines, bw)
    const check = `  ${checkMark(s, c.check)}  `
    const given = c.handed === 0 ? s.dim("·".padStart(5)) : s.cyan(`${c.handed}×`.padStart(5))
    const row = c.retired
      ? `${s.dim(`${date}${sha}${title}`)}  ${s.dim(lines)}  ${check}  ${given}`
      : `${s.dim(date)}${s.yellow(sha)}${title}  ${lines}  ${check}  ${given}`
    out.push(`    ${node} ${row}`)
  }
  if (v.more > 0) out.push(`    ${s.dim(cut(`┆ ${v.more} more: singularity changes lists them all`, width - 4))}`)
  out.push(
    "",
    ...flow([
      color ? ["▆ added ▆ removed", `${s.green(CELL)} ${s.dim("added")} ${s.red(CELL)} ${s.dim("removed")}`] : [`${CELL} added ${CELL_REMOVED} removed`, `${CELL} added ${CELL_REMOVED} removed`],
      [`lines, log scale: a full bar is ${v.most_lines.toLocaleString("en")}`, s.dim(`lines, log scale: a full bar is ${v.most_lines.toLocaleString("en")}`)],
      ["✓ passed ✗ failed · none", `${s.green("✓")} ${s.dim("passed")} ${s.red("✗")} ${s.dim("failed")} ${s.dim("· none")}`],
      ["given: sessions handed it", s.dim("given: sessions handed it")]
    ], width - 4).map((l) => `    ${l}`)
  )
  return out
}

/** The changes handed to most sessions: a dot a session, or scaled to twelve when more. */
const handedRows = (v: Visual, s: Style, width: number): Array<string> => {
  if (v.handed.length === 0) return [`    ${s.dim("none yet: memory hands a change over when a task like it starts")}`]
  const top = v.handed[0]!.sessions
  const dots = Math.min(12, top)
  const hw = Math.max(10, width - 4 - 9 - 2 - dots - 1 - 12)
  const out = v.handed.map((h) => {
    const k = Math.max(1, Math.round((h.sessions / top) * dots))
    return `    ${s.yellow(h.commit.slice(0, 7))}  ${cut(h.title, hw).padEnd(hw)}  ${s.cyan("●".repeat(k))}${" ".repeat(dots - k)} ${plural(h.sessions, "session")}`
  })
  const per = top > dots ? `● about ${(top / dots).toFixed(1)} sessions` : "● a session"
  return [...out, "", `    ${s.dim(per)}`]
}

/** One repo's memory, drawn `width` columns wide. */
export const renderVisual = (v: Visual, o: { readonly color: boolean; readonly width: number }): Array<string> => {
  const s = makeStyle(o.color)
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, o.width))
  const span = v.first === null ? "" : v.first === v.last ? dayLabel(v.first) : `${dayLabel(v.first)} → ${dayLabel(v.last!)}`
  const stored = `${plural(v.stored, "change")} stored in ${v.repo.name}`
  const retired = v.retired === 0 ? "" : ` · ${v.retired} retired`
  const wide = 2 + 2 + 11 + 2 + stored.length + retired.length <= width
  const out = [
    "",
    `  ${s.magenta("◆")} ${s.bold("singularity")}  ${plural(v.stored, "change")} stored in ${s.bold(cut(v.repo.name, width - 17 - stored.length + v.repo.name.length))}${wide ? s.dim(retired) : ""}`
  ]
  if (v.stored === 0) {
    return [...out, "", ...wrapWords("none yet: memory stores a change when a session commits it; singularity store adds earlier sessions'", width - 4).map((l) => `  ${s.dim(l)}`), ""]
  }
  const given = v.sessions === 0 ? "handed to no session yet" : `handed to ${plural(v.sessions, "session")}`
  out.push(...flow([[span, s.dim(span)], ...(wide ? [] : [[retired.slice(3), s.dim(retired.slice(3))] as const]), [given, s.dim(given)]], width - 4, " · ").map((l) => `    ${l}`))

  out.push(
    ...heading(s, width, "Changes by day", "A square a day, a column a week: the darker, the more changes that day."),
    ...calendar(v, s, o.color, width)
  )

  out.push(
    ...heading(s, width, "Latest changes", "Newest first, with each one's lines, last check, and sessions given it."),
    ...latestTable(v, s, o.color, width)
  )

  const most = v.folders[0]?.changes ?? 0
  out.push(
    ...heading(s, width, "Where it knows the code", "Folders by how many stored changes touched them."),
    ...barChart(s, o.color, v.folders.map((f) => ({ label: f.path, n: f.changes, value: String(f.changes) })), {
      width,
      max: most,
      ticks: most > 1 ? [0, Math.round(most / 2), most] : [0, most],
      tick: String,
      unit: "changes"
    })
  )

  const { passed, failed, none } = v.checks
  const pct = (n: number) => `${Math.round((n / v.stored) * 100)}%`
  out.push(
    ...heading(s, width, "Checks before each commit", "The last test, typecheck, build or lint a session ran before committing."),
    ...barChart(s, o.color, [
      { label: "passed", n: passed, value: `${passed} · ${pct(passed)}`, paint: s.green },
      { label: "failed", n: failed, value: `${failed} · ${pct(failed)}`, paint: s.red },
      { label: "no check", n: none, value: `${none} · ${pct(none)}`, paint: s.dim }
    ], { width, max: v.stored, ticks: [0, v.stored / 2, v.stored], tick: pct, unit: `of ${plural(v.stored, "change")}` })
  )

  out.push(
    ...heading(s, width, "Handed over most", "Changes memory gave to the most sessions, at task start or on git show."),
    ...handedRows(v, s, width)
  )
  out.push("", ...flow([["one in full, as an agent would read it:", s.dim("one in full, as an agent would read it:")], ["singularity changes <commit>", s.cyan("singularity changes <commit>")]], width - 2, " ").map((l) => `  ${l}`), "")
  return out
}

/** Every repo memory knows, a row each, with its changes a week over the last weeks. */
export const renderOverview = (v: Overview, o: { readonly color: boolean; readonly width?: number }): Array<string> => {
  const s = makeStyle(o.color)
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, o.width ?? 80))
  const out = [""]
  if (v.repos.length === 0) {
    return [...out, `  ${s.magenta("◆")} ${s.bold("singularity")}  ${s.dim("no changes stored yet")}`, "", ...wrapWords("memory stores a change when a session commits it; singularity store adds earlier sessions'", width - 4).map((l) => `  ${s.dim(l)}`), ""]
  }
  out.push(`  ${s.magenta("◆")} ${s.bold("singularity")}  memory across ${plural(v.repos.length, "repo")}`)
  const most = Math.max(1, ...v.repos.flatMap((r) => r.weeks))
  out.push(...heading(s, width, "Changes a week", `Changes stored per week, last ${WEEKS} weeks; the taller, the more (most: ${most}).`))
  // a bar a week, a space between where it fits
  const spaced = width >= 70
  const sw = spaced ? WEEKS * 2 - 1 : WEEKS
  const nw = Math.max(4, Math.min(28, width - 4 - 2 - 11 - 2 - sw - 8, Math.max(...v.repos.map((r) => r.name.length))))
  out.push(`    ${s.dim(`${"repo".padEnd(nw)}  ${"stored".padEnd(11)}  ${"per week".padEnd(sw)}  last`)}`)
  for (const [i, r] of v.repos.entries()) {
    const paint = ramp(o.color, ROW_SHADES[i % 2]!)
    const spark = r.weeks.map((n) => (n === 0 ? s.dim("·") : paint(SPARKS[Math.min(7, Math.ceil((n / most) * 8) - 1)]!))).join(spaced ? " " : "")
    const count = plural(r.stored, "change").padEnd(11)
    const last = r.last === null ? "" : `  ${dayLabel(r.last)}`
    const retired = r.retired === 0 ? "" : ` · ${r.retired} retired`
    const room = width - (4 + nw + 2 + 11 + 2 + sw)
    out.push(`    ${cut(r.name, nw).padEnd(nw)}  ${count}  ${spark}${s.dim(last.length + retired.length <= room ? last + retired : last.length <= room ? last : "")}`)
  }
  const axis = spaced ? `└${`${WEEKS} weeks ago`.padEnd(sw - 5)}now┘` : `${WEEKS} wks → now`
  out.push(`    ${"".padEnd(nw)}  ${"".padEnd(11)}  ${s.dim(axis)}`)
  out.push("", ...flow([["one repo, drawn in full:", s.dim("one repo, drawn in full:")], ["singularity visualise --repo NAME", s.cyan("singularity visualise --repo NAME")]], width - 2, " ").map((l) => `  ${l}`), "")
  return out
}

/** Each session's commits memory gave it, from `<tenant>/scripts/sessions/*.given`. */
const readGivenAll = Effect.fn("visualise.readGiven")(function*(tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(tenantDir, "scripts", "sessions")
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
  return yield* Effect.forEach(names.filter((n) => n.endsWith(".given")), (n) =>
    fs.readFileString(path.join(dir, n)).pipe(
      Effect.map((t) => t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")),
      Effect.orElseSucceed(() => [])
    ))
})

export const runVisualise = Effect.fn("runVisualise")(function*(o: {
  readonly cwd: string
  readonly repo?: string | undefined
  readonly memoryHome?: string | undefined
  readonly color: boolean
  readonly json: boolean
  readonly width: number
}) {
  const home = yield* loadHome(o.memoryHome)
  yield* Effect.gen(function*() {
    const now = new Date()
    const report = yield* gatherChanges({ cwd: o.cwd, repo: o.repo, tenantDir: home.tenantDir })
    if (report.repo !== null) {
      const v = summarise({ ...report, repo: report.repo }, yield* readGivenAll(home.tenantDir), now)
      return yield* Console.log(o.json ? JSON.stringify(v, null, 2) : renderVisual(v, o).join("\n"))
    }
    const subjects = yield* (yield* RecordStore).subjects()
    const repos = yield* Effect.forEach(subjects, (subject) =>
      gatherChanges({ cwd: o.cwd, repo: subject.id, tenantDir: home.tenantDir }).pipe(Effect.map((r) => {
        const days = r.changes.map((c) => dayOf(whenOf(c))).sort()
        return {
          id: subject.id,
          name: subject.name,
          stored: r.changes.length,
          retired: r.changes.filter((c) => c.retired !== null).length,
          last: days[days.length - 1] ?? null,
          weeks: weekly(r.changes, now)
        }
      })))
    const overview: Overview = { repos: repos.filter((r) => r.stored > 0).sort((a, b) => b.stored - a.stored) }
    yield* Console.log(o.json ? JSON.stringify(overview, null, 2) : renderOverview(overview, o).join("\n"))
  }).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
})
