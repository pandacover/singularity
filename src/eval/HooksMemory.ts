/**
 * The local memory (`~/.singularity`) as a memory setup, handed over by its
 * own hooks as in a user's sessions, not through the system prompt.
 *
 * Before a run: copy the memory home (a `SINGULARITY_HOME`, frozen for a
 * measurement) into the run's directory, so the session's state and the
 * hand-over log stay with the run and the home itself never changes; write
 * Claude Code settings that run the hooks (`--settings`); and point the hooks
 * at the copy. The agent then gets the route at its first prompt and a warning
 * when a trigger appears. The hooks' own model call, which confirms the route,
 * runs the same Claude Code as the agent (`SINGULARITY_CLAUDE`).
 *
 * After the run: the hand-over log says what was handed over (the kind, the
 * steps, the warnings at the start and those whose trigger fired) and what the
 * route's model call cost, which counts toward the run like the graph's step
 * selection. The copied records and graph are removed again; the session's
 * files, the log and any hook errors stay.
 *
 * Nothing is learned here: the SessionEnd hook records only sessions that
 * commit, which eval runs don't, and the graph is built separately
 * (`memory build`).
 */
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { HOOK_SCRIPT, hooksSettings } from "../handover/Install.ts"
import { eventsOf, memoryHookEvents } from "../setup/HookFiles.ts"
import { HOME_ENV, loadHome } from "../local/Home.ts"
import * as JsonMemoryStore from "../memory/JsonMemoryStore.ts"
import { MemoryStore } from "../memory/MemoryStore.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { claudeHome, emptyUsage, type Usage } from "../traces/index.ts"
import { CLAUDE_ENV } from "./Agent.ts"
import type { Delivered, Injection, MemorySetup } from "./Setups.ts"
import { MemoryError } from "./Setups.ts"
import type { Task } from "./Suite.ts"

export interface HooksMemoryOptions {
  /** The memory home to hand over from; never changed. */
  readonly home: string
  /** The Claude Code the agent runs, for the hooks' own model call. */
  readonly claude: ReadonlyArray<string>
  /** The model that confirms the route. */
  readonly selectorModel: string
}

/** A run's copy of the home, and its hook settings, in the run's directory. */
export const RUN_HOME = "memory-home"
export const HOOK_SETTINGS = "hooks.json"

const UsageJson = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cache_creation: Schema.Number,
  cache_read: Schema.Number
})

/** The parts of handovers.jsonl lines (TaskStart.ts, OnTool.ts) a run's record uses. */
export const HandoverLine = Schema.Struct({
  moment: Schema.String,
  kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
  steps: Schema.optionalKey(Schema.Array(Schema.String)),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  proposed: Schema.optionalKey(Schema.Array(Schema.Struct({ kind: Schema.String, coverage: Schema.Number }))),
  reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  selection: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    model: Schema.String,
    cost_usd: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String)
  }))),
  selection_tokens: Schema.optionalKey(Schema.NullOr(UsageJson)),
  excerpts: Schema.optionalKey(Schema.Array(Schema.Struct({ file: Schema.String, from: Schema.Number, to: Schema.Number }))),
  examples: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String, whole: Schema.Boolean }))),
  left_out: Schema.optionalKey(Schema.Number),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool: Schema.optionalKey(Schema.String)
})
export type HandoverLine = typeof HandoverLine.Type

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(HandoverLine))
const Settings = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const usageOf = (u: typeof UsageJson.Type): Usage => ({
  input_tokens: u.input,
  output_tokens: u.output,
  cache_creation_input_tokens: u.cache_creation,
  cache_read_input_tokens: u.cache_read
})

/**
 * What a run was handed, from its hand-over log. `task_start` says whether
 * the task-start hook finished at all; `nodes` are the steps handed over, as
 * reports expect of setups with steps.
 */
export const deliveredFrom = (lines: ReadonlyArray<HandoverLine>, hookErrors: number): Delivered => {
  const start = lines.find((l) => l.moment === "start")
  const fired = lines
    .filter((l) => l.moment === "trigger")
    .flatMap((l) => (l.warnings ?? []).map((warning) => ({ warning, tool: l.tool ?? null })))
  const cost = start?.selection?.cost_usd
  return {
    info: {
      task_start: start !== undefined,
      kind: start?.kind ?? null,
      nodes: start?.steps ?? [],
      warnings_at_start: start?.warnings ?? [],
      fired,
      proposed: start?.proposed ?? [],
      reasons: start?.reasons ?? [],
      selection: start?.selection ?? null,
      // The code that went along: places shown, files handed over whole, and what didn't fit.
      places: start?.excerpts?.length ?? 0,
      files_whole: (start?.examples ?? []).filter((e) => e.whole).map((e) => e.path),
      left_out: start?.left_out ?? 0,
      chars: start?.text?.length ?? 0,
      hook_errors: hookErrors
    },
    spent: cost === undefined || cost === null
      ? undefined
      : { costUsd: cost, usage: start?.selection_tokens ? usageOf(start.selection_tokens) : emptyUsage }
  }
}

