// The facts hand-over (src/facts/) replayed over the real records of a memory
// home, with no agent run: which facts each session would have been given, at
// which moment, and whether they would have mattered. Read only.
//
//   node apps/cli/examples/scripts/replay-facts.ts [--home <memory home>] [--out <file>]
//
// One session left out at a time (several records share a session; leaving
// out one commit would leak its session's facts into its own replay): its
// facts come from every other session of its repo ("others"), or, stricter
// and as daily use would see them, only from changes committed before the
// task started ("past"). Its calls are walked as the hooks would see them
// (records/Segment.ts), and facts fire at three moments: the start of each of
// its tasks (one per record), the first read of a file (the Read tool, or a
// shell command reading it), and a command that failed. Each fact comes once a
// session. Existence checks (a script gone from disk) are left out: a script
// of then may be gone now.
//
// Each fact that fires is scored by what the session did after it:
// - a trap: "prevent" when the session then hit a detour of the same command
//   whose failure shows the trap's signal; "at failure" when the moment was
//   that detour's failing call (it can shorten the detour); "related" when a
//   detour of the same command failed otherwise; "ran it" when the session
//   ran the command without a detour; else noise;
// - a check script: "used" when the session ran it later and not before,
//   "already" when it had run it before, "own script" when the session
//   instead ran a check script of its own; else noise;
// - a project check (the card): "used" when the session ran it after.
// Detours that would be traps by Facts.ts's rules are counted apart, with
// their cost: the ceiling of what traps can save.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { buildFacts, type Fact, type FactIndex, resolvePath, sameAs, scriptOf, scriptsNamed, scriptsRun, trapOf, whenOf } from "../../src/facts/Facts.ts"
import { commandsNow } from "../../src/facts/Index.ts"
import { cardFacts, factsAt, isScriptKey, type Moment, renderCard, repoPath } from "../../src/facts/Lookup.ts"
import { filesReadBy } from "../../src/facts/Reads.ts"
import type { Detour, WorkflowRecord } from "../../src/records/Models.ts"
import { callFailed } from "../../src/records/Outcome.ts"
import { ownPart } from "../../src/records/Segment.ts"
import { commandKeys, isReadOnlyCommand, mainSegments, splitCommand } from "../../src/records/Shell.ts"
import { MIN_SCORE, rank } from "../../src/scripts/Search.ts"
import { parseSession, type ToolCall, type Usage, usageTotal } from "../../src/traces/index.ts"

const { values: opts } = parseArgs({
  options: {
    home: { type: "string", default: join(homedir(), ".singularity") },
    out: { type: "string", default: join(tmpdir(), "replay-facts.txt") }
  }
})

const walk = (d: string): Array<string> =>
  existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []

const tenants = join(opts.home, "tenants")
const all: Array<WorkflowRecord> = (existsSync(tenants) ? readdirSync(tenants) : [])
  .flatMap((t) => walk(join(tenants, t, "records")).filter((f) => f.endsWith(".json")))
  .map((f) => JSON.parse(readFileSync(f, "utf8")) as WorkflowRecord)
  .filter((r) => r.run.outcome === "success")
  .sort((a, b) => whenOf(a).localeCompare(whenOf(b)))

const startOf = (r: WorkflowRecord) => r.run.segment?.from ?? r.run.started_at ?? whenOf(r)
const SHELL = new Set(["Bash", "PowerShell"])
const CHECK_SCRIPT = /test|check|smoke|e2e|shot|screen|snap|(?:^|[-_.])ui(?:$|[-_.])|verify|regress|drive|probe|proof|bench|lint|validate/i

/** One call of a session, as the hooks would see it. */
interface Call {
  readonly at: number
  readonly record: WorkflowRecord
  readonly call: ToolCall
  readonly command: string | undefined
  readonly keys: ReadonlyArray<string>
}

