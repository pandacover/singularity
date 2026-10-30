/**
 * The benchmark's guide arm (Bench.ts): at the task's first prompt, the text
 * in `$SINGULARITY_STATIC_HANDOVER` as the hook's context, the channel memory's
 * card uses. Plain node; never breaks the session.
 */
import { readFileSync } from "node:fs"

try {
  const file = process.env.SINGULARITY_STATIC_HANDOVER
  const text = file === undefined || file === "" ? "" : readFileSync(file, "utf-8").trim()
  if (text !== "") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }))
} catch {
  // Nothing to hand over.
}
