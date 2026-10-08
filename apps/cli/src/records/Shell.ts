/**
 * Shell command lines, taken apart for matching.
 *
 * Agents chain commands (`yarn tsc 2>&1 | tail -8; yarn test:app --watch=false`),
 * so a command line is split into segments at `&&`, `||`, `;`, `|`, `&` and
 * line breaks, outside quotes, heredocs and PowerShell here-strings. Each
 * segment gets a key naming what it runs: the program, plus the subcommand for
 * runners such as yarn, npm or git (`yarn test:update`, `git diff`, `tsc`).
 * Segments that only filter another command's output (`| tail -30`) aren't
 * part of what the line runs.
 *
 * Works for bash and PowerShell lines alike; it's a tokenizer for matching,
 * not a shell parser, so odd quoting can give odd words.
 */
import { posix, win32 } from "node:path"

export interface Segment {
  /** The segment's text, trimmed. */
  readonly text: string
  /** Its words, unquoted, with redirections (`2>&1`, `> out.txt`) left out. */
  readonly words: ReadonlyArray<string>
  /** Reads another command's output (`a | b`). */
  readonly piped: boolean
}

/** The segments of a command line, in order. Empty segments are dropped. */
export const splitCommand = (line: string): Array<Segment> => {
  const segments: Array<Segment> = []
  let current = ""
  let piped = false
  const flush = (nextPiped: boolean) => {
    const text = current.trim()
    if (text !== "") segments.push({ text, words: words(text), piped })
    current = ""
    piped = nextPiped
  }
  let quote: "'" | "\"" | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const next = line[i + 1]
    if (quote !== undefined) {
      current += c
      if (c === "\\" && quote === "\"" && next !== undefined && ESCAPABLE.has(next)) {
        current += next
        i++
      } else if (c === quote) quote = undefined
      continue
    }
    if (c === "'" || c === "\"") {
      quote = c
      current += c
      continue
    }
    if (c === "\\" && next !== undefined && next !== "\n" && next !== "\r") {
      current += c + next
      i++
      continue
    }
    // A heredoc (`<<'EOF'` ... `EOF`) or a PowerShell here-string (`@'` ... `'@`):
    // everything up to its end belongs to this segment.
    const body = heredocEnd(line, i)
    if (body !== undefined) {
      current += line.slice(i, body)
      i = body - 1
      continue
    }
    if (c === "&" && next === "&") {
      flush(false)
      i++
    } else if (c === "|" && next === "|") {
      flush(false)
      i++
    } else if (c === "|") {
      flush(true)
    } else if (c === ";" || c === "\n" || c === "\r") {
      flush(false)
    } else if (c === "&" && !/[<>]/.test(line[i - 1] ?? "") && next !== ">") {
      flush(false)
    } else {
      current += c
    }
  }
  flush(false)
  return segments
}

/**
 * If a heredoc or here-string starts at `i`, the index just past its last line
 * (the rest of the starting line included); otherwise undefined.
 */
const heredocEnd = (line: string, i: number): number | undefined => {
  const rest = line.slice(i)
  const bash = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(rest)
  const ps = /^@(['"])[ \t]*\r?\n/.exec(rest)
  if (bash === null && ps === null) return undefined
  const lineEnd = line.indexOf("\n", i)
  if (lineEnd < 0) return line.length
  const isEnd = bash !== null
    ? (l: string) => l.replace(/^\t+/, "").replace(/\r$/, "") === bash[2]
    : (l: string) => l.startsWith(`${ps![1]}@`)
  let at = lineEnd + 1
  while (at < line.length) {
    const end = line.indexOf("\n", at)
    const text = line.slice(at, end < 0 ? line.length : end)
    if (isEnd(text)) {
      // A here-string's closing `'@` can be followed by more of the command.
      return bash !== null ? (end < 0 ? line.length : end) : at + 2
    }
    if (end < 0) return line.length
    at = end + 1
  }
  return line.length
}

/**
 * What a backslash escapes inside double quotes, as in bash. Anything else
 * keeps its backslash, so quoted Windows paths (`"C:\npm\yarn.cmd"`) survive.
 */
const ESCAPABLE = new Set(["\"", "\\", "$", "`"])

const REDIRECT = /^(\d*|&)(>>?|<)(&\d+)?$/
const REDIRECT_WITH_TARGET = /^(\d*|&)(>>?|<)(?!&?\d*$)/

/** Words of a segment: split at whitespace outside quotes, quotes removed, redirections dropped. */
export const words = (text: string): Array<string> => {
  const out: Array<string> = []
  let word = ""
  let started = false
  let quote: "'" | "\"" | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === "\\" && quote === "\"" && ESCAPABLE.has(text[i + 1] ?? "")) word += text[++i]
      else word += c
      continue
    }
    if (c === "'" || c === "\"") {
      quote = c
      started = true
    } else if (/\s/.test(c)) {
      if (started) out.push(word)
      word = ""
      started = false
    } else {
      word += c
      started = true
    }
  }
  if (started) out.push(word)
  // Subshells and groups: `(yarn test 2>&1 | tail)`, `{ a; b; }`.
  if (out.length > 0) {
    out[0] = out[0].replace(/^[({]+/, "")
    out[out.length - 1] = out[out.length - 1].replace(/[)}]+$/, "")
  }
  const kept: Array<string> = []
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "") continue
    if (REDIRECT.test(out[i])) {
      // `> file`: the target is the next word, unless it's a stream (`2>&1`).
      if (!out[i].includes("&")) i++
      continue
    }
    if (REDIRECT_WITH_TARGET.test(out[i])) continue
    kept.push(out[i])
  }
  return kept
}

