/**
 * Whether Codex trusts memory's hooks, and trusting them when the user says
 * so. Codex runs a hook only once the user trusted it (`/hooks` in Codex),
 * and it skips the others without a word, `codex exec` included. Trust is
 * kept per hook, as the hash of its command and settings, so a hook setup
 * rewrites (a new install path, a new timeout) needs trusting again.
 *
 * Both go through Codex's own app-server (`codex app-server`, JSON-RPC over
 * stdio): `hooks/list` says each hook's key, hash and trust, and
 * `config/value/write` saves the trust into `hooks.state` of Codex's
 * config.toml with Codex's own writer, as `/hooks` does, leaving the rest of
 * the file as it was. The app-server is experimental in Codex; when it
 * doesn't answer, trust is unknown and setup and status point to `/hooks`.
 */
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type AgentDirs, codexHome, isMemoryHookCommand } from "./Agents.ts"

/** One of memory's hooks as Codex sees it. */
export interface CodexHook {
  /** Codex's name for it in `hooks.state`: the hook file, the event and its place there. */
  readonly key: string
  readonly event: string
  readonly hash: string
  readonly trusted: boolean
}

const HookEntry = Schema.Struct({
  key: Schema.String,
  eventName: Schema.String,
  command: Schema.optionalKey(Schema.NullOr(Schema.String)),
  currentHash: Schema.String,
  trustStatus: Schema.String
})

const HooksList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ hooks: Schema.Array(HookEntry) }))
})

const Response = Schema.fromJsonString(Schema.Struct({
  id: Schema.Number,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
}))

interface Call {
  readonly method: string
  readonly params: unknown
}

/** How long the app-server may take to answer everything (it starts in about a second). */
const TIMEOUT_S = 20

/**
 * The answers to `calls`, made in order on one app-server, or undefined when
 * it can't start, says something else or takes too long. The process ends
 * once the last answer is in.
 */
const appServer = Effect.fn("CodexHooks.appServer")(function*(
  codex: ReadonlyArray<string>,
  dirs: AgentDirs,
  calls: ReadonlyArray<Call>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const messages = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "singularity", version: "1" } } },
    { jsonrpc: "2.0", method: "initialized" },
    ...calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }))
  ]
  const input = new TextEncoder().encode(messages.map((m) => JSON.stringify(m)).join("\n") + "\n")
  const answers = new Map<number, { readonly result?: unknown; readonly error?: unknown }>()
  const ran = yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make(codex[0], [...codex.slice(1), "app-server"], {
        // The home setup wrote the hooks in, whatever the environment says.
        env: { ...dirs.env, CODEX_HOME: codexHome(dirs) },
        extendEnv: false,
        // Kept open: the app-server quits when its input ends, before answering what it has read.
        stdin: { stream: Stream.make(input), endOnDone: false },
        stderr: "ignore"
      }))
      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEachWhile((line) =>
          Effect.sync(() => {
            const answer = Option.getOrUndefined(Schema.decodeUnknownOption(Response)(line))
            if (answer !== undefined && answer.id > 0) answers.set(answer.id, answer)
            return answers.size < calls.length
          })
        )
      )
    })
  ).pipe(Effect.timeoutOption(Duration.seconds(TIMEOUT_S)), Effect.orElseSucceed(() => Option.none()))
  if (Option.isNone(ran) || answers.size < calls.length) return undefined
  return calls.map((_, i) => answers.get(i + 1)!)
})

/** Memory's hooks in Codex and whether each is trusted; undefined when Codex's app-server didn't say. */
export const codexHooks = Effect.fn("codexHooks")(function*(codex: ReadonlyArray<string>, dirs: AgentDirs) {
  const answers = yield* appServer(codex, dirs, [{ method: "hooks/list", params: { cwds: [dirs.home] } }])
  const list = answers === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(HooksList)(answers[0].result))
  if (list === undefined) return undefined
  const seen = new Set<string>()
  const out: Array<CodexHook> = []
  for (const h of list.data.flatMap((d) => d.hooks)) {
    if (typeof h.command !== "string" || !isMemoryHookCommand(h.command) || seen.has(h.key)) continue
    seen.add(h.key)
    out.push({ key: h.key, event: h.eventName, hash: h.currentHash, trusted: h.trustStatus === "trusted" })
  }
  return out
})

/** Trust these hooks in Codex, as `/hooks` would; whether Codex saved it. */
export const trustCodexHooks = Effect.fn("trustCodexHooks")(function*(
  codex: ReadonlyArray<string>,
  dirs: AgentDirs,
  hooks: ReadonlyArray<CodexHook>
) {
  if (hooks.length === 0) return true
  // Merged into hooks.state, so that the hooks the user trusted before stay.
  const value = Object.fromEntries(hooks.map((h) => [h.key, { trusted_hash: h.hash }]))
  const answers = yield* appServer(codex, dirs, [{ method: "config/value/write", params: { keyPath: "hooks.state", value, mergeStrategy: "upsert" } }])
  return answers !== undefined && answers[0].error === undefined && answers[0].result !== undefined
})
