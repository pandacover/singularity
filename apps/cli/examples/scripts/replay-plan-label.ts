// Would the agent's plan help find a change filed under "yes"? For each change
// a memory home stored whose part of the log has no prompt that asks for
// something, the agent message its first prompt answered (the plan the person
// said yes to) is read from the session's log, and the home's own history is
// searched again (as replay-real-memory.ts does) with that message as one more
// text the change is found by. No agent run, nothing written to the home.
//
//   node apps/cli/examples/scripts/replay-plan-label.ts [--home <memory home>] [--out <file>]
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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
    out: { type: "string", default: join(tmpdir(), "replay-plan-label.txt") }
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
const ms = (t: { epochMilliseconds: number } | undefined) => (t === undefined ? undefined : Number(t.epochMilliseconds))
const paragraphs = (s: string) => s.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/)
const firstParagraph = (s: string) => paragraphs(s)[0] ?? ""
// Where the agent asks what to do next ("Want me to …?"), the part a "yes" answers.
const lastParagraph = (s: string) => paragraphs(s).at(-1) ?? ""

const rows = await Effect.runPromise(Effect.forEach(records, (r) => Effect.gen(function*() {
  const prompts = [r.task.prompt, ...r.task.followups].map(personText).filter((t) => t !== "")
  const read = taskOf(prompts).prompt
  let walked: string | undefined
  let answered: string | undefined
  let plan: string | undefined
  if (!isRequest(read) && existsSync(r.run.log)) {
    const trace = yield* parseSession(r.run.log).pipe(Effect.orElseSucceed(() => undefined))
    const from = r.run.segment?.from ? Date.parse(r.run.segment.from) : -Infinity
    const to = r.run.segment ? Date.parse(r.run.segment.to) : Infinity
    const person = (trace?.prompts ?? []).filter((p) => isPersonPrompt(p) && ms(p.timestamp) !== undefined)
    walked = person.filter((p) => ms(p.timestamp)! <= from).map((p) => personText(p.text)).filter(isRequest).at(-1)
    // The segment's first prompt, and the last thing the agent said on the main thread before it.
    const first = person.find((p) => ms(p.timestamp)! > from && ms(p.timestamp)! <= to)
    if (first !== undefined) {
      answered = personText(first.text)
      const at = ms(first.timestamp)!
      plan = (trace?.responses ?? [])
        .filter((x) => x.agentId === undefined && x.text.trim() !== "" && (ms(x.timestamp) ?? Infinity) < at)
        .at(-1)?.text.trim()
    }
  }
  const base = r.run.base_commit ?? `${r.run.head_commit}^`
  const message = changeMessage(gitOut(r.run.repo, ["log", "--reverse", "--format=%B%x1e", `${base}..${r.run.head_commit}`]).split("\x1e"))
  return { r, read, walked, answered, plan, message }
})).pipe(Effect.provide(NodeServices.layer)))

const lines: Array<string> = []
const say = (s = "") => { lines.push(s); console.log(s) }
const one = (s: string, n = 70) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const words = (s: string) => (s.match(/\S+/g) ?? []).length

const noAsk = rows.filter((x) => !isRequest(x.read))
const withPlan = noAsk.filter((x) => x.plan !== undefined)
say(`# ${opts.home}: ${rows.length} stored changes, ${noAsk.length} with no prompt that asks, ${withPlan.length} of them with an agent message before their first prompt\n`)
const lens = withPlan.map((x) => words(x.plan!)).sort((a, b) => a - b)
say(`plan length in words: median ${lens[Math.floor(lens.length / 2)] ?? 0}, max ${lens.at(-1) ?? 0}\n`)
say("| change (commit message) | first prompt | the agent message it answered |\n|---|---|---|")
for (const x of withPlan) say(`| ${one(x.message.split("\n")[0] ?? "", 50)} | ${one(x.answered ?? "", 30)} | ${one(x.plan!, 60)} … last paragraph: ${one(lastParagraph(x.plan!), 160)} |`)

