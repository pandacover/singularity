/**
 * Storing what a session did in apps: its calls read by the translators
 * (Calls.ts), made into one trail per app (Trail.ts), and stored with each
 * app's index built again (Store.ts). Three sources feed it the same way:
 *
 * - a Claude Code session's log, in the background at task start and at
 *   session end (`computer-use store`, started by src/computer/hook.ts);
 * - the Claude desktop proxy's calls, kept in its memory (Proxy.ts);
 * - old runs, for the offline replay.
 *
 * A trail stored again later in the same session replaces the earlier one.
 */
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { parseSession } from "../traces/Parse.ts"
import { type Call, observe } from "./Calls.ts"
import { type AppIndex, Trail } from "./Model.ts"
import { appDir, fileName, loadSalt, readIndex, storeTrail } from "./Store.ts"
import { buildTrails, type PromptAt, type Step } from "./Trail.ts"

export interface TimedCall {
  readonly call: Call
  readonly at: string
}

export interface SessionInput {
  readonly session: string
  readonly agent: string
  readonly calls: ReadonlyArray<TimedCall>
  readonly prompts: ReadonlyArray<{ readonly text: string; readonly at: string }>
  /** The text of a snapshot file an answer linked to, read where the session ran; undefined when it is gone. */
  readonly readFile: (file: string) => Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path>
}

const decodeTrail = Schema.decodeUnknownOption(Schema.fromJsonString(Trail))

/** The steps of a session: each call's observations, with the snapshots its answers linked read. */
export const stepsOf = Effect.fn("computer.stepsOf")(function*(input: SessionInput) {
  const steps: Array<Step> = []
  for (const c of input.calls) {
    for (const obs of observe(c.call)) {
      const yaml = obs.yaml ?? (obs.file === undefined ? undefined : yield* input.readFile(obs.file))
      steps.push({ obs, at: c.at, yaml })
    }
  }
  return steps
})

/** Prompts placed among the steps: each before the first step at or after it. */
export const placePrompts = (steps: ReadonlyArray<Step>, prompts: SessionInput["prompts"]): Array<PromptAt> =>
  prompts.map((p) => {
    const i = steps.findIndex((s) => s.at >= p.at)
    return { text: p.text, at: p.at, before: i === -1 ? steps.length : i }
  })

/**
 * The session's trails, with seen-twice judged against what is stored: each
 * app's index, less what this session's own earlier trail of it added.
 */
export const trailsOf = Effect.fn("computer.trailsOf")(function*(input: SessionInput, tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const salt = yield* loadSalt(tenantDir)
  const steps = yield* stepsOf(input)
  const prompts = placePrompts(steps, input.prompts)
  // A first pass finds the apps; their indexes say what other sessions saw.
  const apps = buildTrails(steps, prompts, { salt, session: input.session, agent: input.agent, seenElsewhere: () => false }).map((t) => t.app)
  const indexes = new Map<string, { index: AppIndex | undefined; own: Trail | undefined }>()
  for (const app of apps) {
    const index = yield* readIndex(tenantDir, app)
    const ownText = yield* fs.readFileString(path.join(appDir(tenantDir, app, path), "trails", `${fileName(input.session)}.json`)).pipe(Effect.option)
    indexes.set(app, { index, own: Option.isSome(ownText) ? Option.getOrUndefined(decodeTrail(ownText.value)) : undefined })
  }
  const seenElsewhere = (app: string, screen: string, fp: string): boolean => {
    const entry = indexes.get(app)
    if (entry?.index === undefined) return false
    const n = entry.index.seen[screen]?.[fp] ?? 0
    const own = entry.own
    const ownSaw = own === undefined
      ? false
      : screen === ""
      ? own.screens.some((s) => [...s.address.path, ...(s.address.hash ?? [])].some((x) => "fp" in x && x.fp === fp))
      : own.screens.some((s) => s.key === screen && s.seen.includes(fp))
    return n - (ownSaw ? 1 : 0) >= 1
  }
  return buildTrails(steps, prompts, { salt, session: input.session, agent: input.agent, seenElsewhere })
})

/** Whether a trail holds anything worth keeping: what it left out counts, for status. */
const worthKeeping = (t: Trail) => t.screens.length > 0 || t.rules.length > 0 || (t.desktop?.calls ?? 0) > 0 || Object.keys(t.left_out).length > 0

/** Store a session's trails; the apps stored. */
export const captureSession = Effect.fn("computer.captureSession")(function*(input: SessionInput, tenantDir: string) {
  const stored: Array<string> = []
  for (const t of yield* trailsOf(input, tenantDir)) {
    if (!worthKeeping(t)) continue
    yield* storeTrail(tenantDir, t)
    stored.push(t.app)
  }
  return stored
})

const iso = (t: DateTime.Utc | undefined) => (t === undefined ? "" : DateTime.formatIso(t))

/** A Claude Code session's log as capture's input: its computer-use calls and the person's prompts. */
export const sessionFromLog = Effect.fn("computer.sessionFromLog")(function*(session: string, transcript: string) {
  const path = yield* Path.Path
  const trace = yield* parseSession(transcript, false)
  const calls: Array<TimedCall> = trace.toolCalls
    .filter((c) => c.agentId === undefined && c.name.startsWith("mcp__"))
    .map((c) => ({ call: { name: c.name, input: c.input, result: c.result, failed: c.isError }, at: iso(c.startedAt) }))
  const cwd = trace.cwd ?? path.dirname(transcript)
  const input: SessionInput = {
    session,
    agent: "claude-code",
    calls,
    prompts: trace.prompts.filter((p) => p.harness !== true).map((p) => ({ text: p.text, at: iso(p.timestamp) })),
    readFile: (file) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const p = yield* Path.Path
        const full = p.resolve(cwd, file.replace(/\\/g, "/"))
        return yield* fs.readFileString(full).pipe(Effect.map((t): string | undefined => t), Effect.orElseSucceed(() => undefined))
      })
  }
  return input
})
