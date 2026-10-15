/**
 * `singularity status`: which agents have memory and how (hooks or plugin,
 * skill, the recall note in their instruction file), what memory knows
 * in each repo (the changes it stored) and which of its sessions' commits it
 * left out and why, and whether hooks have been failing.
 * One screen, or with --json the same as data for agents and scripts.
 */
import { Console, DateTime, Effect, FileSystem, Path } from "effect"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import { commitRecordId } from "../records/Build.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { readRetired } from "../scripts/Retired.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { matchSubject } from "../records/Subjects.ts"
import { isMiss, readSkips, type Skip } from "../workflows/Commits.ts"
import type { AgentDirs, Reach } from "./Agents.ts"
import { codexHooks } from "./CodexHooks.ts"
import { makeStyle, plural, tilde } from "./Ui.ts"
import { agentStates, detectAgents, findCommand, findExecutable } from "./Wiring.ts"

export const VERSION = "0.2.0"

const REACH: Record<Reach, string> = {
  "stores": "hands over memory, stores its changes",
  "hands-over": "hands over memory",
  "on-request": "memory when you ask for it"
}

/** Hook errors in the last week: how many, and the last one's first line. */
export const recentHookErrors = Effect.fn("recentHookErrors")(function*(home: Home) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(path.join(home.root, "hook-errors.log")).pipe(Effect.orElseSucceed(() => ""))
  const since = DateTime.toEpochMillis(yield* DateTime.now) - 7 * 24 * 3600 * 1000
  const entries = text.split(/\r?\n/).filter((l) => /^\d{4}-\d\d-\d\dT/.test(l) && Date.parse(l.split(" ")[0]) >= since)
  return { count: entries.length, last: entries.at(-1)?.split(" ").slice(1).join(" ").slice(0, 120) }
})

/**
 * A repo's commits memory left out, by reason, most common first: the latest
 * reason for each, leaving out commits stored since and those memory didn't
 * miss (someone's own work, copies, commits stored with others).
 */
export const leftOut = (skips: ReadonlyArray<Skip>, subject: string, stored: ReadonlySet<string>): Array<readonly [string, number]> => {
  const latest = new Map<string, string>()
  for (const s of skips) if (s.subject === subject) latest.set(s.commit, s.reason)
  const counts = new Map<string, number>()
  for (const [commit, reason] of latest) {
    if (!isMiss(reason) || stored.has(commitRecordId(subject, commit))) continue
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export const shortDate = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en", { month: "short", day: "numeric" })
}

/**
 * What `status` shows, as data: the text is drawn from it, and `status
 * --json` prints it for agents and scripts.
 */
export interface StatusReport {
  readonly version: string
  readonly memory_home: string
  readonly agents: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly set_up: boolean
    readonly reach: Reach
    /** What memory put in the agent: "hooks" or "plugin", "skill", and "recall note" (in its instruction file). */
    readonly parts: ReadonlyArray<string>
    /** Memory's hooks Codex skips until the user trusts them; 0 for other agents. */
    readonly untrusted_hooks: number
  }>
  /** The repo the command ran in, when it ran in one. */
  readonly here: { readonly name: string; readonly root: string; readonly stored: boolean } | null
  readonly repos: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly here: boolean
    readonly changes_stored: number
    /** Stored changes the search passes over for good: reverted, superseded, gone, folded (scripts/Retired.ts). */
    readonly retired: number
    /** When the latest change was stored. */
    readonly last_stored: string | null
    readonly left_out: ReadonlyArray<{ readonly reason: string; readonly count: number }>
  }>
  readonly hook_errors: { readonly this_week: number; readonly last: string | null; readonly log: string }
}

