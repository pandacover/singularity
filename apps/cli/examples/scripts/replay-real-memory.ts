// The changes a memory home stored from real sessions, read again with the
// task chosen the new way (src/records/Task.ts) and found the new way, with no
// agent run and nothing written: the home is read only, and its files' times
// and sizes are checked unchanged at the end.
//
// 1. What each change is filed under: the task as stored, the first prompt
//    of its part of the log that asks for something (read again from the
//    record), the last that asked before it (from the session's log), and its
//    commit message.
// 2. Search over the home's own history: each change whose task asks for
//    something is looked for, in the order they were made, among the changes
//    made before it, with that request as the new task's prompt: by the task
//    as stored, as before, and by the new keys (the request and the commit
//    message's first line, or the whole message). Changes of the same session
//    are left out: its agent made them and has them in front of it. A pick is counted related
//    when it changed a source or test file the change itself changed.
// 3. Prompts that ask for nothing ("please read @HANDOFF.md", "yes"), which
//    must find nothing.
//
//   node apps/cli/examples/scripts/replay-real-memory.ts [--home <memory home>] [--out <file>]
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { changeMessage, taskKeys, taskOf } from "../../src/records/Task.ts"
import { fileKind } from "../../src/scripts/Render.ts"
import { MIN_SCORE, score } from "../../src/scripts/Search.ts"
import { isPersonPrompt, parseSession, personText } from "../../src/traces/index.ts"
import { isRequest } from "../../src/traces/Requests.ts"

const { values: opts } = parseArgs({
  options: {
    home: { type: "string", default: join(homedir(), ".singularity") },
    out: { type: "string", default: join(import.meta.dirname, "results", "eval-2026-10-16", "replay-real-memory.txt") }
  }
})

const walk = (d: string): Array<string> =>
  existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []
const before = new Map(walk(opts.home).filter((f) => !f.includes(`${join("app", "")}`)).map((f) => [f, `${statSync(f).mtimeMs}:${statSync(f).size}`] as const))

interface Rec {
  id: string
  subject: string
  task: { prompt: string; followups: Array<string> }
  files: Array<{ path: string; snapshot: boolean }>
  run: { session_id: string; log: string; repo: string; base_commit: string | null; head_commit: string | null; segment: { from: string | null; to: string } | null; started_at: string | null }
  created_at: string
}
const tenants = join(opts.home, "tenants")
const records: Array<Rec> = (existsSync(tenants) ? readdirSync(tenants) : [])
  .flatMap((t) => walk(join(tenants, t, "records")).filter((f) => f.endsWith(".json")))
  .map((f) => JSON.parse(readFileSync(f, "utf8")) as Rec)
  .filter((r) => r.run.head_commit !== null)
const when = (r: Rec) => r.run.segment?.to ?? r.run.started_at ?? r.created_at
records.sort((a, b) => when(a).localeCompare(when(b)))

const gitOut = (cwd: string, args: Array<string>): string => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return ""
  }
}

// What each change is filed under.
const rows = await Effect.runPromise(Effect.forEach(records, (r) => Effect.gen(function*() {
  const prompts = [r.task.prompt, ...r.task.followups].map(personText).filter((t) => t !== "")
  const read = taskOf(prompts)
  let walked: string | undefined
  if (!isRequest(read.prompt) && r.run.segment?.from && existsSync(r.run.log)) {
    const trace = yield* parseSession(r.run.log).pipe(Effect.orElseSucceed(() => undefined))
    const from = Date.parse(r.run.segment.from)
    walked = trace?.prompts
      .filter((p) => isPersonPrompt(p) && p.timestamp !== undefined && Number(p.timestamp.epochMilliseconds) <= from)
      .map((p) => personText(p.text))
      .filter(isRequest)
      .at(-1)
  }
  const base = r.run.base_commit ?? `${r.run.head_commit}^`
  const message = changeMessage(gitOut(r.run.repo, ["log", "--reverse", "--format=%B%x1e", `${base}..${r.run.head_commit}`]).split("\x1e"))
  return { r, stored: r.task.prompt, read: read.prompt, walked, message }
})).pipe(Effect.provide(NodeServices.layer)))

const lines: Array<string> = []
const say = (s = "") => { lines.push(s); console.log(s) }
const one = (s: string, n = 70) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

say(`# ${opts.home}: ${rows.length} stored changes\n`)
const storedAsks = rows.filter((x) => isRequest(x.stored)).length
const readAsks = rows.filter((x) => isRequest(x.read)).length
const walkedAsks = rows.filter((x) => !isRequest(x.read) && x.walked !== undefined).length
const withMessage = rows.filter((x) => x.message !== "").length
say(`- task as stored asks for something: ${storedAsks}`)
say(`- the first prompt of its part of the log that asks: ${readAsks} (${readAsks - storedAsks} more than as stored)`)
say(`- none there, the last that asked before it, from the session's log: ${walkedAsks}`)
say(`- no prompt that asks: ${rows.length - readAsks - walkedAsks}; with a commit message: ${withMessage}`)
say("\n| change (commit message) | task as stored | new task |\n|---|---|---|")
for (const x of rows) {
  const task = isRequest(x.read) ? x.read : x.walked !== undefined ? `(before it) ${x.walked}` : "(none: its commit message)"
  say(`| ${one(x.message.split("\n")[0] ?? "", 60)} | ${one(x.stored, 50)} | ${one(task, 60)} |`)
}

