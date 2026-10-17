// The recall queries agents ran in the note test (examples/markdownlint/note-test.mjs), asked
// again of each session's own repo and memory: as the agent wrote it, and with the new thing's
// own names left out (PREREGISTRATION-note-2026-10-17.md). Recall calls no model: this is free.
//
//   node replay-note-queries.mjs <note test out dir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const out = path.resolve(process.argv[2] ?? "C:/singularity-workspaces/note-test")
const app = "C:/singularity-workspaces/eval-1016/app-new"
const runs = "C:/singularity-workspaces/eval-1016/ml/runs-p1/with"
const cli = path.join(app, "apps", "cli", "src", "singularity.ts")

// What each task names that no earlier change could have: its rule's ID and alias, its new parameter.
const NEW_NAMES = {
  "t04-list-max-depth": ["MD063", "list-max-depth"],
  "t07-link-url-scheme": ["MD064", "link-url-scheme", "allowed_schemes"],
  "t09-md014-prompts": ["prompts"],
  "t10-ol-delimiter-style": ["MD065", "ol-delimiter-style"],
  "t08-todo-comments-example": ["todo-comments", "todoComments"],
  "t11-circular-extends": []
}
// The task each stored commit came from, to say what recall handed over.
const taskOfCommit = new Map(
  fs.readFileSync(path.join(runs, "records.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).map((r) => [r.post.slice(0, 12), r.task])
)

// The query of a `singularity recall ...` command: its first quoted argument, else the words up to a pipe or redirect.
const queryOf = (command) => {
  const after = command.slice(command.search(/singularity(\.cmd)?\s+recall\b/)).replace(/^singularity(\.cmd)?\s+recall\s+/, "").replace(/^(--\S+\s+)*/, "")
  const quoted = after.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/)
  if (quoted) return (quoted[1] ?? quoted[2]).replace(/\\"/g, "\"")
  return after.split(/\s*(?:\||&&|;|\d?>)/)[0].trim()
}

const withoutNames = (query, names) => {
  let q = query
  for (const n of names) q = q.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ")
  return q.replace(/[`/]+/g, " ").replace(/\s+/g, " ").trim()
}

const recall = (repo, home, query) => {
  const env = { ...process.env, SINGULARITY_HOME: home, SINGULARITY_HOOKS: "off" }
  const j = JSON.parse(execFileSync(process.execPath, [cli, "recall", "--json", query], { cwd: repo, env, encoding: "utf8" }))
  const commit = j.picked?.commit?.slice(0, 12)
  return j.handed_over ? `${taskOfCommit.get(commit) ?? commit} at ${j.score}` : `nothing (best ${j.score})`
}

const rows = fs.readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l))
let n = 0
for (const r of rows) {
  for (const c of r.score?.recalls ?? []) {
    n++
    const repo = path.join(out, r.name, "repo")
    const home = path.join(out, r.name, "home")
    const query = queryOf(c.command)
    const bare = withoutNames(query, NEW_NAMES[r.task] ?? [])
    console.log(`${r.name} (call #${c.index}): "${query}"`)
    console.log(`  in the session: ${c.found ? "a change" : "nothing"}; asked again: ${recall(repo, home, query)}`)
    if (bare !== query) console.log(`  without "${NEW_NAMES[r.task].join("\", \"")}": "${bare}" -> ${recall(repo, home, bare)}`)
  }
}
console.log(`${n} recall calls in ${rows.length} sessions`)
