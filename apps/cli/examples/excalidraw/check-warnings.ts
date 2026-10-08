/**
 * The counts behind the warnings check in PREREGISTRATION.md, read from run
 * output directories (no new runs):
 *
 *     node apps/cli/examples/excalidraw/check-warnings.ts runs/excalidraw/saved-scripts-2-new*
 *
 * Per setup and task:
 *
 * - flag: runs that pass `--watch=false` to `yarn test:update`, which already
 *   passes it, so the command fails; out of the runs that ran `yarn test:update`.
 * - no handleKeyboardGlobally: runs whose first test in `excalidraw.test.tsx`
 *   (written with an edit tool or from the shell) renders `<Excalidraw>`
 *   without `handleKeyboardGlobally`, the trap the graph warns about: key
 *   presses sent to the document never arrive. Out of the runs that wrote one.
 *   A run can still get such a test to work another way, so this counts who
 *   knew up front, not who lost time.
 * - test files: runs that changed test files (snapshots aside), and which.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { loadRecords } from "../../src/eval/Report.ts"
import { splitDiff } from "../../src/eval/SavedScripts.ts"
import type { ToolCall } from "../../src/traces/index.ts"
import { parseSession, SHELL_TOOLS, SHELL_WRITE } from "../../src/traces/index.ts"

const RUNS_TEST_UPDATE = /\btest:update\b/
const DOUBLE_FLAG = /\btest:update\b[^|;&\n]*--watch=false/
const TEST_FILE = /\.test\.tsx?$/

const EditInput = Schema.Struct({
  file_path: Schema.String,
  new_string: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  edits: Schema.optional(Schema.Array(Schema.Struct({ new_string: Schema.String })))
})

/** The text a call writes into `excalidraw.test.tsx`, if it writes there: with an edit tool or a shell command. */
const writesTest = (c: ToolCall): Option.Option<string> => {
  if (SHELL_TOOLS.has(c.name)) {
    const command = String(c.input.command ?? "")
    return command.includes("excalidraw.test.tsx") && SHELL_WRITE.test(command) ? Option.some(command) : Option.none()
  }
  return Schema.decodeUnknownOption(EditInput)(c.input).pipe(
    Option.filter((e) => e.file_path.replace(/\\/g, "/").endsWith("/excalidraw.test.tsx")),
    Option.map((e) => [e.new_string ?? "", e.content ?? "", ...(e.edits ?? []).map((x) => x.new_string)].join("\n"))
  )
}

const Run = Schema.Struct({
  run_id: Schema.String,
  setup: Schema.String,
  task_id: Schema.String,
  session_id: Schema.String,
  success: Schema.NullOr(Schema.Boolean)
})

interface Row {
  runs: number
  ranTestUpdate: number
  flag: number
  wroteTest: number
  trap: number
  testFiles: Array<string>
}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const rows = new Map<string, Row>()
  for (const dir of process.argv.slice(2)) {
    for (const record of yield* loadRecords([dir])) {
      const r = yield* Schema.decodeUnknownEffect(Run)(record)
      const runDir = path.join(dir, "runs", r.run_id)
      const trace = yield* parseSession(path.join(runDir, "transcript", `${r.session_id}.jsonl`))
      const diffFile = path.join(runDir, "diff.patch")
      const diff = (yield* fs.exists(diffFile)) ? (yield* fs.readFileString(diffFile)).replace(/\r\n?/g, "\n") : ""
      const key = `${r.setup} ${r.task_id}`
      const row = rows.get(key) ?? { runs: 0, ranTestUpdate: 0, flag: 0, wroteTest: 0, trap: 0, testFiles: [] }
      rows.set(key, row)
      row.runs += 1
      const commands = trace.toolCalls.filter((c) => SHELL_TOOLS.has(c.name)).map((c) => String(c.input.command ?? ""))
      if (commands.some((c) => RUNS_TEST_UPDATE.test(c))) row.ranTestUpdate += 1
      if (commands.some((c) => DOUBLE_FLAG.test(c))) row.flag += 1
      const firstTest = trace.toolCalls.map(writesTest).filter(Option.isSome).find((t) => t.value.includes("<Excalidraw"))
      if (firstTest !== undefined) {
        row.wroteTest += 1
        if (!firstTest.value.includes("handleKeyboardGlobally")) row.trap += 1
      }
      const [files] = splitDiff(diff)
      const tests = files.filter((f) => TEST_FILE.test(f) && !f.includes("hidden-check"))
      if (tests.length > 0) row.testFiles.push(`${r.run_id}: ${tests.map((f) => path.basename(f)).join(", ")}`)
    }
  }
  for (const [key, row] of [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    yield* Console.log(
      `${key.padEnd(42)} runs ${row.runs}  flag ${row.flag} of ${row.ranTestUpdate}` +
        `  no handleKeyboardGlobally ${row.trap} of ${row.wroteTest}` +
        `  test files changed in ${row.testFiles.length}`
    )
    for (const t of row.testFiles) yield* Console.log(`    ${t}`)
  }
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
