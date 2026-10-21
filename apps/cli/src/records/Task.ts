/**
 * What a stored change is found by. A record's task is what the person asked
 * for, and in a conversation the first prompt of a commit's part of the log
 * is as often "yes" or "commit and open a PR" as a request (traces/Requests.ts):
 * the task is the first prompt there that asks, else, at storing, the last
 * one that asked before it (workflows/Commits.ts). The commit message says
 * what the change did whatever the person typed, so a record keeps it too
 * (`task.message`); records stored before it get it from git when read
 * (scripts/Start.ts).
 *
 * A change is found by its task when the task asks for something, and by its
 * message (`taskKeys`): "commit and open a PR" never matches the next
 * session's "commit and open a PR".
 */
import { isRequest, MIN_WORDS, ownTerms } from "../traces/Requests.ts"

/** A record's task, as the search and the hand-over read it. */
export interface TaskText {
  readonly prompt: string
  readonly followups: ReadonlyArray<string>
  /** The commit message(s) of the change, without trailers (`messageText`); absent on records stored before it. */
  readonly message?: string | undefined
}

/**
 * The task among a commit's prompts, in order (the first, then the
 * follow-ups): the first that asks for something, the others its follow-ups;
 * when none asks, the first, as it was.
 */
export const taskOf = (prompts: ReadonlyArray<string>): { prompt: string; followups: Array<string> } => {
  const asks = prompts.findIndex(isRequest)
  const at = asks < 0 ? 0 : asks
  return { prompt: prompts[at] ?? "", followups: prompts.filter((_, i) => i !== at) }
}

/** Trailers git and agents add (`Co-Authored-By: Claude … <noreply@…>`): every agent's commit has them, so they tell no change apart. */
const TRAILER = /^(?:[A-Za-z][\w-]*: .*<[^<>\s]+@[^<>\s]+>|(?:Co-authored-by|Signed-off-by|Change-Id|Reviewed-by):.*)$/i

/** A commit message as words to find its change by: trailers left out, blank lines to one. */
export const messageText = (raw: string): string =>
  raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !TRAILER.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

/** The messages of a change's commits as one text, oldest first, each once. */
export const changeMessage = (messages: ReadonlyArray<string>): string =>
  [...new Set(messages.map(messageText).filter((m) => m !== ""))].join("\n\n")

/**
 * The texts a stored change is found by: its task when the task asks for
 * something, and its commit message when that says as much as a request
 * must (`MIN_WORDS` words of its own). A task with no message at all (an
 * eval's saved run, never committed; a commit git no longer has) is found by
 * its prompt, as before messages were kept; one filed under "yes" whose
 * message says too little ("wip") isn't found by its words at all. The
 * whole message, not only its first line:
 * looking up each change of the real memory replayed (examples/scripts/
 * replay-real-memory.ts), the first line handed over 5, 2 of them unrelated,
 * the whole message 4, all related; the markdownlint runs' picks stay the same.
 */
export const taskKeys = (task: { readonly prompt: string; readonly message?: string | undefined }): Array<string> => {
  const message = task.message?.trim() ?? ""
  // A message of a word or two ("MD061", "wip") is held by every prompt that names it: it tells nothing apart.
  const telling = ownTerms(message).size >= MIN_WORDS
  const byPrompt = task.prompt.trim() !== "" && (isRequest(task.prompt) || message === "")
  return [...(byPrompt ? [task.prompt] : []), ...(telling ? [message] : [])]
}

/** What the change was for, in a line or a paragraph: its task when that asks for something, else its commit message. */
export const taskShown = (task: { readonly prompt: string; readonly message?: string | undefined }): string =>
  isRequest(task.prompt) || task.message === undefined || task.message === "" ? task.prompt : task.message
