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
 *       ◆ singularity  65 changes stored in singularity · 7 retired
 *         Sep 24 → Oct 22 · handed to 23 sessions
 *
 *       Committed
 *            Sep       Oct
 *       Mon  · ■ · ■ ■
 *       ...
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

const ramp = (color: boolean, n: number) => (s: string) => (color ? `\u001b[38;5;${n}m${s}\u001b[39m` : s)

/** The calendar's shades, least to most; without color, by the glyph alone. */
const HEAT = [96, 133, 170, 207]
const HEAT_GLYPHS = ["░", "▒", "▓", "█"]
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const cut = (s: string, width: number) => (s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s)
const cutLeft = (s: string, width: number) => (s.length > width ? "…" + s.slice(s.length - width + 1) : s)

/** A bar `n / of` of `width` cells, in eighths of a cell. */
const bar = (n: number, of: number, width: number): string => {
  if (of <= 0 || n <= 0) return ""
  const eighths = Math.max(1, Math.round((n / of) * width * 8))
  return "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8]
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
  out.push(`    ${"".padEnd(4)}${s.dim("less")} ${legend} ${s.dim(`more   most in a day: ${most}`)}`)
  return out
}

/** A change's lines on a log scale against the largest, added then removed. */
const linesBar = (s: Style, color: boolean, added: number, removed: number, most: number, width: number): string => {
  const total = added + removed
  if (total === 0 || most === 0) return s.dim("·").padEnd(width)
  const len = Math.max(1, Math.round((width * Math.log10(1 + total)) / Math.log10(1 + most)))
  const plus = Math.round((len * added) / total)
  const minus = len - plus
  const text = color
    ? s.green("▆".repeat(plus)) + s.red("▆".repeat(minus))
    : "█".repeat(plus) + "░".repeat(minus)
  return text + " ".repeat(width - len)
}

const checkMark = (s: Style, c: CheckState) => (c === "passed" ? s.green("✓") : c === "failed" ? s.red("✗") : s.dim("·"))

const BAR = 10

