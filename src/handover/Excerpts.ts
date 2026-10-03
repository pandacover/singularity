/**
 * Excerpts: the code at a route's places, as it is now.
 *
 * Memory keeps where a step's edits went as lines of existing code (spots,
 * records/Spots.ts). At task start each one is looked up in the working tree
 * and the lines around it are handed over, so the agent can make its edits
 * without first reading for the places. None of it is remembered text: a spot
 * that is no longer in its file finds nothing and is left out.
 *
 * - A spot is found where its two lines stand, indentation aside, the lower
 *   one within a few lines of the upper (lines may have come between since).
 *   A pair found in more than MAX_HITS places marks none of them.
 * - A spot with one line, or whose pair is no longer there, is found only
 *   where a line of it is the single one of its kind in the file: a line that
 *   stands in several places doesn't say which (`} as const;` closes every
 *   table).
 * - Spots found close together are one place. A place is handed over when
 *   enough of the kind's runs put an edit there: at least two, and most of
 *   those that took the step.
 * - A place shows a few lines around the spots that enough runs agree on by
 *   themselves; where none does (each run chose another neighbour in the same
 *   list), around all of them.
 * - A step that writes a new file gets the file most of its runs read first:
 *   whole if it is small, by name otherwise.
 * - A small block that a spot's line opens (the neighbour a new block was
 *   written next to), and a small list or block around a place, are shown
 *   whole.
 *
 * It all has to fit the room the hand-over has left, so it goes in by what a
 * piece saves the agent: places first, those in the largest files before the
 * others (they cost the most to read); then the files to read first; then
 * the blocks spots open; then the lists around places, smallest first.
 */

/** Lines shown on each side of a spot. */
export const CONTEXT = 1
/** A spot found in more places than this isn't a place. */
export const MAX_HITS = 3
/** Lines that may have come between a spot's two lines since it was recorded. */
export const PAIR_SLACK = 3
/** Places this close (lines between what they show) are shown as one. */
const JOIN_GAP = 2
/** A list or block is shown whole when it is at most this long. */
export const MAX_BLOCK_CHARS = 700
/** A file to read first is handed over whole when it is at most this long. */
export const MAX_EXAMPLE_CHARS = 1600
/** A place needs this share of the kind's runs of its step, and two of them. */
export const PLACE_SHARE = 0.6

/** A spot of a step on the route, counted over the records of the task's kind. */
export interface SpotSource {
  /** The step's number in the hand-over, from 1. */
  readonly step: number
  readonly file: string
  /** The lines its runs added theirs between; one may be missing. */
  readonly above: string | null
  readonly below: string | null
  /** Records of the kind that put an edit there. */
  readonly records: ReadonlyArray<string>
  /** Records of the kind that took the step. */
  readonly runs: number
}

/** A file a step's runs read before writing a new one next to it. */
export interface ExampleSource {
  readonly step: number
  readonly path: string
  readonly records: ReadonlyArray<string>
  readonly runs: number
}

/** Lines of a file, by index from 0, both ends included. */
export interface Span {
  readonly from: number
  readonly to: number
}

/** A place found in a file. */
export interface Found extends Span {
  readonly file: string
  readonly steps: ReadonlyArray<number>
  /** The place with the block that one of its spots' lines opens, when that is small. */
  readonly opened: Span | undefined
  /** The list or block the place sits in, when that is small. */
  readonly around: Span | undefined
}

/** Lines of a file handed over. Line numbers from 1, both ends included. */
export interface Excerpt {
  readonly file: string
  readonly from: number
  readonly to: number
  readonly steps: ReadonlyArray<number>
}

export interface ShownExample {
  readonly step: number
  readonly path: string
  /** The file's text went along, not just its name. */
  readonly whole: boolean
}

export interface Excerpts {
  /** The section to append to the hand-over; empty when there is nothing to show. */
  readonly text: string
  readonly shown: ReadonlyArray<Excerpt>
  readonly examples: ReadonlyArray<ShownExample>
  /** Places and files that were found but didn't fit. */
  readonly leftOut: number
}

const needed = (runs: number): number => Math.max(2, Math.ceil(PLACE_SHARE * runs))

const indentOf = (line: string): number => line.length - line.trimStart().length

const sizeOf = (lines: ReadonlyArray<string>, span: Span): number => {
  let n = 0
  for (let i = span.from; i <= span.to; i++) n += lines[i].length + 1
  return n
}

/** A spot found: the lines of it that are there. */
interface Hit extends Span {
  readonly at: ReadonlyArray<number>
  readonly spot: SpotSource
}

