/**
 * Exact triggers: when a warning applies, as plain strings to look for in
 * what the agent is doing. Cheap enough to check on every tool call.
 *
 * - `command`: a shell command contains every string in `all` and none in `none`
 *   (`test:update` and `--watch=false`).
 * - `edit`: an edit whose file path ends with `file` (if given) writes text
 *   containing every string in `all` and none in `none` (`<Excalidraw`, but not
 *   `handleKeyboardGlobally`).
 * - `error`: a tool call failed, and its output contains every string in `all`
 *   (`matches of the string to replace`).
 *
 * Matching is case-sensitive substring search, never regular expressions, so
 * a trigger means the same thing to whoever reads it.
 */
import { Schema } from "effect"
import type { ToolCall } from "../traces/index.ts"
import { EDIT_TOOLS, reportsFailure, SHELL_TOOLS, SHELL_WRITE } from "../traces/index.ts"

export const TriggerOn = Schema.Literals(["command", "edit", "error"])
export type TriggerOn = typeof TriggerOn.Type

export const Trigger = Schema.Struct({
  on: TriggerOn,
  all: Schema.Array(Schema.String),
  none: Schema.Array(Schema.String),
  /** Edits only: the end of the edited file's path, with forward slashes (`.test.tsx`, `src/App.tsx`). */
  file: Schema.NullOr(Schema.String)
})
export type Trigger = typeof Trigger.Type

/** What one tool call did, as triggers see it. */
export interface ToolEvent {
  readonly tool: string
  /** Shell calls: the command line. */
  readonly command: string | undefined
  /** Edits and reads: the file, with forward slashes. */
  readonly file: string | undefined
  /**
   * Edits: the text written (new strings or the whole content). Shell
   * commands that look like they write files: the command itself, which
   * holds what they write.
   */
  readonly text: string | undefined
  /** The result, or the error text. Undefined before the call has run. */
  readonly output: string | undefined
  readonly failed: boolean
}

/**
 * Why a trigger can't be used, or undefined if it can. It must look for
 * something specific: a trigger that matched any command would fire all the time.
 */
export const triggerProblem = (t: Trigger): string | undefined => {
  if (t.all.length === 0) return "a trigger needs at least one string in `all`"
  const weak = t.all.find((s) => s.trim().length < 2 || !/[A-Za-z0-9]/.test(s))
  if (weak !== undefined) return `${JSON.stringify(weak)} is too short to look for`
  if (!t.all.some((s) => s.trim().length >= 5)) return "the strings in `all` are too short to be specific"
  if (t.on !== "edit" && t.file !== null) return "only edit triggers take a file"
  return undefined
}

const containsAll = (text: string, all: ReadonlyArray<string>) => all.every((s) => text.includes(s))
const containsNone = (text: string, none: ReadonlyArray<string>) => none.every((s) => !text.includes(s))

export const matchTrigger = (t: Trigger, e: ToolEvent): boolean => {
  switch (t.on) {
    case "command":
      return e.command !== undefined && containsAll(e.command, t.all) && containsNone(e.command, t.none)
    case "edit": {
      if (e.text === undefined) return false
      if (t.file !== null) {
        const file = t.file.replace(/\\/g, "/")
        // Shell writes (sed, heredocs) name their file somewhere in the command.
        const target = e.file !== undefined ? e.file.endsWith(file) : (e.command ?? "").replace(/\\/g, "/").includes(file)
        if (!target) return false
      }
      return containsAll(e.text, t.all) && containsNone(e.text, t.none)
    }
    case "error":
      return e.failed && e.output !== undefined && containsAll(e.output, t.all) && containsNone(e.output, t.none)
  }
}

/** A stable key for grouping identical triggers. */
export const triggerKey = (t: Trigger): string =>
  JSON.stringify([t.on, [...t.all].sort(), [...t.none].sort(), t.file])

/** A trigger in words, for people and for the agent. */
export const describeTrigger = (t: Trigger): string => {
  const q = (xs: ReadonlyArray<string>) => xs.map((s) => `\`${s}\``).join(" and ")
  const none = t.none.length > 0 ? `, without ${t.none.map((s) => `\`${s}\``).join(" or ")}` : ""
  switch (t.on) {
    case "command":
      return `a command with ${q(t.all)}${none}`
    case "edit":
      return `an edit${t.file === null ? "" : ` to a file ending in \`${t.file}\``} that writes ${q(t.all)}${none}`
    case "error":
      return `a failure that says ${q(t.all)}`
  }
}

const slashes = (p: string) => p.replace(/\\/g, "/")

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** The text an edit tool writes. */
export const editText = (tool: string, input: Readonly<Record<string, unknown>>): string | undefined => {
  if (tool === "Write") return str(input.content)
  if (tool === "Edit") return str(input.new_string)
  if (tool === "NotebookEdit") return str(input.new_source)
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.map((e) => (typeof e === "object" && e !== null ? str((e as Record<string, unknown>).new_string) ?? "" : "")).join("\n")
  }
  return undefined
}

/** A recorded tool call as an event. `relative` shortens paths (to the repo root). */
export const eventOfCall = (call: ToolCall, relative: (path: string) => string = (p) => p): ToolEvent => {
  const shell = SHELL_TOOLS.has(call.name)
  const command = shell ? str(call.input.command) : undefined
  const path = str(call.input.file_path) ?? str(call.input.notebook_path)
  const output = call.result
  return {
    tool: call.name,
    command,
    file: path === undefined ? undefined : slashes(relative(path)),
    text: EDIT_TOOLS.has(call.name)
      ? editText(call.name, call.input)
      : command !== undefined && SHELL_WRITE.test(command) ? command : undefined,
    output,
    failed: call.isError || (shell && output !== undefined && reportsFailure(output))
  }
}
