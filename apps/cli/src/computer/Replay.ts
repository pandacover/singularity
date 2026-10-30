/**
 * The offline replay (computer-use-memory.md, the plan's step 3): Claude Code
 * session logs replayed oldest first into a memory home. Before each session
 * is stored, its calls go through the hand-over as they would have live, so
 * the replay says what card and notes each session would have been handed,
 * and after which call. Then the session is stored, for the next ones.
 *
 * It also gives the cost ceiling for routes: per session, the browser calls
 * and the turns (model requests) from its first action in an app to the
 * first time it reached a screen it worked on, set against the route's hops,
 * and its calls and turns in all. A route can't save more than the turns
 * above its floor: one to open its start, one per hop. Dollars are each
 * turn's share of the session's cost, weighed by its tokens at Claude's
 * price ratios (cache reads a tenth of new input, cache writes 1.25, output 5).
 */
import { DateTime, Effect, FileSystem, Path } from "effect"
import type { Trace, Usage } from "../traces/Models.ts"
import { parseSession } from "../traces/Parse.ts"
import { captureSession, sessionFromLog } from "./Capture.ts"
import { observe } from "./Calls.ts"
import { handOverAfter, handOverAtStart } from "./Handover.ts"
import { parseSnapshot } from "./Snapshot.ts"
import { shownRoutes } from "./Render.ts"
import { listApps, loadSalt, readIndex } from "./Store.ts"
import { addressOf } from "./Text.ts"
import { screenKey } from "./Trail.ts"

export interface ReplayResult {
  readonly log: string
  readonly apps: ReadonlyArray<string>
  readonly calls: number
  /** Calls from the first action in an app to reaching the first screen it worked on; undefined when it worked on none. */
  readonly calls_to_screen: number | undefined
  /** The hops of the route memory had to that screen, if it had one. */
  readonly route_hops: number | undefined
  readonly handed: ReadonlyArray<{ readonly after_call: number; readonly text: string }>
  /** The chore's id in an eval run's folder name (`...-runs-L08-8aab3f-work`), when there is one. */
  readonly chore: string | undefined
  /** The main thread's model requests. */
  readonly turns: number
  /** Turns from the first action in an app to reaching the screen worked on, both counted. */
  readonly turns_to_screen: number | undefined
  /** Turns from reaching the screen worked on to the session's end: the work there, the write, and the check after it. */
  readonly turns_after_screen: number | undefined
  /** Turns above a route's floor (one to open its start, one per hop), when memory has a route. */
  readonly savable_turns: number | undefined
  /** The same, had memory known the route this session took (the most routes could save), when it took one. */
  readonly savable_if_known: number | undefined
  /** Claude Code's cost for the session, when its log says. */
  readonly dollars: number | undefined
  /** Shares of the session's cost: the turns to the screen, and the savable ones. */
  readonly share_to_screen: number | undefined
  readonly share_savable: number | undefined
}

/** A turn's weight in dollars, relative to a token of new input. */
const weight = (u: Usage) => u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens + 5 * u.output_tokens

/** Turns, savable turns and cost shares of one session. */
const turnsOf = (trace: Trace, firstAct: number, worked: number, hops: number | undefined) => {
  const main = trace.responses.filter((r) => r.agentId === undefined)
  const turnOf = new Map<string, number>()
  main.forEach((r, i) => r.toolCallIds.forEach((id) => turnOf.set(id, i)))
  const ids = trace.toolCalls.filter((c) => c.agentId === undefined && c.name.startsWith("mcp__")).map((c) => c.id)
  const total = main.reduce((a, r) => a + weight(r.usage), 0)
  const cost = trace.costState?.totalCostUSD
  const dollars = typeof cost === "number" ? cost : undefined
  const from = turnOf.get(ids[firstAct] ?? "")
  const to = turnOf.get(ids[worked] ?? "")
  if (from === undefined || to === undefined || to < from || total === 0) {
    return { turns: main.length, turns_to_screen: undefined, turns_after_screen: undefined, savable_turns: undefined, dollars, share_to_screen: undefined, share_savable: undefined }
  }
  const window = main.slice(from, to + 1).reduce((a, r) => a + weight(r.usage), 0)
  const turnsTo = to - from + 1
  const savable = hops === undefined ? undefined : Math.max(0, turnsTo - (hops + 1))
  return {
    turns: main.length,
    turns_to_screen: turnsTo,
    turns_after_screen: main.length - to - 1,
    savable_turns: savable,
    dollars,
    share_to_screen: window / total,
    share_savable: savable === undefined ? undefined : (window * savable) / turnsTo / total
  }
}

const HARM_CHORES = ["L08", "L14", "L12", "U05", "U02", "T07"]