export const gatherStatus = Effect.fn("gatherStatus")(function*(o: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string; readonly memoryHome?: string | undefined }) {
  const path = yield* Path.Path
  const home = yield* loadHome(o.memoryHome)

  // Agents found here or holding memory.
  const dirs: AgentDirs = { home: o.home, env: o.env }
  const found = yield* detectAgents(dirs, (c) => findExecutable(c, o.env).pipe(Effect.map((p) => p !== undefined)))
  const states = (yield* agentStates(found, dirs)).filter((a) => a.found || a.hookEvents.length > 0 || a.skill)
  const agents: Array<StatusReport["agents"][number]> = []
  for (const a of states) {
    let untrusted = 0
    if (a.agent.id === "codex" && a.hookEvents.length > 0) {
      const codex = yield* findCommand("codex", o.env)
      const hooks = codex === undefined ? undefined : yield* codexHooks(codex, dirs)
      untrusted = hooks?.filter((h) => !h.trusted).length ?? 0
    }
    agents.push({
      id: a.agent.id,
      name: a.agent.name,
      set_up: a.hookEvents.length > 0 || (a.agent.hooks === undefined && a.agent.plugin === undefined && a.skill),
      reach: a.agent.reach,
      parts: [
        ...(a.hookEvents.length > 0 ? [a.agent.plugin === undefined ? "hooks" : "plugin"] : []),
        ...(a.skill ? ["skill"] : []),
        ...(a.note !== undefined && a.note.state !== "missing" ? ["recall note"] : [])
      ],
      untrusted_hooks: untrusted
    })
  }

  // Repos.
  const repo = yield* identifyRepo(o.cwd)
  const skips = yield* readSkips(home.tenantDir)
  const { repos, hereStored } = yield* Effect.gen(function*() {
    const store = yield* RecordStore
    const subjects = yield* store.subjects()
    const here = repo === undefined ? undefined : matchSubject(subjects, repo)
    const repos: Array<StatusReport["repos"][number]> = []
    const retired = yield* readRetired(home.tenantDir)
    for (const subject of subjects) {
      const records = yield* store.find({ subject: subject.id, outcome: "success" })
      repos.push({
        id: subject.id,
        name: subject.name,
        here: here?.id === subject.id,
        changes_stored: records.length,
        retired: records.filter((r) => retired.has(r.id)).length,
        last_stored: records.map((r) => r.created_at).sort().at(-1) ?? null,
        left_out: leftOut(skips, subject.id, new Set(records.map((r) => r.id))).map(([reason, count]) => ({ reason, count }))
      })
    }
    return { repos, hereStored: here !== undefined }
  }).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))

  // Hooks.
  const errors = yield* recentHookErrors(home)
  const report: StatusReport = {
    version: VERSION,
    memory_home: home.root,
    agents,
    here: repo === undefined ? null : { name: path.basename(repo.root), root: repo.root, stored: hereStored },
    repos,
    hook_errors: { this_week: errors.count, last: errors.last ?? null, log: path.join(home.root, "hook-errors.log") }
  }
  return report
})

/** The status screen, drawn from what `gatherStatus` found. */
export const renderStatus = (r: StatusReport, o: { readonly home: string; readonly color: boolean }): Array<string> => {
  const s = makeStyle(o.color)
  const out: Array<string> = []
  const say = (line = "") => void out.push(line)
  say()
  say(`  ${s.magenta("◆")} ${s.bold("singularity")} ${r.version}  ${s.dim(`memory in ${tilde(r.memory_home, o.home)}`)}`)

  say(`\n  ${s.bold("Agents")}`)
  if (r.agents.length === 0) say(`    ${s.dim("no coding agent found")}`)
  const width = Math.max(0, ...r.agents.map((a) => a.name.length)) + 3
  for (const a of r.agents) {
    say(
      a.set_up
        ? `    ${s.green("✓")} ${a.name.padEnd(width)}${REACH[a.reach].padEnd(42)}${s.dim(a.parts.join(" · "))}`
        : `    ${s.dim("·")} ${a.name.padEnd(width)}${s.dim("not set up")}`
    )
    const n = a.untrusted_hooks
    if (n > 0) say(`      ${" ".repeat(width)}${s.yellow(`${plural(n, "hook")} waiting for your trust, so Codex skips ${n === 1 ? "it" : "them"}: type /hooks in Codex`)}`)
  }
  if (r.agents.some((a) => !a.set_up)) say(`    ${s.dim("set up with")} ${s.cyan("singularity setup")}`)

  say(`\n  ${s.bold("Repos")}`)
  const w = Math.max(0, ...r.repos.map((x) => x.name.length)) + 3
  for (const x of r.repos) {
    const last = x.last_stored === null ? "" : ` · last ${shortDate(x.last_stored)}`
    const out = x.retired === 0 ? "" : s.dim(` (${x.retired} retired)`)
    say(`    ${x.name.padEnd(w)}${plural(x.changes_stored, "change")} stored${out}${last}${x.here ? s.cyan(" ← here") : ""}`)
    if (x.left_out.length > 0) say(`    ${" ".repeat(w)}${s.dim(`left out: ${x.left_out.map((m) => `${m.count} ${m.reason}`).join("; ")}`)}`)
  }
  if (r.here !== null && !r.here.stored) say(`    ${s.dim(`${r.here.name} (here): no changes stored yet`)}`)
  if (r.repos.length === 0 && (r.here === null || r.here.stored)) say(`    ${s.dim("none yet: memory starts when a session commits a change with passing checks")}`)
  if (r.repos.some((x) => x.changes_stored > 0)) {
    say(`    ${s.dim("see them with")} ${s.cyan(r.here?.stored === true ? "singularity changes" : "singularity changes --repo NAME")}`)
  }


  const e = r.hook_errors
  say(`\n  ${s.bold("Hooks")}  ${e.this_week === 0
    ? s.green("no errors this week")
    : `${s.yellow(`${plural(e.this_week, "error")} this week`)}, last: ${e.last ?? ""} ${s.dim(`(${tilde(e.log, o.home)})`)}`}`)
  say()
  return out
}

export const runStatus = Effect.fn("runStatus")(function*(o: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string; readonly color: boolean; readonly json: boolean; readonly memoryHome?: string | undefined }) {
  const report = yield* gatherStatus(o)
  yield* Console.log(o.json ? JSON.stringify(report, null, 2) : renderStatus(report, o).join("\n"))
})