/** Runners whose first argument says what runs: `yarn test`, `git diff`. */
const SUBCOMMAND_RUNNERS = new Set([
  "yarn", "pnpm", "bun", "npm", "npx", "pnpx", "bunx", "git", "cargo", "go", "docker", "kubectl", "gh", "dotnet",
  "mvn", "gradle", "make", "pip", "pip3", "poetry", "uv", "deno", "rake", "bundle", "composer"
])
/** Subcommands that only say "run the next word": `yarn run test`, `npm exec vitest`. */
const RUN_WORDS = new Set(["run", "run-script", "exec", "dlx", "x"])
const INTERPRETERS = new Set(["node", "python", "python3", "py", "ruby", "perl", "php", "bash", "sh", "pwsh", "powershell", "tsx", "ts-node"])
const PREFIXES = new Set(["sudo", "time", "env", "nice", "command", "exec", "nohup", "cmd", "/c"])

/** The program's name: no directory, no `.exe`/`.cmd`, lower case. */
const programName = (word: string): string =>
  win32.basename(posix.basename(word)).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase()

const isFlag = (word: string) => word.startsWith("-") && word.length > 1

/**
 * What a segment runs: `yarn test:update`, `npx vitest`, `git diff`,
 * `node -e`, `python3 script.py`, `grep`. Undefined for an empty segment.
 */
export const segmentKey = (segment: Segment): string | undefined => {
  const ws = [...segment.words]
  while (ws.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0]) || PREFIXES.has(ws[0].toLowerCase()))) ws.shift()
  // PowerShell's call operator: `& "C:\...\yarn.cmd" test`.
  if (ws[0] === "&" || ws[0] === ".") ws.shift()
  if (ws.length === 0) return undefined
  const program = programName(ws[0])
  const args = ws.slice(1)
  // `git -C dir diff`: -C and -c take a value.
  if (program === "git") {
    while (args[0] === "-C" || args[0] === "-c") args.splice(0, 2)
  }
  const firstArg = () => args.find((w) => !isFlag(w))
  if (SUBCOMMAND_RUNNERS.has(program)) {
    const sub = firstArg()
    if (sub === undefined) return program
    if (RUN_WORDS.has(sub) && program !== "git" && program !== "docker") {
      const next = args.slice(args.indexOf(sub) + 1).find((w) => !isFlag(w))
      return next === undefined ? `${program} ${sub}` : `${program} ${next}`
    }
    return `${program} ${sub}`
  }
  if (INTERPRETERS.has(program)) {
    const flag = args[0]
    if (flag === "-m" && args[1] !== undefined) return `${program} -m ${args[1]}`
    if (flag === "-e" || flag === "-c" || flag === "-" || flag === "--eval" || flag === "-Command") return `${program} ${flag}`
    const script = firstArg()
    return script === undefined ? program : `${program} ${posix.basename(script.replace(/\\/g, "/"))}`
  }
  return program
}

/** Programs that only filter or page another command's output. */
const FILTERS = new Set([
  "tail", "head", "grep", "egrep", "fgrep", "rg", "awk", "sort", "uniq", "wc", "cut", "tr", "less", "more", "cat",
  "tee", "column", "jq", "findstr", "select-object", "select-string", "out-string", "out-null", "out-host",
  "format-table", "format-list", "where-object", "sort-object", "measure-object", "convertto-json"
])

/** Segments that run something, rather than filter what another one printed. */
export const mainSegments = (segments: ReadonlyArray<Segment>): Array<Segment> =>
  segments.filter((s) => {
    if (!s.piped) return true
    const key = segmentKey(s)
    if (key === undefined) return false
    return !(FILTERS.has(key) || (key === "sed" && !s.words.some((w) => /^-[a-zA-Z]*i/.test(w))))
  })

/** Keys of what a command line runs, in order, without repeats. */
export const commandKeys = (line: string): Array<string> => [
  ...new Set(mainSegments(splitCommand(line)).map(segmentKey).filter((k): k is string => k !== undefined))
]

