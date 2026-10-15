// Which saved script each task would get, old search against new, with no
// agent run: the markdownlint long task in its order (each task searches the
// reference changes of the tasks before it) and excalidraw (the two seed
// tasks stored, as in every excalidraw measurement; then all nine feature
// tasks stored, against the four bug fixes, which none of them fits).
//
//   node examples/scripts/check-search.ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "smol-toml"
import { cosine, words } from "../../src/graph/Similarity.ts"
import { MIN_SCORE, rank } from "../../src/scripts/Search.ts"

const here = import.meta.dirname
const OLD_MIN = 0.35

interface Task { id: string; prompt: string }
interface Case { task: Task; store: Array<Task>; ok: ReadonlyArray<string | null> }


const oldPick = (c: Case): [string | null, number] => {
  const q = words(c.task.prompt)
  let best: [string | null, number] = [null, 0]
  for (const t of c.store) {
    const s = cosine(q, words(t.prompt))
    if (s > best[1]) best = [t.id, s]
  }
  return best[1] >= OLD_MIN ? best : [null, best[1]]
}

const newPick = (c: Case): [string | null, number] => {
  const r = rank(c.task.prompt, c.store)[0]
  if (r === undefined) return [null, 0]
  return r.score >= MIN_SCORE ? [r.doc.id, r.score] : [null, r.score]
}

const report = (title: string, cases: Array<Case>) => {
  console.log(`\n## ${title}\n`)
  console.log("| task | fits | old pick (score) | new pick (score) |")
  console.log("|---|---|---|---|")
  let oldOk = 0
  let newOk = 0
  for (const c of cases) {
    const [o, os] = oldPick(c)
    const [n, ns] = newPick(c)
    const good = (x: string | null) => c.ok.includes(x)
    if (good(o)) oldOk++
    if (good(n)) newOk++
    const show = (x: string | null, s: number) => `${x ?? "nothing"} (${s.toFixed(2)})${good(x) ? "" : " ✗"}`
    console.log(`| ${c.task.id} | ${c.ok.map((x) => x ?? "nothing").join(", ")} | ${show(o, os)} | ${show(n, ns)} |`)
  }
  console.log(`\nfitting picks: old ${oldOk} of ${cases.length}, new ${newOk} of ${cases.length}`)
}

// --- markdownlint ---
const ml = JSON.parse(readFileSync(join(here, "../markdownlint/tasks.json"), "utf8")).tasks as Array<{ id: string; prompt: string; kind: string }>
const mlTasks = ml
const newRules = (upTo: number) => mlTasks.slice(0, upTo).filter((t) => t.kind === "new-rule").map((t) => t.id)
const mlFits = (i: number): ReadonlyArray<string | null> => {
  const t = mlTasks[i]
  const before = mlTasks.slice(0, i)
  if (t.kind === "new-rule") return before.length === 0 ? [null] : newRules(i)
  // A parameter on an existing rule: an earlier parameter, else a new rule (same schema, docs and tests).
  if (t.kind === "rule-option") {
    const opts = before.filter((b) => b.kind === "rule-option").map((b) => b.id)
    return opts.length > 0 ? opts : newRules(i)
  }
  return [null]
}
report("markdownlint, in order", mlTasks.map((task, i) => ({ task, store: mlTasks.slice(0, i), ok: mlFits(i) })))

// --- excalidraw ---
const suite = parse(readFileSync(join(here, "../excalidraw/suite.toml"), "utf8")) as { tasks: Array<{ id: string; prompt: string; family: string }> }
const ex = suite.tasks
const byId = (id: string) => ex.find((t) => t.id === id)!
const seeds = [byId("altkey-zen-m"), byId("toggle-minimap")]
const exFits: Record<string, ReadonlyArray<string | null>> = {
  "altkey-zen-m": ["altkey-zen-m"], "altkey-viewmode-j": ["altkey-zen-m"], "altkey-snap-u": ["altkey-zen-m"],
  "toggle-minimap": ["toggle-minimap"], "toggle-rulers": ["toggle-minimap"], "toggle-presenter": ["toggle-minimap"],
  "midpoint-snap-n": ["altkey-zen-m", "toggle-minimap"], "page-breaks": ["toggle-minimap"], "stats-shortcut-k": ["altkey-zen-m"]
}
report("excalidraw, the two seed tasks stored", ex.map((task) => ({ task, store: seeds, ok: exFits[task.id] ?? [null] })))
const features = ex.filter((t) => t.family !== "bug-fix")
report("excalidraw bug fixes, the nine feature tasks stored", ex.filter((t) => t.family === "bug-fix").map((task) => ({ task, store: features, ok: [null] })))
