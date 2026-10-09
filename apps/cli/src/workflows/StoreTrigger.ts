/**
 * Hooks start memory's storing (Commits.ts) in the background: right after an
 * agent ran a command that can make a commit, and when a task starts or a
 * session ends, for commits made outside the agent. The hook returns at once;
 * `record commits --background` does the work.
 *
 * Plain node, the hook's input read with JSON.parse alone: the tool-call hook
 * runs after every call, and almost every call ends at the first check. A
 * hook that doesn't say where the session ran (Hermes Agent's session end)
 * leaves it to the background run, which reads it from the session's log.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { startInBackground } from "../setup/Background.ts"

/** A command that can make a commit: `git commit`, `git -C x cherry-pick`, `npm run commit`. */
export const COMMITTING = /\bcommit\b|\bgit\b[^|;&\n]*\b(merge|cherry-pick|revert|am|pull|rebase)\b/i

/** Words a committing command has somewhere: a check on the hook's raw input, before parsing it. */
export const MAY_COMMIT = /commit|merge|cherry-pick|revert|\bam\b|pull|rebase/i

interface HookFields {
  readonly session_id?: unknown
  readonly transcript_path?: unknown
  readonly cwd?: unknown
  readonly tool_input?: unknown
}

const fieldsOf = (stdin: string): HookFields | undefined => {
  try {
    const value: unknown = JSON.parse(stdin)
    return typeof value === "object" && value !== null ? (value as HookFields) : undefined
  } catch {
    return undefined
  }
}

/** The command a tool call ran, in any agent's shape: `command`, or Codex's `cmd` (a line, or its words). */
export const commandOf = (toolInput: unknown): string | undefined => {
  if (typeof toolInput !== "object" || toolInput === null) return undefined
  const { command, cmd } = toolInput as { readonly command?: unknown; readonly cmd?: unknown }
  const value = command ?? cmd
  if (typeof value === "string") return value
  return Array.isArray(value) && value.every((w) => typeof w === "string") ? value.join(" ") : undefined
}

/** Whether the tool call a PostToolUse hook reports ran a command that can make a commit. */
export const ranCommit = (stdin: string): boolean => {
  if (!MAY_COMMIT.test(stdin)) return false
  const command = commandOf(fieldsOf(stdin)?.tool_input)
  return command !== undefined && COMMITTING.test(command)
}

/** Store, in the background, the commits memory hasn't looked at yet, with the hook's session known. */
export const startStoring = (stdin: string): void => {
  const fields = fieldsOf(stdin)
  if (fields === undefined || typeof fields.session_id !== "string") return
  const args = ["record", "commits", "--background", "--session", fields.session_id]
  if (typeof fields.cwd === "string" && fields.cwd !== "") args.push("--cwd", fields.cwd)
  if (typeof fields.transcript_path === "string" && fields.transcript_path !== "") args.push("--transcript", fields.transcript_path)
  startInBackground(process.env.SINGULARITY_HOME || join(homedir(), ".singularity"), args, "store.log")
}
