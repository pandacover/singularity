/**
 * Claude Code hook entry point for memory, separate from the CLI so that it
 * starts fast:
 *
 *     node src/workflows/hook.ts user-prompt-submit   (UserPromptSubmit)
 *     node src/workflows/hook.ts user-prompt-pick     (UserPromptSubmit, in the background: Claude Code)
 *     node src/workflows/hook.ts post-tool-use        (PostToolUse and PostToolUseFailure)
 *     node src/workflows/hook.ts session-end          (SessionEnd)
 *
 * Memory is saved scripts (src/scripts/): at a prompt that starts a task (one
 * that asks for something, the session's first such or the first after a
 * commit: src/scripts/Cycle.ts), a pointer to the stored change most like the
 * task, read from git, and the repo's card of check scripts earlier sessions
 * ran (src/facts/), or nothing. A tool call that reads a stored commit with
 * `git show` or `git log` gets what git doesn't show about it
 * (src/scripts/History.ts). There is no learning step. The same script
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
 * modules: the tool-call hook runs after every call and touches git only
 * when the call committed or ran `git show` or `git log`. The task-start
 * hook reads the repo's fact index; it never builds it.
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
      // A stored commit the agent read with git show or git log: what git doesn't show about it. Most calls end at
      // the first check, no "git" then "show" or "log" in the input, and most of the rest at the second
      // (History.ts), before the hand-over's modules load; its failure is logged apart, so a commit is still
      // stored. The input is JSON, where a command's newlines are written `\n`: one line, so `.` needs no `s`
      // flag to span them.
      if (/\bgit\b.{0,160}?\b(?:show|log)\b/.test(stdin)) {
        try {
          if ((await import("../scripts/History.ts")).readsCommits(stdin)) out = await (await import("../scripts/Hook.ts")).handOverRead(stdin)
        } catch (error) {
          logError(event, error)
        }
      }
      // Most calls end here: no word a committing command has (StoreTrigger's MAY_COMMIT), no module loaded.
      if (!evalRun && /commit|merge|cherry-pick|revert|\bam\b|pull|rebase/i.test(stdin)) {
        const trigger = await import("./StoreTrigger.ts")
        if (trigger.ranCommit(stdin)) trigger.startStoring(stdin)
      }
    } else if (event === "user-prompt-submit") {
      // `--picks`: the model's pick runs beside this hook (Claude Code's background hook, below).
      out = await (await import("../scripts/Hook.ts")).userPromptSubmit(stdin, process.argv.includes("--picks"))
      if (!evalRun) (await import("./StoreTrigger.ts")).startStoring(stdin)
    } else if (event === "user-prompt-pick") {
      // The model's pick of the past change, when the person chose one (src/scripts/Pick.ts). Claude Code runs
      // it in the background and hands its output to the agent at its next step.
      out = await (await import("../scripts/Hook.ts")).userPromptPick(stdin)
    } else if (event === "user-prompt-submit-2") {
      // The second task-start hook of a hand-over in two parts, which setup no longer writes. Settings
      // not yet updated (`singularity update` takes it out) still run it: do nothing, and log nothing.
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
// The hook ends by running out of work, not with process.exit: on Windows, process.exit while other threads
// still finish work trips a libuv assertion (async.c:76) and the hook dies with exit 127, which Claude Code
// logs as a hook error, dropping what the hook printed. Something left holding the process open gets 5 s.
process.exitCode = 0
setTimeout(() => process.exit(0), 5000).unref()