/** Programs and subcommands that only look around: a failed search isn't a mistake to warn about. */
const READ_ONLY = new Set([
  "grep", "egrep", "fgrep", "rg", "find", "ls", "dir", "cat", "head", "tail", "wc", "awk", "echo", "printf", "pwd",
  "which", "where", "type", "tree", "stat", "file", "du", "cd", "pushd", "popd", "sed", "test", "true", "false",
  "get-content", "get-childitem", "select-string", "test-path", "get-item", "resolve-path", "get-location",
  "set-location", "write-output", "write-host", "gc", "gci", "sls", "cls", "clear", "sleep", "start-sleep",
  "git status", "git diff", "git log", "git show", "git grep", "git branch", "git rev-parse", "git ls-files",
  "git blame", "git stash", "npm ls", "yarn list", "yarn why", "npm view", "npm why"
])

export const isReadOnlyKey = (key: string): boolean => READ_ONLY.has(key)

/** Whether a segment only looks around. `sed -i` edits, so it doesn't. */
const isReadOnlySegment = (segment: Segment): boolean => {
  const key = segmentKey(segment)
  if (key === undefined) return true
  if (key === "sed") return !segment.words.some((w) => /^-[a-zA-Z]*i/.test(w))
  return READ_ONLY.has(key)
}

/** Every segment of the line only looks around. */
export const isReadOnlyCommand = (line: string): boolean => mainSegments(splitCommand(line)).every(isReadOnlySegment)

export type KeyClass = "test" | "typecheck" | "lint" | "build" | "install" | "other"

/** What kind of check a key runs, by name: `yarn test:update` is a test, `yarn tsc` a typecheck. */
export const classifyKey = (key: string): KeyClass => {
  const k = key.toLowerCase()
  if (/typecheck|type-check|\btsc\b|\bmypy\b|\bpyright\b|\bcargo check\b|\bgo vet\b/.test(k)) return "typecheck"
  if (/\btest|test:|\bvitest\b|\bjest\b|\bpytest\b|\bmocha\b|\bava\b|\bplaywright\b|\bcypress\b|-m pytest/.test(k)) return "test"
  if (/lint|eslint|prettier|\bruff\b|flake8|\bfmt\b|format/.test(k)) return "lint"
  if (/build|compile|bundle/.test(k)) return "build"
  if (/\binstall\b|\bci\b|^(yarn|pnpm|bun|npm) add\b|^pip3? install/.test(k)) return "install"
  return "other"
}

/**
 * Just the checks a command line runs, without what surrounds them:
 * `yarn tsc 2>&1 | tail -8; git status` → `yarn tsc`. The line itself if it
 * runs no check.
 */
export const checksOf = (line: string): string => {
  const checks = mainSegments(splitCommand(line)).filter((s) => {
    const key = segmentKey(s)
    return key !== undefined && ["test", "typecheck", "lint", "build"].includes(classifyKey(key))
  })
  return checks.length === 0 ? line.trim() : checks.map((s) => s.words.join(" ")).join(" && ")
}

/** The words that make a key distinctive in a command line: `yarn test:update` → `test:update`. */
export const keyWord = (key: string): string => {
  const parts = key.split(" ")
  return parts[parts.length - 1]
}

/** The segment of `line` that runs `key`, if any (the last one, when it runs several times). */
export const segmentFor = (line: string, key: string): Segment | undefined =>
  mainSegments(splitCommand(line)).filter((s) => segmentKey(s) === key).pop()

/** Words dropped from and added to a segment, as multisets: what changed between two runs of one command. */
export const wordChange = (before: Segment, after: Segment): { removed: Array<string>; added: Array<string> } => {
  const count = (ws: ReadonlyArray<string>) => {
    const m = new Map<string, number>()
    for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1)
    return m
  }
  const a = count(before.words)
  const b = count(after.words)
  const minus = (x: Map<string, number>, y: Map<string, number>) => {
    const out: Array<string> = []
    for (const [w, n] of x) for (let i = 0; i < n - (y.get(w) ?? 0); i++) out.push(w)
    return out
  }
  return { removed: minus(a, b), added: minus(b, a) }
}

/** A test run limited to tests whose names match (`-t "zen"`): passing it doesn't show that other tests pass. */
export const filtersTestNames = (segment: Segment): boolean =>
  segment.words.some((w) => /^(-t|-k|-g|--grep|--testNamePattern|--test-name-pattern)(=|$)/.test(w))

/**
 * Arguments that aren't flags: test files or name filters, for test commands.
 * A test command without any runs the whole suite.
 */
export const positionalArgs = (segment: Segment, key: string): Array<string> => {
  const ws = segment.words
  let start = ws.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !PREFIXES.has(w.toLowerCase()) && w !== "&")
  if (start < 0) return []
  const parts = key.split(" ")
  if (parts.length > 1) {
    const at = ws.indexOf(parts[parts.length - 1], start + 1)
    if (at >= 0) start = at
  }
  const rest = ws.slice(start + 1).filter((w) => !isFlag(w))
  // `vitest run file`: the runner's own subcommand isn't an argument.
  if (rest.length > 0 && RUN_WORDS.has(rest[0])) rest.shift()
  return rest
}
