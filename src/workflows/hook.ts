/**
 * Claude Code hook entry point for memory v1, separate from the CLI and from
 * v0's hooks (src/hook.ts) so that each starts fast and neither changes the
 * other:
 *
 *     node src/workflows/hook.ts user-prompt-submit   (UserPromptSubmit)
 *     node src/workflows/hook.ts user-prompt-submit-2 (UserPromptSubmit: the hand-over's second part, when it has one)
 *     node src/workflows/hook.ts post-tool-use        (PostToolUse and PostToolUseFailure)
 *     node src/workflows/hook.ts session-end          (SessionEnd)
 *
 * The event's JSON comes on stdin; what the model should see goes to stdout as
 * `hookSpecificOutput.additionalContext`. Each event loads only its own
 * modules: the tool-call hook runs after every call and never touches git or
 * a model.
 *
 * A hook must never break the session it serves: any error is written to
 * `<home>/hook-errors.log` and the hook exits 0 with no output.
 * `SINGULARITY_HOOKS=off` turns every hook off.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const home = () => process.env.SINGULARITY_HOME || join(homedir(), ".singularity")

/** Whether the session was handed v1 memory at its start, checked with nothing but the file system. */
const hasSession = (stdin: string): boolean => {
  try {
    const sessionId = (JSON.parse(stdin) as { session_id?: unknown }).session_id
    const config = JSON.parse(readFileSync(join(home(), "config.json"), "utf-8")) as { tenant?: unknown }
    if (typeof sessionId !== "string" || typeof config.tenant !== "string") return false
    return existsSync(join(home(), "tenants", config.tenant, "workflows", "sessions", `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`))
  } catch {
    return false
  }
}

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
if (process.env.SINGULARITY_HOOKS !== "off") {
  try {
    const stdin = await readStdin()
    let out: string | undefined
    if (event === "post-tool-use") {
      if (hasSession(stdin)) out = await (await import("./HookTool.ts")).postToolUse(stdin)
    } else if (event === "user-prompt-submit") {
      out = await (await import("./HookStart.ts")).userPromptSubmit(stdin)
    } else if (event === "user-prompt-submit-2") {
      out = await (await import("./HookStart.ts")).userPromptSubmit(stdin, 2)
    } else if (event === "session-end") {
      await (await import("./HookEnd.ts")).sessionEnd(stdin)
    } else {
      logError(event, new Error(`unknown hook event ${JSON.stringify(event)}`))
    }
    if (out !== undefined) process.stdout.write(out)
  } catch (error) {
    logError(event, error)
  }
}
process.exit(0)
