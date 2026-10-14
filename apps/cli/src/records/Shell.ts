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
/** Shell keywords before a command (`do npm test`, `if grep -q x f`): the command follows them. */
const LEADING_KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!"])
/**
 * Segments that run nothing of their own: a loop's or a case's head and end
 * (`for f in a b`, `done`), a function's definition (`t() {`), and builtins
 * that set the shell's state (`local s=1`, `export X=1`).
 */
const NO_COMMAND = new Set([
  "for", "select", "case", "in", "done", "fi", "esac", "function", "{", "}", "}}", "]]", "local", "export", "declare",
  "typeset", "readonly", "unset", "shift", "return", "break", "continue", ":", "set", "setopt", "trap", "wait"
])
/** Interpreters' options that take the next word as their value: `python -X utf8 -`, `node -r ts-node/register x.ts`. */
const VALUE_OPTIONS = new Set(["-X", "-W", "-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-C", "--conditions"])
/** Options that say the code comes inline or on stdin: `node -e`, `python -c`, `python -`. */
const INLINE_OPTIONS = new Set(["-e", "-c", "-", "--eval", "-p", "--print", "-Command"])
/** Programs that run another for at most a while: `timeout 600 npm test`. */
const TIME_LIMITS = new Set(["timeout", "gtimeout"])

/** The program's name: no directory, no `.exe`/`.cmd`, lower case. */
export const programName = (word: string): string =>
  win32.basename(posix.basename(word)).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase()

const isFlag = (word: string) => word.startsWith("-") && word.length > 1
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)

/**
 * Where the command proper starts among a segment's words: after shell
 * keywords (`do`, `if`), variable assignments, prefixes (`sudo`, `nice -n
 * 5`), a time limit with its options and duration (`timeout -k 5 600`), and
 * PowerShell's call operator.
 */
const commandStart = (ws: ReadonlyArray<string>): number => {
  let i = 0
  while (i < ws.length) {
    const w = ws[i].toLowerCase()
    if (isAssignment(ws[i]) || LEADING_KEYWORDS.has(w)) i++
    else if (TIME_LIMITS.has(programName(w))) {
      i++
      while (i < ws.length && isFlag(ws[i])) i += /^(-k|-s|--kill-after|--signal)$/.test(ws[i]) ? 2 : 1
      if (i < ws.length && /^\d+(\.\d+)?[smhd]?$/.test(ws[i])) i++
    } else if (PREFIXES.has(w)) {
      i++
      if (w === "nice") while (i < ws.length && isFlag(ws[i])) i += ws[i] === "-n" ? 2 : 1
    } else break
  }
  // PowerShell's call operator: `& "C:\...\yarn.cmd" test`.
  if (ws[i] === "&" || ws[i] === ".") i++
  return i
}

/** A segment's words from its program on: `timeout 600 npm test` → `npm test`. */
export const commandWords = (segment: Segment): ReadonlyArray<string> => segment.words.slice(commandStart(segment.words))

/**
 * What a segment runs: `yarn test:update`, `npx vitest`, `git diff`,
 * `node -e`, `python3 script.py`, `grep`. Undefined for an empty segment,
 * and for one that runs nothing of its own (`done`, `local x=1`).
 * A task runner's tasks (`turbo run typecheck test`) are `segmentKeys`.
 */
export const segmentKey = (segment: Segment): string | undefined => {
  const ws = segment.words.slice(commandStart(segment.words))
  if (ws.length === 0) return undefined
  const program = programName(ws[0])
  if (NO_COMMAND.has(program) || /^[\w.:-]+\(\)$/.test(program)) return undefined
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
    // Past the interpreter's own options: what it runs is a module, inline code, or a script.
    for (let i = 0; i < args.length; i++) {
      const w = args[i]
      if (w === "-m" && args[i + 1] !== undefined) return `${program} -m ${args[i + 1]}`
      if (INLINE_OPTIONS.has(w)) return `${program} ${w}`
      if (VALUE_OPTIONS.has(w)) i++
      else if (!isFlag(w)) return `${program} ${posix.basename(w.replace(/\\/g, "/"))}`
    }
    return program
  }
  return program
}

