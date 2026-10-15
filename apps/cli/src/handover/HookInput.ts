/**
 * What Claude Code sends a command hook on stdin, for the events we use.
 * Fields we don't use are ignored. See the hooks reference in Claude Code's
 * docs: UserPromptSubmit has `prompt`; PostToolUse has `tool_name`,
 * `tool_input` and `tool_response`; PostToolUseFailure has `error` instead of
 * a response, and is how a call's failure is known (a shell command that
 * exits with an error is one); SessionEnd has `reason`. A call a helper agent
 * made carries its `agent_id`.
 */
import { Option, Schema } from "effect"

export const HookInput = Schema.Struct({
  session_id: Schema.String,
  // Codex sends null when a session has no transcript.
  transcript_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  hook_event_name: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  tool_response: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  /** Set when a helper agent (a subagent) made the call; absent for the main thread. */
  agent_id: Schema.optionalKey(Schema.String)
})
export type HookInput = typeof HookInput.Type

export const decodeHookInput = (text: string): HookInput | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(HookInput))(text))
