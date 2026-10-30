/**
 * Computer-use memory in Claude desktop (docs/research/computer-use-design/
 * build.md): an MCP server that stands in front of Playwright MCP. Claude
 * desktop's Chat has no hooks and no log memory can read, and drops a
 * server's instructions, so memory can't wait for the model to call it.
 * Instead every browser call goes through here:
 *
 * - **Tools** are the child's, unchanged. Messages pass both ways as they
 *   are; ids are the asker's own, so nothing is renumbered.
 * - **Hand-over:** after a tool's answer, the card and notes due (Handover.ts)
 *   as one more text block, starting `singularity:`.
 * - **Capture:** the session's calls, kept in memory, are made into trails
 *   and stored after each call (Capture.ts), so a closed app loses nothing.
 *   Snapshot files Playwright links are read once, into memory: no page
 *   text reaches memory's files that the design doesn't allow.
 * - **Sessions:** one server process serves every chat until the app quits.
 *   A new session starts after 10 minutes without a call, or when the
 *   client's `_meta` names another conversation.
 *
 * The host is never broken by memory: when memory fails, the child's answer
 * goes back as it came, and the error goes to `hook-errors.log`.
 */
import { Effect, FileSystem, Path } from "effect"
import { captureSession, type TimedCall } from "./Capture.ts"
import { type Call, observe } from "./Calls.ts"
import { handOverAfter } from "./Handover.ts"

export const SERVER_NAME = "singularity-browser"

/** A new session after this long without a call. */
export const IDLE_MS = 10 * 60 * 1000

export const INSTRUCTIONS =
  "These are Playwright's browser tools, through singularity's memory. A tool's answer may end with a block starting \"singularity:\": what past sessions in the app saw on its screens. Read each screen as you go; decide from the task."

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

const parse = (line: string): Json | undefined => {
  try {
    const v: unknown = JSON.parse(line)
    return isObject(v) ? v : undefined
  } catch {
    return undefined
  }
}

export interface ProxyIo {
  readonly toClient: (line: string) => void
  readonly toChild: (line: string) => void
  /** Run memory's work; a failure is logged, never thrown. */
  readonly run: <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>) => Promise<A | undefined>
  readonly tenantDir: string
  /** Where the child's linked snapshot files are: its working folder. */
  readonly childCwd: string
  readonly now: () => number
  readonly processId: string
  /** Step 0: each call's `_meta`, to learn whether the client names its conversation. */
  readonly logMeta?: ((meta: unknown) => void) | undefined
}

interface Pending {
  readonly name: string
  readonly input: Json
  readonly at: string
}

const textOf = (result: Json): string =>
  (Array.isArray(result.content) ? result.content : [])
    .map((b: unknown) => (isObject(b) && b.type === "text" && typeof b.text === "string" ? b.text : isObject(b) && b.type === "image" ? "[image]" : ""))
    .filter((t: string) => t !== "")
    .join("\n")

const conversationOf = (meta: unknown): string | undefined => {
  if (!isObject(meta)) return undefined
  for (const k of ["conversationId", "conversation_id", "chatId", "chat_id", "sessionId", "session_id"]) if (typeof meta[k] === "string") return meta[k] as string
  return undefined
}

export const makeProxy = (io: ProxyIo) => {
  const pending = new Map<string, Pending>()
  let sessionNo = 0
  let session = `${io.processId}-${++sessionNo}`
  let lastCall = 0
  let conversation: string | undefined
  let calls: Array<TimedCall> = []
  /** Snapshot files read once, kept in memory only: the capture reads them from here. */
  const files = new Map<string, string>()
  let storing: Promise<unknown> = Promise.resolve()

  const newSession = () => {
    session = `${io.processId}-${++sessionNo}`
    calls = []
    files.clear()
  }

  const store = () => {
    const snapshot = [...calls]
    const id = session
    const known = new Map(files)
    storing = storing.then(() =>
      io.run(captureSession({
        session: `desktop-${id}`,
        agent: "claude-desktop",
        calls: snapshot,
        prompts: [],
        readFile: (file) => Effect.succeed(known.get(file))
      }, io.tenantDir))
    )
  }

  const readLinked = (file: string) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const full = path.resolve(io.childCwd, file.replace(/\\/g, "/"))
      return yield* fs.readFileString(full).pipe(Effect.orElseSucceed(() => undefined))
    })

  /** A message from the client: passed to the child, tool calls noted. */
  const fromClient = (line: string): void => {
    const msg = parse(line)
    if (msg !== undefined && msg.method === "tools/call" && (typeof msg.id === "string" || typeof msg.id === "number") && isObject(msg.params)) {
      const t = io.now()
      const meta = msg.params._meta
      io.logMeta?.(meta)
      const named = conversationOf(meta)
      if ((lastCall > 0 && t - lastCall >= IDLE_MS) || (named !== undefined && conversation !== undefined && named !== conversation)) newSession()
      if (named !== undefined) conversation = named
      lastCall = t
      pending.set(String(msg.id), {
        name: typeof msg.params.name === "string" ? msg.params.name : "",
        input: isObject(msg.params.arguments) ? msg.params.arguments : {},
        at: new Date(t).toISOString()
      })
    }
    io.toChild(line)
  }

  /** A message from the child: answers to tool calls get memory's block; everything goes on to the client. */
  const fromChild = async (line: string): Promise<void> => {
    const msg = parse(line)
    if (msg === undefined || msg.method !== undefined || msg.id === undefined || msg.id === null) return io.toClient(line)
    const key = String(msg.id)
    if (msg.result !== undefined && isObject(msg.result) && isObject(msg.result.serverInfo)) {
      // The handshake: the child's capabilities, memory's name and instructions.
      return io.toClient(JSON.stringify({ ...msg, result: { ...msg.result, serverInfo: { ...msg.result.serverInfo, name: SERVER_NAME }, instructions: INSTRUCTIONS } }))
    }
    const call = pending.get(key)
    if (call === undefined) return io.toClient(line)
    pending.delete(key)
    const result = isObject(msg.result) ? msg.result : undefined
    const c: Call = {
      // Named as Claude Code would name Playwright's tools, so the translator knows them.
      name: `mcp__playwright__${call.name}`,
      input: call.input,
      result: result === undefined ? (isObject(msg.error) && typeof msg.error.message === "string" ? msg.error.message : undefined) : textOf(result),
      failed: result === undefined || result.isError === true
    }
    const observations = observe(c)
    if (observations.length === 0) return io.toClient(line)
    const last = observations[observations.length - 1]
    let yaml = last.yaml
    if (yaml === undefined && last.file !== undefined) {
      yaml = await io.run(readLinked(last.file))
      if (yaml !== undefined) files.set(last.file, yaml)
    }
    calls.push({ call: c, at: call.at })
    const text = await io.run(handOverAfter(io.tenantDir, `desktop-${session}`, observations, yaml))
    store()
    if (text === undefined || result === undefined) return io.toClient(line)
    const content = Array.isArray(result.content) ? result.content : []
    io.toClient(JSON.stringify({ ...msg, result: { ...result, content: [...content, { type: "text", text }] } }))
  }

  /** Wait for the stores under way: at shutdown. */
  const settle = () => storing

  return { fromClient, fromChild, settle, session: () => `desktop-${session}` }
}
