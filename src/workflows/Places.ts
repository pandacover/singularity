/**
 * Where an edit goes, told by the structure of the code around it rather than
 * by the lines next to it.
 *
 * A place is the chain of blocks that enclose an edit, from the file's top
 * level inward: `class App {` › `getContextMenuItems = (` › `if (type ===
 * "canvas") {` › `if (this.state.viewModeEnabled) {` › `return [`. Every task
 * that adds to that list has the same chain, whichever neighbour it sits next
 * to, and the chain outlives edits elsewhere in the file: lines move, items
 * come and go, the enclosing declarations stay. Memory keeps the chain; the
 * hand-over looks it up in the code as it is when used (`resolvePlace`).
 *
 * Blocks come from indentation, which formatted code keeps: a block is opened
 * by the nearest line above that is indented less, lifted to the start of its
 * statement when that line only continues one (`}) => {`, a tag's closing
 * `>`). Additions at a file's top level have no enclosing block; they belong
 * to a group of sibling statements named alike (`const PreferencesToggle…`).
 *
 * Everything here is pure: lines in, lines out.
 */

/** One enclosing block. */
export interface Block {
  /** The first line of the statement that opens it, whitespace collapsed. */
  readonly head: string
  /** The line that opens the block itself when it isn't the head (`} else {`, `}) => {`, a tag's `>`). */
  readonly open: string | null
  /**
   * When the block opens on a later line than its head: the statement from
   * head to that line, joined (a tag with its attributes), which tells apart
   * blocks with the same first line.
   */
  readonly opener: string | null
  /** The line that closes it, when one does (`} from "../actions";`, `];`); unions and the like have none. */
  readonly close: string | null
}

export interface PlaceShape {
  readonly file: string
  /** Enclosing blocks, outermost first. Empty at the file's top level. */
  readonly chain: ReadonlyArray<Block>
  /** Top-level additions: the start that sibling statements share (`const PreferencesToggle`). */
  readonly group: string | null
}

/** A place found in a file: lines numbered from 0, `to` inclusive. */
export interface Region {
  readonly from: number
  readonly to: number
  /** The line that opens the innermost block, and the one that closes it, when there are such lines. */
  readonly openLine: number | null
  readonly closeLine: number | null
  /** Group places: the first line of each sibling statement. */
  readonly members: ReadonlyArray<number>
}

const MAX_HEAD_CHARS = 160
const MAX_OPENER_CHARS = 300

export const indentOf = (line: string): number => {
  let n = 0
  for (const c of line) {
    if (c === " ") n += 1
    else if (c === "\t") n += 2
    else break
  }
  return n
}

const blank = (line: string | undefined) => line === undefined || line.trim() === ""

const collapse = (s: string) => s.trim().replace(/\s+/g, " ")

export const normalize = (line: string): string => {
  const t = collapse(line)
  return t.length > MAX_HEAD_CHARS ? t.slice(0, MAX_HEAD_CHARS) : t
}

/** A line that carries on the statement above it rather than starting one. */
export const continues = (line: string): boolean => /^(\)|\]|\}|>|\/>|\.|\?|:|\||&|\+|=>|,)/.test(line.trim())

/** A line that only closes something: `}`, `];`, `} as const;`, `</>`, `)}`. */
const closing = (line: string): boolean => /^(\}|\]|\)|<\/|\/>)/.test(line.trim())

const comment = (line: string): boolean => /^(\/\/|\/\*|\*)/.test(line.trim())

/** The nearest line at or above `index` that isn't blank or a comment and is indented less than `indent`. -1 if none. */
const parentLine = (lines: ReadonlyArray<string>, index: number, indent: number): number => {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
    if (!blank(lines[i]) && !comment(lines[i]) && indentOf(lines[i]) < indent) return i
  }
  return -1
}

/**
 * The first line of the statement `index` belongs to: going up past lines
 * indented more, and past lines at the same depth that only continue it.
 */
export const statementStart = (lines: ReadonlyArray<string>, index: number): number => {
  let i = index
  const depth = indentOf(lines[index])
  while (continues(lines[i])) {
    let j = i - 1
    while (j >= 0 && (blank(lines[j]) || comment(lines[j]) || indentOf(lines[j]) > depth)) j--
    if (j < 0 || indentOf(lines[j]) < depth) break
    i = j
  }
  return i
}

