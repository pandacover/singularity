/**
 * `singularity status`: which agents have memory and how, what memory knows
 * in each repo and which of its sessions' commits it left out and why,
 * whether learning runs on its own, and whether hooks have been failing.
 * One screen, or with --json the same as data for agents and scripts.
 */
import { Console, DateTime, Effect, FileSystem, Layer, Path } from "effect"
import type { ModelAgent } from "../eval/Llm.ts"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import { commitRecordId } from "../records/Build.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { matchSubject } from "../records/Subjects.ts"
import { isMiss, readSkips, type Skip } from "../workflows/Commits.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { budgetReason, learnState, roundUsd, spentToday, waitReason } from "../workflows/Learn.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import type { AgentDirs, Reach } from "./Agents.ts"
import { learningQueue, lockInfo } from "./Background.ts"
import { codexHooks } from "./CodexHooks.ts"
import { LEARNER_NAMES, resolveLearner } from "./Learner.ts"
import { modelFor, readLearn } from "./Preferences.ts"
import { makeStyle, plural, tilde, usd } from "./Ui.ts"
import { agentStates, detectAgents, findCommand, findExecutable } from "./Wiring.ts"

export const VERSION = "0.2.0"

const REACH: Record<Reach, string> = {
  "learns": "hands over memory, learns from changes",
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

/** The last background round, when it failed: its repo and why (learn.log, AutoLearn.ts). */
export const lastLearnFailure = (log: string): { readonly subject: string; readonly reason: string } | undefined => {
  const rounds = log.split(/\r?\n/).filter((l) => /^\d{4}-\d\d-\d\dT\S+ \S+: /.test(l))
  const last = rounds.at(-1)?.match(/^\S+ (\S+): failed: (.*)$/)
  return last === undefined || last === null ? undefined : { subject: last[1], reason: last[2] }
}

const shortDate = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en", { month: "short", day: "numeric" })
}

const clock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" })
}

/** What a repo's next learning round waits on. */
export type NextRound =
  | { readonly state: "learning"; readonly since: string }
  | { readonly state: "queued"; readonly after_running: boolean }
  | { readonly state: "waiting"; readonly reason: string }
  | { readonly state: "ready"; readonly short: string | null }

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
    /** What memory put in the agent: "hooks" or "plugin", and "skill". */
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
    readonly workflows: number
    readonly known_mistakes: number
    readonly changes_stored: number
    readonly learned_from: number
    readonly last_learned: string | null
    readonly next: NextRound
    readonly left_out: ReadonlyArray<{ readonly reason: string; readonly count: number }>
  }>
  readonly learning: {
    readonly auto: boolean
    /** The agent that learns, when it can be found. */
    readonly with: ModelAgent | null
    readonly model: string | null
    readonly every: number
    readonly spent_today_usd: number
    readonly max_usd_per_day: number
    /** Why the agent that learns can't be used, when it can't. */
    readonly problem: string | null
    readonly last_failure: { readonly repo: string; readonly reason: string } | null
  }
  readonly hook_errors: { readonly this_week: number; readonly last: string | null; readonly log: string }
}

