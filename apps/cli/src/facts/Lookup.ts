/**
 * The facts a moment brings (Facts.ts), as they are looked up: plain node
 * and synchronous file reads, so a hook can read the index without
 * computing anything. The hooks use one moment, a task's start: a card of
 * the check scripts earlier sessions ran (`cardFacts`, `renderCard`,
 * scripts/Start.ts). `factsAt` picks for the three moments the replay
 * (examples/scripts/replay-facts.ts) measured:
 *
 * - a task's start: the project's own checks and the strongest other facts;
 * - the agent's first read of a file a stored change changed: the traps and
 *   check scripts of the changes to it;
 * - a command that just failed: the traps of what it runs whose failure
 *   looks like this one (`signal`), and the check scripts it runs, with what
 *   they need set up first.
 *
 * On 2026-10-21 traps helped once in 37 sessions and first reads brought
 * check scripts the session wrote again anyway, so only the card is handed
 * over. Each fact comes once a session (`givenFactsPath`), never one that
 * only the session itself taught, and only while it is live (`isLive`): its
 * script still on disk, its package script still in package.json. No fact
 * runs anything: existence checks only.
 *
 * The index is `<tenant>/facts/<subject>.json`, written at store time
 * (Index.ts); the subject of a folder is the one whose paths hold it
 * (`<tenant>/subjects.json`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { Fact, FactIndex } from "./Facts.ts"

/**
 * The fewest records a fact must come from to be handed over, the most text
 * a hand-over of facts gives, and how many facts a card or moment gives.
 * Set from the replay in examples/scripts/replay-facts.ts over the 81 real
 * records of 2026-10-21 (37 sessions, each facts only from changes committed
 * before it): at 2 records, traps and file reads fire almost never (6 of
 * 3,720 first reads) and only the project's checks are left; 700 and 1,200
 * characters gave the same facts (four a moment came first), and 300 cut
 * 13% of one repo's with no better share of them used. Traps only at a failure, and only when its output shows their
 * signal: given at task starts and first reads too, the hand-overs held 65
 * more facts, one of which a later detour was fixed with, and grew by half.
 */
export const MIN_RECURRENCE = 1
export const MAX_FACTS_CHARS = 700
export const MAX_FACTS = 4
/** The project's checks named in a card. */
const MAX_PROJECT_CHECKS = 3

/**
 * The format of the index the hooks read: raised when what goes into it
 * changes (2: check scripts known by their file, and commands read in full,
 * 2026-10-21), so that the next store builds it again.
 */
export const INDEX_FORMAT = 2

export const factsDir = (tenantDir: string) => join(tenantDir, "facts")
export const indexPath = (tenantDir: string, subject: string) => join(factsDir(tenantDir), `${subject}.json`)

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return undefined
  }
}

/** A repo's fact index, if one was written, in this format, and reads as one. */
export const readIndex = (path: string): FactIndex | undefined => {
  const v = readJson(path) as Partial<FactIndex> | undefined
  return v !== undefined && v !== null && v.format === INDEX_FORMAT && Array.isArray(v.facts) && typeof v.by_file === "object" && typeof v.by_key === "object"
    ? (v as FactIndex)
    : undefined
}

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")

/** The subject a folder is in, and the root of its checkout there, from `subjects.json`'s paths. */
export const repoOf = (tenantDir: string, cwd: string): { readonly subject: string; readonly root: string } | undefined => {
  const v = readJson(join(tenantDir, "subjects.json")) as { subjects?: ReadonlyArray<{ id?: unknown; paths?: unknown }> } | undefined
  const here = slashes(cwd).toLowerCase()
  let best: { subject: string; root: string } | undefined
  for (const s of v?.subjects ?? []) {
    if (typeof s.id !== "string" || !Array.isArray(s.paths)) continue
    for (const p of s.paths) {
      if (typeof p !== "string") continue
      const root = slashes(p)
      const r = root.toLowerCase()
      // The deepest root that holds the folder: a worktree inside another checkout is its own.
      if ((here === r || here.startsWith(r + "/")) && (best === undefined || root.length > best.root.length)) best = { subject: s.id, root }
    }
  }
  return best
}