// Search over the home's own history, as replay-real-memory.ts does.
type Row = typeof rows[number]
const request = (x: Row) => (isRequest(x.read) ? x.read : x.walked ?? x.read)
const base = (x: Row) => taskKeys({ prompt: request(x), message: x.message })
const variants: Array<[string, (x: Row) => Array<string>]> = [
  ["now: request (or the last before it) and message", base],
  ["+ the plan, whole", (x) => [...base(x), ...(x.plan && !isRequest(x.read) ? [x.plan] : [])]],
  ["+ the plan's first paragraph", (x) => [...base(x), ...(x.plan && !isRequest(x.read) ? [firstParagraph(x.plan)] : [])]],
  ["+ the plan's last paragraph", (x) => [...base(x), ...(x.plan && !isRequest(x.read) ? [lastParagraph(x.plan)] : [])]],
  ["the plan instead of the last request before it", (x) =>
    isRequest(x.read) || !x.plan ? base(x) : taskKeys({ prompt: x.plan, message: x.message })]
]
const telling = (r: Rec) => new Set(r.files.filter((f) => !f.snapshot && fileKind(f.path) !== "rest").map((f) => f.path))
const shares = (a: Rec, b: Rec) => { const t = telling(b); return [...telling(a)].some((f) => t.has(f)) }
const queries = rows.map((x, i) => ({ x, i, q: isRequest(x.read) ? x.read : x.walked })).filter((y): y is typeof y & { q: string } => y.q !== undefined && y.i > 0)
say(`\n## Looking each change up among the ones made before it: ${queries.length} changes whose task asks`)
say("\n| found by | handed over | related | unrelated | picks a change with a plan |\n|---|---|---|---|---|")
const picksOf = (keys: (x: Row) => Array<string>) => queries.map(({ x, i, q }) => {
  const docs = rows.slice(0, i).filter((y) => y.r.subject === x.r.subject && y.r.run.session_id !== x.r.run.session_id)
  const best = docs.map((y) => ({ y, s: Math.max(0, ...keys(y).map((k) => score(q, k))) })).sort((a, b) => b.s - a.s)[0]
  return best !== undefined && best.s >= MIN_SCORE ? { x, q, y: best.y, s: best.s, related: shares(x.r, best.y.r) } : { x, q, y: undefined, s: best?.s ?? 0, related: false }
})
const picks = variants.map(([name, keys]) => [name, picksOf(keys)] as const)
for (const [name, ps] of picks) {
  const handed = ps.filter((p) => p.y !== undefined)
  say(`| ${name} | ${handed.length} | ${handed.filter((p) => p.related).length} | ${handed.filter((p) => !p.related).length} | ${handed.filter((p) => p.y!.plan !== undefined && !isRequest(p.y!.read)).length} |`)
}
say("\n### Where a variant picks differently from now\n")
const show = (p: typeof picks[number][1][number]) => (p.y === undefined ? `nothing (${p.s.toFixed(2)})` : `${p.related ? "related" : "UNRELATED"} ${p.s.toFixed(2)}: ${one(p.y.message.split("\n")[0] ?? "", 45)}`)
for (let k = 0; k < queries.length; k++) {
  const now = picks[0][1][k]
  const diff = picks.slice(1).filter(([, ps]) => ps[k].y?.r.id !== now.y?.r.id)
  if (diff.length === 0) continue
  say(`- "${one(now.q, 70)}"\n  - now: ${show(now)}`)
  for (const [name, ps] of diff) say(`  - ${name}: ${show(ps[k])}`)
}

// The plans as prompts' rivals: how high each plan scores against every query, related or not.
say("\n## Best score each plan reaches against any later request (related / unrelated)\n")
for (const x of withPlan) {
  const i = rows.indexOf(x)
  const later = queries.filter((y) => y.i > i && y.x.r.subject === x.r.subject && y.x.r.run.session_id !== x.r.run.session_id)
  const best = (key: string, rel: boolean) => Math.max(0, ...later.filter((y) => shares(y.x.r, x.r) === rel).map((y) => score(y.q, key))).toFixed(2)
  const both = (key: string) => `${best(key, true)} / ${best(key, false)}`
  say(`- ${one(x.message.split("\n")[0] ?? "", 50)}: whole ${both(x.plan!)}, first paragraph ${both(firstParagraph(x.plan!))}, last ${both(lastParagraph(x.plan!))}`)
}
writeFileSync(opts.out, lines.join("\n") + "\n")
say(`\nwritten to ${opts.out}`)