/** Package managers and their runners: what they run is a script of the package or a tool it has. */
const PACKAGE_RUNNERS = new Set(["npm", "yarn", "pnpm", "bun", "npx", "pnpx", "bunx"])

/** Interpreters run alike, whichever name they go by: `python3` and `python`, `node` and `tsx`. */
const FAMILY: Readonly<Record<string, string>> = {
  python3: "python", py: "python", tsx: "node", "ts-node": "node", sh: "bash", pwsh: "powershell"
}

/**
 * What a key's run is about, whichever command ran it: a script by its file
 * (`python3 build.py` and `python build.py` run `build.py`), code an
 * interpreter ran inline (`node (inline)`), a package's script or tool by
 * its name (`yarn test:update`, `npm run test:update`: `test:update`), or the
 * key itself (`git checkout`). A check also targets its kind of check
 * (`check:test`): running the tests another way runs the same check.
 */
export const keyTargets = (key: string): Array<string> => {
  const [program, ...rest] = key.split(" ")
  const args = rest.join(" ")
  let target = key
  if (INTERPRETERS.has(program)) {
    const family = FAMILY[program] ?? program
    target = args === "" || INLINE_OPTIONS.has(args) ? `${family} (inline)` : args.startsWith("-m ") ? `${family} ${args}` : args
  } else if (PACKAGE_RUNNERS.has(program) && args !== "") {
    target = args
  }
  const check = classifyKey(key)
  return ["test", "typecheck", "lint", "build"].includes(check) ? [target, `check:${check}`] : [target]
}