interface Session {
  readonly subject: string
  readonly id: string
  readonly records: ReadonlyArray<WorkflowRecord>
  readonly calls: ReadonlyArray<Call>
  /** Each record's first call, where its task starts. */
  readonly starts: ReadonlyMap<WorkflowRecord, number>
  readonly detours: ReadonlyArray<{ readonly at: number; readonly detour: Detour; readonly record: WorkflowRecord }>
  /** The main thread's model responses: when, and their tokens. */
  readonly turns: ReadonlyArray<{ readonly at: number; readonly tokens: number; readonly usd: number }>
}

/**
 * What a turn cost, by the kind of each token: new input, cache writes (the
 * hour-long cache Claude Code uses), cache reads and output, at the per-token
 * prices where-money-goes.mjs uses. Only their ratios matter here: shares.
 */
const PRICE = { input: 2e-6, write: 4e-6, read: 0.2e-6, output: 10e-6 }
const usdOf = (u: Usage) =>
  u.input_tokens * PRICE.input + u.cache_creation_input_tokens * PRICE.write + u.cache_read_input_tokens * PRICE.read + u.output_tokens * PRICE.output

const sessions: Array<Session> = []
const bySession = new Map<string, Array<WorkflowRecord>>()
for (const r of all) bySession.set(`${r.subject}\u0000${r.run.session_id}`, [...(bySession.get(`${r.subject}\u0000${r.run.session_id}`) ?? []), r])
await Effect.runPromise(Effect.gen(function*() {
  for (const [key, records] of bySession) {
    const [subject, id] = key.split("\u0000")
    const calls: Array<Call> = []
    const starts = new Map<WorkflowRecord, number>()
    const detours: Array<Session["detours"][number]> = []
    const turns: Array<{ at: number; tokens: number; usd: number }> = []
    for (const r of records) {
      if (!existsSync(r.run.log)) continue
      const trace = yield* parseSession(r.run.log).pipe(Effect.orElseSucceed(() => undefined))
      if (trace === undefined) continue
      const part = ownPart(r, trace)
      const mine = part.toolCalls.filter((c) => c.agentId === undefined)
      for (const t of part.responses) {
        if (t.agentId === undefined && t.timestamp !== undefined) turns.push({ at: Number(t.timestamp.epochMilliseconds), tokens: usageTotal(t.usage), usd: usdOf(t.usage) })
      }
      const offset = calls.length
      starts.set(r, offset)
      for (const d of r.detours) detours.push({ at: offset + d.failed.call, detour: d, record: r })
      for (const c of mine) {
        const command = SHELL.has(c.name) && typeof c.input.command === "string" ? c.input.command : undefined
        calls.push({ at: calls.length, record: r, call: c, command, keys: command === undefined ? [] : commandKeys(command) })
      }
    }
    if (starts.size > 0) sessions.push({ subject, id, records: records.filter((r) => starts.has(r)), calls, starts, detours, turns })
  }
}).pipe(Effect.provide(NodeServices.layer)))

/** The moments of a session, in order: each task's start, each file's first read, each failed command. */
const momentsOf = (s: Session): Array<{ readonly at: number; readonly record: WorkflowRecord; readonly moment: Moment }> => {
  const out: Array<{ at: number; record: WorkflowRecord; moment: Moment }> = []
  const read = new Set<string>()
  const startAt = new Map([...s.starts].map(([r, at]) => [at, r] as const))
  for (const c of s.calls) {
    const r = startAt.get(c.at)
    if (r !== undefined) out.push({ at: c.at, record: r, moment: { kind: "start" } })
    const root = c.record.run.repo ?? ""
    const cwd = root
    const files = c.call.name === "Read" && typeof c.call.input.file_path === "string"
      ? [c.call.input.file_path]
      : c.command !== undefined && isReadOnlyCommand(c.command)
      ? filesReadBy(c.command)
      : []
    for (const f of files) {
      const p = root === "" ? undefined : repoPath(root, cwd, f)
      if (p === undefined || read.has(p)) continue
      read.add(p)
      out.push({ at: c.at, record: c.record, moment: { kind: "read", file: p } })
    }
    if (c.command !== undefined && c.call.result !== undefined && !isReadOnlyCommand(c.command) &&
      callFailed({ tool: c.call.name, command: c.command, output: c.call.result, isError: c.call.isError })) {
      out.push({ at: c.at, record: c.record, moment: { kind: "fail", keys: c.keys, output: c.call.result } })
    }
  }
  return out
}

