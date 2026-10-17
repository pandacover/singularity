/**
 * Whether a saved script still holds, checked at use time with git and no
 * model call: a script shows its change as true, so a file whose code has
 * since been rewritten is left out with a pointer to read it as it is now,
 * rather than shown with a hedge.
 *
 * For each file the script's commit changed (snapshots aside):
 *
 * - survival: the share of its meaningful added lines (`isMeaningful`) still
 *   in today's file, whitespace collapsed. At `STALE_BELOW` or more the file
 *   is fresh; a file whose change adds no meaningful line is fresh while it
 *   exists (there is nothing to judge).
 * - moved: below that, up to `GREP_SAMPLES` of the missing lines (the longest)
 *   are searched for with `git grep -F`; when one other file holds at least
 *   `MOVED_SHARE` of them (and two at least), and the added lines found in
 *   the file and that one together reach `STALE_BELOW`, the code moved there.
 * - stale: still below, it was rewritten; the hand-over leaves its change
 *   out and names the commit that rewrote it (`lastChange`). A file deleted
 *   since, and not moved, is gone, and its change is left out too.
 *
 * A script all of whose files are stale or gone isn't handed over (Start.ts).
 *
 * Commands: a project script it ran (`npm x`, `yarn x`, `pnpm x`, `bun x`)
 * is dropped when `x` was a script in a `package.json` (the repo's, or one in
 * a folder of a file it changed) at its commit and is in none of them today.
 * Builtins (`npm ci`, `yarn install`, `bun test`) and tools (`yarn tsc`) were
 * never scripts there, so they are kept: only what was renamed or removed
 * goes.
 *
 * Pure logic first, then a thin git layer that reads either the working tree
 * or, for checks over history (examples/scripts/check-staleness.ts), a revision.
 */
import { Effect, FileSystem, Path, Predicate } from "effect"
import { git } from "../local/Git.ts"
import { taskKeys } from "../records/Task.ts"
import { score } from "./Search.ts"

/** Below this share of its added lines still there, a file has changed past recognition. */
export const STALE_BELOW = 0.5
/** Lines shorter than this (spaces aside) are too common to tell code apart. */
export const MIN_LINE_CHARS = 8
/** Missing lines searched for elsewhere, and the share one other file must hold to count as where they went. */
export const GREP_SAMPLES = 5
export const MOVED_SHARE = 0.6
const COMMON_IN = 3
/** A newer change supersedes an older one when their files and their tasks are this alike. */
export const SUPERSEDE_FILES = 0.8
export const SUPERSEDE_TASK = 0.8

// --- pure ---

export const normalizeLine = (line: string): string => line.replace(/\s+/g, " ").trim()

/**
 * Lines that would match anywhere: an import or require of one name, a
 * package or module line, and lines with no letter or digit (braces,
 * punctuation).
 */