// Search over the home's own history.
type Keys = (x: typeof rows[number]) => Array<string>
const variants: Array<[string, Keys]> = [
  ["as before: the task as stored", (x) => [x.stored]],
  ["new, taken: request and whole message", (x) => taskKeys({ prompt: isRequest(x.read) ? x.read : x.walked ?? x.read, message: x.message })],
  ["new, not taken: request and message's first line", (x) => taskKeys({ prompt: isRequest(x.read) ? x.read : x.walked ?? x.read, message: x.message.split("\n")[0] })]
]
const telling = (r: Rec) => new Set(r.files.filter((f) => !f.snapshot && fileKind(f.path) !== "rest").map((f) => f.path))
const shares = (a: Rec, b: Rec) => { const t = telling(b); return [...telling(a)].some((f) => t.has(f)) }
const queries = rows.map((x, i) => ({ x, i, q: isRequest(x.read) ? x.read : x.walked })).filter((y): y is typeof y & { q: string } => y.q !== undefined && y.i > 0)
say(`\n## Looking each change up among the ones made before it: ${queries.length} changes whose task asks`)
const possible = queries.filter(({ x, i }) => rows.slice(0, i).some((y) => y.r.subject === x.r.subject && y.r.run.session_id !== x.r.run.session_id && shares(x.r, y.r))).length
say(`- with an earlier change of a source or test file it changed: ${possible}`)
say("\n| search by | handed over | related (shares a file) | unrelated |\n|---|---|---|---|")
const picksOf = (keys: Keys) => queries.map(({ x, i, q }) => {
  const docs = rows.slice(0, i).filter((y) => y.r.subject === x.r.subject && y.r.run.session_id !== x.r.run.session_id)
  const best = docs.map((y) => ({ y, s: Math.max(0, ...keys(y).map((k) => score(q, k))) })).sort((a, b) => b.s - a.s)[0]
  return best !== undefined && best.s >= MIN_SCORE ? { x, y: best.y, s: best.s, related: shares(x.r, best.y.r) } : { x, y: undefined, s: best?.s ?? 0, related: false }
})
const picks = variants.map(([name, keys]) => [name, picksOf(keys)] as const)
for (const [name, ps] of picks) {
  const handed = ps.filter((p) => p.y !== undefined)
  say(`| ${name} | ${handed.length} | ${handed.filter((p) => p.related).length} | ${handed.filter((p) => !p.related).length} |`)
}
say("\n| change looked up | as before | new (first line) |\n|---|---|---|")
for (let k = 0; k < queries.length; k++) {
  const show = (p: typeof picks[number][1][number]) => (p.y === undefined ? `- (${p.s.toFixed(2)})` : `${p.related ? "related" : "UNRELATED"} ${p.s.toFixed(2)}: ${one(p.y.message.split("\n")[0] ?? "", 45)}`)
  say(`| ${one(queries[k].x.message.split("\n")[0] ?? "", 50)} | ${show(picks[0][1][k])} | ${show(picks[1][1][k])} |`)
}

// Prompts that ask for nothing.
say("\n## Prompts that ask for nothing\n")
const probes = ["please read @HANDOFF.md", "can you read the HANDOFF.md and tell me what are the next series of steps?", "commit and open a PR", "yes", "alright", "push and merge to main", "What's our benchmark numbers so far?"]
for (const q of probes) {
  const old = rows.map((y) => ({ y, s: score(q, y.stored) })).sort((a, b) => b.s - a.s)[0]
  const fresh = isRequest(q) ? rows.map((y) => ({ y, s: Math.max(0, ...variants[1][1](y).map((k) => score(q, k))) })).sort((a, b) => b.s - a.s)[0] : undefined
  const pickOld = old !== undefined && old.s >= MIN_SCORE ? `${old.s.toFixed(2)} ${one(old.y.message.split("\n")[0] ?? "", 50)}` : "nothing"
  const pickNew = fresh === undefined ? "nothing (asks for nothing)" : fresh.s >= MIN_SCORE ? `${fresh.s.toFixed(2)} ${one(fresh.y.message.split("\n")[0] ?? "", 50)}` : "nothing"
  say(`- "${q}": as before ${pickOld}; new ${pickNew}`)
}

const after = new Map(walk(opts.home).filter((f) => !f.includes(`${join("app", "")}`)).map((f) => [f, `${statSync(f).mtimeMs}:${statSync(f).size}`] as const))
const changed = [...after].filter(([f, v]) => before.get(f) !== v).map(([f]) => f)
say(`\nThe home was read only: ${changed.length === 0 && after.size === before.size ? "nothing in it changed" : `CHANGED ${changed.join(", ")}`}`)
writeFileSync(opts.out, lines.join("\n") + "\n")
