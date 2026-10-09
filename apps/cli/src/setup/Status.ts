/**
 * `singularity status`: which agents have memory and how, what memory knows
 * in each repo, whether learning runs on its own, and whether hooks have
 * been failing. One screen.
 */
import { Console, DateTime, Effect, FileSystem, Layer, Path } from "effect"
import { identifyRepo } from "../local/Git.ts"
import { type Home, loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { matchSubject } from "../records/Subjects.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { learnState, spentToday, waitReason } from "../workflows/Learn.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import type { AgentDirs, Reach } from "./Agents.ts"
import { readLearn } from "./Preferences.ts"
import { makeStyle, plural, tilde, usd } from "./Ui.ts"
import { agentStates, detectAgents, findExecutable } from "./Wiring.ts"

export const VERSION = "0.2.0"

const REACH: Record<Reach, string> = {
  "learns": "hands over memory, learns from sessions",
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

const shortDate = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en", { month: "short", day: "numeric" })
}

export const runStatus = Effect.fn("runStatus")(function*(o: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string; readonly color: boolean; readonly memoryHome?: string | undefined }) {
  const s = makeStyle(o.color)
  const path = yield* Path.Path
  const say = (line = "") => Console.log(line)
  const home = yield* loadHome(o.memoryHome)
  yield* say()
  yield* say(`  ${s.magenta("◆")} ${s.bold("singularity")} ${VERSION}  ${s.dim(`memory in ${tilde(home.root, o.home)}`)}`)

  // Agents found here or holding memory.
  const dirs: AgentDirs = { home: o.home, env: o.env }
  const found = yield* detectAgents(dirs, (c) => findExecutable(c, o.env).pipe(Effect.map((p) => p !== undefined)))
  const states = (yield* agentStates(found, dirs)).filter((a) => a.found || a.hookEvents.length > 0 || a.skill)
  yield* say(`\n  ${s.bold("Agents")}`)
  if (states.length === 0) yield* say(`    ${s.dim("no coding agent found")}`)
  const width = Math.max(0, ...states.map((a) => a.agent.name.length)) + 3
  let missing = 0
  for (const a of states) {
    const wired = a.hookEvents.length > 0 || (a.agent.hooks === undefined && a.agent.plugin === undefined && a.skill)
    const parts = [...(a.hookEvents.length > 0 ? [a.agent.plugin === undefined ? "hooks" : "plugin"] : []), ...(a.skill ? ["skill"] : [])].join(" · ")
    if (!wired) missing++
    yield* say(
      wired
        ? `    ${s.green("✓")} ${a.agent.name.padEnd(width)}${REACH[a.agent.reach].padEnd(42)}${s.dim(parts)}`
        : `    ${s.dim("·")} ${a.agent.name.padEnd(width)}${s.dim("not set up")}`
    )
  }
  if (missing > 0) yield* say(`    ${s.dim("set up with")} ${s.cyan("singularity setup")}`)

  // Repos.
  const layers = Layer.merge(
    JsonRecordStore.layer(home.tenantDir, home.tenant),
    JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
  )
  const prefs = yield* readLearn(home.root)
  const repo = yield* identifyRepo(o.cwd)
  const lines = yield* Effect.gen(function*() {
    const subjects = yield* (yield* RecordStore).subjects()
    const here = repo === undefined ? undefined : matchSubject(subjects, repo)
    const committed = yield* (yield* WorkflowStore).candidates("committed")
    const out: Array<string> = []
    const w = Math.max(0, ...subjects.map((x) => x.name.length)) + 3
    for (const subject of subjects) {
      const state = yield* learnState(subject.id)
      const ids = new Set(state.records.map((r) => r.id))
      const last = committed.filter((c) => c.records.some((r) => ids.has(r))).map((c) => c.created_at).sort().at(-1)
      const knows = state.memory.workflows.length > 0
        ? `${plural(state.memory.workflows.length, "workflow")}, ${plural(state.memory.pitfalls.length, "known mistake")}`
        : "no workflows yet"
      const sessions = `${plural(state.records.length, "session")} recorded${state.learned.length > 0 ? `, ${state.learned.length} learned from` : ""}`
      const waiting = waitReason(state, prefs.every, false)
      const next = waiting === undefined ? s.yellow("ready to learn") : s.dim(waiting)
      const mark = here?.id === subject.id ? s.cyan(" ← here") : ""
      out.push(`    ${subject.name.padEnd(w)}${knows} · ${sessions}${last === undefined ? "" : ` · learned ${shortDate(last)}`}${mark}`)
      out.push(`    ${" ".repeat(w)}${next}`)
    }
    if (repo !== undefined && here === undefined) out.push(`    ${s.dim(`${path.basename(repo.root)} (here): no sessions recorded yet`)}`)
    return { out, spent: yield* spentToday() }
  }).pipe(Effect.provide(layers))
  yield* say(`\n  ${s.bold("Repos")}`)
  if (lines.out.length === 0) yield* say(`    ${s.dim("none yet: memory starts with a Claude Code session that commits a change with passing tests")}`)
  for (const l of lines.out) yield* say(l)

  // Learning and hooks.
  yield* say(`\n  ${s.bold("Learning")}  ${prefs.auto
    ? `on its own, every ${plural(prefs.every, "new session")} · ${usd(lines.spent)} of ${usd(prefs.max_usd_per_day)} spent today`
    : `when you run ${s.cyan("singularity learn")}${lines.spent > 0 ? ` · ${usd(lines.spent)} spent today` : ""}`}`)
  const errors = yield* recentHookErrors(home)
  yield* say(`  ${s.bold("Hooks")}     ${errors.count === 0
    ? s.green("no errors this week")
    : `${s.yellow(`${plural(errors.count, "error")} this week`)}, last: ${errors.last ?? ""} ${s.dim(`(${tilde(path.join(home.root, "hook-errors.log"), o.home)})`)}`}`)
  yield* say()
})