type Variant = "others" | "past"
interface Params {
  readonly variant: Variant
  readonly minRecurrence: number
  readonly maxChars: number
  readonly matchSignal: boolean
  readonly trapsEverywhere: boolean
  /** Add the facts of the stored change most like the task, when it scores this much (task start). */
  readonly bar: number | undefined
}

const indexCache = new Map<string, FactIndex>()
const indexFor = (s: Session, r: WorkflowRecord, variant: Variant): FactIndex => {
  const before = variant === "past" ? startOf(r) : ""
  const key = `${s.subject}\u0000${s.id}\u0000${before}`
  const had = indexCache.get(key)
  if (had !== undefined) return had
  const records = all.filter((x) => x.subject === s.subject && x.run.session_id !== s.id && (variant === "others" || whenOf(x) < before))
  const index = buildFacts(records, { subject: s.subject, env: process.env, now: "" })
  indexCache.set(key, index)
  return index
}

interface Fired {
  readonly session: Session
  readonly at: number
  readonly moment: Moment
  readonly fact: Fact
  readonly via: "moment" | "match"
  verdict?: string
}

const simulate = (s: Session, p: Params): Array<Fired> => {
  const given = new Set<string>()
  const fired: Array<Fired> = []
  for (const m of momentsOf(s)) {
    const index = indexFor(s, m.record, p.variant)
    const picked = factsAt(index, m.moment, {
      sessionId: s.id,
      given,
      live: () => true,
      minRecurrence: p.minRecurrence,
      maxChars: p.maxChars,
      matchSignal: p.matchSignal,
      trapsEverywhere: p.trapsEverywhere
    })
    for (const f of [...picked.project, ...picked.facts]) {
      given.add(f.id)
      fired.push({ session: s, at: m.at, moment: m.moment, fact: f, via: "moment" })
    }
    // The stored change most like the task, by its prompt: its own facts too, above the bar.
    if (m.moment.kind === "start" && p.bar !== undefined) {
      const docs = all.filter((x) => x.subject === s.subject && x.run.session_id !== s.id && (p.variant === "others" || whenOf(x) < startOf(m.record)))
        .map((x) => ({ id: x.id, prompt: x.task.prompt, message: x.task.message, record: x }))
      const best = rank(m.record.task.prompt, docs)[0]
      if (best !== undefined && best.score >= p.bar && best.doc.record.run.head_commit !== null) {
        const head = best.doc.record.run.head_commit
        const own = index.facts.filter((f) => f.commits.includes(head) && !f.project && !given.has(f.id) && f.recurrence >= 1)
        for (const f of own.slice(0, 2)) {
          given.add(f.id)
          fired.push({ session: s, at: m.at, moment: m.moment, fact: f, via: "match" })
        }
      }
    }
  }
  return fired
}

const signalIn = (f: Fact, d: Detour) => f.signal !== null && d.symptom.toLowerCase().includes(f.signal.toLowerCase())

const verdictOf = (x: Fired): string => {
  const { session: s, at, fact: f } = x
  const after = s.calls.filter((c) => c.at > at)
  const before = s.calls.filter((c) => c.at < at)
  const runs = (cs: ReadonlyArray<Call>) => cs.some((c) => c.keys.some((k) => f.keys.includes(k)))
  if (f.kind === "trap") {
    // The same command, or for a trap of a script, any script whose failure shows its signal.
    const script = f.keys.some(isScriptKey)
    const same = s.detours.filter((d) => d.at >= at && d.detour.keys.some((k) => f.keys.includes(k) || (script && isScriptKey(k) && signalIn(f, d.detour))))
    // Fixed the way the trap says: the command that closed the detour ran one of the trap's fixes.
    const alike = (d: Detour) => d.fixed.command !== null && mainSegments(splitCommand(d.fixed.command)).some((seg) => f.fixes.includes(sameAs(seg)))
    if (same.some((d) => d.at > at && signalIn(f, d.detour) && alike(d.detour))) return "prevent, same fix"
    if (same.some((d) => d.at === at && signalIn(f, d.detour) && alike(d.detour))) return "at failure, same fix"
    if (same.some((d) => d.at > at && signalIn(f, d.detour))) return "prevent"
    if (same.some((d) => d.at === at && signalIn(f, d.detour))) return "at failure"
    if (same.length > 0) return "related"
    return runs(after) ? "ran it" : "noise"
  }
  if (f.project) return runs(after) ? "used" : "noise"
  if (runs(after)) return runs(before) ? "already" : "used"
  const own = after.some((c) =>
    c.command !== undefined && mainSegments(splitCommand(c.command)).some((seg) => {
      const script = scriptOf(seg)
      return script !== undefined && CHECK_SCRIPT.test(script.replace(/\\/g, "/").split("/").pop() ?? "")
    })
  )
  return own ? "own script" : "noise"
}

