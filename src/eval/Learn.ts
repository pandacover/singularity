/**
 * Feed finished runs into a memory setup, without running the agent again.
 *
 * Any run output directory works as a source of experience: a no-memory
 * baseline's successful runs are exactly the "successful traces" a memory setup
 * learns from.
 */
import { Effect, FileSystem, Path } from "effect"
import { parseSession } from "../traces/index.ts"
import type { RunRecord } from "./Report.ts"
import { loadRecords } from "./Report.ts"
import type { MemorySetup, Outcome } from "./Setups.ts"
import type { Suite } from "./Suite.ts"

/** Outcomes of recorded runs, in the order they ran. Skips tasks the suite no longer has. */
export const recordedOutcomes = Effect.fn("recordedOutcomes")(function*(
  suite: Suite,
  results: ReadonlyArray<string>,
  taskIds?: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const outcomes: Array<Outcome> = []
  for (const result of results) {
    const isDir = (yield* fs.stat(result)).type === "Directory"
    const outDir = isDir ? result : path.dirname(result)
    for (const rec of yield* loadRecords([result])) {
      if (taskIds?.length && !taskIds.includes(String(rec.task_id))) continue
      const task = suite.tasks.find((t) => t.id === rec.task_id)
      if (task === undefined) continue
      const runDir = path.join(outDir, "runs", String(rec.run_id))
      const diffPath = path.join(runDir, "diff.patch")
      const transcript = path.join(runDir, "transcript", `${String(rec.session_id)}.jsonl`)
      outcomes.push({
        task,
        success: successOf(rec),
        trace: (yield* fs.exists(transcript)) ? yield* parseSession(transcript) : undefined,
        // The Python harness wrote diffs in text mode, so on Windows they have
        // CRLF line endings; read them back as it did (universal newlines).
        diff: (yield* fs.exists(diffPath)) ? (yield* fs.readFileString(diffPath)).replace(/\r\n?/g, "\n") : ""
      })
    }
  }
  return outcomes
})

const successOf = (rec: RunRecord): boolean | null => (typeof rec.success === "boolean" ? rec.success : null)

/** Call `setup.afterRun` for each recorded run. Returns how many were fed in. */
export const learnFrom = Effect.fn("learnFrom")(function*(
  setup: MemorySetup,
  suite: Suite,
  results: ReadonlyArray<string>,
  taskIds?: ReadonlyArray<string>
) {
  const outcomes = yield* recordedOutcomes(suite, results, taskIds)
  for (const outcome of outcomes) yield* setup.afterRun(outcome)
  return outcomes.length
})
