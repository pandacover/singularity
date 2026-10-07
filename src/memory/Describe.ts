/**
 * The memory graph as text, for people.
 */
import { describeTrigger } from "../records/Triggers.ts"
import type { MemoryGraph, Reach } from "./Models.ts"
import type { ReplayReport } from "./Replay.ts"

const reachText = (r: Reach) =>
  r.scope === "tenant" ? "every subject" : r.scope === "tools" ? `${r.subjects.join(", ")}, and repos using ${r.tools.join(", ")}` : r.subjects.join(", ")

const k = (n: number) => `${Math.round(n / 1000)}k`

export const describeMemory = (g: MemoryGraph, version: number | string): string => {
  const steps = new Map(g.steps.map((s) => [s.id, s]))
  const lines = [
    `# Memory, ${typeof version === "number" ? `version ${version}` : `candidate ${version}`}`,
    "",
    `${g.kinds.length} task kinds, ${g.steps.length} steps, ${g.warnings.length} warnings.`,
    "",
    "## Task kinds",
    ""
  ]
  for (const kind of g.kinds) {
    lines.push(`### ${kind.name} (${kind.id})`, "", `${kind.description} Seen in ${kind.evidence.length} runs; reaches ${reachText(kind.reach)}.`, "")
    kind.route.forEach((e, i) => {
      const step = steps.get(e.step)
      const how = `taken ${e.taken}/${kind.evidence.length}` + (e.chosen > 0 ? `, unasked ${e.chosen}` : "")
      lines.push(`${i + 1}. ${e.required ? "**required**" : "optional"} ${step?.name ?? e.step} (${how})`)
      if (e.condition !== null) lines.push(`   - ${e.condition}`)
    })
    lines.push("")
  }
  lines.push("## Steps", "")
  for (const s of g.steps) {
    lines.push(`- **${s.name}** (${s.id}): ${s.purpose}`)
    for (const [subject, p] of Object.entries(s.where)) {
      if (p.files.length > 0) lines.push(`  - ${subject} files (of ${p.runs} runs): ${p.files.map((f) => `${f.path} (${f.seen})`).join(", ")}`)
      for (const l of p.landmarks) lines.push(`  - ${subject}: ${l.fact} (${l.file}; seen ${l.seen})`)
      if (p.checks.length > 0) lines.push(`  - ${subject} checked by: ${p.checks.map((c) => `\`${c.slice(0, 100)}\``).join("; ")}`)
      for (const s of p.spots ?? []) {
        const between = [s.above, s.below].map((l) => (l === null ? "-" : `\`${l.slice(0, 70)}\``)).join(" and ")
        lines.push(`  - ${subject} spot in ${s.file}: between ${between} (${s.records.length} runs)`)
      }
      for (const e of p.examples ?? []) lines.push(`  - ${subject} read first: ${e.path} (${e.records.length} runs)`)
    }
  }
  lines.push("", "## Warnings", "")
  for (const w of g.warnings) {
    const where = w.step !== null ? `step ${w.step}` : w.kind !== null ? `kind ${w.kind}` : "any task"
    lines.push(`- ${w.lesson}`)
    lines.push(`  - ${where}; ${w.moment}; seen ${w.seen}, cost ${k(w.cost.tokens)} tokens / ${w.cost.turns} turns; reaches ${reachText(w.reach)} (${w.id})`)
    if (w.trigger !== null) lines.push(`  - trigger: ${describeTrigger(w.trigger)}`)
  }
  return lines.join("\n") + "\n"
}

export const describeReplay = (r: ReplayReport, verbose = false): string => {
  const lines = [
    `Replay over ${r.cases.length} past tasks: ${r.extra} steps handed over but not needed (${r.unasked} the task never asked for), ` +
    `${r.missing} needed but not handed over, ${r.wrongKind} tasks matched to another kind; ` +
    `warnings would reach ${r.warned} of ${r.detours} detours with a lesson, and fire on ${r.falseAlarms} commands that worked.`
  ]
  for (const c of r.cases) {
    if (!verbose && c.extra.length + c.missing.length === 0 && c.picked === c.kind) continue
    const parts = [
      c.picked !== c.kind ? `matched ${c.picked ?? "nothing"} instead of ${c.kind}` : "",
      c.extra.length > 0 ? `extra ${c.extra.join(", ")}` : "",
      c.missing.length > 0 ? `missing ${c.missing.join(", ")}` : ""
    ].filter((p) => p !== "")
    lines.push(`- ${c.record}: ${parts.join("; ") || "ok"}`)
  }
  return lines.join("\n")
}
