/**
 * The memory layer's one API: the same four calls for every agent and every
 * kind of work (DESIGN-one-layer.md).
 *
 * - start: a task begins; memory hands over what it knows for it.
 * - step: after an action; a warning whose trigger appeared, or a pointer to
 *   a place now on screen; usually nothing.
 * - end: the session is over; it becomes a record, with how it went.
 * - learn: a learning round for a subject, when it is time.
 *
 * Behind the calls, a reader per kind of work. The code reader is memory v1
 * as it was (src/workflows/): the same functions run for the same events, so
 * code hand-overs are unchanged. The web reader (src/web/) serves agents
 * that work in a browser. A task in a git repository goes to the code
 * reader; one that names a web app's address, when the code reader has
 * nothing for it, to the web reader.
 *
 * Ways in, all onto these calls: the hooks (src/workflows/hook.ts), the CLI
 * (`singularity layer start|step|end|learn`, JSON in and out), and, later,
 * MCP. The eval harness uses the hooks and these functions, like users do.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Path } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { decodeHookInput } from "../handover/HookInput.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { userPromptSubmit } from "../workflows/HookStart.ts"
import type { InduceConfig } from "../workflows/Induce.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import type { WebOutcome } from "../web/End.ts"
import { webStart } from "../web/Start.ts"

export type ReaderKind = "code" | "web"

const home = () => process.env.SINGULARITY_HOME || join(homedir(), ".singularity")

/** Which reader a running session belongs to, checked with nothing but the file system (the step hook runs after every call). */
export const sessionKind = (sessionId: string): ReaderKind | undefined => {
  try {
    const config = JSON.parse(readFileSync(join(home(), "config.json"), "utf-8")) as { tenant?: unknown }
    if (typeof config.tenant !== "string") return undefined
    const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")
    const tenantDir = join(home(), "tenants", config.tenant)
    if (existsSync(join(tenantDir, "workflows", "sessions", `${safe}.json`))) return "code"
    if (existsSync(join(tenantDir, "web", "sessions", `${safe}.json`))) return "web"
    return undefined
  } catch {
    return undefined
  }
}

const stores = (tenantDir: string, tenant: string, path: Path.Path) =>
  Layer.merge(
    JsonRecordStore.layer(tenantDir, tenant),
    JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(tenantDir, path), tenant)
  )

const hookJson = (event: string, text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

// --- start ---

export interface StartRequest {
  readonly sessionId: string
  readonly prompt: string
  readonly cwd: string
}

export interface StartResponse {
  readonly reader: ReaderKind | null
  readonly text: string | null
}

/** start, as the hooks call it: the code reader first, as before; the web reader when the code reader has nothing. */
export const startFromHook = async (stdin: string, part: 1 | 2, partsSetting: string | undefined): Promise<string | undefined> => {
  const code = await userPromptSubmit(stdin, part, partsSetting)
  if (code !== undefined || part !== 1) return code
  const input = decodeHookInput(stdin)
  if (input === undefined || input.prompt === undefined || input.prompt.trim() === "") return undefined
  if (sessionKind(input.session_id) !== undefined) return undefined
  const text = await webStartText(input.session_id, input.prompt)
  return text === undefined ? undefined : hookJson(input.hook_event_name ?? "UserPromptSubmit", text)
}

const webStartText = (sessionId: string, prompt: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const h = yield* loadHome()
      const path = yield* Path.Path
      const result = yield* webStart({ sessionId, prompt }, { tenantDir: h.tenantDir }).pipe(Effect.provide(stores(h.tenantDir, h.tenant, path)))
      return result.text
    }).pipe(Effect.provide(NodeServices.layer))
  )

