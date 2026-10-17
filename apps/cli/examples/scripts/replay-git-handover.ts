// The hand-over by commit (src/scripts/History.ts) replayed for free on three sets of past sessions:
// the 12 note-test sessions of 2026-10-17, the user's own sessions since 2026-10-13 (the eval session left
// out), and the memory arm of the 2026-10-16 markdownlint eval (36 sessions, run to their end). For each
// shell call that read commits with git show or git log: what the hook would have added then, from the
// changes committed before the call, leaving out the session's own and what it had been given (its start
// and file hand-overs as logged, a recall in the same call). Harm first: what it adds, and to whom. Then,
// for the markdownlint sessions, whether a mistake it named came up later in the same session.
//
//   node apps/cli/examples/scripts/replay-git-handover.ts
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { commitsRead } from "../../src/scripts/History.ts"
import { commitHandover } from "../../src/scripts/Start.ts"

type Json = any

const readJsonl = (file: string): Array<Json> =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
    : []

interface ShellCall {
  readonly index: number
  readonly at: string
  readonly command: string
  readonly output: string
  readonly failed: boolean
  /** Model responses after the one that made the call: each rereads what the call added. */
  readonly turnsAfter: number
}

const shellCalls = (file: string): { readonly sessionId: string; readonly calls: Array<ShellCall> } => {
  const lines = readJsonl(file)
  const results = new Map<string, { text: string; failed: boolean }>()
  for (const o of lines) {
    if (o.type !== "user" || !Array.isArray(o.message?.content)) continue
    for (const c of o.message.content) {
      if (c.type === "tool_result") {
        results.set(c.tool_use_id, { text: Array.isArray(c.content) ? c.content.map((x: Json) => x.text ?? "").join("") : String(c.content ?? ""), failed: c.is_error === true })
      }
    }
  }
  const responses: Array<string> = []
  const raw: Array<Omit<ShellCall, "turnsAfter"> & { readonly response: number }> = []
  let index = 0
  for (const o of lines) {
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue
    if (!responses.includes(o.message.id)) responses.push(o.message.id)
    for (const c of o.message.content) {
      if (c.type !== "tool_use") continue
      index++
      if (c.name !== "Bash" && c.name !== "PowerShell") continue
      const r = results.get(c.id)
      raw.push({ index: index - 1, at: o.timestamp, command: String(c.input?.command ?? ""), output: r?.text ?? "", failed: r?.failed ?? false, response: responses.indexOf(o.message.id) })
    }
  }
  const sessionId = lines.find((o) => typeof o.sessionId === "string")?.sessionId ?? path.basename(file, ".jsonl")
  return { sessionId, calls: raw.map(({ response, ...c }) => ({ ...c, turnsAfter: responses.length - response - 1 })) }
}

// --- memory as of a call: the changes committed before it ---

interface Source {
  /** Where the records are, by subject, and the files a home needs besides. */
  readonly tenantDir: string
}

const recordsOf = (tenantDir: string) => {
  const dir = path.join(tenantDir, "records")
  return fs.readdirSync(dir).flatMap((subject) =>
    fs.readdirSync(path.join(dir, subject)).filter((f) => f.endsWith(".json")).map((f) => {
      const r = JSON.parse(fs.readFileSync(path.join(dir, subject, f), "utf8"))
      return { subject, file: f, at: String(r.run.segment?.to ?? r.created_at), head: String(r.run.head_commit ?? ""), session: String(r.run.session_id) }
    })
  )
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sg-replay-git-"))
const homes = new Map<string, string>()
/** A home holding `source`'s records made before `at`: built once a set. */
const homeAt = (source: Source, at: string): string => {
  const kept = recordsOf(source.tenantDir).filter((r) => r.at < at)
  const key = `${source.tenantDir}|${kept.map((r) => r.file).sort().join(",")}`
  const known = homes.get(key)
  if (known !== undefined) return known
  const home = path.join(scratch, `home-${homes.size}`)
  const tenant = path.join(home, "tenants", "local")
  fs.mkdirSync(tenant, { recursive: true })
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ tenant: "local" }) + "\n")
  fs.copyFileSync(path.join(source.tenantDir, "subjects.json"), path.join(tenant, "subjects.json"))
  for (const r of kept) {
    fs.mkdirSync(path.join(tenant, "records", r.subject), { recursive: true })
    fs.copyFileSync(path.join(source.tenantDir, "records", r.subject, r.file), path.join(tenant, "records", r.subject, r.file))
  }
  homes.set(key, home)
  return home
}

// --- what markdownlint's mistakes teach (examples/scripts/stored-mistakes.mjs) ---