/** Files a piece of inline code names, by their extension. */
const FILE_IN_CODE = /["'`]([\w@.\/\\:-]*\w\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|md|mdx|py|html|css|scss|ya?ml|toml|txt|sh|ps1))["'`]/g
/** Inline code that writes files: Node's and Python's writers. */
const WRITES_IN_CODE = /writeFileSync\(|writeFile\(|write_text\(|\.write\(|open\([^)]*["'][wa]\+?["']/

/** A file's name as targets compare it: the last part of its path, in lower case. */
export const fileTarget = (path: string): string => `file:${(path.replace(/\\/g, "/").split("/").pop() ?? path).toLowerCase()}`

/**
 * Files a segment edits in place: `sed -i`'s and `perl -i`'s files, and the
 * files inline code names when it writes (`node -e '…writeFileSync("a.ts")…'`).
 */
export const editedFiles = (segment: Segment): Array<string> => {
  const ws = commandWords(segment)
  const program = programName(ws[0] ?? "")
  if (program === "sed" || program === "perl") {
    if (!ws.slice(1).some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) return []
    const files: Array<string> = []
    let script = !ws.some((w) => w === "-e" || w === "--expression")
    for (let i = 1; i < ws.length; i++) {
      if (ws[i] === "-e" || ws[i] === "--expression") i++
      else if (isFlag(ws[i])) continue
      else if (script) script = false
      else files.push(ws[i])
    }
    return files
  }
  if (INTERPRETERS.has(program) && WRITES_IN_CODE.test(segment.text)) {
    return [...new Set([...segment.text.matchAll(FILE_IN_CODE)].map((m) => m[1]))]
  }
  return []
}

/**
 * What a segment's run is about: its keys' targets (`keyTargets`), or for a
 * segment that edits files in place, those files (`file:a.ts`): a broken
 * `sed -i` on a file is fixed by the next edit of that file that works,
 * whichever way it is made.
 */
export const segmentTargets = (segment: Segment): Array<string> => placedTargets(segment, undefined).map((t) => t.target)

/** Programs that move the shell to another folder. */
const MOVES_TO = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"])

/**
 * A folder as places are compared: forward slashes, Git Bash's drives
 * (`/c/x`) as Windows writes them (`c:/x`), no quotes or trailing slash, `.`
 * and `..` worked out, in lower case.
 */
export const folderKey = (path: string): string => {
  const p = path.trim().replace(/^["']+|["']+$/g, "").replace(/\\/g, "/").replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:")
  const drive = /^[a-zA-Z]:/.exec(p)?.[0]
  const parts: Array<string> = []
  for (const part of (drive === undefined ? p : p.slice(2)).split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  const body = parts.join("/")
  return (drive !== undefined ? `${drive}/${body}` : p.startsWith("/") ? `/${body}` : body).toLowerCase()
}

/**
 * Paths no folder can be told for: a variable, `~`, `cd -`, and Git Bash's
 * `/tmp`, which is the Windows user's temp folder under another name.
 */
const UNTOLD = /[$`]|^~|^-$|^\/tmp(?:\/|$)/

const isAbsolute = (key: string) => /^[a-z]:\//.test(key) || key.startsWith("/")

/** A path from `folder`: where it is, or undefined when it can't be told (`UNTOLD`, or no folder to start from). */
export const resolveFolder = (folder: string | undefined, path: string): string | undefined => {
  const p = path.trim().replace(/^["']+|["']+$/g, "").replace(/\\/g, "/")
  if (p === "" || UNTOLD.test(p)) return undefined
  const key = folderKey(p)
  if (isAbsolute(key)) return key
  return folder === undefined ? undefined : folderKey(`${folder}/${p}`)
}

/**
 * The folder of a file a segment names: its own, when the path is absolute;
 * else the folder the segment ran in. Claude Code keeps a `cd` made in an
 * earlier call while it stays in the session's folder, so a relative path is
 * somewhere inside the folder the segment seems to run in, not exactly there.
 */
const placeOfFile = (folder: string | undefined, file: string): string | undefined => {
  const p = file.trim().replace(/^["']+|["']+$/g, "").replace(/\\/g, "/")
  if (p === "" || UNTOLD.test(p)) return undefined
  const key = folderKey(p)
  if (!isAbsolute(key)) return folder
  const slash = key.lastIndexOf("/")
  return slash <= 0 ? "/" : key.slice(0, slash).replace(/^([a-z]:)$/, "$1/")
}

/**
 * Where each segment of a line runs: `cwd`, moved by every `cd` before it
 * (`mkdir -p x && cd x && npm test` runs the tests in x). Undefined where it
 * can't be told.
 */
export const segmentFolders = (line: string, cwd: string | undefined): Array<{ readonly segment: Segment; readonly folder: string | undefined }> => {
  let folder = cwd === undefined ? undefined : folderKey(cwd)
  const out: Array<{ readonly segment: Segment; readonly folder: string | undefined }> = []
  for (const segment of mainSegments(splitCommand(line))) {
    out.push({ segment, folder })
    const ws = commandWords(segment)
    if (MOVES_TO.has(programName(ws[0] ?? ""))) {
      const to = ws.slice(1).find((w) => !isFlag(w))
      folder = to === undefined ? undefined : resolveFolder(folder, to)
    }
  }
  return out
}

/** Whether two folders are one place: one is inside the other. A folder that can't be told is anywhere. */
export const samePlace = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined || a === b) return true
  const within = (x: string, y: string) => x.startsWith(y.endsWith("/") ? y : `${y}/`)
  return within(a, b) || within(b, a)
}

/** A target with the folder it is in: where its segment ran, or the folder of the file it names. */
export interface Placed {
  readonly target: string
  readonly place: string | undefined
}

/**
 * A segment's targets (`segmentTargets`) with their places: a file it edits
 * in place is where that file is; a file named inside inline code, joined
 * and escaped as code does, has no place that can be told; a script an
 * interpreter runs is the same script by its name wherever its file is (one
 * copied or moved to where it works, `node /c/scratch/x.ts` then `node
 * scratch/x.ts`, is still it; the CLI run from a worktree or the installed
 * copy too); anything else, a check, a package's script, a program, is where
 * the segment runs.
 */
export const placedTargets = (segment: Segment, folder: string | undefined): Array<Placed> => {
  const files = editedFiles(segment)
  const keys = segmentKeys(segment)
  const ws = commandWords(segment)
  const checks = keys.flatMap(keyTargets).filter((t) => t.startsWith("check:")).map((target) => ({ target, place: folder }))
  if (files.length > 0) {
    const inPlace = ["sed", "perl"].includes(programName(ws[0] ?? ""))
    return [...files.map((f) => ({ target: fileTarget(f), place: inPlace ? placeOfFile(folder, f) : undefined })), ...checks]
  }
  return keys.flatMap((key) =>
    keyTargets(key).map((target) => {
      const script = INTERPRETERS.has(key.split(" ")[0]) && !target.startsWith("check:") && !target.includes(" ")
      return { target, place: script ? undefined : folder }
    })
  )
}

/** The code of a segment that runs inline code: below its first line (a heredoc, a quoted script over lines), or after the program and its options. */
const codeOf = (text: string): string =>
  text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text.replace(/^\S+(?:\s+-\S*)*\s*/, "")

/**
 * Whether two segments run the same inline code, give or take a fix: half
 * the words of the shorter code, at least three, are in the other.
 */
export const sameCode = (a: string, b: string): boolean => {
  const words = (s: string) => new Set(codeOf(s).match(/[A-Za-z_][\w.]{2,}/g) ?? [])
  const x = words(a)
  const y = words(b)
  const [small, large] = x.size <= y.size ? [x, y] : [y, x]
  if (small.size < 3) return false
  let shared = 0
  for (const w of small) if (large.has(w)) shared++
  return shared / small.size >= 0.5
}

/** Task runners whose arguments name the tasks they run: `turbo run typecheck test`, `nx run-many -t test`. */
const TASK_RUNNERS = new Set(["turbo", "nx"])
/** Turbo's and Nx's own commands, which run no task of the repo's. */
const RUNNER_COMMANDS = new Set([
  "prune", "daemon", "login", "logout", "link", "unlink", "gen", "generate", "g", "ls", "info", "telemetry", "query",
  "watch", "boundaries", "scan", "bin", "completion", "devtools", "graph", "show", "reset", "migrate", "list", "report",
  "init", "add", "release", "format", "format:check", "format:write", "connect", "repair", "sync", "view-logs", "exec"
])
/** Their flags that take the next word as a value. */
const RUNNER_VALUE_FLAGS = new Set([
  "--filter", "-F", "--concurrency", "--cache-dir", "--output-logs", "--log-order", "--env-mode", "--graph", "--summarize",
  "--projects", "-p", "--exclude", "--configuration", "-c", "--parallel", "--base", "--head", "--files"
])
/** Nx's flags that name the targets to run: `-t test lint`, `--targets=test,lint`. */
const NX_TARGET_FLAGS = new Set(["-t", "--target", "--targets"])

/** The tasks a task runner's arguments name, in order. */
const runnerTasks = (runner: string, args: ReadonlyArray<string>): Array<string> => {
  const plain: Array<string> = []
  const targets: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    // What follows `--` goes to the tasks themselves.
    if (w === "--") break
    const [flag, value] = w.split("=", 2)
    if (runner === "nx" && NX_TARGET_FLAGS.has(flag)) {
      if (value !== undefined) targets.push(...value.split(","))
      else while (i + 1 < args.length && !isFlag(args[i + 1])) targets.push(...args[++i].split(","))
    } else if (isFlag(w)) {
      if (value === undefined && RUNNER_VALUE_FLAGS.has(w)) i++
    } else plain.push(w)
  }
  const [command, ...rest] = plain
  if (command === undefined) return targets
  if (runner === "nx") {
    if (command === "run") return rest.flatMap((r) => (r.split(":")[1] === undefined ? [] : [r.split(":")[1]]))
    if (command === "run-many" || command === "affected") return targets
  }
  if (command === "run") return rest
  return RUNNER_COMMANDS.has(command) ? [] : runner === "nx" ? [command] : plain
}

/**
 * Every key a segment runs: its key, or for a task runner one key per task
 * (`npx turbo run typecheck test` runs `npx turbo typecheck` and `npx turbo test`).
 */
export const segmentKeys = (segment: Segment): Array<string> => {
  const key = segmentKey(segment)
  if (key === undefined) return []
  const parts = key.split(" ")
  const runner = parts[parts.length - 1]
  if (parts.length > 2 || !TASK_RUNNERS.has(runner)) return [key]
  const ws = segment.words.slice(commandStart(segment.words))
  const at = ws.findIndex((w, i) => (i === 0 ? programName(w) : w) === runner)
  const tasks = runnerTasks(runner, ws.slice(at + 1))
  return tasks.length === 0 ? [key] : [...new Set(tasks.map((t) => `${key} ${t}`))]
}

/** A key of one task a task runner runs (`npx turbo test`): its arguments name tasks, not test files. */
const isRunnerTaskKey = (key: string): boolean => {
  const parts = key.split(" ")
  return parts.length >= 2 && TASK_RUNNERS.has(parts[parts.length - 2])
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
  ...new Set(mainSegments(splitCommand(line)).flatMap(segmentKeys))
]

/** Programs and subcommands that only look around: a failed search isn't a mistake to warn about. */
const READ_ONLY = new Set([
  "grep", "egrep", "fgrep", "rg", "find", "ls", "dir", "cat", "head", "tail", "wc", "awk", "echo", "printf", "pwd",
  "which", "where", "type", "tree", "stat", "file", "du", "cd", "pushd", "popd", "sed", "test", "[", "[[", "true", "false",
  "date", "seq", "basename", "dirname", "realpath", "readlink", "cygpath", "whoami", "hostname", "uname", "nproc",
  "printenv", "diff", "cmp", "sort", "uniq", "cut", "tr", "column", "jq", "less", "more", "nl", "tac", "xxd", "od",
  "get-content", "get-childitem", "select-string", "test-path", "get-item", "resolve-path", "get-location",
  "set-location", "write-output", "write-host", "gc", "gci", "sls", "cls", "clear", "sleep", "start-sleep",
  "get-date", "get-process", "measure-object", "select-object", "format-hex",
  "git status", "git diff", "git log", "git show", "git grep", "git branch", "git rev-parse", "git ls-files",
  "git blame", "git stash", "git rev-list", "git describe", "git cat-file", "git merge-base", "git for-each-ref",
  "git ls-remote", "git count-objects", "npm ls", "yarn list", "yarn why", "npm view", "npm why"
])

export const isReadOnlyKey = (key: string): boolean => READ_ONLY.has(key)

/** Whether a segment only looks around. `sed -i` edits, so it doesn't. */
export const isReadOnlySegment = (segment: Segment): boolean => {
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
  if (/\btest|test:|\bvitest\b|\bjest\b|\bpytest\b|\bmocha\b|\bava\b|\bplaywright\b|\bcypress\b|-m pytest|\bunittest\b|\brspec\b|\bphpunit\b|\bnextest\b|\bctest\b|\btox\b/.test(k)) return "test"
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
  const checks = mainSegments(splitCommand(line)).filter((s) =>
    segmentKeys(s).some((key) => ["test", "typecheck", "lint", "build"].includes(classifyKey(key)))
  )
  return checks.length === 0 ? line.trim() : checks.map((s) => s.words.join(" ")).join(" && ")
}

/** The words that make a key distinctive in a command line: `yarn test:update` → `test:update`. */
export const keyWord = (key: string): string => {
  const parts = key.split(" ")
  return parts[parts.length - 1]
}

/** The segment of `line` that runs `key`, if any (the last one, when it runs several times). */
export const segmentFor = (line: string, key: string): Segment | undefined =>
  mainSegments(splitCommand(line)).filter((s) => segmentKeys(s).includes(key)).pop()

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
  if (isRunnerTaskKey(key)) return []
  const ws = segment.words
  let start = commandStart(ws)
  if (start >= ws.length) return []
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