/**
 * A fact's command as it reads in the checkout at `root`: the other
 * checkouts of the subject that `subjects.json` knows, named in it as
 * `C:/x`, `C:\x` or `/c/x` (an earlier session ran it there), become `root`
 * in the same form, so the agent runs it on its own checkout.
 */
export const rehome = (tenantDir: string, subject: string, root: string): ((text: string) => string) => {
  const v = readJson(join(tenantDir, "subjects.json")) as { subjects?: ReadonlyArray<{ id?: unknown; paths?: unknown }> } | undefined
  const here = slashes(root)
  const others = (v?.subjects ?? []).filter((s) => s.id === subject && Array.isArray(s.paths)).flatMap((s) => s.paths as Array<unknown>)
    .filter((p): p is string => typeof p === "string").map(slashes).filter((p) => p.toLowerCase() !== here.toLowerCase())
    .sort((a, b) => b.length - a.length)
  const forms = (p: string) => {
    const m = /^([a-zA-Z]):\/(.*)$/.exec(p)
    return m === null ? [{ from: p, to: (h: string) => h }] : [
      { from: p, to: (h: string) => h },
      { from: p.replace(/\//g, "\\"), to: (h: string) => h.replace(/\//g, "\\") },
      { from: `/${m[1].toLowerCase()}/${m[2]}`, to: (h: string) => h.replace(/^([a-zA-Z]):\//, (_, d: string) => `/${d.toLowerCase()}/`) }
    ]
  }
  const swaps = others.flatMap(forms)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return (text) => swaps.reduce((t, s) => t.replace(new RegExp(`${escape(s.from)}(?=$|[\\\\/"'\\s;)&|])`, "gi"), () => s.to(here)), text)
}

/** The scripts of the package.json at a repo's root; undefined when it has none to read. */
export const packageScripts = (root: string): ReadonlySet<string> | undefined => {
  const v = readJson(join(root, "package.json")) as { scripts?: unknown } | undefined
  return v === undefined || typeof v.scripts !== "object" || v.scripts === null ? undefined : new Set(Object.keys(v.scripts))
}

/**
 * Whether a fact still holds as far as existence tells: each script it runs
 * is on disk (a repo path from `root`), and each package script it runs is
 * in package.json (when there is one to read).
 */
export const isLive = (
  fact: Fact,
  root: string,
  scripts: ReadonlySet<string> | undefined,
  exists: (path: string) => boolean = existsSync
): boolean =>
  fact.paths.every((p) => exists(/^(?:[a-zA-Z]:|\/)/.test(p) ? p : join(root, p))) &&
  (scripts === undefined || fact.package_scripts.every((s) => scripts.has(s)))

export type Moment =
  | { readonly kind: "start" }
  | { readonly kind: "read"; readonly file: string }
  | { readonly kind: "fail"; readonly keys: ReadonlyArray<string>; readonly output: string }

/** A check of the project's own (`bun test`), rather than a script run to check: the card names these. */
export const isProjectCheck = (f: Fact) => f.project

export interface PickOptions {
  readonly sessionId: string
  /** Fact ids the session was given already. */
  readonly given: ReadonlySet<string>
  readonly live: (f: Fact) => boolean
  readonly minRecurrence?: number | undefined
  readonly maxChars?: number | undefined
  readonly maxFacts?: number | undefined
  /** A failed command: require the trap's signal in its output (default), or take its traps by key alone. */
  readonly matchSignal?: boolean | undefined
  /** Traps only when a command fails (default), or at a task's start and a first read too. */
  readonly trapsEverywhere?: boolean | undefined
}

/**
 * A key that runs a script file (`node smoke.mjs`, `python e2e.py`). Agents
 * write their own check scripts, one a session, each named its own way: a
 * trap of one (an app's script that times out unless it is built first) is
 * looked up for any failing script whose failure shows its signal.
 */
export const isScriptKey = (k: string) => /^(?:node|python3?|py|bun|deno|tsx|ts-node|bash|sh|pwsh|powershell) \S+\.(?:[cm]?[jt]s|tsx|py|sh|ps1)$/i.test(k)

/** A fact the session may get: not given yet, not the session's own only, live, seen often enough. */
const fresh = (f: Fact, o: PickOptions) =>
  !o.given.has(f.id) && !f.sessions.every((s) => s === o.sessionId) && f.recurrence >= (o.minRecurrence ?? MIN_RECURRENCE) && o.live(f)

/** At most `maxFacts`, strongest first, while their text fits in `maxChars` (the first always). */
const fit = (facts: ReadonlyArray<Fact>, o: PickOptions): Array<Fact> => {
  const out: Array<Fact> = []
  let chars = 0
  for (const f of facts) {
    if (out.length === (o.maxFacts ?? MAX_FACTS)) break
    if (out.length > 0 && chars + f.text.length > (o.maxChars ?? MAX_FACTS_CHARS)) continue
    out.push(f)
    chars += f.text.length
  }
  return out
}

const byIds = (index: FactIndex, ids: ReadonlyArray<string>): Array<Fact> => {
  const want = new Set(ids)
  return index.facts.filter((f) => want.has(f.id))
}

/**
 * The facts a moment brings, strongest first (the index's order): at a
 * task's start, the project's checks and then the strongest other facts; at
 * a first read, the facts of the changes to that file, but the project's
 * checks; at a failure, the traps of what failed whose signal its output
 * shows, and the check scripts it runs.
 */
export const factsAt = (index: FactIndex, moment: Moment, o: PickOptions): { readonly project: Array<Fact>; readonly facts: Array<Fact> } => {
  const here = (f: Fact) => f.kind !== "trap" || o.trapsEverywhere === true
  if (moment.kind === "start") {
    const all = index.facts.filter((f) => here(f) && fresh(f, o))
    return { project: all.filter(isProjectCheck).slice(0, MAX_PROJECT_CHECKS), facts: fit(all.filter((f) => !isProjectCheck(f)), o) }
  }
  if (moment.kind === "read") {
    return { project: [], facts: fit(byIds(index, index.by_file[moment.file] ?? []).filter((f) => here(f) && !isProjectCheck(f) && fresh(f, o)), o) }
  }
  const output = moment.output.toLowerCase()
  const shows = (f: Fact) => f.signal !== null && output.includes(f.signal.toLowerCase())
  const own = new Set(moment.keys.flatMap((k) => index.by_key[k] ?? []))
  const script = moment.keys.some(isScriptKey)
  const matches = (f: Fact) =>
    own.has(f.id)
      ? f.kind === "check" ? !isProjectCheck(f) : o.matchSignal === false || shows(f)
      : script && f.kind === "trap" && f.keys.some(isScriptKey) && shows(f)
  return { project: [], facts: fit(index.facts.filter((f) => matches(f) && fresh(f, o)), o) }
}

/**
 * The repo card a task's start brings (scripts/Hook.ts): the check scripts
 * earlier sessions ran before committing, each still on disk, strongest
 * first. Not the project's own checks (`bun test`): agents run those anyway.
 * Not traps: in the replay they helped once in 37 sessions. Only scripts
 * run for at least `CARD_MIN_RECURRENCE` changes: each session writes check
 * scripts of its own (the replay found 6 of about 300 reused by name), and
 * one run once is a scratch script more often than a harness. But first,
 * whatever their recurrence, the scripts of the change the task is pointed
 * to (`lead`, its commit): the harness written for a task like this one.
 * The facts that fit the card (`renderCard`) are the ones it gives. In the
 * replay of 2026-10-21, ranking the repo's scripts by the files their
 * changes share with the pointed-to one changed no card, and leading with
 * the best match's scripts below the pointer's bar gained one card in
 * chat-v2 and lost one in singularity: neither is done.
 */
export const cardFacts = (index: FactIndex, o: PickOptions, lead?: string): Array<Fact> => {
  const scripts = index.facts.filter((f) => f.kind === "check" && !f.project && f.paths.length > 0)
  const own = lead === undefined ? [] : scripts.filter((f) => f.commits.includes(lead) && fresh(f, { ...o, minRecurrence: 1 }))
  return [...own, ...scripts.filter((f) => !own.includes(f) && fresh(f, { minRecurrence: CARD_MIN_RECURRENCE, ...o }))]
}

export const CARD_MIN_RECURRENCE = 2

const changes = (n: number) => (n === 1 ? "1 change" : `${n} changes`)
const MAX_TITLE_CHARS = 80

/** The folder of a script a command names only by its name (`cd "$TEMP/cu-e2e" && node e2e.mjs`), so the agent can find it. */
const whereIs = (f: Fact): string => {
  const missing = f.paths.filter((p) => {
    const name = p.split("/").pop() ?? p
    return !new RegExp(`[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(f.text)
  })
  return missing.length === 0 ? "" : ` in ${missing.map((p) => p.slice(0, p.lastIndexOf("/")) || p).join(", ")}`
}

/**
 * The card as the agent reads it: each script, where it is when its command
 * doesn't say, and the change it last checked (`titleOf` its commit's), the
 * strongest first while the lines fit in `MAX_FACTS_CHARS` (the first
 * always), `MAX_FACTS` at most. Undefined when none is left; `facts` are the
 * ones shown.
 */
export const renderCard = (
  facts: ReadonlyArray<Fact>,
  titleOf: (commit: string) => string | undefined
): { readonly text: string | undefined; readonly facts: ReadonlyArray<Fact> } => {
  const shown: Array<Fact> = []
  const lines: Array<string> = []
  let chars = 0
  for (const f of facts) {
    if (shown.length === MAX_FACTS) break
    const last = f.commits[0]
    const title = last === undefined ? undefined : titleOf(last)
    const named = title === undefined ? "" : ` "${title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS - 1) + "…" : title}"`
    const line = `- ${f.text}${whereIs(f)} (${changes(f.recurrence)}${last === undefined ? "" : `, last ${last.slice(0, 10)}${named}`})`
    if (shown.length > 0 && chars + line.length > MAX_FACTS_CHARS) continue
    shown.push(f)
    lines.push(line)
    chars += line.length
  }
  if (shown.length === 0) return { text: undefined, facts: [] }
  const text = [
    "# Check scripts earlier sessions here ran",
    "",
    "Before committing, sessions here checked their changes with these scripts, still on disk:",
    "",
    ...lines
  ].join("\n") + "\n"
  return { text, facts: shown }
}

/** Where a session's given facts are kept, next to its marker (scripts/Cycle.ts). */
export const givenFactsPath = (tenantDir: string, safeSessionId: string) => join(tenantDir, "scripts", "sessions", `${safeSessionId}.facts`)

export const readGivenFacts = (path: string): Set<string> =>
  new Set(existsSync(path) ? readFileSync(path, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "") : [])

export const addGivenFacts = (path: string, ids: ReadonlyArray<string>): void => {
  if (ids.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, ids.map((id) => `${id}\n`).join(""))
}

/** A path a tool was given, as a path in the repo; undefined outside it. */
export const repoPath = (root: string, cwd: string, path: string): string | undefined => {
  const p = path.trim().replace(/^["']+|["']+$/g, "")
  if (p === "") return undefined
  // Git Bash's drives (`/c/…`) are Windows's.
  const native = process.platform === "win32" ? p.replace(/^\/([a-zA-Z])\//, "$1:/") : p
  const rel = relative(root, resolve(cwd, native)).replace(/\\/g, "/")
  return rel === "" || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel
}
