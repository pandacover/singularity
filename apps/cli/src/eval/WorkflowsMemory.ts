/**
 * Memory v1 (workflows with blanks, src/workflows/) as a memory setup, handed
 * over by its own hooks as in a user's sessions, never through the system
 * prompt. It works like the v0 hooks setup (HooksMemory.ts):
 *
 * Before a run: copy the memory home (frozen for a measurement) into the
 * run's directory, so the session's state and the hand-over log stay with the
 * run and the home never changes; write Claude Code settings that run v1's
 * hooks (`--settings`); and point them at the copy. The agent gets the
 * workflows at its first prompt and a warning when a pitfall's trigger
 * appears. The hooks' model call, which picks the workflows, runs the same
 * Claude Code as the agent (`SINGULARITY_CLAUDE`) and counts toward the run.
 *
 * After the run: the hand-over log says what was handed over: the workflows,
 * the places shown (file and lines), the pitfalls at the start and those that
 * fired. The copied records and memory are removed again; the session's
 * files, the log and any hook errors stay, for learning from the run later.
 */
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { type HookSpec, hooksSettings } from "../handover/Install.ts"
import { HOME_ENV, loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { emptyUsage, type Usage } from "../traces/index.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import { CLAUDE_ENV } from "./Agent.ts"
import { HOOK_SETTINGS, RUN_HOME } from "./HooksMemory.ts"
import type { Delivered, Injection, MemorySetup } from "./Setups.ts"
import { addSpent, MemoryError } from "./Setups.ts"
import type { Task } from "./Suite.ts"

/** Memory v1's hook entry point. */
export const WORKFLOWS_HOOK_SCRIPT = fileURLToPath(new URL("../workflows/hook.ts", import.meta.url))

export interface WorkflowsMemoryOptions {
  /** The memory home to hand over from; never changed. */
  readonly home: string
  /** The Claude Code the agent runs, for the hooks' own model call. */
  readonly claude: ReadonlyArray<string>
  /** The model that picks the workflows, and drafts the change. */
  readonly selectorModel: string
  /** Hand over the change itself, drafted at task start (Draft.ts): the `workflows-draft` setup. */
  readonly draft?: boolean | undefined
  /**
   * Pick without a model, by memory's cues, and fill the blanks the task
   * states (Cues.ts): the `workflows-cues` setup.
   */
  readonly cues?: boolean | undefined
  /**
   * Hand over in up to two parts, through two task-start hooks, each up to
   * Claude Code's 10,000 characters (HookStart.ts): the `workflows-split` setup.
   */
  readonly parts?: number | undefined
}

/** The hook that hands over the second part of a long hand-over, alongside the first. */
const SECOND_PART: HookSpec = { event: "UserPromptSubmit", arg: "user-prompt-submit-2", matcher: undefined, timeout: 90 }

/** Seconds the task-start hook may take when it drafts the change: the selection's call, then the draft's. */
const DRAFT_HOOK_TIMEOUT = 420

const UsageJson = Schema.Struct({ input: Schema.Number, output: Schema.Number, cache_creation: Schema.Number, cache_read: Schema.Number })

/** The parts of v1's handovers.jsonl lines (Start.ts, HookTool.ts) a run's record uses. */
export const WorkflowHandoverLine = Schema.Struct({
  moment: Schema.String,
  version: Schema.optionalKey(Schema.Number),
  workflows: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, skip: Schema.Array(Schema.Number) }))),
  reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  shown: Schema.optionalKey(Schema.Array(Schema.Struct({ place: Schema.String, file: Schema.String, from: Schema.Number, to: Schema.Number }))),
  missing: Schema.optionalKey(Schema.Array(Schema.String)),
  pitfalls: Schema.optionalKey(Schema.Array(Schema.String)),
  selection: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    model: Schema.String,
    cost_usd: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String)
  }))),
  selection_tokens: Schema.optionalKey(Schema.NullOr(UsageJson)),
  draft: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    model: Schema.String,
    cost_usd: Schema.NullOr(Schema.Number),
    duration_s: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String),
    used: Schema.Boolean,
    edits: Schema.Number,
    files: Schema.Array(Schema.String),
    dropped: Schema.Array(Schema.String),
    unsure: Schema.Array(Schema.String)
  }))),
  draft_tokens: Schema.optionalKey(Schema.NullOr(UsageJson)),
  chars: Schema.optionalKey(Schema.Number),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool: Schema.optionalKey(Schema.String)
})
export type WorkflowHandoverLine = typeof WorkflowHandoverLine.Type

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowHandoverLine))

const usageOf = (u: typeof UsageJson.Type): Usage => ({
  input_tokens: u.input,
  output_tokens: u.output,
  cache_creation_input_tokens: u.cache_creation,
  cache_read_input_tokens: u.cache_read
})

/**
 * What a run was handed, from its hand-over log. `task_start` says whether
 * the task-start hook finished at all; `nodes` are the workflows handed over,
 * as reports expect of setups with steps.
 */
