/**
 * The rules during the runs in PREREGISTRATION-local-memory.md, read from run
 * output directories (no new runs):
 *
 *     node apps/cli/examples/excalidraw/check-runs.ts runs/excalidraw/hooks-1-existing*
 *
 * One line per run: the outcome, tokens and cost; for the hooks setup, what
 * was handed over (the kind, the steps, the warnings at the start and those
 * whose trigger fired, the route selection's cost) and whether a hook failed;
 * and the longest shell command against its time limit. Claude Code stops a
 * command at the `timeout` the agent gives it, 2 minutes if it gives none; a
 * run with a command stopped that way is marked CUT OFF.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Path, Predicate, Schema } from "effect"
import { loadRecords } from "../../src/eval/Report.ts"
import { parseSession, SHELL_TOOLS, toolCallDuration } from "../../src/traces/index.ts"

/** Claude Code's limit for a shell command whose call gives none, in seconds. */
const DEFAULT_LIMIT_S = 120

const Run = Schema.Struct({
  run_id: Schema.String,
  setup: Schema.String,
  task_id: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  success: Schema.NullOr(Schema.Boolean),
  status: Schema.String,
  cost_usd: Schema.NullOr(Schema.Number),
  tokens: Schema.NullOr(Schema.Struct({ total: Schema.Number })),
  injection: Schema.optionalKey(Schema.Unknown)
})

const Hooks = Schema.Struct({
  task_start: Schema.Boolean,
  kind: Schema.NullOr(Schema.String),
  nodes: Schema.Array(Schema.String),
  warnings_at_start: Schema.Array(Schema.String),
  fired: Schema.Array(Schema.Struct({ warning: Schema.String, tool: Schema.NullOr(Schema.String) })),
  selection: Schema.NullOr(Schema.Struct({ cost_usd: Schema.NullOr(Schema.Number), error: Schema.NullOr(Schema.String) })),
  hook_errors: Schema.Number
})

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  let cut = 0
  let hookFailures = 0
  for (const dir of process.argv.slice(2)) {
    for (const record of yield* loadRecords([dir])) {
      const r = yield* Schema.decodeUnknownEffect(Run)(record)
      const parts = [
        r.run_id.padEnd(28),
        r.success === true ? "ok  " : r.success === false ? "FAIL" : r.status,
        `${Math.round((r.tokens?.total ?? 0) / 1000)}k`.padStart(6),
        `$${(r.cost_usd ?? 0).toFixed(3)}`
      ]
      const hooks = Schema.decodeUnknownOption(Hooks)(r.injection)
      if (hooks._tag === "Some") {
        const h = hooks.value
        const failed = !h.task_start || h.hook_errors > 0
        if (failed) hookFailures++
        parts.push(
          failed ? `HOOK FAILURE (start ${h.task_start}, errors ${h.hook_errors})` : "hooks ok",
          `kind ${h.kind?.replace(/^k-/, "") ?? "none"}`,
          `${h.nodes.length} steps`,
          `${h.warnings_at_start.length} warnings at start`,
          `fired ${h.fired.map((f) => f.warning).join(",") || "-"}`,
          h.selection?.error ? `selection FAILED: ${h.selection.error.slice(0, 80)}` : `selection $${(h.selection?.cost_usd ?? 0).toFixed(3)}`
        )
      }
      if (r.session_id !== undefined) {
        const trace = yield* parseSession(path.join(dir, "runs", r.run_id, "transcript", `${r.session_id}.jsonl`)).pipe(Effect.option)
        if (trace._tag === "Some") {
          let longest = { s: 0, limit: DEFAULT_LIMIT_S }
          let stopped = false
          for (const c of trace.value.toolCalls) {
            if (!SHELL_TOOLS.has(c.name)) continue
            const s = toolCallDuration(c) ?? 0
            const limit = Predicate.isNumber(c.input.timeout) ? c.input.timeout / 1000 : DEFAULT_LIMIT_S
            if (s > longest.s) longest = { s, limit }
            if (s >= limit - 1 || /\btimed out\b/i.test(c.result ?? "")) stopped = true
          }
          if (stopped) cut++
          parts.push(`longest command ${Math.round(longest.s)}s of ${Math.round(longest.limit)}s${stopped ? "  CUT OFF" : ""}`)
        }
      }
      yield* Console.log(parts.join("  "))
    }
  }
  yield* Console.log(`\n${cut} runs cut off by a command's time limit, ${hookFailures} with a hook failure`)
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