const pct = (x: number) => `${(100 * x).toFixed(1)}%`

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** The ceiling in turns and dollars, over all sessions, and the harm chores one by one. */
const ceiling = (results: ReadonlyArray<ReplayResult>): Array<string> => {
  const turns = results.reduce((a, r) => a + r.turns, 0)
  const priced = results.filter((r) => r.dollars !== undefined)
  const dollars = priced.reduce((a, r) => a + r.dollars!, 0)
  const toScreen = results.reduce((a, r) => a + (r.turns_to_screen ?? 0), 0)
  const savable = results.reduce((a, r) => a + (r.savable_turns ?? 0), 0)
  const dollarsTo = priced.reduce((a, r) => a + r.dollars! * (r.share_to_screen ?? 0), 0)
  const dollarsSavable = priced.reduce((a, r) => a + r.dollars! * (r.share_savable ?? 0), 0)
  const withRoute = results.filter((r) => r.savable_turns !== undefined)
  const out = [
    "",
    `Turns: ${turns} in ${results.length} sessions; ${toScreen} (${pct(toScreen / Math.max(1, turns))}) from the first action to the screen worked on; ${savable} (${pct(savable / Math.max(1, turns))}) above a route's floor, in the ${withRoute.length} sessions memory had a route for.`,
    `Had memory known every route sessions took: ${results.reduce((a, r) => a + (r.savable_if_known ?? 0), 0)} turns (${pct(results.reduce((a, r) => a + (r.savable_if_known ?? 0), 0) / Math.max(1, turns))}) above a route's floor; median session ${pct(median(results.map((r) => (r.savable_if_known ?? 0) / Math.max(1, r.turns))))}.`,
    `After reaching the screen worked on: ${results.reduce((a, r) => a + (r.turns_after_screen ?? 0), 0)} turns (${pct(results.reduce((a, r) => a + (r.turns_after_screen ?? 0), 0) / Math.max(1, turns))}), the work there, the write and the check after it.`,
    `Median session: ${pct(median(results.map((r) => (r.savable_turns ?? 0) / Math.max(1, r.turns))))} of its turns above a route's floor (${pct(median(withRoute.map((r) => r.savable_turns! / Math.max(1, r.turns))))} among sessions with a route).`
  ]
  if (priced.length > 0) {
    out.push(`Dollars: $${dollars.toFixed(2)} in ${priced.length} sessions; ${pct(dollarsTo / dollars)} on the turns to the screen, ${pct(dollarsSavable / dollars)} on those above a route's floor.`)
  }
  const harms = results.filter((r) => r.chore !== undefined && HARM_CHORES.includes(r.chore))
  if (harms.length > 0) {
    out.push("Harm chores:")
    for (const r of harms) {
      out.push(`  ${r.chore}: ${r.turns} turns${r.turns_to_screen === undefined ? ", never reached a screen worked on" : `, ${r.turns_to_screen} to the screen, ${r.turns_after_screen} after it${r.savable_turns === undefined ? ", no route" : `, ${r.savable_turns} above the route's floor (${r.route_hops} hops)`}`}`)
      // What memory would have handed it, first lines only.
      for (const h of r.handed) out.push(`    after call ${h.after_call}: ${h.text.split("\n").slice(0, 2).join(" ")}`)
    }
  }
  return out
}

/** Session logs in the folders given (subagents' logs left out), or the files themselves. */
const logsIn = Effect.fn("computer.logsIn")(function*(paths: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const out: Array<string> = []
  const walk: (p: string) => Effect.Effect<void, never, FileSystem.FileSystem> = (p) =>
    Effect.gen(function*() {
      const info = yield* fs.stat(p).pipe(Effect.option)
      if (info._tag === "None") return
      if (info.value.type === "File") {
        if (p.endsWith(".jsonl")) out.push(p)
        return
      }
      if (path.basename(p) === "subagents") return
      for (const name of yield* fs.readDirectory(p).pipe(Effect.orElseSucceed(() => [] as Array<string>))) yield* walk(path.join(p, name))
    })
  for (const p of paths) yield* walk(p)
  return out
})