const ms = (t: ToolCall["startedAt"]) => (t === undefined ? undefined : Number(t.epochMilliseconds))

/** The tokens and dollars of a session's turns between two times. */
const spentIn = (s: Session, start: number, end: number) => {
  const turns = s.turns.filter((t) => t.at >= start && t.at <= end)
  return { tokens: turns.reduce((n, t) => n + t.tokens, 0), usd: turns.reduce((n, t) => n + t.usd, 0) }
}

/**
 * What a session spent on check scripts of its own, from the call that wrote
 * one (the Write tool, or a shell line writing it: `cat > x.mjs <<EOF`) to
 * its first run that worked: tokens of the turns between, each script once.
 * Only scripts written after `from`.
 */
const ownScriptCost = (s: Session, from: number): { readonly scripts: number; readonly tokens: number; readonly usd: number } => {
  let scripts = 0
  let tokens = 0
  let usd = 0
  const seen = new Set<string>()
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? ""
  for (const c of s.calls) {
    if (c.at <= from) continue
    const written = c.call.name === "Write" && typeof c.call.input.file_path === "string"
      ? [c.call.input.file_path]
      : c.command === undefined ? [] : [...c.command.matchAll(/(?:cat|tee)\s*>\s*["']?([^"'\s]+\.(?:[cm]?[jt]s|py|sh))/g)].map((m) => m[1])
    for (const path of written) {
      const name = base(path)
      // A script the change itself added (examples/scripts/check-search.ts) is the work, not a way to check it.
      const inRepo = c.record.run.repo === null ? undefined : repoPath(c.record.run.repo, c.record.run.repo, path)
      if (inRepo !== undefined && s.records.some((r) => r.files.some((f) => f.path === inRepo))) continue
      if (!CHECK_SCRIPT.test(name.replace(/\.[^.]+$/, "")) || seen.has(name)) continue
      seen.add(name)
      const run = s.calls.find((x) => x.at > c.at && x.command !== undefined && x.command.includes(name) && x.call.result !== undefined &&
        !callFailed({ tool: x.call.name, command: x.command, output: x.call.result, isError: x.call.isError }))
      const start = ms(c.call.startedAt)
      const end = ms(run?.call.finishedAt ?? run?.call.startedAt)
      if (start === undefined || end === undefined) continue
      scripts++
      const spent = spentIn(s, start, end)
      tokens += spent.tokens
      usd += spent.usd
    }
  }
  return { scripts, tokens, usd }
}

const VERDICTS = ["prevent, same fix", "at failure, same fix", "prevent", "at failure", "related", "ran it", "used", "already", "own script", "noise"] as const
const lines: Array<string> = []
const say = (s = "") => {
  lines.push(s)
  console.log(s)
}

say(`# Facts replay over ${opts.home}`)
say()
for (const subject of [...new Set(sessions.map((s) => s.subject))]) {
  const mine = sessions.filter((s) => s.subject === subject)
  const records = mine.flatMap((s) => s.records)
  // The ceiling: detours that would be traps, and what they cost.
  const why = new Map<string, { n: number; tokens: number; usd: number }>()
  for (const s of mine) for (const d of s.detours) {
    const t = trapOf(d.record, d.detour, process.env)
    const k = typeof t === "string" ? t : "trap"
    const w = why.get(k) ?? { n: 0, tokens: 0, usd: 0 }
    w.n++
    w.tokens += d.detour.cost.tokens
    // Its dollars: the turns from the failing call to the call that fixed it.
    const fixedAt = d.at - d.detour.failed.call + d.detour.fixed.call
    const start = ms(s.calls[d.at]?.call.startedAt)
    const end = ms(s.calls[fixedAt]?.call.finishedAt ?? s.calls[fixedAt]?.call.startedAt)
    if (start !== undefined && end !== undefined) w.usd += spentIn(s, start, end).usd
    why.set(k, w)
  }
  const moments = mine.flatMap(momentsOf)
  const total = mine.reduce((n, s) => n + s.turns.reduce((m, t) => m + t.tokens, 0), 0)
  const pct = (x: number) => `${((100 * x) / Math.max(1, total)).toFixed(1)}%`
  const totalUsd = mine.reduce((n, s) => n + s.turns.reduce((m, t) => m + t.usd, 0), 0)
  const pctUsd = (x: number) => `${((100 * x) / Math.max(1e-9, totalUsd)).toFixed(1)}%`
  say(`## ${subject}: ${mine.length} sessions, ${records.length} records, ${mine.reduce((n, s) => n + s.calls.length, 0)} calls`)
  say()
  say(`Moments: ${moments.filter((m) => m.moment.kind === "start").length} task starts, ${moments.filter((m) => m.moment.kind === "read").length} first reads, ${moments.filter((m) => m.moment.kind === "fail").length} failed commands.`)
  say()
  say("Detours, by what Facts.ts makes of them (count, tokens of the turns they took):")
  say()
  for (const [k, w] of [...why].sort((a, b) => b[1].tokens - a[1].tokens)) say(`- ${k}: ${w.n}, ${Math.round(w.tokens / 1000)}k tokens (${pct(w.tokens)} of the sessions' ${Math.round(total / 1e6)}M), ${pctUsd(w.usd)} of their dollars`)
  say()
  const last = mine.map((s) => indexFor(s, s.records[s.records.length - 1], "others"))
  say(`Traps retired by a later run of the failing command as it was: ${Math.max(0, ...last.map((i) => i.retired))} (most in any one build).`)
  say()
  say("| variant | min rec | chars | signal | traps | bar | fired | start | read | fail | " + VERDICTS.join(" | ") + " | chars/session |")
  say("|---|---|---|---|---|---|---|---|---|---|" + VERDICTS.map(() => "---").join("|") + "|---|")
  const grid: Array<Params> = []
  for (const variant of ["others", "past"] as const) {
    for (const minRecurrence of [1, 2, 3]) {
      for (const maxChars of [300, 700, 1200]) {
        for (const trapsEverywhere of [false, true]) grid.push({ variant, minRecurrence, maxChars, matchSignal: true, trapsEverywhere, bar: undefined })
      }
      grid.push({ variant, minRecurrence, maxChars: 700, matchSignal: false, trapsEverywhere: false, bar: undefined })
    }
    for (const bar of [0.2, 0.27, 0.32, 0.38]) grid.push({ variant, minRecurrence: 1, maxChars: 700, matchSignal: true, trapsEverywhere: false, bar })
  }
  const details: Array<Fired> = []
  for (const p of grid) {
    const fired = mine.flatMap((s) => simulate(s, p))
    for (const f of fired) f.verdict = verdictOf(f)
    if (p.variant === "past" && p.minRecurrence === 1 && p.maxChars === 700 && p.matchSignal && !p.trapsEverywhere && p.bar === undefined) details.push(...fired)
    const shown = p.bar === undefined ? fired : fired.filter((f) => f.via === "match")
    const count = (v: string) => shown.filter((f) => f.verdict === v).length
    const chars = fired.reduce((n, f) => n + f.fact.text.length, 0)
    say(`| ${p.variant} | ${p.minRecurrence} | ${p.maxChars} | ${p.matchSignal ? "yes" : "no"} | ${p.trapsEverywhere ? "all" : "fail"} | ${p.bar ?? "-"} | ${shown.length} | ` +
      `${shown.filter((f) => f.moment.kind === "start").length} | ${shown.filter((f) => f.moment.kind === "read").length} | ${shown.filter((f) => f.moment.kind === "fail").length} | ` +
      VERDICTS.map(count).join(" | ") + ` | ${Math.round(chars / mine.length)} |`)
  }
  say()
  say("By kind and moment (past, min rec 1, 700 chars, signal, traps at failures):")
  say()
  const kinds = (f: Fired) => (f.fact.kind === "trap" ? "trap" : f.fact.project ? "project check" : "check script")
  for (const k of ["project check", "check script", "trap"]) {
    for (const m of ["start", "read", "fail"]) {
      const these = details.filter((f) => kinds(f) === k && f.moment.kind === m)
      if (these.length === 0) continue
      say(`- ${k} at ${m}: ${these.length}: ` + VERDICTS.map((v) => [v, these.filter((f) => f.verdict === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => `${v} ${n}`).join(", "))
    }
  }
  say()
  // The ceiling of "own script": what the sessions that got a check script's fact then spent writing their own.
  const firstCheck = new Map<Session, number>()
  for (const f of details) if (f.fact.kind === "check" && !f.fact.project && !firstCheck.has(f.session)) firstCheck.set(f.session, f.at)
  const own = [...firstCheck].map(([s, at]) => ownScriptCost(s, at))
  const ownTokens = own.reduce((n, o) => n + o.tokens, 0)
  const ownUsd = own.reduce((n, o) => n + o.usd, 0)
  say(`Check scripts the sessions wrote after a check script's fact fired: ${own.reduce((n, o) => n + o.scripts, 0)} in ${own.filter((o) => o.scripts > 0).length} of ${firstCheck.size} sessions, ${Math.round(ownTokens / 1000)}k tokens from writing each to its first run that worked (${pct(ownTokens)} of tokens, ${pctUsd(ownUsd)} of dollars): the most reusing a past one could save.`)
  say()
  say("By recurrence (past, min rec 1, 700 chars, signal, traps at failures), traps and check scripts:")
  say()
  for (const n of [1, 2, 3]) {
    const these = details.filter((f) => !f.fact.project && (n === 3 ? f.fact.recurrence >= 3 : f.fact.recurrence === n))
    if (these.length === 0) continue
    say(`- seen in ${n === 3 ? "3 or more" : n} change(s): ${these.length}: ` + VERDICTS.map((v) => [v, these.filter((f) => f.verdict === v).length] as const).filter(([, c]) => c > 0).map(([v, c]) => `${v} ${c}`).join(", "))
  }
  say()
  lines.push("### Each fact fired (past, min rec 1, 700 chars, signal, traps at failures)", "")
  for (const f of details) {
    const where = f.moment.kind === "read" ? `read ${f.moment.file}` : f.moment.kind
    lines.push(`- ${f.session.id.slice(0, 8)} call ${f.at} ${where} [${f.verdict}] (${f.fact.recurrence}x) ${f.fact.text.slice(0, 220)}`)
  }
  lines.push("")
}
// The task-start card, the hooks' one use of facts: how often its first line names a script the session went
// on to run (by the file it runs), and any line of it. "stored": the records as stored (commands cut at 500
// characters, as the card of 2026-10-21 read them), with the repo's scripts only; "now": commands read again
// from the logs (Index.ts `commandsNow`), then with the scripts of the change the task is pointed to first
// (`lead`), and below the pointer's bar (the best match's, at a lower score). Past only: each task's facts from
// the changes committed before it, its own session's left out.
const now = new Map<string, WorkflowRecord>()
await Effect.runPromise(Effect.forEach(all, (r) => commandsNow(r).pipe(
  Effect.map((c) => { if (c !== undefined) now.set(r.id, { ...r, ...c }) }),
  Effect.orElseSucceed(() => undefined)
)).pipe(Effect.provide(NodeServices.layer)))
const cardCache = new Map<string, FactIndex>()
const cardIndex = (s: Session, r: WorkflowRecord, source: "stored" | "now") => {
  const key = `${source}\u0000${s.id}\u0000${startOf(r)}`
  const had = cardCache.get(key)
  if (had !== undefined) return had
  const records = all.filter((x) => x.subject === s.subject && x.run.session_id !== s.id && whenOf(x) < startOf(r))
    .map((x) => (source === "now" ? now.get(x.id) ?? x : x))
  const index = buildFacts(records, { subject: s.subject, env: process.env, now: "" })
  cardCache.set(key, index)
  return index
}
const cardVariants = [
  { label: "stored, repo-wide (yesterday's)", source: "stored", lead: false },
  { label: "now, repo-wide", source: "now", lead: false },
  { label: "now, the pointed-to change's first", source: "now", lead: true },
  { label: "now, the best match's first at 0.30", source: "now", lead: true, bar: 0.3 },
  { label: "now, the best match's first at 0.25", source: "now", lead: true, bar: 0.25 },
  { label: "now, the best match's first at 0.20", source: "now", lead: true, bar: 0.2 }
] as const
lines.push("## The task-start card", "")
lines.push(
  "| repo | card | starts with a card | first line run later | first line read or run later | any line read or run later | pointer's own script first | chars a card |",
  "|---|---|---|---|---|---|---|---|"
)
console.log("\n## The task-start card\n")
for (const subject of [...new Set(sessions.map((s) => s.subject))]) for (const v of cardVariants) {
  let cards = 0
  let firstRan = 0
  let firstTouched = 0
  let anyTouched = 0
  let ownFirst = 0
  let chars = 0
  for (const s of sessions.filter((x) => x.subject === subject)) {
    const given = new Set<string>()
    for (const [r, at] of s.starts) {
      const index = cardIndex(s, r, v.source)
      const docs = all.filter((x) => x.subject === s.subject && x.run.session_id !== s.id && whenOf(x) < startOf(r) && x.run.head_commit !== null)
        .map((x) => ({ id: x.id, prompt: x.task.prompt, message: x.task.message, record: x }))
      const best = rank(r.task.prompt, docs)[0]
      const pointed = best !== undefined && best.score >= ("bar" in v ? v.bar : MIN_SCORE) ? best.doc.record : undefined
      const facts = cardFacts(index, { sessionId: s.id, given, live: () => true }, v.lead ? pointed?.run.head_commit ?? undefined : undefined)
      const card = renderCard(facts, () => undefined)
      if (card.text === undefined) continue
      for (const f of card.facts) given.add(f.id)
      cards++
      chars += card.text.length
      const later = s.calls.filter((c) => c.at >= at)
      const ran = new Set(later.flatMap((c) => (c.command === undefined ? [] : scriptsRun(c.command, c.record.run.repo, process.env))).map((p) => p.toLowerCase()))
      // Read with the Read tool or a command (`cat ui.mjs`, `cp ui.mjs shots.mjs`), or run.
      const touched = new Set([
        ...ran,
        ...later.flatMap((c) =>
          c.command !== undefined
            ? scriptsNamed(c.command, c.record.run.repo, process.env)
            : c.call.name === "Read" && typeof c.call.input.file_path === "string"
            ? [resolvePath(c.call.input.file_path, process.env, undefined) ?? ""]
            : []
        ).map((p) => p.toLowerCase())
      ])
      const runs = (f: Fact) => f.paths.some((p) => ran.has(p.toLowerCase()))
      const touches = (f: Fact) => f.paths.some((p) => touched.has(p.toLowerCase()))
      if (runs(card.facts[0])) firstRan++
      if (touches(card.facts[0])) firstTouched++
      if (card.facts.some(touches)) anyTouched++
      if (pointed !== undefined && card.facts[0].commits.includes(pointed.run.head_commit!)) ownFirst++
    }
  }
  const row = `| ${subject} | ${v.label} | ${cards} | ${firstRan} | ${firstTouched} | ${anyTouched} | ${ownFirst} | ${cards === 0 ? 0 : Math.round(chars / cards)} |`
  lines.push(row)
  console.log(row)
}
lines.push("")
writeFileSync(opts.out, lines.join("\n") + "\n")
console.log(`\nDetails: ${opts.out}`)
