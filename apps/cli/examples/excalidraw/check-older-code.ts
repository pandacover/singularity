/**
 * Do memory's places still hold in older code? Free (no model, no runs):
 *
 *     node apps/cli/examples/excalidraw/check-older-code.ts --repo REPO [--v1 HOME] [--v0 HOME] [COMMIT ...]
 *
 * Excalidraw's own history has past changes of the kind memory learned from
 * (a setting added end to end), each with a known answer: where its edits
 * went. For each such commit, both memories are looked up in the code just
 * before it, as a hand-over would look them up in a working tree:
 *
 * - v1 (`--v1`, default runs/excalidraw/memory/v1-seed): every place of its
 *   workflows, found by the blocks around it (workflows/Places.ts);
 * - v0 (`--v0`, default runs/excalidraw/memory/local-seed-spots): every spot
 *   of its toggle kind's route, found by its two lines (handover/Excerpts.ts),
 *   with the same bar a hand-over sets (two runs, most of the step's).
 *
 * Counted, over the blocks the commit added to files that were there:
 *
 * - in a known place: the block went into a place memory found (v1: inside
 *   the block or group; v0: at the lines it shows, or in the list they sit in);
 * - places found: how many of memory's places the older code still has.
 *
 * Memory was learned from September 2026 code; the older the commit, the more
 * the code has moved since.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Path } from "effect"
import { findPlaces, type SpotSource } from "../../src/handover/Excerpts.ts"
import { fileAt, git } from "../../src/local/Git.ts"
import { loadHome } from "../../src/local/Home.ts"
import * as JsonMemoryStore from "../../src/memory/JsonMemoryStore.ts"
import { MemoryStore } from "../../src/memory/MemoryStore.ts"
import { editsOfDiff } from "../../src/workflows/Edits.ts"
import * as JsonWorkflowStore from "../../src/workflows/JsonWorkflowStore.ts"
import { locatePlaces } from "../../src/workflows/Locate.ts"
import { indentOf, type Region } from "../../src/workflows/Places.ts"
import { WorkflowStore } from "../../src/workflows/WorkflowStore.ts"

const args = process.argv.slice(2)
const valueOf = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]] : []))[0]
const repo = valueOf("--repo")
const v1Home = valueOf("--v1") ?? "runs/excalidraw/memory/v1-seed"
const v0Home = valueOf("--v0") ?? "runs/excalidraw/memory/local-seed-spots"
const flags = new Set(["--repo", "--v1", "--v0"])
const commits = args.filter((a, i) => !a.startsWith("--") && !flags.has(args[i - 1] ?? ""))
/** Past changes that added a setting end to end, newest first. */
const DEFAULT_COMMITS = ["437595fa", "195a7438", "4c35eba7", "327ed0e2"]

