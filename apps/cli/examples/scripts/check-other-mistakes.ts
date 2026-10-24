// Which other changes' mistakes the hand-overs of markdownlint runs showed,
// and which they show when two changes are linked only through a file few
// stored changes touched (src/eval/SavedRunText.ts tellingFiles, which daily
// use had until 2026-10-24), replayed on each run's stored records as they
// were at each hand-over. Also counts the hand-overs whose mistakes name
// `npm run build-declaration`, which agents ran when a hand-over named it
// (RESULTS.md).
//
//   node examples/scripts/check-other-mistakes.ts <run dir> ...
//
// A run dir is a markdownlint arm with memory (launch.sh): home/ and out/.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { mistakesNearby, mistakesToShow, tellingFiles } from "../../src/eval/SavedRunText.ts"

const jsonl = (path: string) => readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l))

let handovers = 0
let before = 0
let after = 0
let namedBefore = 0
let namedAfter = 0
for (const run of process.argv.slice(2)) {
  const dir = join(run, "home", "tenants", "local", "records", "markdownlint")
  const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
  const taskOf = new Map(jsonl(join(run, "out", "records.jsonl")).map((o) => [o.session_id, o.task.slice(0, 3)]))
  for (const h of jsonl(join(run, "home", "tenants", "local", "workflows", "handovers.jsonl"))) {
    if (!h.picked) continue
    const stored = records.filter((r) => r.created_at < h.at)
    const record = stored.find((r) => r.id === h.picked.id)
    if (record === undefined) continue
    const files: Array<string> = record.files.map((f: { path: string }) => f.path)
    const own = mistakesToShow(record.detours)
    const others = [...stored].reverse().filter((r) => r.id !== record.id).map((r) => ({ files: r.files.map((f: { path: string }) => f.path), mistakes: mistakesToShow(r.detours) }))
    const links = tellingFiles(stored.map((r) => ({ files: r.files.map((f: { path: string }) => f.path) })), 2)
    const was = mistakesNearby(files, others, own)
    const now = mistakesNearby(files.filter(links), others, own)
    if (h.text.includes("## Mistakes other changes to these files made") !== was.length > 0) console.log(`${run} ${taskOf.get(h.session_id)}: the replay differs from what was handed over`)
    handovers++
    before += was.length
    after += now.length
    if ([...own, ...was].some((m) => m.includes("build-declaration"))) namedBefore++
    if ([...own, ...now].some((m) => m.includes("build-declaration"))) namedAfter++
  }
}
console.log(`hand-overs: ${handovers}`)
console.log(`other changes' mistakes shown: ${before} through any shared file, ${after} through telling files`)
console.log(`hand-overs whose mistakes name build-declaration: ${namedBefore}, then ${namedAfter}`)
