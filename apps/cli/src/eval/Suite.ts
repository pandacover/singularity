/**
 * Evaluation suites, loaded from TOML.
 *
 * A suite is one source repo, how to run the agent, and a list of tasks. Example:
 *
 *     name = "toy"
 *     repo = "../.."              # relative to this file
 *     base = "017370d"            # default base commit for tasks
 *     setup = []                  # run in the workspace before each run, untimed
 *     keep = []                   # gitignored paths kept across resets, e.g. node_modules
 *     env = {}                    # extra environment for the agent and commands,
 *                                 # e.g. { VITEST_MAX_FORKS = "4" } to cap test workers
 *     command_timeout_s = 600     # for setup commands and checks
 *
 *     [agent]
 *     model = "haiku"
 *     max_budget_usd = 0.5
 *
 *     [[tasks]]
 *     id = "delete-graph"
 *     family = "graph-admin"      # tasks in one family are "similar"
 *     prompt = "..."
 *     checks = ["python -m pytest -q"]
 *     check_files = "hidden/delete_graph"   # copied over the workspace before checks
 *
 * Unknown keys are errors, so a typo doesn't silently fall back to a default.
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { parse as parseToml } from "smol-toml"

export const DEFAULT_ALLOWED_TOOLS = ["Bash", "PowerShell", "Read", "Edit", "Write", "Glob", "Grep"]

export class SuiteError extends Schema.TaggedError<SuiteError>()("SuiteError", {
  message: Schema.String
}) {}

export interface AgentConfig {
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly permissionMode: string
  readonly allowedTools: ReadonlyArray<string>
  readonly disallowedTools: ReadonlyArray<string>
  readonly maxTurns: number | undefined
  readonly maxBudgetUsd: number | undefined
  readonly timeoutS: number
  /** Passed to `claude` as-is, e.g. ["--safe-mode"]. */
  readonly extraArgs: ReadonlyArray<string>
}

export interface Task {
  readonly id: string
  readonly prompt: string
  readonly base: string
  /** Tasks in one family are "similar". */
  readonly family: string | undefined
  readonly checks: ReadonlyArray<string>
  /** Copied over the workspace after the agent finishes and before checks run, so tests the agent never saw can't be edited to pass. */
  readonly checkFiles: string | undefined
}

export interface Suite {
  readonly name: string
  /** Absolute path of the suite file. */
  readonly path: string
  /** Absolute path of the source repo. */
  readonly repo: string
  readonly tasks: ReadonlyArray<Task>
  readonly agent: AgentConfig
  readonly setup: ReadonlyArray<string>
  readonly keep: ReadonlyArray<string>
  readonly commandTimeoutS: number
  /** Set for the agent and for setup and check commands, on top of the harness's own environment. */
  readonly env: Readonly<Record<string, string>>
}

const Strings = Schema.Array(Schema.String)

const AgentFile = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  permission_mode: Schema.optionalKey(Schema.String),
  allowed_tools: Schema.optionalKey(Strings),
  disallowed_tools: Schema.optionalKey(Strings),
  max_turns: Schema.optionalKey(Schema.Int),
  max_budget_usd: Schema.optionalKey(Schema.Number),
  timeout_s: Schema.optionalKey(Schema.Number),
  extra_args: Schema.optionalKey(Strings)
})

const TaskFile = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  base: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Strings),
  check_files: Schema.optionalKey(Schema.String)
})

const SuiteFile = Schema.Struct({
  name: Schema.String,
  repo: Schema.String,
  base: Schema.optionalKey(Schema.String),
  setup: Schema.optionalKey(Strings),
  keep: Schema.optionalKey(Strings),
  command_timeout_s: Schema.optionalKey(Schema.Number),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
  agent: Schema.optionalKey(AgentFile),
  tasks: Schema.optionalKey(Schema.Array(TaskFile))
})

export const loadSuite = Effect.fn("loadSuite")(function*(suitePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.resolve(suitePath)
  const fail = (message: string) => new SuiteError({ message: `${file}: ${message}` })

  const text = yield* fs.readFileString(file).pipe(Effect.mapError((e) => fail(e.message)))
  const raw = yield* Effect.try({ try: () => parseToml(text), catch: (e) => fail(`invalid TOML: ${String(e)}`) })
  const s = yield* Schema.decodeUnknownEffect(SuiteFile)(raw, { onExcessProperty: "error", errors: "all" }).pipe(
    Effect.mapError((e) => fail(e.message))
  )
  const here = path.dirname(file)

  const tasks: Array<Task> = []
  for (const [i, t] of (s.tasks ?? []).entries()) {
    const base = t.base ?? s.base
    if (base === undefined) return yield* fail(`tasks[${i}]: no 'base' commit, and the suite has no default`)
    let checkFiles: string | undefined
    if (t.check_files !== undefined) {
      checkFiles = path.join(here, t.check_files)
      const isDir = yield* fs.stat(checkFiles).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false)
      )
      if (!isDir) return yield* fail(`tasks[${i}]: check_files ${checkFiles} is not a directory`)
    }
    tasks.push({
      id: t.id,
      // Python's tomllib turns CRLF in multi-line strings into LF; smol-toml
      // keeps it. Normalize, so prompts don't depend on the file's line endings.
      prompt: t.prompt.replace(/\r\n?/g, "\n").trim(),
      base,
      family: t.family,
      checks: t.checks ?? [],
      checkFiles
    })
  }
  const ids = tasks.map((t) => t.id)
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort()
  if (dupes.length > 0) return yield* fail(`duplicate task ids: ${dupes.join(", ")}`)
  if (tasks.length === 0) return yield* fail("suite has no tasks")

  const a = s.agent ?? {}
  return {
    name: s.name,
    path: file,
    repo: path.resolve(here, s.repo),
    tasks,
    agent: {
      model: a.model,
      effort: a.effort,
      permissionMode: a.permission_mode ?? "acceptEdits",
      allowedTools: a.allowed_tools ?? DEFAULT_ALLOWED_TOOLS,
      disallowedTools: a.disallowed_tools ?? [],
      maxTurns: a.max_turns,
      maxBudgetUsd: a.max_budget_usd,
      timeoutS: a.timeout_s ?? 1800,
      extraArgs: a.extra_args ?? []
    },
    setup: s.setup ?? [],
    keep: s.keep ?? [],
    commandTimeoutS: s.command_timeout_s ?? 600,
    env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v)]))
  } satisfies Suite
})

export const suiteTask = (suite: Suite, taskId: string): Effect.Effect<Task, SuiteError> => {
  const task = suite.tasks.find((t) => t.id === taskId)
  return task === undefined
    ? Effect.fail(new SuiteError({ message: `no task ${JSON.stringify(taskId)} in suite ${JSON.stringify(suite.name)}` }))
    : Effect.succeed(task)
}
