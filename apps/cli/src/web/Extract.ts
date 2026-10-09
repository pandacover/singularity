/**
 * What a browser session did, read from its tool calls: each action with
 * the page it was on and the place of the control it used, whether it
 * failed, and the messages pages showed along the way (alerts, status
 * lines). The web reader's evidence, as a diff with its places is the code
 * reader's.
 *
 * Playwright's tools name a control by the reference it had in the last
 * snapshot the agent read, so each action is placed in that snapshot.
 */
import type { ToolCall } from "../traces/index.ts"
import { blankText, chainOf, pagePattern, type Region, webPlaceId } from "./Places.ts"
import { messagesOf, pageOf, parseSnapshot, type SnapNode } from "./Snapshot.ts"

export const BROWSER_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__browser_/

/** A browser tool's short name (`click`), or undefined for any other tool. */
export const browserTool = (name: string): string | undefined => {
  const m = /^mcp__.+?__browser_(.+)$/.exec(name)
  return m === null ? undefined : m[1]
}

const KINDS: Readonly<Record<string, string>> = {
  click: "click",
  type: "type",
  fill_form: "fill",
  select_option: "select",
  press_key: "key",
  navigate: "navigate",
  navigate_back: "back",
  handle_dialog: "dialog",
  hover: "hover",
  drag: "drag",
  file_upload: "upload",
  wait_for: "wait"
}

export interface WebAction {
  /** The call's position among the session's browser calls, from 0. */
  readonly index: number
  readonly kind: string
  readonly page: string | undefined
  readonly chain: ReadonlyArray<Region> | undefined
  readonly place: string | undefined
  /** What it typed, chose or pressed, with the task's values as blanks. */
  readonly text: string | undefined
  readonly failed: boolean
  readonly error: string | undefined
}

export interface PageMessage {
  /** After which action (its index), or -1 before any. */
  readonly after: number
  readonly page: string | undefined
  readonly text: string
}

export interface WebSessionView {
  readonly actions: ReadonlyArray<WebAction>
  readonly messages: ReadonlyArray<PageMessage>
  /** Browser calls in all, snapshots included. */
  readonly calls: number
  readonly snapshots: number
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

const failedResult = (c: ToolCall): string | undefined => {
  const r = c.result ?? ""
  if (c.isError || /(^|\n)### Error/.test(r)) {
    const text = r.replace(/^[\s\S]*?### Error\s*/, "").replace(/\u001b\[[0-9;]*m/g, "").trim()
    return text.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 240) || "failed"
  }
  return undefined
}

/** One action per control the call used: `fill_form` fills several at once. */
const targetsOf = (kind: string, input: Readonly<Record<string, unknown>>): Array<{ ref: string | undefined; text: string | undefined }> => {
  if (kind === "fill" && Array.isArray(input.fields)) {
    return (input.fields as Array<Record<string, unknown>>).map((f) => ({ ref: str(f.target) ?? str(f.ref), text: str(f.value) }))
  }
  const ref = str(input.target) ?? str(input.ref)
  const values = Array.isArray(input.values) ? (input.values as Array<unknown>).filter((v): v is string => typeof v === "string").join(", ") : undefined
  const text = str(input.text) ?? values ?? str(input.key) ?? str(input.url) ?? (typeof input.accept === "boolean" ? (input.accept ? "accept" : "dismiss") : undefined)
  return [{ ref, text }]
}

export const readWebSession = (calls: ReadonlyArray<ToolCall>, values: ReadonlyArray<string>, subject: string): WebSessionView => {
  let nodes: ReadonlyArray<SnapNode> = []
  let url: string | undefined
  const actions: Array<WebAction> = []
  const messages: Array<PageMessage> = []
  const seen = new Set<string>()
  let browserCalls = 0
  let snapshots = 0
  for (const c of calls) {
    const tool = browserTool(c.name)
    if (tool === undefined) continue
    const index = browserCalls++
    const kind = KINDS[tool]
    const error = failedResult(c)
    if (kind !== undefined) {
      const page = url === undefined ? undefined : pagePattern(url, values)
      for (const t of targetsOf(kind, c.input)) {
        const chain = t.ref === undefined ? undefined : chainOf(nodes, t.ref, values)
        const element = str(c.input.element)
        const fallback: Array<Region> | undefined = chain === undefined && element !== undefined ? [{ role: "element", name: blankText(element, values).slice(0, 120) }] : undefined
        const where = chain ?? fallback
        const target = kind === "navigate" ? pagePattern(t.text ?? "", values) : undefined
        actions.push({
          index,
          kind,
          page: kind === "navigate" ? target : page,
          chain: kind === "navigate" ? undefined : where,
          place: kind === "navigate" || page === undefined || chain === undefined ? undefined : webPlaceId(subject, page, chain),
          text: kind === "navigate" ? undefined : t.text === undefined ? undefined : blankText(t.text, values).slice(0, 160),
          failed: error !== undefined,
          error
        })
      }
    }
    const view = pageOf(c.result)
    if (view.url !== undefined) url = view.url
    if (view.yaml !== undefined) {
      snapshots++
      nodes = parseSnapshot(view.yaml)
      const page = url === undefined ? undefined : pagePattern(url, values)
      for (const m of messagesOf(nodes)) {
        const text = blankText(m, values).slice(0, 240)
        const key = `${page}\u0000${text}`
        if (seen.has(key)) continue
        seen.add(key)
        messages.push({ after: actions.length === 0 ? -1 : actions[actions.length - 1].index, page, text })
      }
    }
  }
  return { actions, messages, calls: browserCalls, snapshots }
}

