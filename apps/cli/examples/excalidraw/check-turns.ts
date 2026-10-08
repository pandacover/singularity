/**
 * Where a run's turns go, read from run output directories (no new runs):
 *
 *     node apps/cli/examples/excalidraw/check-turns.ts runs/excalidraw/hooks-1-existing* [--task toggle-rulers]
 *
 * One line per run: its turns (model responses) and tokens; the turns it took
 * before its first edit (an edit tool, or a shell command that writes files),
 * which is the looking around; its edits that failed, by file; and, for the
 * toggle tasks, whether its first turn already searched for an existing
 * toggle. Then the medians per group of runs (a directory and its lanes) and
 * task.
 *
 * For runs of the hooks setup, a second line: whether the hand-over arrived
 * whole (Claude Code cuts a hook's text at 10,000 characters and puts a file
 * path in its place), and which of the files whose lines it was shown the
 * run read or searched anyway.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { median } from "../../src/eval/PyFormat.ts"
import { loadRecords } from "../../src/eval/Report.ts"
import { EDIT_TOOLS, parseSession, READ_TOOLS, SEARCH_TOOLS, SHELL_TOOLS, SHELL_WRITE, type ToolCall, usageTotal } from "../../src/traces/index.ts"

const Run = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  success: Schema.NullOr(Schema.Boolean)
})

/** A transcript line holding what a hook handed the model. */
const HookContext = Schema.Struct({
  type: Schema.Literal("attachment"),
  attachment: Schema.Struct({
    type: Schema.Literal("hook_additional_context"),
    content: Schema.Array(Schema.String),
    hookEvent: Schema.optionalKey(Schema.String)
  })
})
const decodeHookContext = Schema.decodeUnknownOption(Schema.fromJsonString(HookContext))

/** The start line of a run's hand-over log (TaskStart.ts). */
const Handover = Schema.Struct({
  moment: Schema.Literal("start"),
  text: Schema.NullOr(Schema.String),
  excerpts: Schema.optionalKey(Schema.Array(Schema.Struct({ file: Schema.String }))),
  examples: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String, whole: Schema.Boolean })))
})
const decodeHandover = Schema.decodeUnknownOption(Schema.fromJsonString(Handover))

const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() !== "")

/** An existing toggle of excalidraw's, by one of its names: what a run looks for to copy from. */
const EXISTING_TOGGLE = /actionToggle[A-Z]\w+|\b(zenMode|viewMode|gridMode|objectsSnapMode)(Enabled)?\b|\b(showStats|toggleStats)\b/

const isEdit = (c: ToolCall): boolean =>
  EDIT_TOOLS.has(c.name) || (SHELL_TOOLS.has(c.name) && typeof c.input.command === "string" && SHELL_WRITE.test(c.input.command))

const baseName = (file: unknown): string => String(file ?? "?").split(/[\\/]/).pop() ?? "?"

interface Row {
  readonly group: string
  readonly task: string
  readonly turns: number
  readonly tokens: number
  readonly look: number
  readonly failedEdits: number
}