const BOILERPLATE = [
  /^import\s+(type\s+)?[\w$]+\s+from\s+["'][^"']+["'];?$/,
  /^import\s+(type\s+)?\{\s*[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*\}\s+from\s+["'][^"']+["'];?$/,
  /^import\s+(\*\s+as\s+[\w$]+\s+from\s+)?["'][^"']+["'];?$/,
  /^(const|let|var)\s+[\w$]+\s*=\s*require\(["'][^"']+["']\);?$/,
  /^(import\s+[\w.]+|from\s+[\w.]+\s+import\s+[\w]+)$/,
  /^(package|module|use|using|#include)\s+[\w.:<>"/]+;?$/
]

/** Whether an added line says enough to be looked for later: 8 characters or more besides spaces, a letter or digit, not boilerplate. */
export const isMeaningful = (line: string): boolean => {
  const n = normalizeLine(line)
  return n.replace(/ /g, "").length >= MIN_LINE_CHARS && /[A-Za-z0-9]/.test(n) && !BOILERPLATE.some((re) => re.test(n))
}

export interface AddedLine {
  /** Whitespace collapsed: what survival compares. */
  readonly norm: string
  /** Trimmed only: what `git grep` looks for. */
  readonly raw: string
}

/** The meaningful lines a diff chunk adds, once each. */
export const addedLinesOf = (chunk: string): Array<AddedLine> => {
  const seen = new Set<string>()
  const out: Array<AddedLine> = []
  for (const line of chunk.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const raw = line.slice(1).trim()
    if (!isMeaningful(raw)) continue
    const norm = normalizeLine(raw)
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({ norm, raw })
  }
  return out
}

/** The set of a file's lines, whitespace collapsed. */
export const linesOf = (text: string): Set<string> => new Set(text.replace(/\r\n?/g, "\n").split("\n").map(normalizeLine))

/** The share of `added` still in `today`; undefined when nothing was added to judge by. */
export const survivalOf = (added: ReadonlyArray<AddedLine>, today: Set<string>): number | undefined =>
  added.length === 0 ? undefined : added.filter((l) => today.has(l.norm)).length / added.length

/** The longest of the lines `today` no longer holds: the most telling ones to look for elsewhere. */
export const samplesOf = (added: ReadonlyArray<AddedLine>, today: Set<string> | undefined, n = GREP_SAMPLES): Array<AddedLine> =>
  added.filter((l) => today === undefined || !today.has(l.norm)).sort((a, b) => b.raw.length - a.raw.length).slice(0, n)

/**
 * Where most of the sampled lines are now, other than `own`: the file holding
 * at least two of them and `MOVED_SHARE` of all, if one does. A line found in
 * more than `COMMON_IN` files says nothing about where code went, so it
 * counts as not found; so does a tie between two files.
 */
export const movedTarget = (
  samples: ReadonlyArray<string>,
  hits: ReadonlyArray<{ readonly path: string; readonly match: string }>,
  own: string | null
): string | undefined => {
  if (samples.length < 2) return undefined
  const filesOf = new Map<string, Set<string>>()
  for (const h of hits) if (samples.includes(h.match)) filesOf.set(h.match, (filesOf.get(h.match) ?? new Set()).add(h.path))
  const byFile = new Map<string, Set<string>>()
  for (const h of hits) {
    if (h.path === own || !samples.includes(h.match) || filesOf.get(h.match)!.size > COMMON_IN) continue
    byFile.set(h.path, (byFile.get(h.path) ?? new Set()).add(h.match))
  }
  const best = [...byFile.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
  if (best.length === 0) return undefined
  const [path, found] = best[0]
  if (best[1] !== undefined && best[1][1].size === found.size) return undefined
  return found.size >= 2 && found.size / samples.length >= MOVED_SHARE ? path : undefined
}

/** The commits a commit message says it reverts (`This reverts commit <sha>.`), full or abbreviated. */
export const revertsOf = (message: string): Array<string> =>
  [...message.matchAll(/This reverts commit ([0-9a-f]{7,40})\b/gi)].map((m) => m[1].toLowerCase())

/** The Jaccard index of two sets of paths. */
export const jaccard = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  const x = new Set(a)
  const y = new Set(b)
  const both = [...x].filter((p) => y.has(p)).length
  const either = new Set([...x, ...y]).size
  return either === 0 ? 0 : both / either
}

/**
 * Whether two stored changes are one change made twice: mostly the same
 * files, and tasks that ask for the same thing both ways, by the texts each
 * is found by (records/Task.ts `taskKeys`). Two changes filed under the same
 * "commit and then start" aren't alike for that: their messages say what each
 * did.
 */
export const sameChange = (
  a: { readonly files: ReadonlyArray<string>; readonly prompt: string; readonly message?: string | undefined },
  b: { readonly files: ReadonlyArray<string>; readonly prompt: string; readonly message?: string | undefined }
): boolean =>
  jaccard(a.files, b.files) >= SUPERSEDE_FILES &&
  taskKeys(a).some((x) => taskKeys(b).some((y) => Math.min(score(x, y), score(y, x)) >= SUPERSEDE_TASK))

const SCRIPT_KEY = /^(npm|yarn|pnpm|bun) (\S+)$/

/** `commands` without the package scripts that were scripts then (`before`) and are in no package.json now (`after`). */
export const keepCommands = (commands: ReadonlyArray<string>, before: ReadonlySet<string>, after: ReadonlySet<string>): Array<string> =>
  commands.filter((c) => {
    const m = SCRIPT_KEY.exec(c)
    return m === null || !before.has(m[2]) || after.has(m[2])
  })

/** The names of a package.json's scripts; none when it isn't one. */
export const scriptsOf = (json: string | undefined): Array<string> => {
  if (json === undefined) return []
  try {
    const parsed: unknown = JSON.parse(json)
    const scripts = Predicate.isObject(parsed) ? (parsed as Record<string, unknown>).scripts : undefined
    return Predicate.isObject(scripts) ? Object.keys(scripts) : []
  } catch {
    return []
  }
}

// --- git ---

/** Where "today" is read: the working tree of `root`, or `rev` when given (read with git, the working tree untouched). */
export interface Today {
  readonly root: string
  readonly rev?: string | undefined
}

const upTo = (t: Today) => t.rev ?? "HEAD"

/** A file's text today, or undefined when it isn't there. */
export const readToday = Effect.fnUntraced(function*(t: Today, file: string) {
  if (t.rev !== undefined) {
    return yield* git(t.root, ["show", `${t.rev}:${file}`]).pipe(Effect.orElseSucceed(() => undefined))
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.join(t.root, file)).pipe(Effect.orElseSucceed(() => undefined))
})

/** Which files today hold which of `patterns`, each found as a whole. */
export const grepToday = Effect.fnUntraced(function*(t: Today, patterns: ReadonlyArray<string>) {
  if (patterns.length === 0) return []
  const args = ["grep", "-F", "-I", "-o", "-z", "--no-color", ...patterns.flatMap((p) => ["-e", p])]
  if (t.rev !== undefined) args.push(t.rev)
  // git grep exits 1 when nothing matches.
  const out = yield* git(t.root, args).pipe(Effect.orElseSucceed(() => ""))
  const prefix = t.rev === undefined ? "" : `${t.rev}:`
  const hits: Array<{ path: string; match: string }> = []
  // `-z`: the name, a NUL, then the match and a newline.
  for (const part of out.split("\n")) {
    const nul = part.indexOf("\0")
    if (nul < 0) continue
    const name = part.slice(0, nul)
    hits.push({ path: name.startsWith(prefix) ? name.slice(prefix.length) : name, match: part.slice(nul + 1) })
  }
  return hits
})

/**
 * The commit after `head` up to today that rewrote `file`: the latest that
 * took out `line` (one of the change's lines no longer there), else the
 * latest that changed the file at all. Its short hash and title.
 */
export const lastChange = Effect.fnUntraced(function*(t: Today, head: string, file: string, line?: string) {
  const ask = (pickaxe: ReadonlyArray<string>) =>
    git(t.root, ["log", "-1", "--format=%h%x1f%s", ...pickaxe, `${head}..${upTo(t)}`, "--", file]).pipe(
      Effect.map((out) => {
        const [hash, title] = out.trim().split("\x1f")
        return hash === undefined || hash === "" ? null : { hash, title: title ?? "" }
      }),
      Effect.orElseSucceed(() => null)
    )
  const took = line === undefined ? null : yield* ask([`-S${line}`])
  return took ?? (yield* ask([]))
})

export type Verdict =
  | { readonly kind: "fresh"; readonly survival: number | undefined }
  | { readonly kind: "moved"; readonly survival: number | undefined; readonly to: string }
  | { readonly kind: "stale"; readonly survival: number; readonly last: { readonly hash: string; readonly title: string } | null }
  | { readonly kind: "gone" }

/**
 * How a file the commit `head` changed stands today, from its diff chunk:
 * `now` is its path today (renames followed), null when it's deleted.
 */
export const judgeFile = Effect.fn("scripts.judgeFile")(function*(
  t: Today,
  head: string,
  file: { readonly now: string | null; readonly chunk: string | undefined },
  /** Whether to look for moved code and the commit that rewrote it (a git grep and two logs); else a file below the bar is stale, with no commit named. */
  search = true
) {
  const added = file.chunk === undefined ? [] : addedLinesOf(file.chunk)
  const text = file.now === null ? undefined : yield* readToday(t, file.now)
  if (added.length === 0) return text === undefined ? { kind: "gone" } as const : { kind: "fresh", survival: undefined } as const
  const today = text === undefined ? undefined : linesOf(text)
  const survival = today === undefined ? 0 : survivalOf(added, today)!
  if (survival >= STALE_BELOW) return { kind: "fresh", survival } as const
  const samples = samplesOf(added, today)
  const hits = search ? yield* grepToday(t, samples.map((s) => s.raw)) : []
  const to = movedTarget(samples.map((s) => s.raw), hits, text === undefined ? null : file.now)
  // Moved when the change survives in its file and that one together, as a file that kept it would.
  const there = to === undefined ? undefined : yield* readToday(t, to)
  if (to !== undefined && there !== undefined) {
    const both = new Set([...(today ?? []), ...linesOf(there)])
    if (survivalOf(added, both)! >= STALE_BELOW) return { kind: "moved", survival, to } as const
  }
  if (text === undefined) return { kind: "gone" } as const
  return { kind: "stale", survival, last: search ? yield* lastChange(t, head, file.now!, samples[0]?.raw) : null } as const
})

/** The commit after `head` up to today that says it reverts it, if any. */
export const revertedBy = Effect.fn("scripts.revertedBy")(function*(t: Today, head: string) {
  const out = yield* git(t.root, ["log", "-F", "--grep=This reverts commit", "--format=%H%x1f%B%x1e", `${head}..${upTo(t)}`])
    .pipe(Effect.orElseSucceed(() => ""))
  for (const entry of out.split("\x1e")) {
    const [hash, message] = entry.trim().split("\x1f")
    if (hash === undefined || message === undefined) continue
    if (revertsOf(message).some((r) => head.toLowerCase().startsWith(r))) return hash
  }
  return undefined
})

/** Whether `a` is an ancestor of `b` (or the same commit). */
export const isAncestor = (root: string, a: string, b: string) =>
  git(root, ["merge-base", "--is-ancestor", a, b]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

/** `commands` without the package scripts that no longer exist (see the module's comment). */
export const liveCommands = Effect.fn("scripts.liveCommands")(function*(t: Today, head: string, commands: ReadonlyArray<string>, files: ReadonlyArray<string>) {
  if (!commands.some((c) => SCRIPT_KEY.test(c))) return [...commands]
  const dirs = new Set<string>([""])
  for (const f of files) {
    const parts = f.split("/").slice(0, -1)
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"))
  }
  const candidates = [...dirs].map((d) => (d === "" ? "package.json" : `${d}/package.json`))
  const listed = yield* git(t.root, ["ls-tree", "--name-only", head, "--", ...candidates]).pipe(Effect.orElseSucceed(() => ""))
  const manifests = listed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
  if (manifests.length === 0) return [...commands]
  const before = new Set<string>()
  const after = new Set<string>()
  for (const m of manifests) {
    for (const s of scriptsOf(yield* git(t.root, ["show", `${head}:${m}`]).pipe(Effect.orElseSucceed(() => undefined)))) before.add(s)
    for (const s of scriptsOf(yield* readToday(t, m))) after.add(s)
  }
  return keepCommands(commands, before, after)
})
