/**
 * Computer-use memory's commands for working on it, from the repo
 * (`node src/cli.ts computer-use ...`); daily use goes through `singularity
 * setup computer-use` and the hooks:
 *
 *     computer-use step0 on | off | report                   Step 0's logging hook (src/computer/Step0.ts)
 *     computer-use store --session ID --transcript FILE      store a Claude Code session's trails (the hooks run this)
 *     computer-use show [APP] [--json]                       the apps memory knows, or one app's index and card
 *     computer-use replay LOG... [--home DIR]                the offline replay: what each session would have been handed
 */
import { Console, DateTime, Effect, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { homedir } from "node:os"
import { sessionFromLog, captureSession } from "../computer/Capture.ts"
import { renderCard, screenLabel } from "../computer/Render.ts"
import { runReplay } from "../computer/Replay.ts"
import { step0IsOn, step0Off, step0On, step0Report } from "../computer/Step0.ts"
import { listApps, readIndex } from "../computer/Store.ts"
import { lowerPriority } from "../eval/Proc.ts"
import { loadHome } from "../local/Home.ts"
import { releaseLock, takeLock } from "../setup/Background.ts"
import { homeFlag } from "./Common.ts"

const dirsOf = () => ({ home: homedir(), env: process.env })

const step0 = Command.make(
  "step0",
  {
    action: Argument.Literals("action", ["on", "off", "report"] as const).pipe(Argument.withDescription("on: add the logging hook; off: take it out; report: what it saw")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    if (args.action === "on") {
      const file = yield* step0On(dirsOf())
      return yield* Console.log(`Step 0's logging hook is in ${file}, for every MCP tool. New Claude Code sessions log to ${home.root}/step0/.`)
    }
    if (args.action === "off") {
      const was = yield* step0Off(dirsOf())
      return yield* Console.log(was ? "Step 0's logging hook taken out." : "Step 0's logging hook wasn't there.")
    }
    const on = yield* step0IsOn(dirsOf())
    yield* Console.log([`logging hook: ${on ? "on" : "off"}`, ...(yield* step0Report(home.root))].join("\n"))
  })
).pipe(Command.withDescription("Step 0: a hook that only logs MCP tool calls, to see what Claude Code hands hooks for browser and computer-use tools"))

/** How long a background run waits for another to finish before giving up (the next sweep looks again). */
const STORE_WAIT_MS = 120_000

const store = Command.make(
  "store",
  {
    session: Flag.String("session").pipe(Flag.withDescription("the session's id")),
    transcript: Flag.String("transcript").pipe(Flag.withDescription("its Claude Code log")),
    background: Flag.Boolean("background").pipe(Flag.withDefault(false), Flag.withDescription("as the hooks start it: below normal priority, one run at a time")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const stamp = args.background ? `${DateTime.formatIso(yield* DateTime.now)} ` : ""
    const say = (line: string) => Console.log(`${stamp}${line}`)
    if (args.background) {
      yield* lowerPriority
      let waited = 0
      while (!takeLock(home.root, "store.lock")) {
        if (waited >= STORE_WAIT_MS) return yield* say(`computer use ${args.session}: another run is still storing; the next one looks again`)
        yield* Effect.sleep("500 millis")
        waited += 500
      }
    }
    const apps = yield* Effect.gen(function*() {
      const input = yield* sessionFromLog(args.session, args.transcript)
      return yield* captureSession(input, home.tenantDir)
    }).pipe(Effect.ensuring(Effect.sync(() => args.background && releaseLock(home.root, "store.lock"))))
    yield* say(apps.length === 0 ? `computer use ${args.session}: nothing to store` : `computer use ${args.session}: stored ${apps.join(", ")}`)
  })
).pipe(Command.withDescription("store what a Claude Code session did in apps, one trail per app (the hooks run this on their own)"))

const show = Command.make(
  "show",
  {
    app: Argument.String("app").pipe(Argument.optional, Argument.withDescription("an app's host, as `show` lists them")),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("the index as JSON")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    if (Option.isNone(args.app)) {
      const apps = yield* listApps(home.tenantDir)
      if (apps.length === 0) return yield* Console.log("No apps yet.")
      for (const app of apps) {
        const index = yield* readIndex(home.tenantDir, app)
        if (index === undefined) continue
        yield* Console.log(`${app}: ${index.sessions.length} session(s), ${Object.values(index.screens).filter((s) => s.worked_in > 0).length} screen(s) worked on, ${index.routes.length} route(s), ${index.rules.length} rule(s)`)
      }
      return
    }
    const index = yield* readIndex(home.tenantDir, args.app.value)
    if (index === undefined) return yield* Console.log(`Memory has nothing for ${args.app.value}.`)
    if (args.json) return yield* Console.log(JSON.stringify(index, null, 2))
    const lines = [`${index.app}: ${index.sessions.length} session(s)`]
    for (const s of Object.values(index.screens).filter((x) => x.worked_in > 0)) {
      lines.push(`  screen ${screenLabel(index, s) ?? "(not seen twice yet)"}: worked on in ${s.worked_in}, ${s.fields.length} field(s) that start set, ${s.traps.length} trap(s)`)
    }
    for (const r of index.retired) lines.push(`  retired route: ${r.why}`)
    for (const [why, n] of Object.entries(index.left_out)) lines.push(`  left out: ${n} ${why}`)
    lines.push("", renderCard(index) ?? "(no card yet: routes show once two sessions saw their strings)")
    yield* Console.log(lines.join("\n"))
  })
).pipe(Command.withDescription("the apps computer-use memory knows, or one app's screens and card"))

const replay = Command.make(
  "replay",
  {
    logs: Argument.String("log").pipe(Argument.atLeast(1), Argument.withDescription("Claude Code session logs (.jsonl), or folders of them, replayed oldest first")),
    home: homeFlag,
    json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("each session's result as a JSON line"))
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const lines = yield* runReplay(args.logs.map((l) => path.resolve(l)), home.tenantDir, args.json)
    for (const line of lines) yield* Console.log(line)
  })
).pipe(Command.withDescription("the offline replay: store sessions oldest first, and say what each would have been handed before it was stored"))

export const computerCommand = Command.make("computer-use").pipe(
  Command.withDescription("computer-use memory: Step 0, storing sessions, the offline replay"),
  Command.withSubcommands([step0, store, show, replay])
)
