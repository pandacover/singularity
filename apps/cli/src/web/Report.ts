/**
 * The "new job" benchmark's report: harm first, then success and cost by
 * phase and by kind of chore, traps hit again, the update, the mazes, and the
 * bars written before the runs (DESIGN-one-layer.md).
 *
 * Reads each condition's results.jsonl and the runner's `reveal` (saved after
 * the runs), which says what each chore was. Tolerant of how `reveal` names
 * things: a chore's category comes from `category` (or `kind`).
 */
import { Effect, FileSystem, Path } from "effect"

export interface Row {
  readonly setup: string
  readonly condition: string
  readonly phase: string
  readonly task_id: string
  readonly success: boolean
  readonly num_turns: number | null
  readonly cost_usd: number | null
  readonly tokens: { readonly total: number } | null
  readonly traps_hit: ReadonlyArray<string>
  readonly moves: number | null
  readonly fewest_moves: number | null
  readonly started_at: string
  readonly status: string
  readonly browser_calls?: number
}

export interface ChoreInfo {
  readonly id: string
  readonly category: string
  readonly kind: string
  readonly app: string
}

const median = (xs: ReadonlyArray<number>): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const sum = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0)
const pct = (a: number, b: number) => (b === 0 ? "–" : `${Math.round((100 * a) / b)}%`)
const fmt = (x: number | null, d = 0) => (x === null ? "–" : x.toFixed(d))
const k = (x: number | null) => (x === null ? "–" : `${Math.round(x / 1000)}k`)
const change = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? "–" : `${a >= b ? "+" : ""}${Math.round((100 * (a - b)) / b)}%`)

/** What `reveal` says of each chore, whatever shape it has. */
export const choresOfReveal = (reveal: unknown): Map<string, ChoreInfo> => {
  const out = new Map<string, ChoreInfo>()
  const r = reveal as Record<string, unknown>
  const list: Array<Record<string, unknown>> = Array.isArray(r.chores) ? (r.chores as Array<Record<string, unknown>>) : r.chores !== null && typeof r.chores === "object"
    ? Object.entries(r.chores as Record<string, Record<string, unknown>>).map(([id, v]): Record<string, unknown> => ({ id, ...v }))
    : []
  for (const c of list) {
    const id = String(c.id ?? c.chore ?? "")
    if (id === "") continue
    out.set(id, { id, category: String(c.category ?? c.kind ?? "?"), kind: String(c.kind ?? c.category ?? "?"), app: String(c.app ?? "?") })
  }
  return out
}

export const loadRows = Effect.fn("web.loadRows")(function*(dirs: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const rows: Array<Row> = []
  for (const d of dirs) {
    const file = path.join(d, "results.jsonl")
    if (!(yield* fs.exists(file))) continue
    for (const l of (yield* fs.readFileString(file)).split(/\r?\n/)) {
      if (l.trim() === "") continue
      try {
        rows.push(JSON.parse(l) as Row)
      } catch {
        // a partial line
      }
    }
  }
  return rows
})

