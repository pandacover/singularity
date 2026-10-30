/**
 * What the computer-use hook (hook.ts) runs for each event: the hand-over
 * after a call, the card at a task's start, and storing in the background.
 *
 * Plain node, with no Effect: the tool-call hook runs after every browser
 * call, and importing Effect alone takes about 0.4 s. So the hook's input and
 * memory's small files are read with JSON.parse and checked by hand, as the
 * coding hook's commit check reads its input (workflows/StoreTrigger.ts); a
 * file that doesn't look right counts as missing. Storing, which is slow and
 * writes, runs in the background and reads everything with Schema
 * (Capture.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { startInBackground } from "../setup/Background.ts"
import { observe } from "./Calls.ts"
import { afterCall, appsNamedIn, cardsAtStart, handOverWith } from "./HandoverCore.ts"
import type { Address, AppIndex, Given } from "./Model.ts"
import { givenPath, indexPath, saltPath, wordsPath } from "./Paths.ts"

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is Array<string> => Array.isArray(v) && v.every((x) => typeof x === "string")

const root = () => process.env.SINGULARITY_HOME || join(homedir(), ".singularity")

/** The tenant's folder, as loadHome finds it: config.json's tenant, else `local`. */
const tenantDir = (): string => {
  let tenant = "local"
  try {
    const config: unknown = JSON.parse(readFileSync(join(root(), "config.json"), "utf-8"))
    if (isObject(config) && typeof config.tenant === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.tenant)) tenant = config.tenant
  } catch {
    // No config yet: the default tenant.
  }
  return join(root(), "tenants", tenant)
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const readJson = (file: string): unknown => {
  try {
    return parseJson(readFileSync(file, "utf-8"))
  } catch {
    return undefined
  }
}

/** An app's index, when it looks like one: the fields the hand-over reads. */
const readIndex = (tenant: string, app: string): AppIndex | undefined => {
  const v = readJson(indexPath(tenant, app))
  return isObject(v) && v.version === 1 && v.app === app && isObject(v.screens) && isObject(v.texts) && Array.isArray(v.routes) &&
      Array.isArray(v.rules) && Array.isArray(v.sessions)
    ? (v as unknown as AppIndex)
    : undefined
}

const readGiven = (tenant: string, session: string): Given => {
  const v = readJson(givenPath(tenant, session))
  if (!isObject(v) || !strings(v.cards) || !strings(v.screens)) return { cards: [], screens: [] }
  const a = v.address
  const address = isObject(a) && typeof a.app === "string" && Array.isArray(a.path) && strings(a.query) && (a.hash === undefined || Array.isArray(a.hash))
    ? (a as unknown as Address)
    : undefined
  return { cards: v.cards, screens: v.screens, ...(typeof v.host === "string" ? { host: v.host } : {}), ...(address === undefined ? {} : { address }) }
}

const writeGiven = (tenant: string, session: string, given: Given) => {
  const file = givenPath(tenant, session)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(given) + "\n")
  renameSync(tmp, file)
}

const readSalt = (tenant: string): string | undefined => {
  try {
    const s = readFileSync(saltPath(tenant), "utf-8").trim()
    return s.length >= 32 ? s : undefined
  } catch {
    return undefined
  }
}

interface Input {
  readonly session_id: string
  readonly transcript_path?: string
  readonly cwd?: string
  readonly hook_event_name?: string
  readonly prompt?: string
  readonly tool_name?: string
  readonly tool_input?: Json
  readonly tool_response?: unknown
  readonly error?: string
  readonly agent_id?: string
}

const inputOf = (stdin: string): Input | undefined => {
  const v = parseJson(stdin)
  if (!isObject(v) || typeof v.session_id !== "string") return undefined
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined)
  return {
    session_id: v.session_id,
    transcript_path: str("transcript_path"),
    cwd: str("cwd"),
    hook_event_name: str("hook_event_name"),
    prompt: str("prompt"),
    tool_name: str("tool_name"),
    tool_input: isObject(v.tool_input) ? v.tool_input : {},
    tool_response: v.tool_response,
    error: str("error"),
    agent_id: str("agent_id")
  }
}

