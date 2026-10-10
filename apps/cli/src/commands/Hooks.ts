/**
 * `node src/cli.ts hooks ...`: put the hooks into Claude Code's settings, or take
 * them out; and `node src/cli.ts handover TASK`: what a task would be handed.
 */
import { Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defaultClaude } from "../eval/Agent.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { DEFAULT_SELECTOR_MODEL } from "../eval/StepSelector.ts"
import { HOOK_SCRIPT, hasOurHooks, hooksSettings, withOurHooks, withoutOurHooks } from "../handover/Install.ts"
import { taskStart } from "../handover/TaskStart.ts"
import { loadHome } from "../local/Home.ts"
import { ReportError } from "../eval/Report.ts"
import { claudeHome } from "../traces/index.ts"
import { homeFlag, recordsLayer } from "./Common.ts"
import { memoryLayer } from "./Memory.ts"

const SCOPES = ["user", "project", "local"] as const

const Settings = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const scopeFlag = Flag.Literals("scope", SCOPES).pipe(
  Flag.withDefault("user"),
  Flag.withDescription("user: ~/.claude/settings.json (every session); project: <repo>/.claude/settings.json; local: <repo>/.claude/settings.local.json")
)
const repoFlag = Flag.String("repo").pipe(Flag.optional, Flag.withDescription("the repo, for project and local scope (default: here)"))

const settingsFile = Effect.fn("settingsFile")(function*(scope: (typeof SCOPES)[number], repo: Option.Option<string>) {
  const path = yield* Path.Path
  if (scope === "user") return path.join(yield* claudeHome, "settings.json")
  const root = path.resolve(Option.getOrElse(repo, () => "."))
  return path.join(root, ".claude", scope === "project" ? "settings.json" : "settings.local.json")
})

const readSettings = Effect.fn("readSettings")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(file))) return {} as Record<string, unknown>
  const text = yield* fs.readFileString(file)
  return yield* Schema.decodeUnknownEffect(Settings)(text.trim() === "" ? "{}" : text).pipe(
    Effect.mapError((e) => new ReportError({ message: `${file} isn't valid JSON settings: ${e.message}` }))
  )
})

const writeSettings = Effect.fn("writeSettings")(function*(file: string, settings: Record<string, unknown>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  // Keep the file as it was before the first change, once.
  const backup = `${file}.before-singularity`
  if ((yield* fs.exists(file)) && !(yield* fs.exists(backup))) yield* fs.copyFile(file, backup)
  yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(settings, null, 2) + "\n")
  yield* fs.rename(`${file}.tmp`, file)
})

const install = Command.make(
  "install",
  {
    scope: scopeFlag,
    repo: repoFlag,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("print the settings, change nothing"))
  },
  Effect.fn(function*(args) {
    const file = yield* settingsFile(args.scope, args.repo)
    const next = withOurHooks(yield* readSettings(file), process.execPath, HOOK_SCRIPT)
    if (args.dryRun) return yield* Console.log(`${file} would become:\n${JSON.stringify(next, null, 2)}`)
    yield* writeSettings(file, next)
    yield* Console.log(`hooks installed in ${file}`)
  })
).pipe(Command.withDescription("add the memory hooks to Claude Code's settings"))

const uninstall = Command.make(
  "uninstall",
  { scope: scopeFlag, repo: repoFlag },
  Effect.fn(function*(args) {
    const file = yield* settingsFile(args.scope, args.repo)
    const settings = yield* readSettings(file)
    if (!hasOurHooks(settings, HOOK_SCRIPT)) return yield* Console.log(`no memory hooks in ${file}`)
    yield* writeSettings(file, withoutOurHooks(settings, HOOK_SCRIPT))
    yield* Console.log(`hooks removed from ${file}`)
  })
).pipe(Command.withDescription("remove the memory hooks from Claude Code's settings"))

const print = Command.make(
  "print",
  {},
  Effect.fn(function*(_args) {
    yield* Console.log(JSON.stringify(hooksSettings(process.execPath, HOOK_SCRIPT), null, 2))
  })
).pipe(Command.withDescription("print the hook settings, e.g. for `claude --settings FILE`"))

const status = Command.make(
  "status",
  { repo: repoFlag },
  Effect.fn(function*(args) {
    for (const scope of SCOPES) {
      const file = yield* settingsFile(scope, args.repo)
      const on = hasOurHooks(yield* readSettings(file), HOOK_SCRIPT)
      yield* Console.log(`${scope.padEnd(8)} ${on ? "installed" : "-        "} ${file}`)
    }
  })
).pipe(Command.withDescription("where the memory hooks are installed"))

export const hooksCommand = Command.make("hooks").pipe(
  Command.withDescription("Claude Code hooks that hand memory over during sessions"),
  Command.withSubcommands([install, uninstall, print, status])
)

export const handoverCommand = Command.make(
  "handover",
  {
    task: Argument.String("task").pipe(Argument.variadic({ min: 1 }), Argument.withDescription("the task, as it would be asked")),
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("the repo it would run in (default: here)")),
    noModel: Flag.Boolean("no-model").pipe(Flag.withDefault(false), Flag.withDescription("word search only, no model to confirm")),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_SELECTOR_MODEL)),
    claude: Flag.String("claude").pipe(Flag.optional),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const selector = args.noModel
      ? undefined
      : {
        claude: Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude(),
        cwd: path.join(defaultWorkspaces(), "_learner"),
        model: args.model
      }
    const result = yield* taskStart(
      { sessionId: "preview", prompt: args.task.join(" "), cwd: path.resolve(Option.getOrElse(args.cwd, () => ".")) },
      { tenantDir: home.tenantDir, selector, persist: false }
    )
    const state = result.state
    if (state === undefined) return yield* Console.log("this directory isn't a repo memory knows")
    yield* Console.error(`proposed: ${(result.proposals ?? []).map((p) => `${p.kind} (${p.coverage})`).join(", ") || "none"}`)
    yield* Console.error(`kind: ${state.kind ?? "none"}; ${state.steps.length} steps, ${state.warnings.length} warnings at the start, ${state.triggers.length} warnings on triggers`)
    for (const r of result.reasons ?? []) yield* Console.error(`  ${r}`)
    const code = result.excerpts
    if (code !== undefined && code.shown.length + code.examples.length + code.leftOut > 0) {
      yield* Console.error(
        `code: ${code.shown.length} places in ${new Set(code.shown.map((e) => e.file)).size} files, ` +
          `${code.examples.length} files to read first, ${code.leftOut} left out for room; ${result.text?.length ?? 0} characters in all`
      )
    }
    if (state.selection?.error) yield* Console.error(`model call failed: ${state.selection.error}`)
    if (state.selection?.cost_usd != null) yield* Console.error(`selection cost $${state.selection.cost_usd.toFixed(4)}`)
    yield* Console.log(result.text === undefined ? "(nothing handed over)" : `\n${result.text}`)
  }, (effect, args) => Effect.provide(effect, Layer.merge(recordsLayer(args.home), memoryLayer(args.home))))
).pipe(Command.withDescription("show what memory would hand a task at its start, without running anything"))