/** One repo's memory, drawn `width` columns wide. */
export const renderVisual = (v: Visual, o: { readonly color: boolean; readonly width: number }): Array<string> => {
  const s = makeStyle(o.color)
  const width = Math.max(64, Math.min(110, o.width))
  const span = v.first === null ? "" : v.first === v.last ? dayLabel(v.first) : `${dayLabel(v.first)} → ${dayLabel(v.last!)}`
  const out = [
    "",
    `  ${s.magenta("◆")} ${s.bold("singularity")}  ${plural(v.stored, "change")} stored in ${s.bold(v.repo.name)}${v.retired === 0 ? "" : s.dim(` · ${v.retired} retired`)}`
  ]
  if (v.stored === 0) {
    return [...out, "", `  ${s.dim("none yet: memory stores a change when a session commits it; singularity store adds earlier sessions'")}`, ""]
  }
  out.push(`    ${s.dim([span, v.sessions === 0 ? "handed to no session yet" : `handed to ${plural(v.sessions, "session")}`].join(" · "))}`)

  out.push("", `  ${s.bold("Committed")}`, ...calendar(v, s, o.color, width))

  // the latest changes: a node each, then date, commit, title, lines, check, sessions given it
  // indent, node, date, commit, then after the title: lines, and "check given" (a mark under check, a count under given)
  const fixed = 4 + 2 + 7 + 2 + 7 + 2 + 2 + BAR + 2 + 11
  const tw = Math.max(16, width - fixed - 1)
  out.push(
    "",
    `  ${s.bold("Latest changes")}`,
    `    ${"".padEnd(2 + 7 + 2 + 7 + 2 + tw + 2)}${s.dim("lines".padEnd(BAR + 2) + "check given")}`
  )
  for (const c of v.latest) {
    const node = c.retired ? s.dim("○") : s.magenta("●")
    const date = dayLabel(c.day).padEnd(7)
    const sha = (c.commit?.slice(0, 7) ?? "").padEnd(7)
    const title = cut(c.title, tw).padEnd(tw)
    const lines = linesBar(s, o.color, c.added, c.removed, v.most_lines, BAR)
    const given = c.handed === 0 ? s.dim("·".padStart(5)) : s.cyan(`${c.handed}×`.padStart(5))
    const row = c.retired
      ? `${s.dim(`${date}  ${sha}  ${title}`)}  ${s.dim("retired".padEnd(BAR))}    ${checkMark(s, c.check)}   ${given}`
      : `${s.dim(date)}  ${s.yellow(sha)}  ${title}  ${lines}    ${checkMark(s, c.check)}   ${given}`
    out.push(`    ${node} ${row}`)
  }
  if (v.more > 0) out.push(`    ${s.dim(`┆ ${v.more} more: singularity changes lists them all`)}`)

  // the folders memory knows most
  const most = v.folders[0]?.changes ?? 0
  const pw = Math.min(36, Math.max(...v.folders.map((f) => f.path.length)))
  const fw = Math.max(10, width - 4 - pw - 2 - 8)
  out.push("", `  ${s.bold("Where it knows the code")}  ${s.dim("changes that touched each folder")}`)
  for (const f of v.folders) {
    out.push(`    ${cutLeft(f.path, pw).padEnd(pw)}  ${s.magenta(bar(f.changes, most, fw).padEnd(fw))} ${String(f.changes).padStart(3)}`)
  }

  // the checks before commits, as one bar
  const { passed, failed, none } = v.checks
  const cw = Math.max(20, width - 8)
  const cells = (n: number) => Math.round((n / v.stored) * cw)
  const [p, f] = [cells(passed), cells(failed)]
  const n = Math.max(0, cw - p - f)
  out.push(
    "",
    `  ${s.bold("Checks before each commit")}`,
    `    ${o.color ? s.green("█".repeat(p)) + s.red("█".repeat(f)) + s.dim("░".repeat(n)) : "█".repeat(p) + "▒".repeat(f) + "░".repeat(n)}`,
    `    ${s.green("✓")} ${passed} passed   ${s.red("✗")} ${failed} failed   ${s.dim("·")} ${none} with no check`
  )

  // the changes handed over most
  out.push("", `  ${s.bold("Handed over most")}  ${s.dim("sessions memory gave each change to")}`)
  if (v.handed.length === 0) out.push(`    ${s.dim("none yet: memory hands a change over when a task like it starts")}`)
  else {
    const top = v.handed[0]!.sessions
    const dots = Math.min(12, top)
    const hw = Math.max(16, width - 4 - 7 - 2 - 2 - dots - 12)
    for (const h of v.handed) {
      const k = Math.max(1, Math.round((h.sessions / top) * dots))
      out.push(`    ${s.yellow(h.commit.slice(0, 7))}  ${cut(h.title, hw).padEnd(hw)}  ${s.cyan("●".repeat(k))}${" ".repeat(dots - k)} ${plural(h.sessions, "session")}`)
    }
  }
  out.push("", `  ${s.dim("one in full, as an agent would read it:")} ${s.cyan("singularity changes <commit>")}`, "")
  return out
}

/** Every repo memory knows, a row each, with a sparkline of its last weeks. */
export const renderOverview = (v: Overview, o: { readonly color: boolean }): Array<string> => {
  const s = makeStyle(o.color)
  const out = [""]
  if (v.repos.length === 0) {
    return [...out, `  ${s.magenta("◆")} ${s.bold("singularity")}  ${s.dim("no changes stored yet")}`, "", `  ${s.dim("memory stores a change when a session commits it; singularity store adds earlier sessions'")}`, ""]
  }
  out.push(`  ${s.magenta("◆")} ${s.bold("singularity")}  memory across ${plural(v.repos.length, "repo")}`, "")
  const nw = Math.min(28, Math.max(...v.repos.map((r) => r.name.length)))
  const most = Math.max(1, ...v.repos.flatMap((r) => r.weeks))
  out.push(`    ${"".padEnd(nw)}  ${"".padEnd(12)}  ${s.dim(`last ${WEEKS} weeks`)}`)
  for (const r of v.repos) {
    const spark = r.weeks.map((n) => (n === 0 ? s.dim("·") : s.magenta(SPARKS[Math.min(7, Math.ceil((n / most) * 8) - 1)]!))).join("")
    const count = `${plural(r.stored, "change")}`.padEnd(12)
    const last = r.last === null ? "" : s.dim(`  last ${dayLabel(r.last)}`)
    out.push(`    ${cut(r.name, nw).padEnd(nw)}  ${count}  ${spark}${last}${r.retired === 0 ? "" : s.dim(` · ${r.retired} retired`)}`)
  }
  out.push("", `  ${s.dim("one repo, drawn in full:")} ${s.cyan("singularity visualise --repo NAME")}`, "")
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
