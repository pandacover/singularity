/**
 * Spots: where a run put its edits, told by the code that was already there.
 *
 * For every block of lines a run added to an existing file, the nearest line
 * above it and the nearest below it that were there before and say something
 * (`actionToggleObjectsSnapMode,`, not `});`). The memory graph keeps the
 * spots that several runs of a step agree on, and the hand-over looks them up
 * in the code as it is then, so the agent gets the lines around each place
 * without reading for them (handover/Excerpts.ts). The run's own new lines
 * are never kept: memory says where to look, not what was written.
 *
 * The two lines are kept together because one line alone can stand in several
 * places (`} as const;` closes every table); the pair says which one.
 *
 * Only pure additions count. Where a run changed or removed lines, those
 * lines were that task's own target (another task changes other lines), so
 * they mark no place for other tasks.
 */
import { diffFiles, isSnapshot } from "./Extract.ts"
import type { Spot } from "./Models.ts"

/** How far from an added block a spot's line may be, in lines. */
const REACH = 3
const MAX_LINE_CHARS = 200
const MAX_SPOTS = 200

/** Whether a line can mark a place: it has a word in it, and isn't just a bracket or a short keyword. */
export const tellingLine = (line: string): boolean => {
  const t = line.trim()
  return t.length >= 8 && t.length <= MAX_LINE_CHARS && /[A-Za-z_]{4,}/.test(t)
}

interface HunkLine {
  readonly tag: " " | "+" | "-"
  readonly text: string
}

/** The lines of each hunk in one file's part of a diff. */
const hunksOf = (lines: ReadonlyArray<string>): Array<Array<HunkLine>> => {
  const hunks: Array<Array<HunkLine>> = []
  let current: Array<HunkLine> | undefined
  for (const l of lines) {
    if (l.startsWith("@@")) {
      current = []
      hunks.push(current)
    } else if (current !== undefined && !l.startsWith("\\")) {
      const tag = l[0]
      // git writes an empty context line as a single space; some tools strip it.
      if (tag === "+" || tag === "-") current.push({ tag, text: l.slice(1) })
      else current.push({ tag: " ", text: l.slice(1) })
    }
  }
  return hunks
}

/** The spots of a run's change: for each block it added to an existing file, the telling lines above and below it. */
export const spotsOfDiff = (diff: string): Array<Spot> => {
  const spots = new Map<string, Spot>()
  for (const { path, lines } of diffFiles(diff)) {
    if (isSnapshot(path)) continue
    const head = lines.slice(0, Math.max(0, lines.findIndex((l) => l.startsWith("@@"))))
    // New, deleted and renamed files have no place that was there before and still is.
    if (head.some((l) => /^(new file mode|deleted file mode|rename from|GIT binary patch|Binary files)/.test(l))) continue
    for (const hunk of hunksOf(lines)) {
      for (let a = 0; a < hunk.length; a++) {
        if (hunk[a].tag !== "+" || hunk[a - 1]?.tag === "+") continue
        let b = a
        while (hunk[b + 1]?.tag === "+") b++
        // Lines changed or removed here: the task's own target, not a place others share.
        if (hunk[a - 1]?.tag === "-" || hunk[b + 1]?.tag === "-") continue
        /** The nearest telling line from `start`, going `by`, before any other change. */
        const near = (start: number, by: number): string | null => {
          for (let k = start, n = 0; n < REACH && hunk[k]?.tag === " "; k += by, n++) {
            if (tellingLine(hunk[k].text)) return hunk[k].text.trim()
          }
          return null
        }
        const above = near(a - 1, -1)
        const below = near(b + 1, 1)
        if (above !== null || below !== null) spots.set(`${path}\u0000${above}\u0000${below}`, { file: path, above, below })
      }
    }
  }
  return [...spots.values()].slice(0, MAX_SPOTS)
}