const keysOf = (text: string): Set<string> => {
  const keys = new Set<string>()
  if (/UnicodeDecodeError: 'charmap' codec/.test(text)) keys.add("python-encoding")
  if (/Parsing error: Unterminated string constant/.test(text)) keys.add("python-escapes")
  if (/plan expected \d+ assertions? but received \d+/.test(text)) keys.add("plan-count")
  if (/\b\d+ == \d+\b/.test(text)) keys.add("file-count")
  if (/✖ projectFiles|Issue\(s\) with/.test(text)) keys.add("project-files")
  if (/Invalid state: Snapshot|Snapshot '[^']*' (?:not found|missing)/.test(text)) keys.add("snapshot")
  if (/✖ readme\b/.test(text)) keys.add("readme")
  if (/✖ validateJsonUsingConfigSchema/.test(text)) keys.add("schema")
  if (/does not meet (?:\w+ )?threshold/.test(text)) keys.add("coverage")
  if (/ENOENT: no such file or directory, open '(?:doc-build|doc-src)/.test(text)) keys.add("missing-doc")
  for (const line of text.split(/\r?\n/)) {
    if (!/\b\d+:\d+\s+error\s/.test(line) || /Parsing error/.test(line)) continue
    const rule = line.trim().split(/\s+/).pop() ?? ""
    if (/^(@[\w-]+\/)?[a-z][\w-]*(\/[\w-]+)?$/.test(rule) && rule.includes("-")) keys.add(`lint:${rule}`)
  }
  if (/error TS\d+/.test(text)) keys.add("types")
  return keys
}

// --- the replay ---

interface Fire {
  readonly set: string
  readonly session: string
  readonly call: number
  readonly command: string
  readonly commit: string
  readonly chars: number
  readonly sections: Array<string>
  readonly turnsAfter: number
  /** markdownlint: the mistakes it named, by what they teach, and those the session made later. */
  readonly named: Array<string>
  readonly later: Array<string>
}

interface Session {
  readonly set: string
  readonly transcript: string
  readonly repo: string
  readonly source: Source
  /** Commits the session's start and file hand-overs gave, and when. */
  readonly given: ReadonlyArray<{ readonly at: string; readonly commit: string }>
  /** HEAD while the session ran, for HEAD-relative revisions; undefined when it moved (left unresolved). */
  readonly head?: string | undefined
}

const fires: Array<Fire> = []
const counts = new Map<string, { sessions: number; calls: number; reads: number; unresolved: number }>()

const replay = async (s: Session) => {
  const { sessionId, calls } = shellCalls(s.transcript)
  const count = counts.get(s.set) ?? { sessions: 0, calls: 0, reads: 0, unresolved: 0 }
  counts.set(s.set, count)
  count.sessions++
  count.calls += calls.length
  const given = new Set<string>()
  for (const call of calls) {
    for (const g of s.given) if (g.at < call.at) given.add(g.commit)
    const read = commitsRead(call.command, call.output)
    // A recall in the same call: what it printed, the session now has (`recall` notes it, commands/Setup.ts).
    const home = homeAt(s.source, call.at)
    if (/singularity(\.cmd)?\s+recall\b/.test(call.command)) {
      const printed = call.output.match(/committed as ([0-9a-f]{7,40})/)?.[1]
      if (printed !== undefined) for (const r of recordsOf(path.join(home, "tenants", "local"))) if (r.head.startsWith(printed)) given.add(r.head)
    }
    if (read === undefined || call.failed) continue
    count.reads++
    const revs = read.revs.flatMap((r) => (s.head === undefined ? [] : [r.replace(/^HEAD/, s.head)]))
    if (read.hashes.length === 0 && revs.length === 0) {
      count.unresolved++
      continue
    }
    const result = await Effect.runPromise(
      commitHandover(
        { sessionId, cwd: s.repo, command: call.command, hashes: read.hashes, revs, given: [...given] },
        { tenantDir: path.join(home, "tenants", "local"), persist: false }
      ).pipe(Effect.provide(JsonRecordStore.layer(path.join(home, "tenants", "local"), "local")), Effect.provide(NodeServices.layer))
    )
    if (result.text === undefined || result.picked === null) continue
    given.add(result.picked.commit)
    const mistakes = result.text.split("\n").filter((l) => l.startsWith("- `"))
    const named = [...new Set(mistakes.flatMap((m) => [...keysOf(m)]))]
    const later = [...new Set(calls.filter((c) => c.index > call.index && (c.failed || /exit code [1-9]|not ok \d|✖|error/i.test(c.output))).flatMap((c) => [...keysOf(c.output)]))]
    fires.push({
      set: s.set,
      session: sessionId,
      call: call.index,
      command: call.command.replace(/\s+/g, " ").slice(0, 90),
      commit: result.picked.commit.slice(0, 10),
      chars: result.text.length,
      sections: result.text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3)),
      turnsAfter: call.turnsAfter,
      named,
      later: named.filter((k) => later.includes(k))
    })
  }
}

