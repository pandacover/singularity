// The lookups of replay-real-memory.ts that hand nothing over although an
// earlier change of another session edited a source or test file the change
// itself edited: each with its request, its commit message, and those earlier
// changes (best score first), the files they share and what the search scored
// them. For reading by hand: was one of them worth handing over? Read only.
//
//   node apps/cli/examples/scripts/replay-misses.ts [--home <memory home>] [--out <file>]
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { changeMessage, taskKeys, taskOf } from "../../src/records/Task.ts"
import { fileKind } from "../../src/scripts/Render.ts"
import { MIN_SCORE, score, watchFiles } from "../../src/scripts/Search.ts"
import { isPersonPrompt, parseSession, personText } from "../../src/traces/index.ts"
import { isRequest } from "../../src/traces/Requests.ts"

const { values: opts } = parseArgs({
  options: {
    home: { type: "string", default: join(homedir(), ".singularity") },
    out: { type: "string", default: join(tmpdir(), "replay-misses.txt") }
  }
})

const walk = (d: string): Array<string> =>
  existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []

interface Rec {
  id: string
  subject: string
  task: { prompt: string; followups: Array<string> }
  files: Array<{ path: string; snapshot: boolean }>
  run: { session_id: string; log: string; repo: string; base_commit: string | null; head_commit: string | null; segment: { from: string | null; to: string } | null; started_at: string | null }
  created_at: string
}
const tenants = join(opts.home, "tenants")
// Retired scripts (folded into a later change, gone, ...) are never handed over: leave them out, as the search does.
const retired = new Set((existsSync(tenants) ? readdirSync(tenants) : [])
  .map((t) => join(tenants, t, "scripts", "retired.jsonl"))
  .filter(existsSync)
  .flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => (JSON.parse(l) as { id: string }).id)))
const records: Array<Rec> = (existsSync(tenants) ? readdirSync(tenants) : [])
  .flatMap((t) => walk(join(tenants, t, "records")).filter((f) => f.endsWith(".json")))
  .map((f) => JSON.parse(readFileSync(f, "utf8")) as Rec)
  .filter((r) => r.run.head_commit !== null && !retired.has(r.id))
const when = (r: Rec) => r.run.segment?.to ?? r.run.started_at ?? r.created_at
records.sort((a, b) => when(a).localeCompare(when(b)))

const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit)$/
const gitOut =(cwd: string, args: Array<string>): string => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return ""
  }
}

const rows = await Effect.runPromise(Effect.forEach(records, (r) => Effect.gen(function*() {
  const prompts = [r.task.prompt, ...r.task.followups].map(personText).filter((t) => t !== "")
  const read = taskOf(prompts).prompt
  let walked: string | undefined
  // The change's files in the order its session first edited them (edit tools only), as the watch would see them.
  let edits: Array<string> = []
  if (existsSync(r.run.log)) {
    const trace = yield* parseSession(r.run.log).pipe(Effect.orElseSucceed(() => undefined))
    const from = r.run.segment?.from ? Date.parse(r.run.segment.from) : -Infinity
    const to = r.run.segment ? Date.parse(r.run.segment.to) : Infinity
    if (!isRequest(read) && r.run.segment?.from) {
      walked = trace?.prompts
        .filter((p) => isPersonPrompt(p) && p.timestamp !== undefined && Number(p.timestamp.epochMilliseconds) <= from)
        .map((p) => personText(p.text))
        .filter(isRequest)
        .at(-1)
    }
    const mine = r.files.filter((f) => !f.snapshot).map((f) => f.path)
    for (const c of trace?.toolCalls ?? []) {
      const at = c.startedAt === undefined ? undefined : Number(c.startedAt.epochMilliseconds)
      if (at === undefined || at <= from || at > to || !EDITS.test(c.name)) continue
      const p = [c.input.file_path, c.input.notebook_path, c.input.path].find((x) => typeof x === "string")
      if (typeof p !== "string") continue
      const norm = p.replace(/\\/g, "/")
      const f = mine.find((m) => norm === m || norm.endsWith(`/${m}`))
      if (f !== undefined && !edits.includes(f)) edits.push(f)
    }
  }
  const base = r.run.base_commit ?? `${r.run.head_commit}^`
  const message = changeMessage(gitOut(r.run.repo, ["log", "--reverse", "--format=%B%x1e", `${base}..${r.run.head_commit}`]).split("\x1e"))
  return { r, read, walked, message, edits }
})).pipe(Effect.provide(NodeServices.layer)))

