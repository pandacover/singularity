/**
 * How well memory v1's places fit each task, from recorded runs (no new runs):
 *
 *     node apps/cli/examples/excalidraw/check-v1-places.ts --repo REPO [--memory HOME] [--records HOME] [--no-model | --cues] [--verbose]
 *
 * For each task with successful no-memory runs (in the `--records` home,
 * default ~/.singularity), memory v1 (the head of the `--memory` home)
 * picks the workflows the task needs, as at task start (a model call, about
 * two cents; `--no-model` picks by words, `--cues` by memory's cues, both
 * without a model; with `--verbose`, `--cues` also lists the blanks it
 * fills), and each of the task's runs is
 * compared with the places it would have been shown, in the code at the run's
 * base commit:
 *
 * - edited: the places the run's edits went (Places.ts), new files included;
 * - shown and edited: of those, the ones the hand-over showed;
 * - missed: edited but not shown, told apart by whether memory has the place
 *   at all or only didn't pick it for this task;
 * - shown, unused: places shown that the run left alone: what this task
 *   didn't need, or must not do.
 *
 * Memory built from the seed tasks has not seen the other tasks' runs, so for
 * them this is a held-out check.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Path } from "effect"
import { homedir } from "node:os"
import { defaultClaude } from "../../src/eval/Agent.ts"
import { median } from "../../src/eval/PyFormat.ts"
import { defaultWorkspaces } from "../../src/eval/Runner.ts"
import { fileAt } from "../../src/local/Git.ts"
import { loadHome } from "../../src/local/Home.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { gatherEvidence, shapeOf } from "../../src/workflows/Evidence.ts"
import { describePlace } from "../../src/workflows/Induce.ts"
import * as JsonWorkflowStore from "../../src/workflows/JsonWorkflowStore.ts"
import { resolvePlace } from "../../src/workflows/Places.ts"
import { cueChoice, fillsFor } from "../../src/workflows/Cues.ts"
import { selectWorkflows } from "../../src/workflows/Select.ts"
import { forSubject } from "../../src/workflows/Start.ts"
import { WorkflowStore } from "../../src/workflows/WorkflowStore.ts"

const args = process.argv.slice(2)
const valueOf = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]] : []))[0]
const repoArg = valueOf("--repo")
const memoryArg = valueOf("--memory") ?? "runs/excalidraw/memory/v1-seed"
const recordsArg = valueOf("--records") ?? `${homedir()}/.singularity`
const noModel = args.includes("--no-model")
const byCues = args.includes("--cues")
const thinking = args.includes("--thinking")
const verbose = args.includes("--verbose")
const only = args.flatMap((a, i) => (a === "--task" && args[i + 1] !== undefined ? [args[i + 1]] : []))

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (repoArg === undefined) return yield* Console.error("--repo REPO: a clone of the runs' repo, to read files at their base commit")
  const memoryHome = yield* loadHome(memoryArg)
  const recordsHome = yield* loadHome(recordsArg)
  const all = yield* Effect.gen(function*() {
    return yield* (yield* WorkflowStore).memory()
  }).pipe(Effect.provide(JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(memoryHome.tenantDir, path), memoryHome.tenant)))
  const records = (yield* Effect.gen(function*() {
    return yield* (yield* RecordStore).find({ outcome: "success" })
  }).pipe(Effect.provide(JsonRecordStore.layer(recordsHome.tenantDir, recordsHome.tenant))))
    .filter((r) => r.run.setup === "no-memory" && r.run.task_id !== null)

  const learned = new Set(all.workflows.flatMap((w) => w.tasks))
  const cwd = path.join(defaultWorkspaces(), "_learner")
  yield* fs.makeDirectory(cwd, { recursive: true })
  const selector = noModel || byCues ? undefined : { claude: yield* defaultClaude(), cwd, model: "sonnet", thinking }
  const tasks = [...new Set(records.map((r) => r.run.task_id!))].filter((t) => only.length === 0 || only.includes(t)).sort()
  yield* Console.log(`memory: ${all.workflows.length} workflows from ${[...learned].join(", ")}; ${records.length} no-memory runs of ${tasks.length} tasks\n`)

  const summary: Array<string> = []
  let spent = 0
  for (const task of tasks) {
    const runs = records.filter((r) => r.run.task_id === task)
    const memory = forSubject(all, runs[0].subject)
    const selection = byCues
      ? { chosen: cueChoice(memory, runs[0].task.prompt), call: null, reasons: [] }
      : yield* selectWorkflows(memory, runs[0].task.prompt, selector)
    if (verbose && byCues) {
      for (const c of selection.chosen) {
        const filled = [...fillsFor(runs[0].task.prompt, c.workflow)].map(([b, v]) => `${b}=${v}`).join(", ")
        yield* Console.log(`   ${task}: ${c.workflow.id}${c.skip.length > 0 ? ` (skip ${c.skip.join(", ")})` : ""}${filled ? `; fills ${filled}` : ""}`)
      }
    }
    spent += selection.call?.costUsd ?? 0
    const places = new Map(memory.places.map((p) => [p.id, p]))
    const chosenPlaces = [...new Set(selection.chosen.flatMap((c) =>
      c.workflow.steps.flatMap((s, i) => (c.skip.includes(i + 1) || s.place === null ? [] : [s.place]))
    ))]
    const evidence = yield* gatherEvidence(runs, { repo: repoArg })
    const rows: Array<{ edited: number; hit: number; missedKnown: number; missedNew: number; unused: number }> = []
    const unusedCount = new Map<string, number>()
    const missedCount = new Map<string, number>()
    for (const run of evidence.runs) {
      // A place is shown only if the code at the run's base has it.
      const shown = new Set<string>()
      for (const id of chosenPlaces) {
        const p = places.get(id)!
        if (p.new_file !== null) {
          shown.add(id)
          continue
        }
        const text = run.base === null ? undefined : yield* fileAt(repoArg, run.base, p.file)
        if (text !== undefined && resolvePlace(text.split("\n"), shapeOf(p)) !== undefined) shown.add(id)
      }
      const edited = new Set(run.uses.map((u) => u.place))
      const hit = [...edited].filter((id) => shown.has(id))
      const missed = [...edited].filter((id) => !shown.has(id))
      const unused = [...shown].filter((id) => !edited.has(id))
      for (const id of unused) unusedCount.set(id, (unusedCount.get(id) ?? 0) + 1)
      for (const id of missed) missedCount.set(id, (missedCount.get(id) ?? 0) + 1)
      rows.push({
        edited: edited.size,
        hit: hit.length,
        missedKnown: missed.filter((id) => places.has(id)).length,
        missedNew: missed.filter((id) => !places.has(id)).length,
        unused: unused.length
      })
    }
    if (rows.length === 0) continue
    const med = (f: (r: (typeof rows)[number]) => number) => Math.round(median(rows.map(f)))
    const kind = learned.has(task) ? "learned from" : "held out"
    const line = `${task.padEnd(18)} ${kind.padEnd(12)} ${rows.length} runs: edited ${med((r) => r.edited)} places, ` +
      `${med((r) => r.hit)} shown; missed ${med((r) => r.missedKnown)} memory has + ${med((r) => r.missedNew)} it doesn't; ` +
      `shown but unused ${med((r) => r.unused)}`
    summary.push(line)
    yield* Console.log(line)
    yield* Console.log(`   workflows: ${selection.chosen.map((c) => c.workflow.id + (c.skip.length > 0 ? ` (skip ${c.skip.join(",")})` : "")).join(", ") || "none"}`)
    const allPlaces = new Map(evidence.places.map((p) => [p.id, p]))
    const describe = (id: string) => {
      const p = places.get(id) ?? allPlaces.get(id)
      return p === undefined ? id : describePlace(p)
    }
    const always = (m: Map<string, number>) => [...m.entries()].filter(([, n]) => n * 2 > rows.length)
    for (const [id] of always(unusedCount)) yield* Console.log(`   shown, unused in most runs: ${describe(id)}`)
    for (const [id] of always(missedCount)) yield* Console.log(`   missed in most runs (${places.has(id) ? "memory has it" : "memory lacks it"}): ${describe(id)}`)
    if (verbose) for (const r of selection.reasons) yield* Console.log(`   # ${r}`)
    yield* Console.log("")
  }
  yield* Console.log("Medians per task:")
  for (const line of summary) yield* Console.log(line)
  if (spent > 0) yield* Console.log(`\nselection calls: $${spent.toFixed(3)}`)
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
