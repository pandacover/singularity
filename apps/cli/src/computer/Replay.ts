/**
 * The offline replay (computer-use-memory.md, the plan's step 3): Claude Code
 * session logs replayed oldest first into a memory home. Before each session
 * is stored, its calls go through the hand-over as they would have live, so
 * the replay says what card and notes each session would have been handed,
 * and after which call. Then the session is stored, for the next ones.
 *
 * It also gives the cost ceiling for routes: per session, the browser calls
 * from its first action in an app to the first time it reached a screen it
 * worked on, set against the route's hops, and its calls in all.
 */
import { DateTime, Effect, FileSystem, Path } from "effect"
import { parseSession } from "../traces/Parse.ts"
import { captureSession, sessionFromLog } from "./Capture.ts"
import { observe } from "./Calls.ts"
import { handOverAfter, handOverAtStart } from "./Handover.ts"
import { parseSnapshot } from "./Snapshot.ts"
import { loadSalt, readIndex } from "./Store.ts"
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
    const apps = yield* captureSession(input, tenantDir)
    // The ceiling: calls to the first screen worked on, and the route memory now has to it.
    let callsTo: number | undefined
    let hops: number | undefined
    for (const app of apps) {
      const index = yield* readIndex(tenantDir, app)
      if (index === undefined) continue
      const firstAct = input.calls.findIndex((c) => observe(c.call).some((o) => o.act !== undefined))
      const worked = keys.findIndex((k, j) => j >= firstAct && k !== undefined && (index.screens[k]?.worked_in ?? 0) > 0)
      if (firstAct >= 0 && worked >= 0) {
        callsTo = worked - firstAct + 1
        hops = index.routes.find((r) => r.to === keys[worked])?.hops.length
      }
    }
    const result: ReplayResult = { log, apps, calls: input.calls.length, calls_to_screen: callsTo, route_hops: hops, handed }
    results.push(result)
    if (json) out.push(JSON.stringify(result))
    else {
      out.push(`${n}. ${path.basename(path.dirname(log))}/${path.basename(log)}: ${apps.join(", ") || "no app"}, ${input.calls.length} calls${callsTo === undefined ? "" : `, ${callsTo} to the screen worked on${hops === undefined ? "" : ` (route: ${hops} hops)`}`}`)
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
  }
  return out
})
