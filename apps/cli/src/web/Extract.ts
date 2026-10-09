/**
 * What a browser session did, read from its tool calls: each action with
 * the page it was on and the place of the control it used, whether it
 * failed, and the messages pages showed along the way (alerts, status
 * lines). The web reader's evidence, as a diff with its places is the code
 * reader's.
 *
 * Playwright's tools name a control by the reference it had in the last
 * snapshot the agent read, so each action is placed in that snapshot.
 *
 * Forms open with some fields already set (a ticked box, a chosen option):
 * for each page the session acted on, the fields set when it first read the
 * page, and whether it changed them. Steps list what sessions changed; what
 * they left alone is only here.
 */
import type { ToolCall } from "../traces/index.ts"
import { blankText, chainOf, pagePattern, type Region, regionHead, webPlaceId } from "./Places.ts"
import { byRef, fieldState, isField, isToggle, messagesOf, pageOf, parseSnapshot, type SnapNode } from "./Snapshot.ts"

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
  /** For a form field: what it was set to just before (`ticked`, an option). */
  readonly was: string | undefined
  readonly failed: boolean
  readonly error: string | undefined
}

/** A field already set when the session first read its page, and whether the session changed it. */
export interface PresetField {
  /** The field as a region head: `checkbox "Restock items"`. */
  readonly control: string
  readonly state: string
  readonly changed: boolean
}

export interface PageForm {
  readonly page: string
  readonly fields: ReadonlyArray<PresetField>
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
  /** Pages the session acted on that opened with fields already set. */
  readonly forms: ReadonlyArray<PageForm>
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

interface SeenField {
  readonly role: string
  readonly head: string
  readonly state: string
  readonly set: boolean
  /** How many actions the session had taken when it first saw the field. */
  readonly at: number
}

const blankName = (name: string, values: ReadonlyArray<string>) => blankText(name.trim(), values).slice(0, 120)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** What a field is set to, with only the task's own values as blanks: an option's number ("4 weeks") is the app's, not the task's. */
const blankState = (state: string, values: ReadonlyArray<string>): string => {
  let t = state.trim()
  for (const v of values) {
    if (v.length < 2) continue
    t = t.replace(new RegExp(`(^|[^A-Za-z0-9])${escape(v)}(?=$|[^A-Za-z0-9])`, "gi"), (_m, pre: string) => `${pre}{value}`)
  }
  return t.slice(0, 120)
}

/** The fields a snapshot shows, as heads with the task's values as blanks; one per head. */
const fieldsOf = (nodes: ReadonlyArray<SnapNode>, values: ReadonlyArray<string>, at: number): Array<SeenField> => {
  const out: Array<SeenField> = []
  for (const n of nodes) {
    if (!isField(n.role)) continue
    const s = fieldState(nodes, n)
    if (s === undefined) continue
    const head = regionHead({ role: n.role, name: blankName(n.name, values) })
    if (out.some((f) => f.head === head)) continue
    out.push({ role: n.role, head, state: s.state === "filled" ? s.state : blankState(s.state, values), set: s.set, at })
  }
  return out
}

/** A button clicked, or Enter pressed: what sends a form. */
const sends = (a: WebAction): boolean =>
  !a.failed && ((a.kind === "click" && a.chain !== undefined && a.chain[a.chain.length - 1].role === "button") || (a.kind === "key" && /enter/i.test(a.text ?? "")))

/** Whether the session's actions on a page left a field it opened with set to something else. */
const changedBy = (field: SeenField, acts: ReadonlyArray<WebAction>): boolean => {
  const own = acts.filter((a) => a.chain !== undefined && regionHead(a.chain[a.chain.length - 1]) === field.head)
  if (isToggle(field.role)) {
    let on = field.state !== "unticked"
    for (const a of own) {
      if (a.kind === "click") on = !on
      else if (a.kind === "fill" && (a.text === "true" || a.text === "false")) on = a.text === "true"
    }
    return !on
  }
  if (field.role === "radio" || field.role === "menuitemradio") {
    // Another option of the same group chosen.
    return acts.some((a) => a.kind === "click" && a.chain !== undefined && a.chain[a.chain.length - 1].role === field.role && regionHead(a.chain[a.chain.length - 1]) !== field.head)
  }
  if (field.role === "combobox" || field.role === "listbox") return own.some((a) => a.kind !== "select" || (a.text ?? "") !== field.state)
  return own.length > 0
}

const fieldWas = (nodes: ReadonlyArray<SnapNode>, ref: string | undefined, values: ReadonlyArray<string>): string | undefined => {
  const node = ref === undefined ? undefined : byRef(nodes, ref)
  if (node === undefined || !isField(node.role)) return undefined
  const s = fieldState(nodes, node)
  return s === undefined ? undefined : s.state === "filled" || s.state === "empty" ? s.state : blankState(s.state, values)
}

export const readWebSession = (calls: ReadonlyArray<ToolCall>, values: ReadonlyArray<string>, subject: string): WebSessionView => {
  let nodes: ReadonlyArray<SnapNode> = []
  let url: string | undefined
  const actions: Array<WebAction> = []
  const messages: Array<PageMessage> = []
  const seen = new Set<string>()
  // Each page's fields as the session first saw each one: a form in a dialog or
  // behind a disclosure shows only once it is opened, at the same address.
  const firstSeen = new Map<string, Map<string, SeenField>>()
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
          was: kind === "navigate" || chain === undefined ? undefined : fieldWas(nodes, t.ref, values),
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
      if (page !== undefined) {
        const fields = firstSeen.get(page) ?? new Map<string, SeenField>()
        for (const f of fieldsOf(nodes, values, actions.length)) {
          if (fields.has(f.head)) continue
          // Used before the session read it: what it started as is unknown.
          const used = actions.some((a) => a.page === page && a.chain !== undefined && regionHead(a.chain[a.chain.length - 1]) === f.head)
          fields.set(f.head, used ? { ...f, set: false } : f)
        }
        firstSeen.set(page, fields)
      }
      for (const m of messagesOf(nodes)) {
        const text = blankText(m, values).slice(0, 240)
        const key = `${page}\u0000${text}`
        if (seen.has(key)) continue
        seen.add(key)
        messages.push({ after: actions.length === 0 ? -1 : actions[actions.length - 1].index, page, text })
      }
    }
  }
  // A field counts once the session sent the form it was in: a page only looked at, or a
  // form opened and left, says nothing about what the field should be.
  const forms: Array<PageForm> = []
  for (const [page, all] of firstSeen) {
    const fields = [...all.values()].filter((f) => f.set && actions.slice(f.at).some((a) => a.page === page && sends(a)))
    const acts = actions.filter((a) => !a.failed && a.kind !== "navigate" && a.page === page)
    if (fields.length === 0) continue
    forms.push({ page, fields: fields.map((f) => ({ control: f.head, state: f.state, changed: changedBy(f, acts) })) })
  }
  return { actions, messages, forms, calls: browserCalls, snapshots }
}

