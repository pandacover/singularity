/**
 * How well the places memory learns from some tasks fit another task, read
 * from the records of a memory home (no new runs, no model; the home is only
 * read):
 *
 *     node examples/excalidraw/check-places.ts --repo REPO [--home HOME] [--from TASK ...] [--verbose]
 *
 * For each task with read no-memory runs, memory is built from the records of
 * the other tasks only (all of them, or only the `--from` tasks), and each of
 * the task's runs is compared with the places that memory would have shown it
 * (handover/Excerpts.ts), in the code at the run's base commit:
 *
 * - at the lines shown: of the blocks the run added to files that were there,
 *   how many went in at a place it would have been shown;
 * - in the same list: how many more went into the list or block such a place
 *   sits in, at other lines (the run chose another neighbour: any line of the
 *   list would do);
 * - not shown: the rest, which the agent would still have had to read for;
 * - left alone: places shown in lists the run added nothing to: what this
 *   task must not do.
 *
 * The steps handed over are the route's required steps and the optional ones
 * the run needed, as in the replay check (memory/Replay.ts). Lines a run
 * changed or removed are the task's own target, which no other task shares;
 * they are counted apart, as are the files it created.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { median } from "../../src/eval/PyFormat.ts"
import { findPlaces, type SpotSource } from "../../src/handover/Excerpts.ts"
import { fileAt } from "../../src/local/Git.ts"
import { loadHome } from "../../src/local/Home.ts"
import { applyAliases, readAliases } from "../../src/memory/Aliases.ts"
import { buildGraph, kindIdOf, kindNames, stepIdOf } from "../../src/memory/Build.ts"
import { withSpots } from "../../src/memory/Merge.ts"
import { diffFiles, isSnapshot } from "../../src/records/Extract.ts"
import { WorkflowRecord } from "../../src/records/Models.ts"

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRecord))

const args = process.argv.slice(2)
const valuesOf = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]] : []))
const homeArg = valuesOf("--home")[0]
const repoArg = valuesOf("--repo")[0]
const from = valuesOf("--from")
const verbose = args.includes("--verbose")

/** What a run did to the files that were there: where it added blocks, and how many blocks it changed. */
interface Edits {
  /**
   * For each added block: the number (from 1) of the last line before it that
   * was there already (0 at the top), and how far its first line is indented.
   */
  readonly added: Array<{ readonly file: string; readonly after: number; readonly indent: number }>
  readonly changed: number
  readonly created: number
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * The line that opens the list or block a line at `indent` would sit in, going
 * up from `index` (from 0): the nearest line indented less. -1 at the top level.
 */
const openerOf = (lines: ReadonlyArray<string>, index: number, indent: number): number => {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
    if (lines[i].trim() !== "" && indentOf(lines[i]) < indent) return i
  }
  return -1
}