const gitOut = (repo: string, ...args: Array<string>) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()

// (a) The note test: each session's repo and memory as it started, nothing handed over.
const noteTest = "C:/singularity-workspaces/note-test"
for (const name of fs.readdirSync(noteTest).filter((d) => /^t\d\d-[AB]$/.test(d)).sort()) {
  const repo = path.join(noteTest, name, "repo")
  await replay({ set: "note test", transcript: path.join(noteTest, name, "transcript.jsonl"), repo, source: { tenantDir: path.join(noteTest, name, "home", "tenants", "local") }, given: [], head: gitOut(repo, "rev-parse", "HEAD") })
}

// (b) The user's own sessions since 2026-10-13, against a copy of their memory read as it stood at each call.
const realTenant = path.join(os.homedir(), ".singularity", "tenants", "local")
const realHandovers = readJsonl(path.join(realTenant, "workflows", "handovers.jsonl"))
const audit = JSON.parse(fs.readFileSync("C:/singularity-workspaces/analysis/daily-audit/sessions.json", "utf8")) as Array<Json>
const projects = path.join(os.homedir(), ".claude", "projects")
for (const x of audit) {
  if (x.id.startsWith("83d702eb") || x.prompts === 0 || !fs.existsSync(x.cwd)) continue
  const dir = fs.readdirSync(projects).find((d) => fs.existsSync(path.join(projects, d, `${x.id}.jsonl`)))
  if (dir === undefined) continue
  const given = realHandovers.filter((h) => h.session_id === x.id && h.picked?.commit).map((h) => ({ at: String(h.at), commit: String(h.picked.commit) }))
  // HEAD moves in these sessions: HEAD-relative revisions stay unresolved.
  await replay({ set: "your sessions", transcript: path.join(projects, dir, `${x.id}.jsonl`), repo: x.cwd, source: { tenantDir: realTenant }, given })
}

// (c) The memory arm of the 2026-10-16 markdownlint eval: one session a task, HEAD at the task's start until it committed.
const ml = "C:/singularity-workspaces/eval-1016/ml"
for (const pass of [1, 2, 3]) {
  const tenantDir = path.join(ml, `sg-home-p${pass}`, "tenants", "local")
  const handovers = readJsonl(path.join(tenantDir, "workflows", "handovers.jsonl"))
  const runs = path.join(ml, `runs-p${pass}`, "with")
  for (const task of fs.readdirSync(runs).filter((d) => /^t\d\d-/.test(d)).sort()) {
    const record = JSON.parse(fs.readFileSync(path.join(runs, task, "record.json"), "utf8"))
    const given = handovers.filter((h) => h.session_id === record.session_id && h.picked?.commit).map((h) => ({ at: String(h.at), commit: String(h.picked.commit) }))
    await replay({ set: `markdownlint p${pass}`, transcript: path.join(runs, task, "transcript.jsonl"), repo: path.join(ml, `arm-with-p${pass}`), source: { tenantDir }, given, head: record.pre })
  }
}

// --- report: harm first ---

const sets = [...counts.keys()]
const median = (xs: Array<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.floor((s.length - 1) / 2)]
}
console.log("set | sessions | shell calls | calls that read commits | unresolved | hand-overs | sessions with one | median chars | chars x later turns")
for (const set of sets) {
  const c = counts.get(set)!
  const mine = fires.filter((f) => set.startsWith("markdownlint") ? f.set === set : f.set === set)
  console.log(`${set} | ${c.sessions} | ${c.calls} | ${c.reads} | ${c.unresolved} | ${mine.length} | ${new Set(mine.map((f) => f.session)).size} | ${median(mine.map((f) => f.chars))} | ${mine.reduce((a, f) => a + f.chars * f.turnsAfter, 0)}`)
}
console.log("")
for (const f of fires) {
  console.log(`${f.set} ${f.session.slice(0, 8)} call ${f.call}: ${f.commit}, ${f.chars} chars (${f.sections.join("; ")}), ${f.turnsAfter} turns after; named ${f.named.join(",") || "-"}; came up later ${f.later.join(",") || "-"} | ${f.command}`)
}
const mlFires = fires.filter((f) => f.set.startsWith("markdownlint"))
console.log(`\nmarkdownlint: ${mlFires.length} hand-overs; ${mlFires.filter((f) => f.named.length > 0).length} named a mistake; ${mlFires.filter((f) => f.later.length > 0).length} named one the session then made (${[...new Set(mlFires.flatMap((f) => f.later))].join(", ")})`)
fs.rmSync(scratch, { recursive: true, force: true })
