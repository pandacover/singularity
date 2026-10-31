/**
 * Claude Code hook entry point for computer-use memory, apart from the coding
 * hook (src/workflows/hook.ts) so that each part is set up and taken out on
 * its own (src/computer/Setup.ts):
 *
 *     node src/computer/hook.ts post-tool-use        (PostToolUse and PostToolUseFailure: browser and computer-use tools)
 *     node src/computer/hook.ts user-prompt-submit   (UserPromptSubmit)
 *     node src/computer/hook.ts session-end          (SessionEnd)
 *
 * After a browser call, the app card and a screen's notes (Handover.ts). At
 * a task's start, the card when the prompt names a known app's address. At
 * task start and session end, a session that used these tools is stored in
 * the background (`computer-use store`, Capture.ts), one run at a time under
 * `store.lock`.
 *
 * The tool-call hook runs after every call its matcher names, screenshots
 * included, whose input can be megabytes: the tool's name is checked on the
 * raw input before anything is parsed or loaded. Like every hook of memory's,
 * it never breaks the session: errors go to `<home>/hook-errors.log`, and it
 * exits 0. `SINGULARITY_HOOKS=off` turns it off.
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
    appendFileSync(join(home(), "hook-errors.log"), `${new Date().toISOString()} computer ${event}: ${text}\n`)
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
      // Most calls end here: not a tool memory reads. The same test as Calls.ts COMPUTER_TOOL, without loading it.
      if (/"tool_name"\s*:\s*"mcp__(?:Claude_Browser|claude-in-chrome|computer-use|[^"]*?__browser_)/.test(stdin)) {
        out = await (await import("./HookRun.ts")).afterToolCall(stdin)
      }
    } else if (event === "user-prompt-submit") {
      out = await (await import("./HookRun.ts")).atPrompt(stdin)
    } else if (event === "session-end") {
      await (await import("./HookRun.ts")).atSessionEnd(stdin)
    } else {
      logError(event, new Error(`unknown hook event ${JSON.stringify(event)}`))
    }
    if (out !== undefined) process.stdout.write(out)
  } catch (error) {
    logError(event, error)
  }
}
// As in the coding hook: end by running out of work, never process.exit while work finishes (Windows).
process.exitCode = 0
setTimeout(() => process.exit(0), 5000).unref()