export const workflowsDeliveredFrom = (lines: ReadonlyArray<WorkflowHandoverLine>, hookErrors: number): Delivered => {
  const start = lines.find((l) => l.moment === "start")
  const fired = lines
    .filter((l) => l.moment === "trigger")
    .flatMap((l) => (l.pitfalls ?? []).map((pitfall) => ({ pitfall, tool: l.tool ?? null })))
  const cost = start?.selection?.cost_usd
  const draftCost = start?.draft?.cost_usd
  // The hooks' model calls count with the run: the selection's, and the draft's when there was one.
  const selectionSpent = cost === undefined || cost === null
    ? undefined
    : { costUsd: cost, usage: start?.selection_tokens ? usageOf(start.selection_tokens) : emptyUsage }
  const draftSpent = draftCost === undefined || draftCost === null
    ? undefined
    : { costUsd: draftCost, usage: start?.draft_tokens ? usageOf(start.draft_tokens) : emptyUsage }
  return {
    info: {
      task_start: start !== undefined,
      version: start?.version ?? null,
      nodes: (start?.workflows ?? []).map((w) => w.id),
      workflows: start?.workflows ?? [],
      reasons: start?.reasons ?? [],
      shown: start?.shown ?? [],
      missing: start?.missing ?? [],
      pitfalls_at_start: start?.pitfalls ?? [],
      fired,
      selection: start?.selection ?? null,
      ...(start?.draft === undefined ? {} : { draft: start.draft }),
      chars: start?.chars ?? 0,
      hook_errors: hookErrors
    },
    spent: addSpent(selectionSpent, draftSpent)
  }
}

const toMemoryError = (e: { readonly message: string }) =>
  e instanceof MemoryError ? e : new MemoryError({ message: `workflows memory: ${e.message}` })

/** After the run: what the hooks handed over, from the copy's log; then the copy's records and memory go. */
const collect = Effect.fn("WorkflowsMemory.collect")(function*(runDir: string, runHome: string, tenantDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const log = path.join(tenantDir, "workflows", "handovers.jsonl")
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
  for (const dir of ["versions", "candidates"]) yield* fs.remove(path.join(tenantDir, "workflows", dir), { recursive: true, force: true })
  yield* fs.remove(path.join(tenantDir, "workflows", "workflows.json"), { force: true })
  return workflowsDeliveredFrom(lines, hookErrors)
}, Effect.mapError(toMemoryError))

export const makeWorkflowsMemory = (options: WorkflowsMemoryOptions): MemorySetup => {
  const beforeRun = Effect.fn("WorkflowsMemory.beforeRun")(function*(_task: Task, _workspace: string, runDir?: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (runDir === undefined) {
      return yield* new MemoryError({ message: "the workflows setup hands memory over during a run; preview it with `workflows handover`" })
    }
    const source = path.resolve(options.home)
    if (!(yield* fs.exists(path.join(source, "config.json")))) {
      return yield* new MemoryError({ message: `${source} isn't a memory home (it has no config.json)` })
    }
    const runHome = path.join(runDir, RUN_HOME)
    yield* fs.copy(source, runHome)
    const home = yield* loadHome(runHome)
    // The run's session starts with nothing from earlier sessions.
    for (const leftover of [
      path.join(home.tenantDir, "workflows", "sessions"),
      path.join(home.tenantDir, "workflows", "handovers.jsonl"),
      path.join(runHome, "hook-errors.log")
    ]) {
      yield* fs.remove(leftover, { recursive: true, force: true })
    }
    const stores = Layer.merge(
      JsonRecordStore.layer(home.tenantDir, home.tenant),
      JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
    )
    const { version, sources } = yield* Effect.gen(function*() {
      const records = yield* (yield* RecordStore).find()
      const version = yield* (yield* WorkflowStore).head()
      // The tasks memory learned from, so reports can tell exact repeats from similar tasks.
      const sources = [...new Set(records.flatMap((r) => (r.run.task_id === null ? [] : [r.run.task_id])))].sort()
      return { version, sources }
    }).pipe(Effect.provide(stores))
    const settings = path.join(runDir, HOOK_SETTINGS)
    const hooks = hooksSettings(process.execPath, WORKFLOWS_HOOK_SCRIPT, options.parts === 2 ? [SECOND_PART] : [], true)
    yield* fs.writeFileString(settings, JSON.stringify(options.draft === true ? withStartTimeout(hooks, DRAFT_HOOK_TIMEOUT) : hooks, null, 2) + "\n")
    return {
      systemPrompt: undefined,
      info: { memory: source, version, sources },
      args: ["--settings", settings],
      env: {
        // Hooks installed for daily work stay off, with their own home; the run's own carry RUN_HOOK_FLAG.
        SINGULARITY_HOOKS: "off",
        SINGULARITY_AUTOLEARN: "off",
        [HOME_ENV]: runHome,
        [CLAUDE_ENV]: JSON.stringify(options.claude),
        SINGULARITY_SELECTOR: options.cues === true ? "cues" : "on",
        SINGULARITY_SELECTOR_MODEL: options.selectorModel,
        SINGULARITY_DRAFTER: options.draft === true ? "on" : "off",
        SINGULARITY_DRAFTER_MODEL: options.selectorModel,
        SINGULARITY_HANDOVER_PARTS: String(options.parts ?? 1)
      },
      delivered: collect(runDir, runHome, home.tenantDir)
    } satisfies Injection
  }, Effect.mapError(toMemoryError))

  const name = options.draft === true ? "workflows-draft" : options.parts === 2 ? "workflows-split" : options.cues === true ? "workflows-cues" : "workflows"
  return { name, beforeRun, afterRun: () => Effect.void }
}

/** The settings with the task-start hook given `seconds`. */
const withStartTimeout = (settings: Record<string, unknown>, seconds: number): Record<string, unknown> => {
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
  return {
    ...settings,
    hooks: {
      ...hooks,
      UserPromptSubmit: (hooks.UserPromptSubmit ?? []).map((e) => ({ ...e, hooks: e.hooks.map((h) => ({ ...h, timeout: seconds })) }))
    }
  }
}
