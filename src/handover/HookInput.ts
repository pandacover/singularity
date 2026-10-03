/**
 * What Claude Code sends a command hook on stdin, for the events we use.
 * Fields we don't use are ignored. See the hooks reference in Claude Code's
 * docs: UserPromptSubmit has `prompt`; PostToolUse has `tool_name`,
 * `tool_input` and `tool_response`; PostToolUseFailure has `error` instead of
 * a response; SessionEnd has `reason`.
 */
import { Option, Predicate, Schema } from "effect"
import type { ToolEvent } from "../records/Triggers.ts"
import { editText } from "../records/Triggers.ts"
import { EDIT_TOOLS, reportsFailure, SHELL_TOOLS, SHELL_WRITE } from "../traces/index.ts"
import { relativizer } from "../records/Extract.ts"

export const HookInput = Schema.Struct({
  session_id: Schema.String,
  transcript_path: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  hook_event_name: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  tool_response: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String)
})
export type HookInput = typeof HookInput.Type

export const decodeHookInput = (text: string): HookInput | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(HookInput))(text))

const str = (v: unknown): string | undefined => (Predicate.isString(v) ? v : undefined)

/** A tool response as text: a shell's stdout and stderr, or anything else as JSON. */
const responseText = (response: unknown): string | undefined => {
  if (response === undefined || response === null) return undefined
  if (Predicate.isString(response)) return response
  if (Predicate.isObject(response)) {
    const r = response as Record<string, unknown>
    const out = [str(r.stdout), str(r.stderr)].filter((s): s is string => s !== undefined && s !== "")
    if (out.length > 0) return out.join("\n")
  }
  return JSON.stringify(response)
}

/** The tool call a PostToolUse or PostToolUseFailure hook reports, as triggers see it. */
export const eventOfHook = (input: HookInput, repoRoot: string | undefined): ToolEvent | undefined => {
  const tool = input.tool_name
  const args = input.tool_input
  if (tool === undefined || args === undefined) return undefined
  const shell = SHELL_TOOLS.has(tool)
  const command = shell ? str(args.command) : undefined
  const path = str(args.file_path) ?? str(args.notebook_path)
  const failed = input.error !== undefined
  const output = failed ? input.error : responseText(input.tool_response)
  return {
    tool,
    command,
    file: path === undefined ? undefined : relativizer(repoRoot)(path),
    text: EDIT_TOOLS.has(tool) ? editText(tool, args) : command !== undefined && SHELL_WRITE.test(command) ? command : undefined,
    output,
    failed: failed || (shell && output !== undefined && reportsFailure(output))
  }
}