/** The line that closes the block opened at `open`: the first line after it indented no deeper, if it only closes. */
const closeLineOf = (lines: ReadonlyArray<string>, open: number): number | null => {
  const depth = indentOf(lines[open])
  for (let i = open + 1; i < lines.length; i++) {
    if (blank(lines[i])) continue
    if (indentOf(lines[i]) <= depth) return closing(lines[i]) ? i : null
  }
  return null
}

/** The last line of the block opened at `open`: its closing line, or the last line indented deeper. */
const endOf = (lines: ReadonlyArray<string>, open: number): number => {
  const depth = indentOf(lines[open])
  let last = open
  for (let i = open + 1; i < lines.length; i++) {
    if (blank(lines[i])) continue
    if (indentOf(lines[i]) <= depth) return closing(lines[i]) ? i : last
    last = i
  }
  return last
}

interface Found {
  readonly open: number
  readonly start: number
}

/** The enclosing blocks of a line at `indent` just below line `index`, innermost first. */
const enclosing = (lines: ReadonlyArray<string>, index: number, indent: number): Array<Found> => {
  const out: Array<Found> = []
  let depth = indent
  let at = index
  while (depth > 0) {
    const open = parentLine(lines, at, depth)
    if (open < 0) break
    const start = statementStart(lines, open)
    out.push({ open, start })
    depth = indentOf(lines[start])
    at = start - 1
  }
  return out
}

/** The statement's text from `start` to `open`, joined. */
const openerText = (lines: ReadonlyArray<string>, start: number, open: number): string => {
  const t = collapse(lines.slice(start, open + 1).filter((l) => !comment(l)).join(" "))
  return t.length > MAX_OPENER_CHARS ? t.slice(0, MAX_OPENER_CHARS) : t
}

const blockOf = (lines: ReadonlyArray<string>, f: Found): Block => {
  const close = closeLineOf(lines, f.open)
  return {
    head: normalize(lines[f.start]),
    open: f.open === f.start ? null : normalize(lines[f.open]),
    opener: f.open === f.start ? null : openerText(lines, f.start, f.open),
    close: close === null ? null : normalize(lines[close])
  }
}

const KEYWORDS = new Set([
  "export", "default", "const", "let", "var", "function", "async", "class", "interface", "type", "enum",
  "import", "declare", "abstract", "public", "private", "protected", "static", "readonly"
])

const identChar = (c: string | undefined) => c !== undefined && /[\w$]/.test(c)

const LEADING_KEYWORDS = /^((export|default|const|let|var|function|async|class|interface|type|enum|declare|abstract)\s+)+/

/** A statement without the keywords before its name: `PreferencesToggleZenModeItem = …` from `export const PreferencesToggleZenModeItem = …`. */
export const stripKeywords = (s: string): string => s.trim().replace(LEADING_KEYWORDS, "")

/**
 * The start two sibling statements share after their keywords, in whole
 * words or camel-case parts, if it names something: `PreferencesToggle` from
 * `const PreferencesToggleGridModeItem = …` and
 * `export const PreferencesToggleZenModeItem = …`.
 */
export const sharedStart = (x: string, y: string): string | null => {
  const a = stripKeywords(x)
  const b = stripKeywords(y)
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  let prefix = a.slice(0, n)
  const tail = /[\w$]*$/.exec(prefix)?.[0] ?? ""
  if (tail.length > 0 && (identChar(a[n]) || identChar(b[n])) && (/[a-z0-9]/.test(a[n] ?? "") || /[a-z0-9]/.test(b[n] ?? ""))) {
    // It stops inside a word: keep the camel-case parts it shares whole (PreferencesToggleZ… -> PreferencesToggle).
    let cut = 0
    for (let k = tail.length - 1; k > 0; k--) {
      if (/[A-Z]/.test(tail[k])) {
        cut = k
        break
      }
    }
    prefix = prefix.slice(0, prefix.length - tail.length + cut)
  }
  prefix = prefix.trimEnd()
  const named = (prefix.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((w) => !KEYWORDS.has(w))
  if (named.length === 0 || named.join("").length < 4) return null
  return prefix
}

/** The start two file names share, in whole camel-case parts: `actionToggle` from `actionToggleZenMode` and `actionToggleRulers`. */
export const sharedNameStart = (a: string, b: string): string => {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  const prefix = a.slice(0, n)
  if (n === a.length || n === b.length) return prefix
  // Inside a camel-case part: keep only the parts shared whole.
  if (/[a-z0-9]/.test(a[n]) || /[a-z0-9]/.test(b[n])) {
    for (let k = prefix.length - 1; k > 0; k--) if (/[A-Z]/.test(prefix[k])) return prefix.slice(0, k)
    return ""
  }
  return prefix
}

/** Statement starts at the top level (indent 0), as line numbers. */
const topStatements = (lines: ReadonlyArray<string>): Array<number> => {
  const out: Array<number> = []
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i]) || indentOf(lines[i]) > 0 || continues(lines[i]) || comment(lines[i])) continue
    out.push(i)
  }
  return out
}

