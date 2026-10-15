// Which stored change the file hand-over would give each task, with no agent
// run (src/scripts/Search.ts watchFiles): the files a task's reference change
// edits stand for the files its agent edits. As in check-search.ts: the
// markdownlint long task in its order (each task's store is the reference
// changes of the tasks before it), and excalidraw (the two seed tasks
// stored; then the nine feature tasks stored, against the four bug fixes,
// which none of them fits).
//
// Two views: as it runs, where only a task the start search handed nothing
// watches files; and alone, every task watching, to see what the guard lets
// through when the start search misses.
//
//   node examples/scripts/check-file-handover.ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "smol-toml"
import { FILE_MIN_SCORE, MAX_FILE_SHARE, MIN_SCORE, rank, watchFiles } from "../../src/scripts/Search.ts"

const here = import.meta.dirname

interface Task { id: string; prompt: string; files: Array<string> }
interface Case { task: Task; store: Array<Task>; ok: ReadonlyArray<string | null> }

const filesOf = (patch: string) => [...patch.matchAll(/^diff --git a\/\S+ b\/(\S+)/gm)].map((m) => m[1])

/** For one task: the start pick, else the stored changes its edits would bring (file: pick), first file first. */
const look = (c: Case, alone: boolean) => {
  const top = rank(c.task.prompt, c.store)[0]
  const start = top !== undefined && top.score >= MIN_SCORE ? top : undefined
  if (start !== undefined && !alone) return { start, picks: [] as Array<{ file: string; id: string; score: number }> }
  const watched = watchFiles(c.task.prompt, c.store)
  const picks = c.task.files.flatMap((file) => {
    const best = watched.get(file)?.[0]
    return best === undefined ? [] : [{ file, id: best.doc.id, score: best.score }]
  })
  return { start, picks }
}

const report = (title: string, cases: Array<Case>, alone: boolean) => {
  console.log(`\n## ${title}${alone ? ", every task watching" : ""}\n`)
  console.log("| task | fits | start pick | file hand-overs (file: pick, score) |")
  console.log("|---|---|---|---|")
  let right = 0
  let wrong = 0
  for (const c of cases) {
    const { start, picks } = look(c, alone)
    const shown = picks.map((p) => {
      const fits = c.ok.includes(p.id)
      if (fits) right++
      else wrong++
      return `${p.file}: ${p.id} (${p.score.toFixed(2)})${fits ? "" : " ✗"}`
    })
    const ok = c.ok.map((x) => x ?? "nothing").join(", ")
    console.log(`| ${c.task.id} | ${ok} | ${start === undefined ? "nothing" : `${start.doc.id} (${start.score.toFixed(2)})`} | ${shown.join("; ") || "none"} |`)
  }
  console.log(`\nfile hand-overs that fit: ${right}; that don't: ${wrong}`)
}

console.log(`FILE_MIN_SCORE ${FILE_MIN_SCORE}, MAX_FILE_SHARE ${MAX_FILE_SHARE}`)

// --- markdownlint, fits as in check-search.ts ---
const ml = (JSON.parse(readFileSync(join(here, "../markdownlint/tasks.json"), "utf8")).tasks as Array<{ id: string; prompt: string; kind: string }>)
  .map((t) => ({ ...t, files: filesOf(readFileSync(join(here, "../markdownlint/reference", `${t.id}.patch`), "utf8")) }))
const newRules = (upTo: number) => ml.slice(0, upTo).filter((t) => t.kind === "new-rule").map((t) => t.id)
const mlFits = (i: number): ReadonlyArray<string | null> => {
  const t = ml[i]
  const before = ml.slice(0, i)
  if (t.kind === "new-rule") return before.length === 0 ? [null] : newRules(i)
  if (t.kind === "rule-option") {
    const opts = before.filter((b) => b.kind === "rule-option").map((b) => b.id)
    return opts.length > 0 ? opts : newRules(i)
  }
  return [null]
}
const mlCases = ml.map((task, i) => ({ task, store: ml.slice(0, i), ok: mlFits(i) }))
report("markdownlint, in order", mlCases, false)
report("markdownlint, in order", mlCases, true)

// --- excalidraw ---
const suite = parse(readFileSync(join(here, "../excalidraw/suite.toml"), "utf8")) as { tasks: Array<{ id: string; prompt: string; family: string }> }
const ex = suite.tasks.map((t) => ({ ...t, files: filesOf(readFileSync(join(here, "../excalidraw/reference", `${t.id}.patch`), "utf8")) }))
const byId = (id: string) => ex.find((t) => t.id === id)!
const seeds = [byId("altkey-zen-m"), byId("toggle-minimap")]
const exFits: Record<string, ReadonlyArray<string | null>> = {
  "altkey-zen-m": ["altkey-zen-m"], "altkey-viewmode-j": ["altkey-zen-m"], "altkey-snap-u": ["altkey-zen-m"],
  "toggle-minimap": ["toggle-minimap"], "toggle-rulers": ["toggle-minimap"], "toggle-presenter": ["toggle-minimap"],
  "midpoint-snap-n": ["altkey-zen-m", "toggle-minimap"], "page-breaks": ["toggle-minimap"], "stats-shortcut-k": ["altkey-zen-m"]
}
const exCases = ex.filter((t) => !seeds.includes(t)).map((task) => ({ task, store: seeds, ok: exFits[task.id] ?? [null] }))
report("excalidraw, the two seed tasks stored", exCases, false)
report("excalidraw, the two seed tasks stored", exCases, true)
const features = ex.filter((t) => t.family !== "bug-fix")
const bugCases = ex.filter((t) => t.family === "bug-fix").map((task) => ({ task, store: features, ok: [null] }))
report("excalidraw bug fixes, the nine feature tasks stored", bugCases, true)
