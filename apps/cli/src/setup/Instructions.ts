/**
 * The recall note: a short block in an agent's user-level instruction file
 * (Claude Code's CLAUDE.md, Codex's and OpenCode's AGENTS.md; Agents.ts says
 * which file each reads) telling the agent it can run `singularity recall`
 * mid-task. Memory hands over at a task's start (src/scripts/Start.ts), and
 * adds what git doesn't show about a stored commit the agent reads
 * (src/scripts/History.ts); the note is how an agent
 * knows to look again when the task turns to something done before.
 *
 * The block sits between two marker comments, so setup adds it once and
 * replaces it in place when its text changes, and uninstall takes it out
 * leaving the rest of the file as it was. It goes at the end of the file,
 * after a blank line; taking it out takes that blank line too. A file that
 * didn't end with a newline keeps the one added before the block. A file
 * left empty once the block is out goes: it was setup's (agents skip an
 * empty instruction file anyway, and OpenCode would read an existing one
 * instead of Claude Code's).
 *
 * The text editing is plain functions; reading and writing files is Effect.
 */
import { Effect, FileSystem, Path } from "effect"
import { writeFileWhole } from "../local/Files.ts"

export const NOTE_START = "<!-- singularity:start (added by `singularity setup`; `singularity uninstall` removes it) -->"
export const NOTE_END = "<!-- singularity:end -->"

/** What the note tells the agent, without its markers: for eval drivers that hand it over themselves. */
export const RECALL_NOTE = `## singularity memory

This machine keeps the changes past coding sessions committed in each git
repository. At task start you may be handed one, headed "A past change in
this repository like your task".

Mid-task, when you are about to do something that was likely done before in
this repository (a kind of change, a fix, a command that keeps failing), run
\`singularity recall "<what you are about to do>"\` in the repository. It
prints the most similar past change, read from git as it is now, or says there
is none. It calls no model. Don't run it at every step, or for the task you
were just handed a change for.`

/** The note with its markers, as it goes in a file (with `\n` line endings). */
export const NOTE_BLOCK = `${NOTE_START}\n${RECALL_NOTE}\n${NOTE_END}`

export type NoteState = "missing" | "current" | "outdated"

/** Where the block is in `text`: from its start marker to the end of its end marker's line. */
const findBlock = (text: string): { readonly start: number; readonly end: number } | undefined => {
  const start = text.indexOf("<!-- singularity:start")
  if (start < 0 || (start > 0 && text[start - 1] !== "\n")) return undefined
  const endMarker = text.indexOf(NOTE_END, start)
  if (endMarker < 0) return undefined
  let end = endMarker + NOTE_END.length
  if (text.startsWith("\r\n", end)) end += 2
  else if (text[end] === "\n") end += 1
  return { start, end }
}

/** The block in the file's line endings: CRLF when the file uses them. */
const blockFor = (text: string, block: string) => (text.includes("\r\n") ? block.replace(/\n/g, "\r\n") : block)

/** Whether `text` holds the note, as `block` is now. */
export const noteState = (text: string, block: string = NOTE_BLOCK): NoteState => {
  const found = findBlock(text)
  if (found === undefined) return "missing"
  const current = text.slice(found.start, found.end).replace(/\r\n/g, "\n").replace(/\n$/, "")
  return current === block ? "current" : "outdated"
}

/** `text` with the note: replaced in place when it is there, else added at the end after a blank line. */
export const withNote = (text: string, block: string = NOTE_BLOCK): string => {
  const ours = blockFor(text, block)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const found = findBlock(text)
  if (found !== undefined) return text.slice(0, found.start) + ours + eol + text.slice(found.end)
  if (text === "") return ours + eol
  const ended = text.endsWith("\n") ? text : text + eol
  return ended + eol + ours + eol
}

/** `text` without the note, and without the blank line put before it. */
export const withoutNote = (text: string): string => {
  const found = findBlock(text)
  if (found === undefined) return text
  let before = text.slice(0, found.start)
  const after = text.slice(found.end)
  if (after === "") {
    if (before.endsWith("\r\n\r\n")) before = before.slice(0, -2)
    else if (before.endsWith("\n\n")) before = before.slice(0, -1)
  }
  return before + after
}

/**
 * An agent's user-level instruction files, in the order it reads them: it
 * uses the first that isn't empty. `create` is the one setup writes when none
 * has text.
 */
export interface InstructionFiles {
  readonly reads: ReadonlyArray<string>
  readonly create: string
}

const readText = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))

/** The file the agent reads now: the first with text, else the one to create. */
export const noteTarget = Effect.fn("noteTarget")(function*(files: InstructionFiles) {
  const fs = yield* FileSystem.FileSystem
  for (const file of files.reads) {
    const text = yield* readText(fs, file)
    if (text !== undefined && text.trim() !== "") return file
  }
  return files.create
})

/** Put the note in the file the agent reads; that file and whether it changed. */
export const installNote = Effect.fn("installNote")(function*(files: InstructionFiles, block: string = NOTE_BLOCK) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* noteTarget(files)
  const text = (yield* readText(fs, file)) ?? ""
  const next = withNote(text, block)
  if (next === text) return { file, changed: false }
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileWhole(fs, file, next)
  return { file, changed: true }
})

/** Take the note out of a file; whether it was there. A file left empty goes. */
export const removeNote = Effect.fn("removeNote")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* readText(fs, file)
  if (text === undefined || findBlock(text) === undefined) return false
  const rest = withoutNote(text)
  if (rest === "") yield* fs.remove(file)
  else yield* writeFileWhole(fs, file, rest)
  return true
})

/** Whether the file the agent reads now has the note, and how current it is. */
export const noteIn = Effect.fn("noteIn")(function*(files: InstructionFiles) {
  const fs = yield* FileSystem.FileSystem
  const file = yield* noteTarget(files)
  const text = yield* readText(fs, file)
  return { file, state: text === undefined ? "missing" as NoteState : noteState(text) }
})
