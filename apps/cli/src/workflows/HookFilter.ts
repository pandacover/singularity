/**
 * The tool-call hook's first look (src/workflows/hook.ts): whether a call may
 * set off the trigger of a pitfall the session was handed, told in plain
 * JavaScript before any module loads. Loading the modules that match
 * triggers (HookTool.ts) takes most of half a second, and the hook runs after
 * every edit and command; nearly every call sets off nothing and ends here,
 * in about a tenth of a second.
 *
 * It must never say no to a call a trigger matches, so it asks less than the
 * match does (records/Triggers.ts): that every word of the strings a trigger
 * looks for (`all`) is somewhere in what the hook was sent. What the match
 * reads is made of those strings, joined only at spaces and line breaks (a
 * command's words, a shell's output and errors, a patch's added lines without
 * their `+`), or is the tool's result as JSON: a word, having no space, lies
 * within one of them. It reads the session file and the call without Schema,
 * as the hook's other first looks do; the match reads them again with it,
 * and anything this can't read is left to the match.
 */

/** Every string in a value. */
const stringsIn = (value: unknown, out: Array<string>): Array<string> => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out)
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) stringsIn(v, out)
  return out
}

/** What the match may read of a call: every string in it, and its result as JSON or, from Hermes Agent, read from JSON. */
const callText = (input: Record<string, unknown>): string => {
  const strings = stringsIn(input, [])
  const response = input.tool_response
  if (typeof response === "string") {
    try {
      stringsIn(JSON.parse(response), strings)
    } catch {
      // A result that isn't JSON is one of the strings already.
    }
  } else if (typeof response === "object" && response !== null) {
    strings.push(JSON.stringify(response))
  }
  return strings.join("\n")
}

interface TriggerShape {
  readonly on: string
  readonly all: ReadonlyArray<string>
}

const isTrigger = (t: unknown): t is TriggerShape =>
  typeof t === "object" && t !== null && typeof (t as { on?: unknown }).on === "string" &&
  Array.isArray((t as { all?: unknown }).all) && ((t as { all: Array<unknown> }).all).every((s) => typeof s === "string")

/**
 * Whether a tool call (the hook's stdin) may set off a trigger of the
 * session's pitfalls (the session file's text): false only when none can.
 */
export const mayFire = (stdin: string, session: string): boolean => {
  try {
    const input = JSON.parse(stdin) as unknown
    const triggers = (JSON.parse(session) as { triggers?: unknown }).triggers
    if (typeof input !== "object" || input === null || !Array.isArray(triggers)) return true
    let text: string | undefined
    return triggers.some((p: unknown) => {
      const trigger = typeof p === "object" && p !== null ? (p as { trigger?: unknown }).trigger : undefined
      if (trigger === null) return false
      if (!isTrigger(trigger)) return true
      // Pages and actions are a web reader's; code calls never match them.
      if (trigger.on === "page" || trigger.on === "action") return false
      const call = (text ??= callText(input as Record<string, unknown>))
      return trigger.all.flatMap((s) => s.split(/\s+/)).filter((w) => w !== "").every((w) => call.includes(w))
    })
  } catch {
    return true
  }
}