export const gatherStatus = Effect.fn("gatherStatus")(function*(o: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string; readonly memoryHome?: string | undefined }) {
  const fs = yield* FileSystem.FileSystem
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
      parts: [...(a.hookEvents.length > 0 ? [a.agent.plugin === undefined ? "hooks" : "plugin"] : []), ...(a.skill ? ["skill"] : [])],
      untrusted_hooks: untrusted
    })
  }

  // Repos.
  const layers = Layer.merge(
    JsonRecordStore.layer(home.tenantDir, home.tenant),
    JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
  )
  const prefs = yield* readLearn(home.root)
  const repo = yield* identifyRepo(o.cwd)
  const skips = yield* readSkips(home.tenantDir)
  const { repos, spent, hereStored } = yield* Effect.gen(function*() {
    const subjects = yield* (yield* RecordStore).subjects()
    const here = repo === undefined ? undefined : matchSubject(subjects, repo)
    const committed = yield* (yield* WorkflowStore).candidates("committed")
    const spent = yield* spentToday()
    const running = lockInfo(home.root)
    const queued = learningQueue(home.root)
    const repos: Array<StatusReport["repos"][number]> = []
    for (const subject of subjects) {
      const state = yield* learnState(subject.id)
      const ids = new Set(state.records.map((r) => r.id))
      const last = committed.filter((c) => c.records.some((r) => ids.has(r))).map((c) => c.created_at).sort().at(-1)
      const waiting = waitReason(state, prefs.every, false)
      const short = prefs.auto ? budgetReason(roundUsd(state), spent, prefs.max_usd_per_day) : undefined
      const next: NextRound = running?.subject === subject.id
        ? { state: "learning", since: running.at }
        : queued.includes(subject.id)
        ? { state: "queued", after_running: running !== undefined }
        : waiting !== undefined
        ? { state: "waiting", reason: waiting }
        : { state: "ready", short: short ?? null }
      repos.push({
        id: subject.id,
        name: subject.name,
        here: here?.id === subject.id,
        workflows: state.memory.workflows.length,
        known_mistakes: state.memory.pitfalls.length,
        changes_stored: state.records.length,
        learned_from: state.learned.length,
        last_learned: last ?? null,
        next,
        left_out: leftOut(skips, subject.id, ids).map(([reason, count]) => ({ reason, count }))
      })
    }
    return { repos, spent, hereStored: here !== undefined }
  }).pipe(Effect.provide(layers))

  // Learning and hooks.
  const learner = yield* Effect.result(resolveLearner(prefs.with, dirs))
  const failed = lastLearnFailure(yield* fs.readFileString(path.join(home.root, "learn.log")).pipe(Effect.orElseSucceed(() => "")))
  const errors = yield* recentHookErrors(home)
  const report: StatusReport = {
    version: VERSION,
    memory_home: home.root,
    agents,
    here: repo === undefined ? null : { name: path.basename(repo.root), root: repo.root, stored: hereStored },
    repos,
    learning: {
      auto: prefs.auto,
      with: learner._tag === "Success" ? learner.success.agent : null,
      model: (learner._tag === "Success" ? modelFor(prefs, learner.success.agent) : undefined) ?? null,
      every: prefs.every,
      spent_today_usd: spent,
      max_usd_per_day: prefs.max_usd_per_day,
      problem: learner._tag === "Failure" ? learner.failure.message : null,
      last_failure: failed === undefined ? null : { repo: failed.subject, reason: failed.reason }
    },
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
    const knows = x.workflows > 0 ? `${plural(x.workflows, "workflow")}, ${plural(x.known_mistakes, "known mistake")}` : "no workflows yet"
    const changes = `${plural(x.changes_stored, "change")} stored${x.learned_from > 0 ? `, ${x.learned_from} learned from` : ""}`
    const next = x.next.state === "learning"
      ? s.yellow(`learning now, since ${clock(x.next.since)}`)
      : x.next.state === "queued"
      ? s.yellow(x.next.after_running ? "queued to learn after the round running now" : "queued to learn")
      : x.next.state === "waiting"
      ? s.dim(x.next.reason)
      : x.next.short === null
      ? s.yellow("ready to learn")
      : `${s.yellow("ready to learn with singularity learn")}${s.dim(`: ${x.next.short}`)}`
    say(`    ${x.name.padEnd(w)}${knows} · ${changes}${x.last_learned === null ? "" : ` · learned ${shortDate(x.last_learned)}`}${x.here ? s.cyan(" ← here") : ""}`)
    say(`    ${" ".repeat(w)}${next}`)
    if (x.left_out.length > 0) say(`    ${" ".repeat(w)}${s.dim(`left out: ${x.left_out.map((m) => `${m.count} ${m.reason}`).join("; ")}`)}`)
  }
  if (r.here !== null && !r.here.stored) say(`    ${s.dim(`${r.here.name} (here): no changes stored yet`)}`)
  if (r.repos.length === 0 && (r.here === null || r.here.stored)) say(`    ${s.dim("none yet: memory starts when a session commits a change with passing checks")}`)

  const l = r.learning
  const through = l.with === null ? "" : ` with ${LEARNER_NAMES[l.with]}${l.model === null ? "" : ` (${l.model})`}`
  say(`\n  ${s.bold("Learning")}  ${l.auto
    ? `on its own${through}, every ${plural(l.every, "new change")} · ${usd(l.spent_today_usd)} of ${usd(l.max_usd_per_day)} spent today ${s.dim("(the limit: singularity setup --daily-limit)")}`
    : `when you run ${s.cyan("singularity learn")}${through}${l.spent_today_usd > 0 ? ` · ${usd(l.spent_today_usd)} spent today` : ""}`}`)
  if (l.problem !== null) say(`            ${s.yellow(l.problem)}`)
  if (l.last_failure !== null) say(`            ${s.yellow(`the last round, of ${l.last_failure.repo}, failed: ${l.last_failure.reason.slice(0, 240)}`)}`)
  const e = r.hook_errors
  say(`  ${s.bold("Hooks")}     ${e.this_week === 0
    ? s.green("no errors this week")
    : `${s.yellow(`${plural(e.this_week, "error")} this week`)}, last: ${e.last ?? ""} ${s.dim(`(${tilde(e.log, o.home)})`)}`}`)
  say()
  return out
}

export const runStatus = Effect.fn("runStatus")(function*(o: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string; readonly color: boolean; readonly json: boolean; readonly memoryHome?: string | undefined }) {
  const report = yield* gatherStatus(o)
  yield* Console.log(o.json ? JSON.stringify(report, null, 2) : renderStatus(report, o).join("\n"))
})
