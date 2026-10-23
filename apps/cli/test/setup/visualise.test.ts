import { describe, expect, it } from "@effect/vitest"
import type { Change, ChangesReport } from "../../src/setup/Changes.ts"
import { countGiven, MAX_WIDTH, MIN_WIDTH, renderOverview, renderVisual, summarise, weekly } from "../../src/setup/Visualise.ts"

const change = (n: number, at: string, o: Partial<Change> = {}): Change => ({
  id: `repo-${n}`,
  commit: String(n).repeat(40).slice(0, 40),
  title: `Change ${n}`,
  commits: 1,
  committed_at: at,
  stored_at: at,
  task: `please make change ${n}`,
  files: [{ path: "src/a.ts", status: "modified", added: 10 * n, removed: n }],
  checks: [{ command: "npm test", ok: true }],
  retired: null,
  ...o
})

// Midday, so the local day is the same as UTC's in any timezone this runs in.
const report: ChangesReport & { repo: NonNullable<ChangesReport["repo"]> } = {
  repo: { id: "repo", name: "repo", root: "/repo" },
  repos: [{ id: "repo", name: "repo" }],
  changes: [
    change(3, "2026-10-21T12:00:00Z", { files: [{ path: "README.md", status: "modified", added: 900, removed: 100 }] }),
    change(2, "2026-10-21T12:00:00Z", { checks: [{ command: "npm test", ok: true }, { command: "npm test", ok: false }] }),
    change(1, "2026-10-14T12:00:00Z", { checks: [], retired: { reason: "reverted by 0123456789ab", at: "2026-10-15T00:00:00Z" } })
  ]
}
const now = new Date(2026, 9, 22, 12)
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "")

describe("singularity visualise", () => {
  it("counts each session once per commit it was given", () => {
    expect([...countGiven([["a", "b", "a"], ["a"]])]).toEqual([["a", 2], ["b", 1]])
  })

  it("sums up a repo's changes: days, checks, folders and hand-overs", () => {
    const v = summarise(report, [[report.changes[0].commit!], [report.changes[0].commit!, report.changes[2].commit!], ["elsewhere"]], now)
    expect(v.stored).toBe(3)
    expect(v.retired).toBe(1)
    expect([v.first, v.last]).toEqual(["2026-10-14", "2026-10-21"])
    // Every day from the first to today, today included.
    expect(v.days).toHaveLength(9)
    expect(v.days.filter((d) => d.changes > 0)).toEqual([{ day: "2026-10-14", changes: 1 }, { day: "2026-10-21", changes: 2 }])
    expect(v.sessions).toBe(2)
    expect(v.checks).toEqual({ passed: 1, failed: 1, none: 1 })
    expect(v.latest.map((c) => [c.check, c.handed, c.retired])).toEqual([["passed", 2, false], ["failed", 0, false], ["none", 1, true]])
    expect(v.folders).toEqual([{ path: "src", changes: 2 }, { path: "(top level)", changes: 1 }])
    expect(v.handed.map((h) => [h.title, h.sessions])).toEqual([["Change 3", 2], ["Change 1", 1]])
    expect(v.most_lines).toBe(1000)
  })

  it("draws it within the terminal's width, the same with color as without", () => {
    const v = summarise(report, [[report.changes[0].commit!]], now)
    for (const width of [30, MIN_WIDTH, 64, 80, 200]) {
      const plain = renderVisual(v, { color: false, width })
      const colored = renderVisual(v, { color: true, width })
      expect(plain.join("\n")).not.toContain("\u001b[")
      expect(colored.map((l) => strip(l).length)).toEqual(plain.map((l) => l.length))
      for (const line of plain) expect(line.length).toBeLessThanOrEqual(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)))
    }
    const plain = renderVisual(v, { color: false, width: 80 })
    const text = plain.join("\n")
    expect(text).toContain("3 changes stored in repo · 1 retired")
    expect(text).toContain("Oct 14 → Oct 21 · handed to 1 session")
    expect(text).toMatch(/○ Oct 14 +1111111 +Change 1 +retired/)
    expect(text).toMatch(/3333333 +Change 3 +● 1 session/)

    // Each graph: its title over a rule to the edge, then a line saying what it shows.
    for (const title of ["Changes by day", "Latest changes", "Where it knows the code", "Checks before each commit", "Handed over most"]) {
      const at = plain.findIndex((l) => l.startsWith(`  ${title} ─`))
      expect(at).toBeGreaterThan(0)
      expect(plain[at]).toHaveLength(80)
      expect(plain[at + 1]).toMatch(/^ {2}[A-Z]/)
    }
    expect(text).toContain("busiest day: 2 changes")
    expect(text).toMatch(/date +commit +change +lines +check +given/)
    expect(text).toContain("lines, log scale: a full bar is 1,000")

    // Bars on axes with their units: folders in changes, checks as a share of every change.
    expect(text).toMatch(/ {4}src +▆+ 2\n {4}\(top level\) +▆+ 1\n +└[─┴]+┘\n +changes {2}0 +1 +2\n/)
    expect(text).toMatch(/passed +▆+ 1 · 33%\n {4}failed +▆+ 1 · 33%\n {4}no check +▆+ 1 · 33%\n +└[─┴]+┘\n {4}of 3 changes {2}0% +50% +100%\n/)

    // Narrow, the date column goes and the rest stays.
    const narrow = renderVisual(v, { color: false, width: MIN_WIDTH }).join("\n")
    expect(narrow).not.toMatch(/Oct 21 +3333333/)
    expect(narrow).toMatch(/● 3333333 +Change 3/)
    // The calendar: a row a weekday under the months it spans, Oct 21 (a Wednesday) the busiest day.
    const mon = plain.findIndex((l) => l.startsWith("    Mon "))
    expect(plain[mon - 1]).toMatch(/^ {8}Sep +Oct$/)
    expect(plain[mon + 2]).toMatch(/^ {4}Wed .*█$/)

    // Bars on a log scale: the largest change fills its bar, the smallest still shows.
    const bars = plain.filter((l) => / ● /.test(l)).map((l) => (l.match(/[▆▂]+/) ?? [""])[0].length)
    expect(bars[0]).toBe(10)
    expect(bars[1]).toBeGreaterThan(0)
    expect(bars[1]).toBeLessThan(10)
  })

  it("says when nothing is stored, and draws every repo side by side", () => {
    const empty = summarise({ ...report, changes: [] }, [], now)
    expect(renderVisual(empty, { color: false, width: 80 }).join("\n")).toContain("none yet")

    expect(weekly(report.changes, now).slice(-2)).toEqual([1, 2])
    const text = renderOverview({
      repos: [
        { id: "repo", name: "repo", stored: 3, retired: 1, last: "2026-10-21", weeks: weekly(report.changes, now) },
        { id: "other", name: "other", stored: 1, retired: 0, last: "2026-08-01", weeks: new Array(12).fill(0) }
      ]
    }, { color: false, width: 80 }).join("\n")
    expect(text).toContain("memory across 2 repos")
    expect(text).toMatch(/ {2}Changes a week ─+\n {2}Changes stored per week, last 12 weeks/)
    // A bar a week, a space between, over an axis from twelve weeks ago to now.
    expect(text).toMatch(/repo +3 changes +(· ){10}▄ █ {2}Oct 21 · 1 retired/)
    expect(text).toMatch(/other +1 change +(· ){11}· {2}Aug 1/)
    expect(text).toMatch(/└12 weeks ago +now┘/)
    expect(renderOverview({ repos: [] }, { color: false }).join("\n")).toContain("no changes stored yet")
  })
})