const editsOf = (diff: string): Edits => {
  const added: Array<{ file: string; after: number; indent: number }> = []
  let changed = 0
  let created = 0
  for (const { path, lines } of diffFiles(diff)) {
    if (isSnapshot(path)) continue
    const firstHunk = lines.findIndex((l) => l.startsWith("@@"))
    if (firstHunk < 0) continue
    const head = lines.slice(0, firstHunk)
    if (head.some((l) => l.startsWith("new file mode"))) created++
    if (head.some((l) => /^(new file mode|deleted file mode|rename from|GIT binary patch|Binary files)/.test(l))) continue
    let base = 0
    let previous = " "
    let block: { after: number; indent: number; changes: boolean } | undefined
    const close = (next: string) => {
      if (block === undefined) return
      if (block.changes || next === "-") changed++
      else added.push({ file: path, after: block.after, indent: Math.max(0, block.indent) })
      block = undefined
    }
    for (const l of lines.slice(head.length)) {
      const header = /^@@ -(\d+)/.exec(l)
      if (header !== null) {
        close(" ")
        base = Number(header[1]) - 1
        previous = " "
        continue
      }
      if (l.startsWith("\\")) continue
      const tag = l[0] === "+" || l[0] === "-" ? l[0] : " "
      if (tag === "+") {
        if (block === undefined) block = { after: base, indent: -1, changes: previous === "-" }
        // A block is as deep as its first line that isn't blank.
        if (block.indent < 0 && l.slice(1).trim() !== "") block.indent = indentOf(l.slice(1))
      } else {
        close(tag)
        base++
      }
      previous = tag
    }
    close(" ")
  }
  return { added, changed, created }
}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* loadHome(homeArg)
  const stored: Array<WorkflowRecord> = []
  const recordsDir = path.join(home.tenantDir, "records")
  for (const subject of yield* fs.readDirectory(recordsDir)) {
    for (const name of yield* fs.readDirectory(path.join(recordsDir, subject))) {
      if (name.endsWith(".json")) stored.push(yield* decodeRecord(yield* fs.readFileString(path.join(recordsDir, subject, name))))
    }
  }
  const aliases = yield* readAliases(path.join(home.tenantDir, "memory"))
  const records = yield* withSpots(applyAliases(stored, aliases))
  const read = records.filter((r) => r.model !== null && r.run.outcome === "success")
  const kindOf = kindNames(read)

  const texts = new Map<string, ReadonlyArray<string> | undefined>()
  const linesAt = Effect.fnUntraced(function*(repo: string, commit: string, file: string) {
    const key = `${commit} ${file}`
    if (!texts.has(key)) texts.set(key, (yield* fileAt(repo, commit, file))?.split("\n"))
    return texts.get(key)
  })

  const tasks = [...new Set(read.filter((r) => r.run.setup === "no-memory" && r.run.task_id !== null).map((r) => r.run.task_id!))].sort()
  yield* Console.log(
    `${read.length} read records of ${new Set(read.map((r) => r.run.task_id)).size} tasks. ` +
      `For each task, memory is built from ${from.length > 0 ? from.join(", ") : "every other task"}, never from the task's own runs.\n`
  )
  const summary: Array<string> = []
  for (const task of tasks) {
    const memory = read.filter((r) => r.run.task_id !== task && (from.length === 0 || (r.run.task_id !== null && from.includes(r.run.task_id))))
    const graph = buildGraph(memory, { tenant: home.tenant })
    const runs = read.filter((r) => r.run.task_id === task && r.run.setup === "no-memory")
    const rows: Array<{ added: number; exact: number; near: number; places: number; alone: number; changed: number; created: number }> = []
    const aloneNames = new Map<string, number>()
    for (const r of runs) {
      const kind = graph.kinds.find((k) => k.id === kindIdOf(kindOf.get(r.id) ?? r.model!.kind.name))
      const diffFile = r.run.run_dir === null || r.run.run_id === null ? undefined : path.join(r.run.run_dir, "runs", r.run.run_id, "diff.patch")
      const repo = repoArg ?? r.run.repo
      if (diffFile === undefined || repo === null || r.run.base_commit === null) continue
      const edits = editsOf(yield* fs.readFileString(diffFile))
      /** A place shown, and the lines that open the lists or blocks its spots sit in. */
      const places: Array<{ file: string; from: number; to: number; openers: Set<number> }> = []
      if (kind !== undefined) {
        const needed = new Set(r.model!.steps.filter((s) => s.origin !== "chosen").map((s) => stepIdOf(s.name)))
        const handed = kind.route.filter((e) => e.required || needed.has(e.step)).map((e) => e.step)
        const ofKind = new Set(kind.evidence)
        const spots: Array<SpotSource> = []
        handed.forEach((id, i) => {
          const step = graph.steps.find((s) => s.id === id)
          const place = step?.where[r.subject]
          if (step === undefined || place === undefined) return
          const stepRuns = step.evidence.filter((e) => ofKind.has(e)).length
          for (const s of place.spots ?? []) {
            const seen = s.records.filter((e) => ofKind.has(e))
            if (seen.length > 0) spots.push({ step: i + 1, file: s.file, above: s.above, below: s.below, records: seen, runs: stepRuns })
          }
        })
        for (const file of new Set(spots.map((s) => s.file))) {
          const lines = yield* linesAt(repo, r.run.base_commit, file)
          if (lines === undefined) continue
          for (const p of findPlaces(file, lines, spots.filter((s) => s.file === file))) {
            // The spots' own lines: what is shown, less the line of context on each side.
            const inner = p.to - p.from >= 2 ? { from: p.from + 1, to: p.to - 1 } : p
            const openers = new Set<number>()
            for (let i = inner.from; i <= inner.to; i++) if (lines[i].trim() !== "") openers.add(openerOf(lines, i - 1, indentOf(lines[i])))
            places.push({ file, from: p.from, to: p.to, openers })
          }
        }
      }
      // An added block is at a place when it went in between, or right next to, the lines shown;
      // in the same list when the same line opens both. (Everything at a file's top level is one list.)
      const openers = new Map<(typeof edits.added)[number], number>()
      for (const e of edits.added) {
        const lines = yield* linesAt(repo, r.run.base_commit, e.file)
        if (lines !== undefined) openers.set(e, openerOf(lines, e.after - 1, e.indent))
      }
      const atLines = (e: (typeof edits.added)[number]) => places.filter((p) => p.file === e.file && e.after >= p.from && e.after <= p.to + 1)
      const inList = (e: (typeof edits.added)[number]) => places.filter((p) => p.file === e.file && openers.has(e) && p.openers.has(openers.get(e)!))
      const used = new Set(edits.added.flatMap((e) => [...atLines(e), ...inList(e)]))
      const alone = places.filter((p) => !used.has(p))
      for (const p of alone) {
        const name = `${p.file.split("/").pop()} ${p.from + 1}-${p.to + 1}`
        aloneNames.set(name, (aloneNames.get(name) ?? 0) + 1)
      }
      const exact = edits.added.filter((e) => atLines(e).length > 0)
      const near = edits.added.filter((e) => atLines(e).length === 0 && inList(e).length > 0)
      const row = { added: edits.added.length, exact: exact.length, near: near.length, places: places.length, alone: alone.length, changed: edits.changed, created: edits.created }
      rows.push(row)
      if (verbose) {
        yield* Console.log(
          `  ${r.id}: kind ${kind?.name ?? "not in memory"}; added ${row.added} blocks: ${row.exact} at the lines shown, ${row.near} in the same list, ` +
            `${row.added - row.exact - row.near} not shown; ${row.places} places shown, ${row.alone} left alone; ${row.changed} blocks changed, ${row.created} files created`
        )
        for (const e of edits.added.filter((x) => !exact.includes(x) && !near.includes(x))) yield* Console.log(`      not shown: ${e.file} after line ${e.after}`)
      }
    }
    if (rows.length === 0) continue
    const med = (f: (row: (typeof rows)[number]) => number) => Math.round(median(rows.map(f)))
    const often = [...aloneNames.entries()].filter(([, n]) => n === rows.length).map(([name]) => name)
    const line = `${task.padEnd(24)} ${rows.length} runs: added ${med((x) => x.added)} blocks: ${med((x) => x.exact)} at the lines shown, ` +
      `${med((x) => x.near)} in the same list, ${med((x) => x.added - x.exact - x.near)} not shown; ` +
      `${med((x) => x.places)} places shown, ${med((x) => x.alone)} left alone` +
      `; changed ${med((x) => x.changed)} blocks of its own, created ${med((x) => x.created)} files`
    summary.push(line)
    if (verbose) yield* Console.log(`${line}\n`)
    if (often.length > 0) summary.push(`${"".padEnd(24)} left alone in every run: ${often.join("; ")}`)
  }
  yield* Console.log("Medians per task:")
  for (const line of summary) yield* Console.log(line)
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
