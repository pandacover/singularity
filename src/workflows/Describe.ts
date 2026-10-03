/**
 * Memory v1 in words, for people: the workflows in graph order with their
 * steps, places and pitfalls, then the edges.
 */
import { describeTrigger } from "../records/Triggers.ts"
import { describePlace } from "./Induce.ts"
import { graphOrder, type WorkflowMemory } from "./Models.ts"

export const describeMemory = (m: WorkflowMemory, version: number | string): string => {
  const places = new Map(m.places.map((p) => [p.id, p]))
  const pitfalls = new Map(m.pitfalls.map((p) => [p.id, p]))
  const lines = [
    `Workflow memory ${version}: ${m.workflows.length} workflows, ${m.places.length} places, ${m.pitfalls.length} pitfalls, ${m.edges.length} edges`,
    ""
  ]
  for (const w of graphOrder(m)) {
    lines.push(`## ${w.id}: ${w.name}`, `   use when: ${w.use_when}`)
    if (w.blanks.length > 0) lines.push(`   blanks: ${w.blanks.map((b) => `{${b.name}} ${b.meaning}`).join("; ")}`)
    w.steps.forEach((s, i) => {
      const p = s.place === null ? undefined : places.get(s.place)
      lines.push(`   ${i + 1}. ${s.do}${s.when === null ? "" : ` [when: ${s.when}]`}`)
      if (p !== undefined) lines.push(`      at ${describePlace(p)}`)
    })
    if (w.checks.length > 0) lines.push(`   checks: ${w.checks.join("; ")}`)
    for (const id of w.pitfalls) {
      const p = pitfalls.get(id)
      if (p !== undefined) lines.push(`   pitfall ${p.id}: ${p.text}${p.trigger === null ? "" : ` (fires on ${describeTrigger(p.trigger)})`}`)
    }
    lines.push(`   from ${w.evidence.length} runs of ${w.tasks.join(", ") || "no task"}`, "")
  }
  const loose = m.pitfalls.filter((p) => !m.workflows.some((w) => w.pitfalls.includes(p.id)))
  if (loose.length > 0) {
    lines.push("Pitfalls in no workflow:")
    for (const p of loose) lines.push(`- ${p.id}: ${p.text}${p.trigger === null ? "" : ` (fires on ${describeTrigger(p.trigger)})`}`)
    lines.push("")
  }
  lines.push("Edges:")
  for (const e of m.edges) {
    const extra = [e.condition === null ? "" : `if ${e.condition}`, e.guidance === null ? "" : `guidance: ${e.guidance}`, e.pitfalls === null ? "" : `avoid: ${e.pitfalls}`]
      .filter(Boolean)
      .join("; ")
    lines.push(`- ${e.from} -${e.relation}-> ${e.to}${extra ? `: ${extra}` : ""}`)
  }
  return lines.join("\n")
}
