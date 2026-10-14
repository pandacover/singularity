/**
 * Claude Code hook entry point for memory, separate from the CLI so that it
 * starts fast:
 *
 *     node src/workflows/hook.ts user-prompt-submit   (UserPromptSubmit)
 *     node src/workflows/hook.ts user-prompt-submit-2 (kept for installed settings; hands over nothing)
 *     node src/workflows/hook.ts post-tool-use        (PostToolUse and PostToolUseFailure)
 *     node src/workflows/hook.ts session-end          (SessionEnd)
 *
 * Memory is saved scripts (src/scripts/): at a session's first prompt, the
 * stored change most like the task is handed over, read from git, or nothing.
 * There is no learning step and no warning during the task. The same script
 * serves Codex, Gemini CLI and Droid, whose hooks speak Claude Code's format,
 * and Hermes Agent, whose plugin (src/setup/HermesPlugin.ts) speaks it for
 * Hermes. Memory stores a change when it is committed: after a tool call that
 * ran a committing command, a background run stores the commit with the steps
 * that led to it (src/workflows/Commits.ts), and every task start and session
 * end starts one too, for commits made outside the agent. Eval runs store
 * nothing: they measure memory as it was.
 *
 * The event's JSON comes on stdin; what the model should see goes to stdout as
 * `hookSpecificOutput.additionalContext`. Each event loads only its own
 * modules: the tool-call hook runs after every call and never touches git or
 * a model unless the call committed.
 *
 * A hook must never break the session it serves: any error is written to
 * `<home>/hook-errors.log` and the hook exits 0 with no output.
 * `SINGULARITY_HOOKS=off` turns every hook off, except an eval run's own,
 * which the harness would mark with `--eval-run`: hooks installed for daily
 * work stay silent in runs.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const home = () => process.env.SINGULARITY_HOME || join(homedir(), ".singularity")

const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf-8")
}

const logError = (event: string, error: unknown) => {
  try {
    mkdirSync(home(), { recursive: true })
    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
    appendFileSync(join(home(), "hook-errors.log"), `${new Date().toISOString()} workflows ${event}: ${text}\n`)
  } catch {
    // Nowhere to report it; stay quiet rather than break the session.
  }
}

const event = process.argv[2] ?? ""
const evalRun = process.argv.includes("--eval-run")
if (process.env.SINGULARITY_HOOKS !== "off" || evalRun) {
  try {
    const stdin = await readStdin()
    let out: string | undefined
    if (event === "post-tool-use") {
      // Saved scripts give no warnings during a task: the hook only starts storing after a commit.
      // Most calls end here: no word a committing command has (StoreTrigger's MAY_COMMIT), no module loaded.
      if (!evalRun && /commit|merge|cherry-pick|revert|\bam\b|pull|rebase/i.test(stdin)) {
        const trigger = await import("./StoreTrigger.ts")
        if (trigger.ranCommit(stdin)) trigger.startStoring(stdin)
      }
    } else if (event === "user-prompt-submit") {
      out = await (await import("../scripts/Hook.ts")).userPromptSubmit(stdin)
      if (!evalRun) (await import("./StoreTrigger.ts")).startStoring(stdin)
    } else if (event === "user-prompt-submit-2") {
      // Saved scripts hand over in one part.
    } else if (event === "session-end") {
      if (!evalRun) (await import("./StoreTrigger.ts")).startStoring(stdin)
    } else {
      logError(event, new Error(`unknown hook event ${JSON.stringify(event)}`))
    }
    if (out !== undefined) process.stdout.write(out)
  } catch (error) {
    logError(event, error)
  }
}
process.exit(0)