type Row = typeof rows[number]
const lines: Array<string> = []
const say = (s = "") => { lines.push(s); console.log(s) }
const one = (s: string, n = 70) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const keys = (x: Row) => taskKeys({ prompt: isRequest(x.read) ? x.read : x.walked ?? x.read, message: x.message })
const telling = (r: Rec) => new Set(r.files.filter((f) => !f.snapshot && fileKind(f.path) !== "rest").map((f) => f.path))
const shared = (a: Rec, b: Rec) => { const t = telling(b); return [...telling(a)].filter((f) => t.has(f)) }
// How many changes of the whole memory edited each file: a file most changes edit says little.
const editors = new Map<string, number>()
for (const x of rows) for (const f of telling(x.r)) editors.set(f, (editors.get(f) ?? 0) + 1)

const queries = rows.map((x, i) => ({ x, i, q: isRequest(x.read) ? x.read : x.walked })).filter((y): y is typeof y & { q: string } => y.q !== undefined && y.i > 0)
const earlier = (x: Row, i: number) => rows.slice(0, i).filter((y) => y.r.subject === x.r.subject && y.r.run.session_id !== x.r.run.session_id)
// The by-file watch for a lookup (Search.ts watchFiles), and what the first watched file the change's session edited brings.
const byFile = (x: Row, q: string, i: number) => {
  const docs = earlier(x, i).map((y) => ({ y, prompt: isRequest(y.read) ? y.read : y.walked ?? y.read, message: y.message, files: y.r.files.filter((f) => !f.snapshot).map((f) => f.path) }))
  const watched = watchFiles(q, docs)
  const file = x.edits.find((f) => watched.has(f))
  const top = file === undefined ? undefined : watched.get(file)![0]
  return { watched: watched.size, file, pick: top === undefined ? undefined : { y: top.doc.y, s: top.score } }
}
const misses = queries.flatMap(({ x, i, q }) => {
  const docs = earlier(x, i)
  const scored = docs.map((y) => ({ y, s: Math.max(0, ...keys(y).map((k) => score(q, k))), files: shared(x.r, y.r) }))
  const top = [...scored].sort((a, b) => b.s - a.s)[0]
  const related = scored.filter((c) => c.files.length > 0).sort((a, b) => b.s - a.s)
  if (related.length === 0 || (top !== undefined && top.s >= MIN_SCORE)) return []
  return [{ x, i, q, related }]
})
say(`# ${misses.length} lookups that hand over nothing while an earlier change shares a file\n`)
say(`Files most changes edited: ${[...editors].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f} (${n})`).join(", ")}\n`)
misses.forEach(({ x, i, q, related }, k) => {
  say(`## ${k + 1}. ${one(x.message.split("\n")[0] ?? "", 90)}`)
  say(`request: ${one(q, 400)}`)
  say(`message: ${one(x.message, 300)}`)
  for (const c of related.slice(0, 4)) {
    say(`- ${c.s.toFixed(2)} ${one(c.y.message.split("\n")[0] ?? "", 80)}`)
    say(`  its request: ${one(isRequest(c.y.read) ? c.y.read : c.y.walked ?? c.y.read, 200)}`)
    say(`  shares: ${c.files.map((f) => `${f.replace(/^apps\/cli\//, "")} (${editors.get(f)})`).join(", ")}`)
  }
  if (related.length > 4) say(`- and ${related.length - 4} more`)
  const w = byFile(x, q, i)
  say(`watch: ${w.watched} files; edits in order: ${x.edits.map((f) => f.replace(/^apps\/cli\//, "")).join(", ") || "(none read)"}`)
  say(w.pick === undefined ? "→ by file: nothing" : `→ by file, at ${w.file!.replace(/^apps\/cli\//, "")}: ${w.pick.s.toFixed(2)} ${one(w.pick.y.message.split("\n")[0] ?? "", 80)}`)
  say()
})

// The by-file hand-over over every lookup the start hands nothing: what the first watched edit brings.
const noPick = queries.filter(({ x, i, q }) => {
  const docs = earlier(x, i)
  return !docs.some((y) => Math.max(0, ...keys(y).map((k) => score(q, k))) >= MIN_SCORE)
})
const brought = noPick.map(({ x, i, q }) => ({ x, q, ...byFile(x, q, i) })).filter((b) => b.pick !== undefined)
say(`# By file, over the ${noPick.length} lookups the start hands nothing: ${brought.length} hand over\n`)
for (const b of brought) {
  const rel = shared(b.x.r, b.pick!.y.r).length > 0
  say(`- ${rel ? "shares" : "NO SHARE"} ${b.pick!.s.toFixed(2)}: "${one(b.x.message.split("\n")[0] ?? "", 60)}" ← "${one(b.pick!.y.message.split("\n")[0] ?? "", 60)}" (at ${b.file!.replace(/^apps\/cli\//, "")})`)
}
writeFileSync(opts.out, lines.join("\n") + "\n")