/** The places `spots` mark in one file, given as its lines. */
export const findPlaces = (file: string, lines: ReadonlyArray<string>, spots: ReadonlyArray<SpotSource>): Array<Found> => {
  const blank = (i: number) => lines[i].trim() === ""
  const positions = new Map<string, Array<number>>()
  for (const s of spots) for (const l of [s.above, s.below]) if (l !== null && !positions.has(l)) positions.set(l, [])
  lines.forEach((l, i) => positions.get(l.trim())?.push(i))

  /** Where a spot is: the lines of it found, per place. */
  const locate = (s: SpotSource): Array<Array<number>> => {
    if (s.above !== null && s.below !== null) {
      const lower = positions.get(s.below)!
      const pairs = positions.get(s.above)!.flatMap((i) => {
        const j = lower.find((b) => b > i && b - i <= 1 + PAIR_SLACK)
        return j === undefined ? [] : [[i, j]]
      })
      if (pairs.length > MAX_HITS) return []
      if (pairs.length > 0) return pairs
    }
    return [s.above, s.below].flatMap((l) => (l !== null && positions.get(l)!.length === 1 ? [[positions.get(l)![0]]] : []))
  }
  const hits: Array<Hit> = spots
    .flatMap((s) => locate(s).map((at) => ({ from: at[0], to: at[at.length - 1], at, spot: s })))
    .sort((a, b) => a.from - b.from || a.to - b.to)

  const clusters: Array<{ to: number; hits: Array<Hit> }> = []
  for (const h of hits) {
    const last = clusters[clusters.length - 1]
    if (last !== undefined && h.from - last.to <= 2 * CONTEXT + 1 + JOIN_GAP) {
      last.hits.push(h)
      last.to = Math.max(last.to, h.to)
    } else clusters.push({ to: h.to, hits: [h] })
  }

  const found: Array<Found> = []
  for (const cluster of clusters) {
    const enough = needed(Math.max(...cluster.hits.map((h) => h.spot.runs)))
    if (new Set(cluster.hits.flatMap((h) => h.spot.records)).size < enough) continue
    // Where most runs put the edit; if each chose another neighbour, all of them.
    const agreed = cluster.hits.filter((h) => new Set(h.spot.records).size >= enough)
    const core = agreed.length > 0 ? agreed : cluster.hits
    const first = Math.min(...core.map((h) => h.from))
    const last = Math.max(...core.map((h) => h.to))
    let from = Math.max(0, first - CONTEXT)
    let to = Math.min(lines.length - 1, last + CONTEXT)
    while (from < first && blank(from)) from++
    while (to > last && blank(to)) to--

    // A block that a spot's line opens: the neighbour an added block was written next to.
    let opened: Span | undefined
    for (const at of core.flatMap((h) => h.at)) {
      let next = at + 1
      while (next < lines.length && blank(next)) next++
      if (next >= lines.length || indentOf(lines[next]) <= indentOf(lines[at])) continue
      let end = next
      while (end < lines.length && (blank(end) || indentOf(lines[end]) > indentOf(lines[at]))) end++
      if (end < lines.length && end > (opened?.to ?? to) && sizeOf(lines, { from: at, to: end }) <= MAX_BLOCK_CHARS) opened = { from, to: end }
    }
    // The list or block the edits went into: the one its deepest lines sit in (a spot's
    // lower line is often the line that closes it).
    let around: Span | undefined
    const coreLines = core.flatMap((h) => h.at)
    const depth = Math.max(...coreLines.map((at) => indentOf(lines[at])))
    if (depth > 0) {
      const deepest = coreLines.filter((at) => indentOf(lines[at]) === depth)
      let open = Math.min(...deepest) - 1
      while (open >= 0 && (blank(open) || indentOf(lines[open]) >= depth)) open--
      let close = Math.max(...deepest) + 1
      while (close < lines.length && (blank(close) || indentOf(lines[close]) >= depth)) close++
      const block = { from: open, to: close }
      if (open >= 0 && close < lines.length && (open < from || close > to) && sizeOf(lines, block) <= MAX_BLOCK_CHARS) {
        around = { from: Math.min(from, open), to: Math.max(to, close) }
      }
    }
    found.push({ file, steps: [...new Set(core.map((h) => h.spot.step))].sort((a, b) => a - b), from, to, opened, around })
  }
  return found
}

interface Range {
  from: number
  to: number
  steps: Array<number>
}

/** Ranges in line order, with those that overlap or nearly touch made one. */
const joined = (ranges: ReadonlyArray<Range>): Array<Range> => {
  const out: Array<Range> = []
  for (const r of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = out[out.length - 1]
    if (last !== undefined && r.from - last.to - 1 <= JOIN_GAP) {
      last.to = Math.max(last.to, r.to)
      last.steps = [...new Set([...last.steps, ...r.steps])].sort((a, b) => a - b)
    } else out.push({ from: r.from, to: r.to, steps: [...r.steps] })
  }
  return out
}

const stepsLabel = (steps: ReadonlyArray<number>): string => `step${steps.length === 1 ? "" : "s"} ${steps.join(", ")}`

const fenceFor = (text: string): string => (text.includes("```") ? "````" : "```")

export const EXCERPTS_INTRO = "Read from the working tree as this task started. Earlier tasks made these steps' edits next to the lines shown. " +
  "The lines are exact, so a file can be edited from them without reading it first."

interface Chosen {
  /** By file: the ranges to show. */
  readonly ranges: Map<string, Array<Range>>
  readonly examples: Array<ShownExample>
}