const toMemoryError = (e: { readonly message: string }) =>
  e instanceof MemoryError ? e : new MemoryError({ message: `hooks memory: ${e.message}` })

/** Hooks installed for daily work would run next to the run's own, and hand everything over twice. */
const refuseInstalledHooks = Effect.fnUntraced(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(yield* claudeHome, "settings.json")
  if (!(yield* fs.exists(file))) return
  const settings = Schema.decodeUnknownOption(Settings)(yield* fs.readFileString(file))
  // From any checkout or install, v1's included: they would hand memory over next to the run's own.
  if (Option.isSome(settings) && memoryHookEvents(eventsOf(settings.value, "wrapped")).length > 0) {
    return yield* new MemoryError({
      message: `memory hooks are installed in ${file}, so they would run twice; take them out for the run (singularity uninstall, or hooks uninstall)`
    })
  }
})

/** After the run: what the hooks handed over, from the copy's log; then the copy's records and graph go. */
const collect = Effect.fn("HooksMemory.collect")(function*(runDir: string, runHome: string, tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const log = path.join(tenantDir, "handovers.jsonl")
  const lines = (yield* fs.exists(log))
    ? (yield* fs.readFileString(log)).split(/\r?\n/).flatMap((l) => Option.toArray(decodeLine(l)))
    : []
  // hook.ts starts every error entry with a timestamp; stack lines follow it.
  const errors = path.join(runHome, "hook-errors.log")
  const hookErrors = (yield* fs.exists(errors))
    ? (yield* fs.readFileString(errors)).split(/\r?\n/).filter((l) => /^\d{4}-\d\d-\d\dT/.test(l)).length
    : 0
  const text = lines.find((l) => l.moment === "start")?.text
  if (text) yield* fs.writeFileString(path.join(runDir, "injected.md"), text)
  yield* fs.remove(path.join(tenantDir, "records"), { recursive: true, force: true })
  yield* fs.remove(path.join(tenantDir, "memory"), { recursive: true, force: true })
  return deliveredFrom(lines, hookErrors)
}, Effect.mapError(toMemoryError))

export const makeHooksMemory = (options: HooksMemoryOptions): MemorySetup => {
  const beforeRun = Effect.fn("HooksMemory.beforeRun")(function*(_task: Task, _workspace: string, runDir?: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (runDir === undefined) {
      return yield* new MemoryError({ message: "the hooks setup hands memory over during a run; preview it with `handover --home`" })
    }
    yield* refuseInstalledHooks()
    const source = path.resolve(options.home)
    if (!(yield* fs.exists(path.join(source, "config.json")))) {
      return yield* new MemoryError({ message: `${source} isn't a memory home (it has no config.json)` })
    }
    const runHome = path.join(runDir, RUN_HOME)
    yield* fs.copy(source, runHome)
    const home = yield* loadHome(runHome)
    // The run's session starts with nothing from earlier sessions.
    for (const leftover of [path.join(home.tenantDir, "sessions"), path.join(home.tenantDir, "handovers.jsonl"), path.join(runHome, "hook-errors.log")]) {
      yield* fs.remove(leftover, { recursive: true, force: true })
    }
    const stores = Layer.merge(
      JsonRecordStore.layer(home.tenantDir, home.tenant),
      JsonMemoryStore.layer(path.join(home.tenantDir, "memory"), home.tenant)
    )
    const { version, sources } = yield* Effect.gen(function*() {
      const records = yield* (yield* RecordStore).find()
      const version = yield* (yield* MemoryStore).head()
      // The tasks memory learned from, so reports can tell exact repeats from similar tasks.
      const sources = [...new Set(records.flatMap((r) => (r.run.task_id === null ? [] : [r.run.task_id])))].sort()
      return { version, sources }
    }).pipe(Effect.provide(stores))
    const settings = path.join(runDir, HOOK_SETTINGS)
    yield* fs.writeFileString(settings, JSON.stringify(hooksSettings(process.execPath, HOOK_SCRIPT), null, 2) + "\n")
    return {
      systemPrompt: undefined,
      info: { memory: source, version, sources },
      args: ["--settings", settings],
      env: {
        SINGULARITY_HOOKS: "on",
        SINGULARITY_AUTOLEARN: "off",
        [HOME_ENV]: runHome,
        [CLAUDE_ENV]: JSON.stringify(options.claude),
        SINGULARITY_SELECTOR: "on",
        SINGULARITY_SELECTOR_MODEL: options.selectorModel
      },
      delivered: collect(runDir, runHome, home.tenantDir)
    } satisfies Injection
  }, Effect.mapError(toMemoryError))

  return { name: "hooks", beforeRun, afterRun: () => Effect.void }
}
