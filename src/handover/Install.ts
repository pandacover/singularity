/**
 * Claude Code settings that run the hooks, and merging them into a settings
 * file without touching anything else in it.
 *
 * - UserPromptSubmit: the route and its warnings at task start (up to a
 *   minute, for the model that confirms the route).
 * - PostToolUse and PostToolUseFailure, for shell commands and edits:
 *   warnings whose trigger appears. Reads, searches and the like never
 *   trigger anything, so they don't run the hook.
 * - SessionEnd: record the session if it committed a change with passing tests.
 *
 * Our entries are recognized by the hook script's path, so installing twice
 * replaces them and uninstalling removes only them.
 */
import { Predicate } from "effect"
import { fileURLToPath } from "node:url"

/** The hook entry point, next to the CLI. */
export const HOOK_SCRIPT = fileURLToPath(new URL("../hook.ts", import.meta.url))

export interface HookSpec {
  readonly event: string
  readonly arg: string
  readonly matcher: string | undefined
  /** Seconds. */
  readonly timeout: number
}

export const TOOL_MATCHER = "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit"

export const HOOKS: ReadonlyArray<HookSpec> = [
  { event: "UserPromptSubmit", arg: "user-prompt-submit", matcher: undefined, timeout: 90 },
  { event: "PostToolUse", arg: "post-tool-use", matcher: TOOL_MATCHER, timeout: 15 },
  { event: "PostToolUseFailure", arg: "post-tool-use", matcher: TOOL_MATCHER, timeout: 15 },
  { event: "SessionEnd", arg: "session-end", matcher: undefined, timeout: 30 }
]

const slashes = (p: string) => p.replace(/\\/g, "/")

/** The hook's command line: node and the script, quoted for the shell Claude Code runs it in. */
export const hookCommand = (node: string, script: string, arg: string): string =>
  `"${slashes(node)}" "${slashes(script)}" ${arg}`

type Json = Record<string, unknown>

const isOurs = (script: string) => (entry: unknown): boolean => {
  if (!Predicate.isObject(entry)) return false
  const hooks = (entry as Json).hooks
  return Array.isArray(hooks) && hooks.some((h) =>
    Predicate.isObject(h) && Predicate.isString((h as Json).command) && slashes((h as Json).command as string).includes(slashes(script))
  )
}

/** The `hooks` settings for our hook script, as `claude --settings` takes them; `extra` adds hooks of its own. */
export const hooksSettings = (node: string, script: string, extra: ReadonlyArray<HookSpec> = []): Json => {
  const hooks: Record<string, Array<Json>> = {}
  for (const h of [...HOOKS, ...extra]) {
    const entry: Json = { hooks: [{ type: "command", command: hookCommand(node, script, h.arg), timeout: h.timeout }] }
    if (h.matcher !== undefined) entry.matcher = h.matcher
    hooks[h.event] = [...(hooks[h.event] ?? []), entry]
  }
  return { hooks }
}

/** `settings` without our hooks; other hooks and settings stay as they were. */
export const withoutOurHooks = (settings: Json, script: string): Json => {
  if (!Predicate.isObject(settings.hooks)) return settings
  const hooks: Record<string, unknown> = {}
  for (const [event, entries] of Object.entries(settings.hooks as Json)) {
    const kept = Array.isArray(entries) ? entries.filter((e) => !isOurs(script)(e)) : entries
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept
  }
  const out: Json = { ...settings, hooks }
  if (Object.keys(hooks).length === 0) delete out.hooks
  return out
}

/** `settings` with our hooks added (replacing any earlier copy of them). */
export const withOurHooks = (settings: Json, node: string, script: string): Json => {
  const base = withoutOurHooks(settings, script)
  const hooks: Record<string, unknown> = Predicate.isObject(base.hooks) ? { ...(base.hooks as Json) } : {}
  for (const [event, entries] of Object.entries(hooksSettings(node, script).hooks as Record<string, Array<Json>>)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as Array<unknown>) : []
    hooks[event] = [...existing, ...entries]
  }
  return { ...base, hooks }
}

/** Whether `settings` runs our hooks. */
export const hasOurHooks = (settings: Json, script: string): boolean =>
  Predicate.isObject(settings.hooks) &&
  Object.values(settings.hooks as Json).some((entries) => Array.isArray(entries) && entries.some(isOurs(script)))
