/**
 * A task-start hook that hands over a fixed text: how the benchmark's
 * baselines (an onboarding guide, Agent Workflow Memory's workflows) reach the
 * agent, through the same door and at the same moment as the memory layer's
 * own hand-over.
 *
 *     node src/web/StaticHook.ts   (UserPromptSubmit)
 *
 * `SINGULARITY_STATIC_HANDOVER` names a JSON file: {"all": text} for every
 * task, or {"by_origin": {"http://localhost:5101": text, ...}} for the app the
 * task's first address names. Never breaks a session: on any error it prints
 * nothing and exits 0.
 */
import { readFileSync } from "node:fs"

const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf-8")
}

try {
  const input = JSON.parse(await readStdin()) as { prompt?: unknown; hook_event_name?: unknown }
  const file = process.env.SINGULARITY_STATIC_HANDOVER
  if (file !== undefined && typeof input.prompt === "string") {
    const spec = JSON.parse(readFileSync(file, "utf-8")) as { all?: unknown; by_origin?: Record<string, unknown> }
    const url = /https?:\/\/[^\s)>"'\]]+/.exec(input.prompt)?.[0]
    let origin: string | undefined
    try {
      origin = url === undefined ? undefined : new URL(url).origin
    } catch {
      origin = undefined
    }
    const text = typeof spec.all === "string" ? spec.all : origin !== undefined && typeof spec.by_origin?.[origin] === "string" ? (spec.by_origin[origin] as string) : undefined
    if (text !== undefined && text.trim() !== "") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: typeof input.hook_event_name === "string" ? input.hook_event_name : "UserPromptSubmit", additionalContext: text.slice(0, 9800) } }))
    }
  }
} catch {
  // never break a session
}
process.exit(0)
