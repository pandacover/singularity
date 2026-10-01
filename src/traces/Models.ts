/**
 * Normalized view of a Claude Code session transcript.
 */
import { DateTime } from "effect"

export interface Usage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens: number
  readonly cache_read_input_tokens: number
}

export const emptyUsage: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
}

export const usageTotal = (u: Usage): number =>
  u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens
})

/** Field-wise max, for merging repeated logs of one response. */
export const maxUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: Math.max(a.input_tokens, b.input_tokens),
  output_tokens: Math.max(a.output_tokens, b.output_tokens),
  cache_creation_input_tokens: Math.max(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
  cache_read_input_tokens: Math.max(a.cache_read_input_tokens, b.cache_read_input_tokens)
})

/** The JSON shape used in run records: `{input, output, cache_creation, cache_read, total}`. */
export const usageToJson = (u: Usage) => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cache_creation: u.cache_creation_input_tokens,
  cache_read: u.cache_read_input_tokens,
  total: usageTotal(u)
})

/** A message typed by the user (or sent by the harness) on the main thread. */
export interface Prompt {
  readonly text: string
  readonly timestamp: DateTime.Utc | undefined
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  /** Undefined for the main thread, otherwise the subagent's id. */
  readonly agentId: string | undefined
  readonly startedAt: DateTime.Utc | undefined
  finishedAt: DateTime.Utc | undefined
  /** Text of the tool result; undefined if no result was logged (e.g. interrupted). */
  result: string | undefined
  isError: boolean
}

export const toolCallDuration = (c: ToolCall): number | undefined =>
  c.startedAt === undefined || c.finishedAt === undefined ? undefined : secondsBetween(c.startedAt, c.finishedAt)

/** One model API response. Claude Code logs each content block as its own line. */
export interface Response {
  readonly id: string
  readonly model: string
  readonly agentId: string | undefined
  readonly timestamp: DateTime.Utc | undefined
  usage: Usage
  text: string
  readonly toolCallIds: Array<string>
  stopReason: string | undefined
}

export interface Trace {
  readonly sessionId: string
  readonly path: string
  readonly cwd: string | undefined
  readonly gitBranch: string | undefined
  readonly version: string | undefined
  readonly prompts: ReadonlyArray<Prompt>
  /** Sorted by timestamp. */
  readonly responses: ReadonlyArray<Response>
  /** Sorted by start time. */
  readonly toolCalls: ReadonlyArray<ToolCall>
  /** Synthetic assistant messages Claude Code writes when an API call fails. */
  readonly apiErrors: number
  /**
   * Claude Code's own running totals from the last "cost-state" line. Unlike
   * `responses`, these include side calls (e.g. WebFetch summarization).
   */
  readonly costState: Readonly<Record<string, unknown>> | undefined
  readonly startedAt: DateTime.Utc | undefined
  readonly endedAt: DateTime.Utc | undefined
  readonly skippedLines: number
}

export const traceUsage = (t: Trace): Usage => t.responses.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage)

export const usageByModel = (t: Trace): Map<string, Usage> => {
  const out = new Map<string, Usage>()
  for (const r of t.responses) out.set(r.model, addUsage(out.get(r.model) ?? emptyUsage, r.usage))
  return out
}

export const traceModels = (t: Trace): Array<string> => [...new Set(t.responses.map((r) => r.model))].sort()

export const traceAgentIds = (t: Trace): Array<string> =>
  [...new Set(t.responses.flatMap((r) => (r.agentId === undefined ? [] : [r.agentId])))].sort()

export const traceWallTime = (t: Trace): number | undefined =>
  t.startedAt === undefined || t.endedAt === undefined ? undefined : secondsBetween(t.startedAt, t.endedAt)

const secondsBetween = (a: DateTime.Utc, b: DateTime.Utc): number => (DateTime.toEpochMillis(b) - DateTime.toEpochMillis(a)) / 1000