export const runReplay = Effect.fn("computer.runReplay")(function*(paths: ReadonlyArray<string>, tenantDir: string, json: boolean) {
  const path = yield* Path.Path
  const logs = yield* logsIn(paths)
  // Oldest first, by each session's first logged moment.
  const dated: Array<{ log: string; at: string }> = []
  for (const log of logs) {
    const trace = yield* parseSession(log, false).pipe(Effect.option)
    if (trace._tag === "None") continue
    const first = trace.value.toolCalls.find((c) => c.name.startsWith("mcp__"))?.startedAt
    if (first === undefined) continue
    dated.push({ log, at: DateTime.formatIso(first) })
  }
  dated.sort((a, b) => a.at.localeCompare(b.at))
  const salt = yield* loadSalt(tenantDir)
  const out: Array<string> = []
  const results: Array<ReplayResult> = []
  let n = 0
  for (const { log } of dated) {
    const session = `replay-${++n}-${path.basename(log, ".jsonl").slice(0, 8)}`
    const input = yield* sessionFromLog(session, log)
    const handed: Array<{ after_call: number; text: string }> = []
    const firstPrompt = input.prompts[0]?.text
    if (firstPrompt !== undefined) {
      const text = yield* handOverAtStart(tenantDir, session, firstPrompt)
      if (text !== undefined) handed.push({ after_call: 0, text })
    }
    // Each call through the hand-over, as live.
    const keys: Array<string | undefined> = []
    let i = 0
    for (const c of input.calls) {
      i++
      const obs = observe(c.call)
      if (obs.length === 0) {
        keys.push(undefined)
        continue
      }
      const last = obs[obs.length - 1]
      const yaml = last.yaml ?? (last.file === undefined ? undefined : yield* input.readFile(last.file))
      const text = yield* handOverAfter(tenantDir, session, obs, yaml)
      if (text !== undefined) handed.push({ after_call: i, text })
      const parsed = last.url === undefined ? undefined : addressOf(salt, last.url)
      keys.push(parsed === undefined || yaml === undefined ? undefined : screenKey(salt, parsed.address, parseSnapshot(yaml)))
    }
    // The routes the card could show before this session, by app.
    const before = new Map<string, ReturnType<typeof shownRoutes>>()
    for (const app of yield* listApps(tenantDir)) {
      const index = yield* readIndex(tenantDir, app)
      if (index !== undefined) before.set(app, shownRoutes(index))
    }
    const apps = yield* captureSession(input, tenantDir)
    // The ceiling: calls to the first screen worked on (known once the session is stored), and the route memory had to it.
    let callsTo: number | undefined
    let hops: number | undefined
    let hopsKnown: number | undefined
    let span: { firstAct: number; worked: number } | undefined
    for (const app of apps) {
      const index = yield* readIndex(tenantDir, app)
      if (index === undefined) continue
      const firstAct = input.calls.findIndex((c) => observe(c.call).some((o) => o.act !== undefined))
      const worked = keys.findIndex((k, j) => j >= firstAct && k !== undefined && (index.screens[k]?.worked_in ?? 0) > 0)
      if (firstAct >= 0 && worked >= 0) {
        callsTo = worked - firstAct + 1
        hops = before.get(app)?.find((r) => r.route.to === keys[worked])?.route.hops.length
        hopsKnown = index.routes.find((r) => r.to === keys[worked])?.hops.length
        span = { firstAct, worked }
      }
    }
    const trace = yield* parseSession(log, false)
    const turns = turnsOf(trace, span?.firstAct ?? -1, span?.worked ?? -1, hops)
    const chore = /-runs-([A-Z]\d{2})-[0-9a-f]{6}-work$/.exec(path.basename(path.dirname(log)))?.[1]
    const known = turnsOf(trace, span?.firstAct ?? -1, span?.worked ?? -1, hopsKnown).savable_turns
    const result: ReplayResult = { log, apps, calls: input.calls.length, calls_to_screen: callsTo, route_hops: hops, handed, chore, ...turns, savable_if_known: known }
    results.push(result)
    if (json) out.push(JSON.stringify(result))
    else {
      const turnText = turns.turns_to_screen === undefined
        ? `, ${turns.turns} turns`
        : `, ${turns.turns} turns, ${turns.turns_to_screen} to it${turns.savable_turns === undefined ? "" : `, ${turns.savable_turns} above the route's floor`}`
      out.push(`${n}. ${path.basename(path.dirname(log))}/${path.basename(log)}: ${apps.join(", ") || "no app"}, ${input.calls.length} calls${callsTo === undefined ? "" : `, ${callsTo} to the screen worked on${hops === undefined ? "" : ` (route: ${hops} hops)`}`}${turnText}`)
      for (const h of handed) out.push(`   after call ${h.after_call}:`, ...h.text.split("\n").map((l) => `     ${l}`))
    }
  }
  if (!json) {
    const withScreen = results.filter((r) => r.calls_to_screen !== undefined)
    const sum = (f: (r: ReplayResult) => number) => withScreen.reduce((a, r) => a + f(r), 0)
    out.push(
      "",
      `${results.length} sessions; ${results.filter((r) => r.handed.length > 0).length} handed something; ${results.reduce((a, r) => a + r.handed.length, 0)} hand-overs.`,
      withScreen.length === 0 ? "No session reached a screen it worked on." : `Calls to the screen worked on: ${sum((r) => r.calls_to_screen!)} of ${sum((r) => r.calls)} calls in those ${withScreen.length} sessions (${((100 * sum((r) => r.calls_to_screen!)) / Math.max(1, sum((r) => r.calls))).toFixed(1)}%).`
    )
    out.push(...ceiling(results))
  }
  return out
})
