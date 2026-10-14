/**
 * What the person wrote in a prompt, told apart from what the tools around
 * them added. Records keep only the person's words (records/Build.ts), and
 * stored records are read through the same filter (JsonRecordStore.ts), so
 * learning never takes a tool's text for what was asked.
 *
 * - A prompt Claude Code marks as the system's (`promptSource: "system"`:
 *   notices of background tasks, messages from other sessions) is no one's
 *   words (`Prompt.harness`, set by Parse.ts).
 * - Inside a prompt, what Claude Code, T3 Code and the desktop app add goes:
 *   reminders and notices in their tags, slash commands' output, image
 *   notes, the context T3 attaches to images and annotations, the desktop
 *   app's canned commands ("Create PR"), and notes that a request was
 *   interrupted. A slash command keeps the arguments the person typed.
 * - A quote of the assistant keeps only the person's comment on it: a T3
 *   quote link's `comment=`, or an older citation's `comment`. A preview
 *   annotation keeps its comment.
 * - Pasted text is marked as pasted, as quoted lines (`> `): the text between
 *   two `---` lines (or after a last one), the way the person pastes a draft
 *   or a comment. Quoted lines belong to the person's message but aren't
 *   their words: `ownWords` leaves them out.
 *
 * Pure, and the same when applied again to its own result.
 */
import { Option, Schema } from "effect"
import type { Prompt } from "./Models.ts"

/** Blocks a tool wraps in tags of its own, dropped whole. */
const TOOL_BLOCK =
  /<(system-reminder|task-notification|local-command-stdout|local-command-stderr|local-command-caveat|t3_context|[a-z]+(?:-[a-z]+)*-command)\b[^>]*>[\s\S]*?<\/\1>/g

/** A slash command as Claude Code logs it: what the person typed after the command is its arguments. */
const SLASH_COMMAND =
  /<command-name>[\s\S]*?<\/command-name>\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?(?:<command-args>([\s\S]*?)<\/command-args>)?/g

/** Whole prompts a tool sent in the person's place. */
const TOOL_PROMPT = [
  /^\[Request interrupted by user[^\]\n]*\]$/,
  /^The app was quit while you were working\. Please continue from where you left off\.$/
]

/** Notes about attached images, and T3's notes about attachments. */
const ATTACHMENT_NOTES = [
  /\[Attached image "[^"\n]*" is saved at: [^\]\n]*\]/g,
  /\[Image(?: #\d+|: [^\]\n]*)\]/g,
  /!\[[^\]\n]*\]\(t3-context:\/\/[^)\s]*\)/g,
  /\[User attached [^\]\n]*\]/g,
  /^Attachment metadata:[ \t]*(?:\n- [^\n]*)*/gm
]

/** A T3 quote link: `[Assistant quote](t3-citation://…?text=…&comment=…)`. */
const QUOTE_LINK = /\[Assistant quote\]\((t3-citation:\/\/[^)\s]*)\)/g

/** An older T3 quote: `[assistant-quote-1]` where it was put, with its citation in a block below. */
const QUOTE_MARK = /\[assistant-quote-(\d+)\]/g
const CITATIONS = /<assistant_citations>([\s\S]*?)<\/assistant_citations>/g

const Citations = Schema.fromJsonString(Schema.Array(Schema.Struct({
  id: Schema.String,
  citation: Schema.Struct({ comment: Schema.optionalKey(Schema.NullOr(Schema.String)) })
})))

/** `[Preview annotation: a side by side comparison would look better; ref=…]` */
const ANNOTATION = /\[Preview annotation: ([^\]\n]*?); ref=[^\]\n]*\]/g

const PASTE_FENCE = /^\s*-{3,}\s*$/
const QUOTED = /^\s*>/

/** The person's comment on a T3 quote link, if they wrote one. */
const linkComment = (url: string): string => {
  try {
    return new URL(url).searchParams.get("comment") ?? ""
  } catch {
    return ""
  }
}

/** The comments of an older T3 citation block, by quote id. */
const citationComments = (text: string): Map<string, string> => {
  const comments = new Map<string, string>()
  for (const m of text.matchAll(CITATIONS)) {
    const body = m[1]
    const json = body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Citations)(json))
    for (const c of decoded ?? []) comments.set(c.id, c.citation.comment ?? "")
  }
  return comments
}

/** Text between `---` lines turned into quoted lines, the fences dropped. */
const markPasted = (text: string): string => {
  const out: Array<string> = []
  let pasted = false
  for (const line of text.split("\n")) {
    if (PASTE_FENCE.test(line)) {
      pasted = !pasted
      continue
    }
    out.push(pasted && line.trim() !== "" && !QUOTED.test(line) ? `> ${line}` : line)
  }
  return out.join("\n")
}

/** Spaces left where something was taken out of a line closed up, and blank lines to one. */
const tidy = (text: string): string =>
  text.split("\n").map((l) => l.replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ").replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim()

/** What the person wrote in a prompt's text: the tools' parts dropped, quotes reduced to the person's comments, pasted text quoted. */
export const personText = (text: string): string => {
  let t = text.replace(/\r\n?/g, "\n")
  if (TOOL_PROMPT.some((p) => p.test(t.trim()))) return ""
  const comments = citationComments(t)
  t = t.replace(CITATIONS, " ")
  t = t.replace(QUOTE_MARK, (_, n: string) => ` ${comments.get(`assistant-quote-${n}`) ?? ""} `)
  t = t.replace(TOOL_BLOCK, " ")
  t = t.replace(SLASH_COMMAND, (_, args: string | undefined) => (args ?? "").trim())
  for (const note of ATTACHMENT_NOTES) t = t.replace(note, " ")
  t = t.replace(QUOTE_LINK, (_, url: string) => ` ${linkComment(url)} `)
  t = t.replace(ANNOTATION, (_, comment: string) => ` ${comment} `)
  return tidy(markPasted(t))
}

/** The person's own words: their text without what they pasted or quoted. */
export const ownWords = (text: string): string =>
  tidy(personText(text).split("\n").filter((l) => !QUOTED.test(l)).join("\n"))

/** Whether a prompt holds anything the person wrote. */
export const isPersonPrompt = (p: Prompt): boolean => p.harness !== true && personText(p.text) !== ""

/** The prompts the person wrote, each as `personText` has it; the rest left out. */
export const personPrompts = (prompts: ReadonlyArray<Prompt>): Array<Prompt> =>
  prompts.flatMap((p) => {
    if (p.harness === true) return []
    const text = personText(p.text)
    return text === "" ? [] : [{ ...p, text }]
  })

/** A task's prompts as the person wrote them: the first one that holds anything, then the others. */
export const personTask = (prompts: ReadonlyArray<string>): { readonly prompt: string; readonly followups: Array<string> } => {
  const [prompt, ...followups] = prompts.map(personText).filter((t) => t !== "")
  return { prompt: prompt ?? "", followups }
}