/** The line (from 0) that opens the list a line at `indent` below `index` sits in; -1 at the top level. */
const openerOf = (lines: ReadonlyArray<string>, index: number, indent: number): number => {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) if (lines[i].trim() !== "" && indentOf(lines[i]) < indent) return i
  return -1
}

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  if (repo === undefined) return yield* Console.error("--repo REPO: a clone of excalidraw with its history")
  const v1h = yield* loadHome(v1Home)
  const v1 = yield* Effect.gen(function*() {
    return yield* (yield* WorkflowStore).memory()
  }).pipe(Effect.provide(JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(v1h.tenantDir, path), v1h.tenant)))
  const v0h = yield* loadHome(v0Home)
  const v0 = yield* Effect.gen(function*() {
    return yield* (yield* MemoryStore).graph()
  }).pipe(Effect.provide(JsonMemoryStore.layer(path.join(v0h.tenantDir, "memory"), v0h.tenant)))

  // v0's spots for a toggle task: the route of its kind that edits the most files.
  const kind = [...v0.kinds].sort((a, b) => b.route.length - a.route.length)[0]
  const ofKind = new Set(kind.evidence)
  const spots: Array<SpotSource> = []
  kind.route.forEach((e, i) => {
    const step = v0.steps.find((s) => s.id === e.step)
    if (step === undefined) return
    for (const [, where] of Object.entries(step.where)) {
      const runs = step.evidence.filter((id) => ofKind.has(id)).length
      for (const s of where.spots ?? []) {
        const records = s.records.filter((id) => ofKind.has(id))
        if (records.length > 0) spots.push({ step: i + 1, file: s.file, above: s.above, below: s.below, records, runs })
      }
    }
  })
  yield* Console.log(`v1: ${v1.places.length} places in ${v1.workflows.length} workflows. v0: ${spots.length} spots on the route of "${kind.name}".\n`)

  for (const commit of commits.length > 0 ? commits : DEFAULT_COMMITS) {
    const subject = (yield* git(repo, ["log", "-1", "--format=%h %ad %s", "--date=short", commit])).trim()
    const parent = (yield* git(repo, ["rev-parse", `${commit}^`])).trim()
    const diff = (yield* git(repo, ["diff", parent, commit])).replace(/\r\n?/g, "\n")
    const d = editsOfDiff(diff)
    const added = d.edits.filter((e) => e.kind === "add")
    const files = new Map<string, ReadonlyArray<string> | undefined>()
    const linesOf = Effect.fnUntraced(function*(file: string) {
      if (!files.has(file)) files.set(file, (yield* fileAt(repo, parent, file))?.split("\n"))
      return files.get(file)
    })

    // v1: every place, found by its blocks in the code before the commit (in another file, if it moved).
    const regions = new Map<string, Array<Region>>()
    let v1Found = 0
    let v1Moved = 0
    for (const [, at] of yield* locatePlaces({ kind: "commit", repo, commit: parent }, v1.places.filter((p) => p.new_file === null))) {
      if (at.kind !== "block") continue
      v1Found++
      if (at.moved) v1Moved++
      regions.set(at.file, [...(regions.get(at.file) ?? []), at.region])
    }
    const blockPlaces = v1.places.filter((p) => p.new_file === null).length
    // v0: every spot of the route, found by its lines, as a hand-over would.
    const v0Places = new Map<string, Array<{ from: number; to: number; openers: Set<number> }>>()
    let v0Found = 0
    for (const file of new Set(spots.map((s) => s.file))) {
      const lines = yield* linesOf(file)
      if (lines === undefined) continue
      for (const f of findPlaces(file, lines, spots.filter((s) => s.file === file))) {
        v0Found++
        const openers = new Set<number>()
        for (let i = f.from; i <= f.to; i++) if (lines[i].trim() !== "") openers.add(openerOf(lines, i - 1, indentOf(lines[i])))
        v0Places.set(file, [...(v0Places.get(file) ?? []), { from: f.from, to: f.to, openers }])
      }
    }
    const v0Spots = new Set(spots.map((s) => `${s.file}\u0000${s.above}\u0000${s.below}`)).size

    let inV1 = 0
    let inV0 = 0
    let relevant = 0
    const knownFiles = new Set([...v1.places.map((p) => p.file), ...regions.keys(), ...spots.map((s) => s.file)])
    for (const e of added) {
      const lines = yield* linesOf(e.file)
      if (lines === undefined) continue
      if (knownFiles.has(e.file)) relevant++
      const at = e.at - 1
      if ((regions.get(e.file) ?? []).some((r) => at >= r.from && at <= r.to)) inV1++
      const opener = openerOf(lines, at, e.indent)
      if ((v0Places.get(e.file) ?? []).some((p) => (at >= p.from - 1 && at <= p.to + 1) || p.openers.has(opener))) inV0++
    }
    const created = d.created.filter((c) => v1.places.some((p) => p.new_file !== null && c.file.startsWith(`${p.new_file.dir}/${p.new_file.prefix}`)))
    yield* Console.log(`${subject}`)
    yield* Console.log(`  the commit added ${added.length} blocks to existing files (${relevant} in files memory knows), created ${d.created.length} files`)
    yield* Console.log(`  v1: ${v1Found} of ${blockPlaces} places found (${v1Moved} in a file they moved to); ${inV1} added blocks in a known place; ${created.length} new files where it expects them`)
    yield* Console.log(`  v0: ${v0Found} places found from ${v0Spots} spots; ${inV0} added blocks at or in the list of a found place\n`)
  }
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