/** The group of imports at the top of a file. */
export const IMPORTS = "import "

/**
 * The group of top-level statements around a spot: what the statement above
 * and the one below share, else what either shares with its own neighbour.
 */
const groupAround = (lines: ReadonlyArray<string>, above: number, below: number): string | null => {
  const tops = topStatements(lines)
  const ai = [...tops].reverse().findIndex((i) => i <= above)
  const a = ai < 0 ? -1 : tops.length - 1 - ai
  const b = tops.findIndex((i) => i >= below)
  const text = (k: number) => (k < 0 || k >= tops.length ? undefined : lines[tops[k]].trim())
  const pairs: Array<[string | undefined, string | undefined]> = [
    [text(a), text(b < 0 ? -1 : b)],
    [text(a < 0 ? -1 : a - 1), text(a)],
    [text(b < 0 ? -1 : b), text(b < 0 ? -1 : b + 1)]
  ]
  for (const [x, y] of pairs) {
    if (x === undefined || y === undefined) continue
    if (x.startsWith(IMPORTS) && y.startsWith(IMPORTS)) return IMPORTS
    const shared = sharedStart(x, y)
    if (shared !== null) return shared
  }
  // At the very top, before the first statement or among the imports.
  const first = text(b < 0 ? -1 : b) ?? text(a)
  return first !== undefined && first.startsWith(IMPORTS) ? IMPORTS : null
}

/**
 * The place of a block added after line `after` (lines counted from 1, 0 for
 * the very top), whose first line is indented by `indent`, in a file whose
 * lines (before the change) are `lines`.
 */
export const placeOfAddition = (file: string, lines: ReadonlyArray<string>, after: number, indent: number): PlaceShape => {
  const chain = enclosing(lines, after - 1, indent).map((f) => blockOf(lines, f)).reverse()
  if (chain.length > 0) return { file, chain, group: null }
  return { file, chain: [], group: groupAround(lines, after - 1, after) }
}

/**
 * The place of an existing line (counted from 0) that a run changed: the
 * blocks around it, up to the list it is one item of. A changed row among
 * rows that start alike (`<Shortcut` in the help dialog) stands for the list:
 * which row is the task's own business.
 */
export const placeOfLine = (file: string, lines: ReadonlyArray<string>, index: number): PlaceShape => {
  const found = enclosing(lines, index - 1, indentOf(lines[index]))
  while (found.length > 1 && !uniqueAmongSiblings(lines, found[0], found[1])) found.shift()
  const chain = found.map((f) => blockOf(lines, f)).reverse()
  if (chain.length > 0) return { file, chain, group: null }
  return { file, chain: [], group: groupAround(lines, index - 1, index + 1) }
}

/**
 * Whether no other direct child of `parent` starts like `block` does, over as
 * many lines as `block` takes to open (a tag with its attributes).
 */
const uniqueAmongSiblings = (lines: ReadonlyArray<string>, block: Found, parent: Found): boolean => {
  const span = block.open - block.start
  const text = (start: number) => openerText(lines, start, Math.min(lines.length - 1, start + span))
  const own = text(block.start)
  const depth = indentOf(lines[block.start])
  const end = endOf(lines, parent.open)
  let same = 0
  for (let i = parent.open + 1; i <= end; i++) {
    if (blank(lines[i]) || indentOf(lines[i]) !== depth || continues(lines[i])) continue
    if (text(i) === own) same++
  }
  return same <= 1
}

/** A stable key for places that are the same: file, chain and group. */
export const placeKey = (p: PlaceShape): string =>
  JSON.stringify([p.file, p.chain.map((b) => [b.head, b.open, b.opener, b.close]), p.group])