/** A tool's answer as text, images as `[image]` and never read: a string, content blocks, or `{ content: [...] }`. */
export const answerText = (response: unknown): string | undefined => {
  if (response === undefined || response === null) return undefined
  if (typeof response === "string") return response
  const list = Array.isArray(response) ? response : isObject(response) && Array.isArray(response.content) ? response.content : undefined
  if (list === undefined) return isObject(response) && typeof response.result === "string" ? response.result : undefined
  return list.map((b) => (isObject(b) && typeof b.text === "string" ? b.text : isObject(b) && b.type === "image" ? "[image]" : "")).filter((t) => t !== "").join("\n")
}

const context = (hookEvent: string | undefined, text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: hookEvent ?? "PostToolUse", additionalContext: text } })

/** After a browser or computer-use call: the card and notes due, as the hook's JSON, or nothing. */
export const afterToolCall = (stdin: string): string | undefined => {
  const input = inputOf(stdin)
  // A helper agent's calls are its own.
  if (input === undefined || input.tool_name === undefined || input.agent_id !== undefined) return undefined
  const failed = input.hook_event_name === "PostToolUseFailure" || input.error !== undefined
  const observations = observe({ name: input.tool_name, input: input.tool_input ?? {}, result: input.error ?? answerText(input.tool_response), failed })
  if (observations.length === 0) return undefined
  const tenant = tenantDir()
  const last = observations[observations.length - 1]
  // Playwright's linked snapshot file, where the session runs.
  let yaml = last.yaml
  if (yaml === undefined && last.file !== undefined && input.cwd !== undefined) {
    try {
      yaml = readFileSync(resolve(input.cwd, last.file.replace(/\\/g, "/")), "utf-8")
    } catch {
      // Gone already: no screen to read.
    }
  }
  const before = readGiven(tenant, input.session_id)
  const salt = readSalt(tenant)
  const call = afterCall(before, observations, yaml, salt)
  const index = call.host === undefined || !call.acted ? undefined : readIndex(tenant, call.host)
  const { given, texts } = handOverWith(call, index, salt, yaml)
  // The session's file also says it used these tools: the sweeps store it then.
  if (JSON.stringify(given) !== JSON.stringify(before) || !existsSync(givenPath(tenant, input.session_id))) writeGiven(tenant, input.session_id, given)
  return texts.length === 0 ? undefined : context(input.hook_event_name, texts.join("\n\n"))
}

/** Whether a session's log has calls of claude.ai's connectors (Calls.ts, app tools), which the tool-call hook doesn't see. */
const usedAppTools = (transcript: string | undefined): boolean => {
  if (transcript === undefined || transcript === "") return false
  try {
    return /"name"\s*:\s*"mcp__claude_ai_[^"]+__/.test(readFileSync(transcript, "utf-8"))
  } catch {
    return false
  }
}

/** Store the session in the background (Capture.ts), when it used these tools; at its end, app tools too. */
const store = (tenant: string, input: Input, end = false) => {
  if (!existsSync(givenPath(tenant, input.session_id)) && !(end && usedAppTools(input.transcript_path))) return
  if (input.transcript_path === undefined || input.transcript_path === "") return
  startInBackground(root(), ["computer-use", "store", "--background", "--session", input.session_id, "--transcript", input.transcript_path], "store.log")
}

/** At a task's start: the session so far, stored; and the card when the prompt names a known app's address. */
export const atPrompt = (stdin: string): string | undefined => {
  const input = inputOf(stdin)
  if (input === undefined) return undefined
  const tenant = tenantDir()
  store(tenant, input)
  if (input.prompt === undefined) return undefined
  const words = readJson(wordsPath(tenant))
  const named = appsNamedIn(input.prompt, readSalt(tenant), isObject(words) ? (words as Record<string, string>) : {})
  const indexes = named.map((h) => readIndex(tenant, h)).filter((i): i is AppIndex => i !== undefined)
  if (indexes.length === 0) return undefined
  const before = readGiven(tenant, input.session_id)
  const { given, texts } = cardsAtStart(before, indexes)
  if (given !== before) writeGiven(tenant, input.session_id, given)
  return texts.length === 0 ? undefined : context("UserPromptSubmit", texts.join("\n\n"))
}

/** At a session's end: the session, stored. */
export const atSessionEnd = (stdin: string): void => {
  const input = inputOf(stdin)
  if (input !== undefined) store(tenantDir(), input, true)
}