/** start, as a caller without hooks makes it. */
export const start = async (req: StartRequest): Promise<StartResponse> => {
  const stdin = JSON.stringify({ session_id: req.sessionId, prompt: req.prompt, cwd: req.cwd, hook_event_name: "UserPromptSubmit" })
  const code = await userPromptSubmit(stdin, 1, "1")
  if (code !== undefined) return { reader: "code", text: (JSON.parse(code) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext }
  const text = await webStartText(req.sessionId, req.prompt)
  return { reader: text === undefined ? null : "web", text: text ?? null }
}

// --- step ---

export interface StepRequest {
  readonly sessionId: string
  readonly toolName: string
  readonly toolInput: Readonly<Record<string, unknown>>
  readonly toolResponse?: unknown
  readonly error?: string | undefined
  readonly cwd?: string | undefined
}

/** step, as the hooks call it: the session's own reader. */
export const stepFromHook = async (stdin: string, sessionId: string | undefined): Promise<string | undefined> => {
  const kind = sessionId === undefined ? undefined : sessionKind(sessionId)
  if (kind === "code") return (await import("../workflows/HookTool.ts")).postToolUse(stdin)
  if (kind !== "web") return undefined
  const input = decodeHookInput(stdin)
  if (input === undefined || input.tool_name === undefined) return undefined
  const text = await webStepText({
    sessionId: input.session_id,
    toolName: input.tool_name,
    toolInput: input.tool_input ?? {},
    toolResponse: input.tool_response,
    error: input.error
  })
  return text === undefined ? undefined : hookJson(input.hook_event_name ?? "PostToolUse", text)
}

const webStepText = (req: StepRequest): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const h = yield* loadHome()
      const path = yield* Path.Path
      const { webStep } = yield* Effect.promise(() => import("../web/Step.ts"))
      return yield* webStep(
        { sessionId: req.sessionId, tool: req.toolName, toolInput: req.toolInput, response: req.toolResponse, error: req.error },
        h.tenantDir
      ).pipe(Effect.provide(stores(h.tenantDir, h.tenant, path)))
    }).pipe(Effect.provide(NodeServices.layer))
  )

/** step, as a caller without hooks makes it. */
export const step = async (req: StepRequest): Promise<{ readonly text: string | null }> => {
  const kind = sessionKind(req.sessionId)
  if (kind === "code") {
    const out = await (await import("../workflows/HookTool.ts")).postToolUse(JSON.stringify({
      session_id: req.sessionId,
      cwd: req.cwd,
      hook_event_name: "PostToolUse",
      tool_name: req.toolName,
      tool_input: req.toolInput,
      tool_response: req.toolResponse,
      ...(req.error === undefined ? {} : { error: req.error })
    }))
    return { text: out === undefined ? null : (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext }
  }
  if (kind !== "web") return { text: null }
  return { text: (await webStepText(req)) ?? null }
}

// --- end ---

export interface EndRequest {
  readonly sessionId: string
  readonly transcript: string
  readonly cwd: string
  /** How it went, when the caller knows (an eval's check, a user's verdict). */
  readonly outcome?: WebOutcome | undefined
  readonly taskId?: string | undefined
  readonly prompt?: string | undefined
  /** The memory home, when not the environment's. */
  readonly home?: string | undefined
}

export interface EndResponse {
  readonly reader: ReaderKind | null
  readonly record: string | null
  readonly subject: string | null
  readonly reason: string
}

/** end, as a caller makes it. The code reader's session end stays the hook's (HookEnd.ts), unchanged. */
export const end = (req: EndRequest): Promise<EndResponse> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const h = yield* loadHome(req.home)
      const { webEnd } = yield* Effect.promise(() => import("../web/End.ts"))
      const out = yield* webEnd(
        { sessionId: req.sessionId, transcript: req.transcript, outcome: req.outcome ?? { success: null, feedback: null }, taskId: req.taskId, prompt: req.prompt },
        h.tenantDir,
        h.tenant
      )
      return {
        reader: out.record === undefined ? null : "web",
        record: out.record ?? null,
        subject: "subject" in out && typeof out.subject === "string" ? out.subject : null,
        reason: out.reason
      } satisfies EndResponse
    }).pipe(Effect.provide(NodeServices.layer))
  )

// --- learn ---

export interface LearnRequest {
  readonly subject: string
  readonly config: InduceConfig & { readonly every?: number | undefined; readonly now?: boolean | undefined }
  /** The memory home, when not the environment's. */
  readonly home?: string | undefined
}

/** learn: a round for one subject, by its reader, on its reader's schedule. */
export const learn = (req: LearnRequest): Promise<Readonly<Record<string, unknown>>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const h = yield* loadHome(req.home)
      const path = yield* Path.Path
      const layer = stores(h.tenantDir, h.tenant, path)
      if (req.subject.startsWith("web-")) {
        const { learnWebSubject } = yield* Effect.promise(() => import("../web/Learn.ts"))
        return (yield* learnWebSubject(req.subject, req.config, h.tenantDir).pipe(Effect.provide(layer))) as unknown as Readonly<Record<string, unknown>>
      }
      return yield* Effect.gen(function*() {
        const { DEFAULT_EVERY, learnSubject } = yield* Effect.promise(() => import("../workflows/Learn.ts"))
        const subject = (yield* (yield* RecordStore).subjects()).find((s) => s.id === req.subject)
        if (subject === undefined) return { kind: "waiting", subject: req.subject, reason: "no such subject" }
        return (yield* learnSubject(subject, { ...req.config, every: req.config.every ?? DEFAULT_EVERY })) as unknown as Readonly<Record<string, unknown>>
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.provide(NodeServices.layer))
  )