const words = (s: string): Array<string> => s.match(/[A-Za-z_$][\w$]*|\d+/g) ?? []
const literals = (s: string): Array<string> => s.match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? []

/** Whether a line looks like a block's head: the same text, or (loosely) the same first words when the line has grown. */
const headMatches = (line: string, head: string, loose: boolean): boolean => {
  const n = normalize(line)
  if (n === head) return true
  if (!loose) return false
  const a = words(head)
  const b = words(n)
  const k = Math.min(a.length, 6)
  return k >= 1 && (a.length >= 2 || head.length >= 8) && a.slice(0, k).every((w, i) => b[i] === w)
}

/**
 * Find a place in a file as it is now: each block of the chain inside the
 * one before, by its head (exactly, else by its first words), its opening
 * line and its closing line. Undefined when the code no longer has it.
 */
export const resolvePlace = (lines: ReadonlyArray<string>, place: PlaceShape): Region | undefined => {
  if (place.chain.length === 0) return place.group === null ? undefined : resolveGroup(lines, place.group)
  /** Blocks of the chain are looked for among the direct children of the one before: not deeper inside it. */
  const search = (depth: number, from: number, to: number, loose: boolean, parentOpen: number | null): Region | undefined => {
    const block = place.chain[depth]
    for (let i = from; i <= to && i < lines.length; i++) {
      if (blank(lines[i]) || (continues(lines[i]) && block.head !== normalize(lines[i]))) continue
      if (!headMatches(lines[i], block.head, loose)) continue
      if (statementStart(lines, i) !== i) continue
      if ((enclosing(lines, i - 1, indentOf(lines[i]))[0]?.open ?? null) !== parentOpen) continue
      // The line that opens the block: the head itself, or a later line of the same statement.
      let open = i
      if (block.open !== null) {
        const depthOf = indentOf(lines[i])
        open = -1
        for (let j = i + 1; j <= to && j < lines.length; j++) {
          if (blank(lines[j])) continue
          if (indentOf(lines[j]) < depthOf) break
          if (indentOf(lines[j]) === depthOf) {
            if (normalize(lines[j]) === block.open) {
              open = j
              break
            }
            if (!continues(lines[j])) break
          }
        }
        if (open < 0) continue
        if (block.opener !== null) {
          const text = openerText(lines, i, open)
          if (loose ? !literals(block.opener).every((s) => text.includes(s)) : text !== block.opener) continue
        }
      }
      const close = closeLineOf(lines, open)
      if (block.close !== null && (close === null || normalize(lines[close]) !== block.close)) continue
      const end = endOf(lines, open)
      if (depth === place.chain.length - 1) return { from: i, to: end, openLine: open, closeLine: close, members: [] }
      const inner = search(depth + 1, open + 1, end, loose, open)
      if (inner !== undefined) return inner
    }
    return undefined
  }
  return search(0, 0, lines.length - 1, false, null) ?? search(0, 0, lines.length - 1, true, null)
}

/** A group of top-level statements that start alike: from the first to the end of the last. */
const resolveGroup = (lines: ReadonlyArray<string>, group: string): Region | undefined => {
  const tops = topStatements(lines)
  const members = tops.filter((i) => (group === IMPORTS ? lines[i].trim() : stripKeywords(lines[i])).startsWith(group))
  if (members.length === 0) return undefined
  const last = members[members.length - 1]
  const next = tops.find((i) => i > last)
  let to = next === undefined ? lines.length - 1 : next - 1
  while (to > last && blank(lines[to])) to--
  return { from: members[0], to, openLine: null, closeLine: null, members }
}

/** Whether line `index` (from 0) lies inside a place found in the same file. */
export const inRegion = (r: Region, index: number): boolean => index >= r.from && index <= r.to

/** The chain in words, for people and the agent: `class App › getContextMenuItems = ( › return [`. */
export const describeChain = (p: PlaceShape, max = 5): string => {
  if (p.chain.length === 0) return p.group === null ? "the top level" : `the top-level \`${p.group}…\` statements`
  const short = (s: string) => (s.length > 70 ? s.slice(0, 67) + "..." : s)
  const parts = p.chain.map((b) => short(b.open !== null && !continues(b.open) ? `${b.head} … ${b.open}` : b.head))
  const shown = parts.length > max ? ["…", ...parts.slice(parts.length - max)] : parts
  return shown.join(" › ")
}
