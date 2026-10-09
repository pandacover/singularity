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
 * `--parts=2` after a task-start event says the hand-over comes in two parts,
 * from two hooks (`SINGULARITY_HANDOVER_PARTS` says the same for eval runs).
 * The same script serves Codex, Gemini CLI and Droid, whose hooks speak
 * Claude Code's format; only Claude Code's sessions are recorded at their end.
 * When a recorded session makes it time to learn, and the user turned
 * learning on its own on, a learning round starts in the background
 * (src/setup/AutoLearn.ts).
 *
 * The event's JSON comes on stdin; what the model should see goes to stdout as
 * `hookSpecificOutput.additionalContext`. Each event loads only its own
 * modules: the tool-call hook runs after every call and never touches git or
 * a model.
 *
 * A hook must never break the session it serves: any error is written to
 * `<home>/hook-errors.log` and the hook exits 0 with no output.
 * `SINGULARITY_HOOKS=off` turns every hook off, except an eval run's own,
 * which the harness marks with `--eval-run` (`RUN_HOOK_FLAG` in
 * handover/Install.ts): hooks installed for daily work stay silent in runs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const home = () => process.env.SINGULARITY_HOME || join(homedir(), ".singularity")

/**
 * Which reader handed the session memory at its start (src/layer/Api.ts):
 * code (v1's session file) or web, checked with nothing but the file system.
 */
const sessionKind = (stdin: string): "code" | "web" | undefined => {
  try {
    const sessionId = (JSON.parse(stdin) as { session_id?: unknown }).session_id
    const config = JSON.parse(readFileSync(join(home(), "config.json"), "utf-8")) as { tenant?: unknown }
    if (typeof sessionId !== "string" || typeof config.tenant !== "string") return undefined
    const file = `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`
    if (existsSync(join(home(), "tenants", config.tenant, "workflows", "sessions", file))) return "code"
    if (existsSync(join(home(), "tenants", config.tenant, "web", "sessions", file))) return "web"
    return undefined
  } catch {
    return undefined
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
const parts = process.argv.find((a) => a.startsWith("--parts="))?.slice("--parts=".length) ?? process.env.SINGULARITY_HANDOVER_PARTS
if (process.env.SINGULARITY_HOOKS !== "off" || process.argv.includes("--eval-run")) {
  try {
    const stdin = await readStdin()
    let out: string | undefined
    // Every event goes to the memory layer's calls (src/layer/Api.ts): start, step, end.
    if (event === "post-tool-use") {
      const kind = sessionKind(stdin)
      if (kind === "code") out = await (await import("./HookTool.ts")).postToolUse(stdin)
      else if (kind === "web") out = await (await import("../web/HookStep.ts")).webPostToolUse(stdin)
    } else if (event === "user-prompt-submit") {
      out = await (await import("../layer/Api.ts")).startFromHook(stdin, 1, parts)
    } else if (event === "user-prompt-submit-2") {
      out = await (await import("./HookStart.ts")).userPromptSubmit(stdin, 2, parts)
    } else if (event === "session-end") {
      if (sessionKind(stdin) === "web") {
        await (await import("../web/HookStep.ts")).webSessionEnd(stdin)
      } else {
        const outcome = await (await import("./HookEnd.ts")).sessionEnd(stdin)
        if (outcome?.reason === "recorded" && outcome.subject !== undefined) await (await import("../setup/AutoLearn.ts")).afterRecord(outcome.subject)
      }
    } else {
      logError(event, new Error(`unknown hook event ${JSON.stringify(event)}`))
    }
    if (out !== undefined) process.stdout.write(out)
  } catch (error) {
    logError(event, error)
  }
}
process.exit(0)
