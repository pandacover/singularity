// Whether finding stored changes by their commit message too (src/records/Task.ts
// `taskKeys`) changes what the markdownlint daily runs of 2026-10-16 were
// handed: each with-arm task of each pass is looked for among the changes
// stored before it, by the task as stored (what the hook did then) and by the
// new keys, with the message read from the arm's clone. Free; reads only.
//
//   node apps/cli/examples/scripts/check-search-messages.ts [--ml <dir>]
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { changeMessage, taskKeys } from "../../src/records/Task.ts"
import { MIN_SCORE, score } from "../../src/scripts/Search.ts"

const { values: opts } = parseArgs({ options: { ml: { type: "string", default: "C:/singularity-workspaces/eval-1016/ml" } } })
const results = join(import.meta.dirname, "results", "eval-2026-10-16")
const tasks = JSON.parse(readFileSync(join(import.meta.dirname, "..", "markdownlint", "tasks.json"), "utf8")).tasks as Array<{ id: string; prompt: string }>

let same = 0, differ = 0
for (const pass of [1, 2, 3]) {
  const repo = join(opts.ml, `arm-with-p${pass}`)
  const dir = join(opts.ml, `sg-home-p${pass}`, "tenants", "local", "records", `arm-with-p${pass}`)
  const runs = readFileSync(join(results, `markdownlint-p${pass}-with-records.jsonl`), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l))
  const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  const indexOf = (r: { run: { head_commit: string } }) => runs.find((x) => (x.commits ?? []).some((c: string) => c.startsWith(r.run.head_commit)))?.index as number
  const docs = records.map((r) => {
    const base = r.run.base_commit ?? `${r.run.head_commit}^`
    const out = execFileSync("git", ["-C", repo, "log", "--reverse", "--format=%B%x1e", `${base}..${r.run.head_commit}`], { encoding: "utf8" })
    return { index: indexOf(r), prompt: r.task.prompt as string, message: changeMessage(out.split("\x1e")) }
  })
  console.log(`\n## pass ${pass}\n`)
  console.log("| task | as stored (score) | new keys (score) |\n|---|---|---|")
  for (const [k, task] of tasks.entries()) {
    const index = k + 1
    const stored = docs.filter((d) => d.index < index)
    const best = (keys: (d: typeof docs[number]) => Array<string>) => {
      const top = stored.map((d) => ({ d, s: Math.max(0, ...keys(d).map((key) => score(task.prompt, key))) })).sort((a, b) => b.s - a.s)[0]
      return top === undefined ? { pick: "-", s: 0 } : { pick: top.s >= MIN_SCORE ? `t${String(top.d.index).padStart(2, "0")}` : "-", s: top.s }
    }
    const old = best((d) => [d.prompt])
    const fresh = best((d) => taskKeys(d))
    if (old.pick === fresh.pick) same++
    else differ++
    console.log(`| ${task.id} | ${old.pick} (${old.s.toFixed(2)}) | ${fresh.pick} (${fresh.s.toFixed(2)})${old.pick === fresh.pick ? "" : " CHANGED"} |`)
  }
}
console.log(`\nSame pick: ${same}; changed: ${differ}`)