const render = (chosen: Chosen, linesOf: (file: string) => ReadonlyArray<string>): string => {
  const out = ["", "## The code where these steps' edits go", "", EXCERPTS_INTRO, ""]
  const files = [...chosen.ranges.entries()]
    .map(([file, ranges]) => ({ file, ranges: joined(ranges) }))
    .filter((f) => f.ranges.length > 0)
    .sort((a, b) => Math.min(...a.ranges.flatMap((r) => r.steps)) - Math.min(...b.ranges.flatMap((r) => r.steps)) || a.file.localeCompare(b.file))
  for (const { file, ranges } of files) {
    const lines = linesOf(file)
    const body = ranges.flatMap((r) => [`@@ lines ${r.from + 1}-${r.to + 1} @@`, ...lines.slice(r.from, r.to + 1)])
    const fence = fenceFor(body.join("\n"))
    out.push(`\`${file}\` (${stepsLabel([...new Set(ranges.flatMap((r) => r.steps))].sort((a, b) => a - b))}):`, fence, ...body, fence, "")
  }
  for (const e of chosen.examples) {
    if (e.whole) {
      const text = linesOf(e.path).join("\n").replace(/\n+$/, "")
      const fence = fenceFor(text)
      out.push(`\`${e.path}\` (step ${e.step}: earlier tasks read this file before writing their new one), whole:`, fence, text, fence, "")
    } else {
      out.push(`Step ${e.step}: earlier tasks read \`${e.path}\` before writing their new file.`, "")
    }
  }
  return out.join("\n")
}

/**
 * The excerpts for a route: what `spots` and `examples` find in `texts` (the
 * working tree's files by path, line endings as `\n`; a missing file isn't
 * there), as much of it as fits in `room` characters.
 */
export const makeExcerpts = (
  spots: ReadonlyArray<SpotSource>,
  examples: ReadonlyArray<ExampleSource>,
  texts: ReadonlyMap<string, string>,
  room: number
): Excerpts => {
  const split = new Map<string, ReadonlyArray<string>>()
  const linesOf = (file: string): ReadonlyArray<string> => {
    if (!split.has(file)) split.set(file, (texts.get(file) ?? "").split("\n"))
    return split.get(file)!
  }
  const found: Array<Found> = []
  for (const file of [...new Set(spots.map((s) => s.file))]) {
    if (texts.get(file) !== undefined) found.push(...findPlaces(file, linesOf(file), spots.filter((s) => s.file === file)))
  }
  // One file to read first per step: the one most of its runs read.
  const firstReads: Array<ExampleSource> = []
  for (const e of [...examples].sort((a, b) => a.step - b.step || b.records.length - a.records.length || a.path.localeCompare(b.path))) {
    if (texts.get(e.path) === undefined || e.records.length < needed(e.runs)) continue
    if (!firstReads.some((f) => f.step === e.step)) firstReads.push(e)
  }

  const chosen: Chosen = { ranges: new Map(), examples: [] }
  let text = ""
  let leftOut = 0
  /** Make a change to `chosen`; keep it if the section still fits, undo it otherwise. */
  const attempt = (change: () => () => void): boolean => {
    const undo = change()
    const next = render(chosen, linesOf)
    if (next.length <= room) {
      text = next
      return true
    }
    undo()
    return false
  }
  const add = (f: Found, span: Span) => () => {
    const ranges = chosen.ranges.get(f.file) ?? []
    chosen.ranges.set(f.file, [...ranges, { from: span.from, to: span.to, steps: [...f.steps] }])
    return () => {
      if (ranges.length === 0) chosen.ranges.delete(f.file)
      else chosen.ranges.set(f.file, ranges)
    }
  }

  const bySize = [...found].sort((a, b) => texts.get(b.file)!.length - texts.get(a.file)!.length || a.file.localeCompare(b.file) || a.from - b.from)
  const placed: Array<Found> = []
  for (const f of bySize) {
    if (attempt(add(f, f))) placed.push(f)
    else leftOut++
  }
  for (const e of firstReads) {
    const shown = (whole: boolean) => () => {
      chosen.examples.push({ step: e.step, path: e.path, whole })
      return () => void chosen.examples.pop()
    }
    const small = texts.get(e.path)!.length <= MAX_EXAMPLE_CHARS
    if (!(small && attempt(shown(true))) && !attempt(shown(false))) leftOut++
  }
  /** What showing `span` instead of the place adds, in characters. */
  const extra = (f: Found, span: Span) => sizeOf(linesOf(f.file), span) - sizeOf(linesOf(f.file), f)
  for (const grow of [(f: Found) => f.opened, (f: Found) => f.around]) {
    const spans = placed.flatMap((f) => {
      const span = grow(f)
      return span === undefined ? [] : [{ f, span }]
    })
    for (const { f, span } of spans.sort((a, b) => extra(a.f, a.span) - extra(b.f, b.span))) attempt(add(f, span))
  }

  const shown = [...chosen.ranges.entries()].flatMap(([file, ranges]) =>
    joined(ranges).map((r) => ({ file, from: r.from + 1, to: r.to + 1, steps: r.steps }))
  )
  return shown.length + chosen.examples.length === 0
    ? { text: "", shown: [], examples: [], leftOut }
    : { text, shown, examples: [...chosen.examples], leftOut }
}