const flags = process.argv.slice(2)
const taskAt = flags.indexOf("--task")
const onlyTask = taskAt >= 0 ? flags[taskAt + 1] : undefined
const dirs = flags.filter((f, i) => f !== "--task" && (taskAt < 0 || i !== taskAt + 1))

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const rows: Array<Row> = []
  for (const dir of dirs) {
    const group = path.basename(dir).replace(/-lane\d+$/, "")
    for (const record of yield* loadRecords([dir])) {
      const r = yield* Schema.decodeUnknownEffect(Run)(record)
      if (r.session_id === undefined || (onlyTask !== undefined && r.task_id !== onlyTask)) continue
      const trace = yield* parseSession(path.join(dir, "runs", r.run_id, "transcript", `${r.session_id}.jsonl`)).pipe(Effect.option)
      if (trace._tag === "None") continue
      const calls = new Map(trace.value.toolCalls.map((c) => [c.id, c]))
      const turns = trace.value.responses
        .filter((x) => x.agentId === undefined)
        .map((x) => ({ tokens: usageTotal(x.usage), calls: x.toolCallIds.flatMap((id) => calls.get(id) ?? []) }))
      const firstEdit = turns.findIndex((t) => t.calls.some(isEdit))
      const failed = turns.flatMap((t) => t.calls.filter((c) => EDIT_TOOLS.has(c.name) && c.isError).map((c) => baseName(c.input.file_path)))
      const byFile = [...new Set(failed)].map((f) => `${f} x${failed.filter((x) => x === f).length}`)
      const first = turns[0]?.calls.some((c) => EXISTING_TOGGLE.test(`${c.input.pattern ?? ""} ${c.input.file_path ?? ""} ${c.input.command ?? ""}`)) ?? false
      const row: Row = {
        group,
        task: r.task_id,
        turns: turns.length,
        tokens: turns.reduce((n, t) => n + t.tokens, 0),
        look: firstEdit < 0 ? turns.length : firstEdit,
        failedEdits: failed.length
      }
      rows.push(row)
      yield* Console.log([
        r.run_id.padEnd(28),
        r.success === true ? "ok  " : "FAIL",
        `${row.turns} turns`.padStart(9),
        `${Math.round(row.tokens / 1000)}k`.padStart(6),
        `${firstEdit < 0 ? "no edit seen" : `${row.look} turns before the first edit`}`.padEnd(30),
        `failed edits: ${byFile.join(", ") || "-"}`.padEnd(34),
        r.task_id.startsWith("toggle-") ? `first turn looks for an existing toggle: ${first ? "yes" : "no"}` : ""
      ].join("  "))

      // The hooks setup keeps its hand-over log with the run.
      const runDir = path.join(dir, "runs", r.run_id)
      const tenants = path.join(runDir, "memory-home", "tenants")
      const tenantNames = yield* fs.readDirectory(tenants).pipe(Effect.orElseSucceed(() => [] as Array<string>))
      for (const tenant of tenantNames) {
        const log = yield* fs.readFileString(path.join(tenants, tenant, "handovers.jsonl")).pipe(Effect.option)
        const start = Option.isNone(log) ? undefined : lines(log.value).flatMap((l) => Option.toArray(decodeHandover(l)))[0]
        if (start === undefined || start.text === null) continue
        const transcript = yield* fs.readFileString(path.join(runDir, "transcript", `${r.session_id}.jsonl`))
        const arrived = lines(transcript)
          .flatMap((l) => Option.toArray(decodeHookContext(l)))
          .filter((a) => a.attachment.hookEvent === "UserPromptSubmit")
          .map((a) => a.attachment.content.join("\n"))
        const whole = arrived.some((text) => text.trim() === start.text!.trim())
        const shown = [...new Set([...(start.excerpts ?? []).map((e) => e.file), ...(start.examples ?? []).filter((e) => e.whole).map((e) => e.path)])]
        // A read or a search of a file whose lines the run already had.
        const looked = (c: ToolCall) => {
          const target = String(c.input.file_path ?? c.input.path ?? "").replace(/\\/g, "/").toLowerCase()
          return (READ_TOOLS.has(c.name) || SEARCH_TOOLS.has(c.name)) ? shown.find((f) => target.endsWith(f.toLowerCase())) : undefined
        }
        const again = [...new Set(turns.flatMap((t) => t.calls.flatMap((c) => looked(c) ?? [])))]
        yield* Console.log(
          `${"".padEnd(28)}  handed ${start.text.length} characters, ${whole ? "arrived whole" : `NOT WHOLE (arrived: ${arrived.map((a) => a.length).join(", ") || "nothing"})`}; ` +
            `code of ${shown.length} files shown` +
            (shown.length === 0 ? "" : `, ${again.length} of them read or searched anyway${again.length > 0 ? `: ${again.map(baseName).join(", ")}` : ""}`)
        )
      }
    }
  }
  yield* Console.log("\nMedians (min-max):")
  const show = (xs: ReadonlyArray<number>, unit = "") => `${Math.round(median([...xs]))}${unit} (${Math.round(Math.min(...xs))}-${Math.round(Math.max(...xs))}${unit})`
  for (const key of [...new Set(rows.map((r) => `${r.group}\u0000${r.task}`))]) {
    const [group, task] = key.split("\u0000")
    const rs = rows.filter((r) => r.group === group && r.task === task)
    yield* Console.log(
      `${group.padEnd(26)} ${task.padEnd(18)} ${rs.length} runs: ${show(rs.map((r) => r.turns))} turns, ` +
        `${show(rs.map((r) => r.tokens / 1000), "k")} tokens, ${show(rs.map((r) => r.look))} turns before the first edit, ` +
        `${rs.filter((r) => r.failedEdits > 0).length} of ${rs.length} runs with a failed edit`
    )
  }
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