export const report = (rows: ReadonlyArray<Row>, chores: ReadonlyMap<string, ChoreInfo>, opts: { readonly memory: string; readonly none: string }): string => {
  const L: Array<string> = []
  const setups = [...new Set(rows.map((r) => r.setup))]
  const phases = ["learn", "test", "update"].filter((p) => rows.some((r) => r.phase === p))
  const of = (setup: string, phase?: string, pred: (r: Row) => boolean = () => true) =>
    rows.filter((r) => r.setup === setup && (phase === undefined || r.phase === phase) && pred(r))
  const cat = (r: Row) => chores.get(r.task_id)?.category ?? "?"
  const byChore = (setup: string) => new Map(of(setup).map((r) => [`${r.phase}/${r.task_id}`, r]))

  // 1. Harm.
  const mem = byChore(opts.memory)
  const none = byChore(opts.none)
  const harm = [...mem.entries()].filter(([key, r]) => !r.success && none.get(key)?.success === true)
  const helped = [...mem.entries()].filter(([key, r]) => r.success && none.get(key)?.success === false)
  L.push("## 1. Harm: chores memory failed that no memory passed", "")
  if (harm.length === 0) L.push("None.", "")
  else {
    L.push("| Phase | Chore | Category | Memory turns | No-memory turns |", "|---|---|---|---|---|")
    for (const [key, r] of harm) L.push(`| ${r.phase} | ${r.task_id} | ${cat(r)} | ${fmt(r.num_turns)} | ${fmt(none.get(key)?.num_turns ?? null)} |`)
    L.push("")
  }
  L.push(`The other way (memory passed, no memory failed): ${helped.length === 0 ? "none" : helped.map(([, r]) => `${r.phase}/${r.task_id} (${cat(r)})`).join(", ")}.`, "")

  // 2. Success and cost by condition and phase.
  L.push("## 2. Success and cost, by condition and phase", "", "| Condition | Phase | Runs | Success | Median turns | Median tokens | Median $ | Total $ |", "|---|---|---|---|---|---|---|---|")
  for (const s of setups) {
    for (const p of phases) {
      const rs = of(s, p)
      if (rs.length === 0) continue
      L.push(`| ${s} | ${p} | ${rs.length} | ${pct(rs.filter((r) => r.success).length, rs.length)} | ${fmt(median(rs.flatMap((r) => (r.num_turns === null ? [] : [r.num_turns]))))} | ${k(median(rs.flatMap((r) => (r.tokens === null ? [] : [r.tokens.total]))))} | ${fmt(median(rs.flatMap((r) => (r.cost_usd === null ? [] : [r.cost_usd]))), 3)} | ${fmt(sum(rs.flatMap((r) => (r.cost_usd === null ? [] : [r.cost_usd]))), 2)} |`)
    }
  }
  L.push("")

  // 3. By category.
  const cats = [...new Set(rows.map(cat))].sort()
  L.push("## 3. By kind of chore", "", `| Category | ${setups.map((s) => `${s} success · median turns`).join(" | ")} |`, `|---|${setups.map(() => "---").join("|")}|`)
  for (const c of cats) {
    const cells = setups.map((s) => {
      const rs = of(s, undefined, (r) => cat(r) === c)
      return rs.length === 0 ? "–" : `${rs.filter((r) => r.success).length}/${rs.length} · ${fmt(median(rs.flatMap((r) => (r.num_turns === null ? [] : [r.num_turns]))))}`
    })
    L.push(`| ${c} | ${cells.join(" | ")} |`)
  }
  L.push("")

  // 4. Traps hit again.
  L.push("## 4. Traps", "", "| Condition | Trap hits | Hits on a trap this condition had hit before |", "|---|---|---|")
  for (const s of setups) {
    const seen = new Set<string>()
    let hits = 0
    let again = 0
    for (const r of [...of(s)].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
      for (const t of r.traps_hit) {
        hits++
        if (seen.has(t)) again++
        seen.add(t)
      }
    }
    L.push(`| ${s} | ${hits} | ${again} |`)
  }
  L.push("")

  // 5. The update.
  const upd = (s: string) => [...of(s, "update")].sort((a, b) => a.started_at.localeCompare(b.started_at))
  if (rows.some((r) => r.phase === "update")) {
    L.push("## 5. After the update, chore by chore (turns, pass or fail)", "", `| Chore | Category | ${setups.map((s) => s).join(" | ")} |`, `|---|---|${setups.map(() => "---").join("|")}|`)
    for (const r of upd(opts.memory).length > 0 ? upd(opts.memory) : upd(opts.none)) {
      const cells = setups.map((s) => {
        const x = of(s, "update", (y) => y.task_id === r.task_id)[0]
        return x === undefined ? "–" : `${fmt(x.num_turns)} ${x.success ? "pass" : "FAIL"}`
      })
      L.push(`| ${r.task_id} | ${cat(r)} | ${cells.join(" | ")} |`)
    }
    L.push("")
  }

  // 6. Mazes.
  const mazes = rows.filter((r) => r.fewest_moves !== null || cat(r).includes("maze"))
  if (mazes.length > 0) {
    L.push("## 6. Mazes", "", "| Condition | Phase | Chore | Solved | Moves | Fewest | Turns |", "|---|---|---|---|---|---|---|")
    for (const r of [...mazes].sort((a, b) => a.setup.localeCompare(b.setup) || a.started_at.localeCompare(b.started_at))) {
      L.push(`| ${r.setup} | ${r.phase} | ${r.task_id} | ${r.success ? "yes" : "no"} | ${fmt(r.moves)} | ${fmt(r.fewest_moves)} | ${fmt(r.num_turns)} |`)
    }
    L.push("")
  }

  // 7. The bars.
  L.push("## 7. The bars written before the runs", "")
  const fails = (s: string, p: string) => of(s, p).filter((r) => !r.success).length
  const turns = (s: string, p: string | undefined, pred: (r: Row) => boolean) => median(of(s, p, pred).flatMap((r) => (r.num_turns === null ? [] : [r.num_turns])))
  const succ = (s: string, p: string | undefined, pred: (r: Row) => boolean) => {
    const rs = of(s, p, pred)
    return rs.length === 0 ? null : rs.filter((r) => r.success).length / rs.length
  }
  const bars: Array<[string, boolean | null, string]> = []
  for (const p of phases) {
    const a = fails(opts.memory, p)
    const b = fails(opts.none, p)
    bars.push([`No more failures than no memory in ${p}`, of(opts.memory, p).length === 0 ? null : a <= b, `${a} against ${b}`])
  }
  const repeatish = (r: Row) => ["repeat", "shares-parts"].includes(cat(r))
  const tm = turns(opts.memory, "test", repeatish)
  const tn = turns(opts.none, "test", repeatish)
  const sm = succ(opts.memory, "test", repeatish)
  const sn = succ(opts.none, "test", repeatish)
  bars.push(["Test, repeats and shares-parts: median turns at least 20% below no memory, success no lower", tm === null || tn === null ? null : tm <= 0.8 * tn && (sm ?? 0) >= (sn ?? 0), `turns ${fmt(tm)} against ${fmt(tn)} (${change(tm, tn)}), success ${sm === null ? "–" : pct(sm * 100, 100)} against ${sn === null ? "–" : pct(sn * 100, 100)}`])
  const risky = (r: Row) => ["look-alike", "unrelated"].includes(cat(r))
  const rm = turns(opts.memory, "test", risky)
  const rn = turns(opts.none, "test", risky)
  const rsm = succ(opts.memory, "test", risky)
  const rsn = succ(opts.none, "test", risky)
  bars.push(["Look-alikes and unrelated: success no lower, median turns at most 10% above", rm === null || rn === null ? null : (rsm ?? 0) >= (rsn ?? 0) && rm <= 1.1 * rn, `turns ${fmt(rm)} against ${fmt(rn)} (${change(rm, rn)}), success ${rsm === null ? "–" : pct(rsm * 100, 100)} against ${rsn === null ? "–" : pct(rsn * 100, 100)}`])
  const um = upd(opts.memory)
  const un = upd(opts.none)
  if (um.length > 0 && un.length > 0) {
    const half = (rs: ReadonlyArray<Row>) => rs.slice(Math.floor(rs.length / 2))
    const cm = sum(half(um).flatMap((r) => (r.num_turns === null ? [] : [r.num_turns])))
    const cn = sum(half(un).flatMap((r) => (r.num_turns === null ? [] : [r.num_turns])))
    const usm = um.filter((r) => r.success).length
    const usn = un.filter((r) => r.success).length
    bars.push(["Update: success no lower, and the last half of update chores costs no more turns", usm >= usn && cm <= cn, `success ${usm}/${um.length} against ${usn}/${un.length}; last half ${cm} turns against ${cn}`])
  }
  L.push("| Bar | Holds | Numbers |", "|---|---|---|")
  for (const [name, ok, numbers] of bars) L.push(`| ${name} | ${ok === null ? "no data" : ok ? "yes" : "**no**"} | ${numbers} |`)
  const verdict = bars.every(([, ok]) => ok !== false) ? "**Memory passes the bars.**" : "**Memory fails the bars.**"
  L.push("", verdict, "")
  return L.join("\n")
}
