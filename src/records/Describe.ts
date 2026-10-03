/**
 * Records as text, for people.
 */
import type { WorkflowRecord } from "./Models.ts"

const k = (n: number) => `${Math.round(n / 1000)}k`

const firstLine = (s: string, max = 90) => {
  const line = s.trim().split(/\r?\n/)[0] ?? ""
  return line.length > max ? line.slice(0, max - 3) + "..." : line
}

/** One line per record: id, outcome, detours, kind or task. */
export const recordLine = (r: WorkflowRecord): string => {
  const what = r.model?.kind.name ?? firstLine(r.task.prompt, 70)
  const tokens = r.run.tokens === null ? "?" : k(r.run.tokens)
  return `${r.id.padEnd(24)} ${r.run.outcome === "success" ? "ok  " : "FAIL"} ${tokens.padStart(6)} ` +
    `${String(r.detours.length).padStart(2)} detours  ${what}`
}

/** A record in full, as Markdown. */
export const describeRecord = (r: WorkflowRecord): string => {
  const lines = [
    `# ${r.id}`,
    "",
    `- subject ${r.subject}, tenant ${r.tenant}; ${r.run.source}${r.run.setup ? ` (${r.run.setup})` : ""}; ${r.run.outcome}`,
    `- ${r.run.turns} turns, ${r.run.tool_calls} tool calls, ${r.run.tokens === null ? "?" : k(r.run.tokens)} tokens` +
    (r.run.cost_usd === null ? "" : `, $${r.run.cost_usd.toFixed(2)}`),
    `- base ${r.run.base_commit?.slice(0, 12) ?? "?"}${r.run.head_commit ? `, head ${r.run.head_commit.slice(0, 12)}` : ""}`,
    `- log ${r.run.log}`,
    "",
    "## Task",
    "",
    r.task.prompt,
    ...r.task.followups.map((f) => `\nThen: ${f}`),
    "",
    "## Files changed",
    "",
    ...(r.files.length === 0 ? ["(none)"] : r.files.map((f) => `- ${f.path} (${f.status}, +${f.added} -${f.removed}${f.snapshot ? ", snapshot" : ""})`))
  ]
  if (r.detours.length > 0) {
    lines.push("", "## Detours", "")
    for (const d of r.detours) {
      const failed = d.failed.command ?? `${d.failed.tool} ${d.failed.file ?? ""}`
      const fixed = d.fixed.command ?? `${d.fixed.tool} ${d.fixed.file ?? ""}`
      lines.push(`- ${d.kind}, ${d.cost.turns} turns, ${k(d.cost.tokens)} tokens${d.failures > 1 ? `, failed ${d.failures} times` : ""}`)
      lines.push(`  - failed: \`${firstLine(failed, 120)}\``)
      for (const s of d.symptom.split("\n").slice(0, 2)) lines.push(`    - ${firstLine(s, 140)}`)
      lines.push(`  - fixed: \`${firstLine(fixed, 120)}\``)
      if (d.removed.length + d.added.length > 0) {
        lines.push(`    - dropped ${d.removed.map((w) => `\`${w}\``).join(" ") || "nothing"}, added ${d.added.map((w) => `\`${w}\``).join(" ") || "nothing"}`)
      }
      if (d.files_edited.length > 0) lines.push(`    - after editing ${d.files_edited.join(", ")}`)
    }
  }
  const failed = r.commands.filter((c) => !c.ok)
  if (failed.length > 0) {
    lines.push("", "## Commands that failed", "")
    for (const c of failed) lines.push(`- \`${firstLine(c.command, 120)}\`: ${firstLine(c.error ?? "", 120)}`)
  }
  if (r.checks.length > 0) {
    lines.push("", "## Checks", "")
    for (const c of r.checks) lines.push(`- ${c.ok ? "pass" : "FAIL"} \`${firstLine(c.command, 120)}\``)
  }
  if (r.memory !== null) {
    lines.push("", `## Memory it was given (${r.memory.setup})`, "")
    for (const i of r.memory.items) lines.push(`- ${i.kind} ${i.id} at ${i.moment}: ${i.outcome}${i.note ? ` (${i.note})` : ""}`)
  }
  const m = r.model
  if (m !== null) {
    lines.push("", `## The model's reading (${m.model})`, "", `Kind: **${m.kind.name}**: ${m.kind.description}`)
    if (m.asked.length > 0) lines.push(`Asked: ${m.asked.join("; ")}`)
    if (m.ruled_out.length > 0) lines.push(`Ruled out: ${m.ruled_out.join("; ")}`)
    if (m.values.length > 0) lines.push(`This task's own values: ${m.values.map((v) => `${v.name} = ${v.value}`).join("; ")}`)
    lines.push("", "Steps:", "")
    m.steps.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.name}** (${s.origin}): ${s.purpose}`)
      if (s.files.length > 0) lines.push(`   - files: ${s.files.join(", ")}`)
      if (s.check !== null) lines.push(`   - checked by \`${s.check}\``)
      for (const l of s.landmarks) lines.push(`   - ${l.fact} (${l.file}: ${l.anchors.map((a) => `\`${a}\``).join(", ")})`)
    })
    if (m.lessons.length > 0) {
      lines.push("", "Lessons:", "")
      for (const l of m.lessons) lines.push(`- ${l.lesson}${l.trigger === null ? "" : ` [trigger: ${l.trigger.on} ${l.trigger.all.join(" + ")}]`}`)
    }
    if (m.false_leads.length > 0) {
      lines.push("", "False leads:", "")
      for (const f of m.false_leads) lines.push(`- ${f.what}${f.file === null ? "" : ` (${f.file})`}`)
    }
    if (m.dropped.length > 0) {
      lines.push("", "Claims dropped by the checks:", "")
      for (const d of m.dropped) lines.push(`- ${d}`)
    }
  }
  return lines.join("\n") + "\n"
}
