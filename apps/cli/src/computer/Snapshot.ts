/**
 * Screens as a browser agent reads them as text: an indented list of roles
 * and names, each control tagged with a reference the agent's actions name.
 * Playwright MCP writes `button "Refund" [ref=e19]`; Claude's built-in
 * browser tags controls `[ref_3]` (its `read_page`, "a YAML-style
 * accessibility tree").
 *
 *     - main [ref=e5]:
 *       - region "Actions" [ref=e7]:
 *         - button "Edit" [ref=e8]
 *         - group [ref=e9]:
 *           - button "Refund" [ref=e19]
 *
 * Back from the browser memory removed in 2d18711 (src/web/Snapshot.ts),
 * with the second tag form and Playwright's linked snapshot files. Nothing
 * here keeps a screen.
 */

export interface SnapNode {
  readonly index: number
  readonly depth: number
  readonly role: string
  readonly name: string
  readonly ref: string | undefined
  readonly attrs: Readonly<Record<string, string | true>>
  /** Text after the colon on the same line (`- alert: Refunds over $500 need a note`). */
  readonly text: string | undefined
  readonly parent: number | undefined
}

const LINE = /^([A-Za-z][A-Za-z0-9-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/

const unquote = (s: string): string => {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string
    } catch {
      return t.slice(1, -1)
    }
  }
  return t
}

const attrsOf = (s: string): Record<string, string | true> => {
  const out: Record<string, string | true> = {}
  for (const m of s.matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)) out[m[1].trim()] = m[2] === undefined ? true : m[2].trim()
  return out
}

/** The control's reference: `[ref=e19]`, or the built-in browser's `[ref_3]`. */
const refOf = (attrs: Readonly<Record<string, string | true>>): string | undefined => {
  if (typeof attrs.ref === "string") return attrs.ref
  return Object.keys(attrs).find((k) => /^ref_\d+$/.test(k))
}

/** The elements of a snapshot, in document order, each with its parent. Properties (`- /url: ...`) are left out. */
export const parseSnapshot = (yaml: string): Array<SnapNode> => {
  const nodes: Array<SnapNode> = []
  const stack: Array<number> = []
  for (const raw of yaml.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^(\s*)- (.*)$/.exec(raw)
    if (m === null) continue
    const depth = Math.floor(m[1].length / 2)
    const body = unquote(m[2])
    if (body.startsWith("/")) continue
    const p = LINE.exec(body)
    if (p === null) continue
    while (stack.length > 0 && nodes[stack[stack.length - 1]].depth >= depth) stack.pop()
    const attrs = attrsOf(p[3] ?? "")
    const node: SnapNode = {
      index: nodes.length,
      depth,
      role: p[1],
      name: p[2] === undefined ? "" : p[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      ref: refOf(attrs),
      attrs,
      text: p[4] === undefined || p[4].trim() === "" ? undefined : unquote(p[4]),
      parent: stack.length === 0 ? undefined : stack[stack.length - 1]
    }
    nodes.push(node)
    stack.push(node.index)
  }
  return nodes
}

export interface PageView {
  readonly url: string | undefined
  /** The snapshot's text, when the answer carried one inline. */
  readonly yaml: string | undefined
  /** Playwright's link to a snapshot file (`- [Snapshot](..\pw\page-….yml)`), as written. */
  readonly file: string | undefined
}

/** What a Playwright MCP answer says of the page: its address, and its snapshot inline or as a file. */
export const pageOf = (result: string | undefined): PageView => {
  if (result === undefined) return { url: undefined, yaml: undefined, file: undefined }
  const url = /^- Page URL: (.+)$/m.exec(result)?.[1]?.trim()
  const yaml = /```yaml\r?\n([\s\S]*?)```/.exec(result)?.[1]
  const file = /^- \[Snapshot\]\(([^)]+\.ya?ml)\)/m.exec(result)?.[1]
  return { url, yaml, file }
}

export const ancestors = (nodes: ReadonlyArray<SnapNode>, node: SnapNode): Array<SnapNode> => {
  const out: Array<SnapNode> = []
  let at = node.parent
  while (at !== undefined) {
    out.unshift(nodes[at])
    at = nodes[at].parent
  }
  return out
}

export const byRef = (nodes: ReadonlyArray<SnapNode>, ref: string): SnapNode | undefined => nodes.find((n) => n.ref === ref)

/** Controls that open a screen or set something: what routes and notes are made of. */
const CONTROLS = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "switch", "radio", "combobox", "listbox", "textbox", "searchbox", "spinbutton", "slider", "option"])
export const isControl = (role: string): boolean => CONTROLS.has(role)

/** Controls that hold a value a form sends. */
const TOGGLES = new Set(["checkbox", "switch", "menuitemcheckbox"])
const CHOICES = new Set(["radio", "menuitemradio"])
const PICKERS = new Set(["combobox", "listbox"])
const TEXTS = new Set(["textbox", "searchbox", "spinbutton", "slider"])

export const isField = (role: string): boolean => TOGGLES.has(role) || CHOICES.has(role) || PICKERS.has(role) || TEXTS.has(role)
export const isToggle = (role: string): boolean => TOGGLES.has(role)
export const isTextField = (role: string): boolean => TEXTS.has(role)

/** The elements inside a node, in document order. */
export const descendants = (nodes: ReadonlyArray<SnapNode>, node: SnapNode): Array<SnapNode> => {
  const out: Array<SnapNode> = []
  for (let i = node.index + 1; i < nodes.length && nodes[i].depth > node.depth; i++) out.push(nodes[i])
  return out
}

/** A select's first option when it only asks to choose (`— choose —`, `Select…`): no value yet. */
const PLACEHOLDER = /^[\s\-—–_.…]*$|\b(choose|select|pick)\b/i

/**
 * Whether a field starts set, by state only: a ticked box, a selected radio,
 * a chosen option. Never what is chosen or typed. Text already in a box is
 * in plain sight, so it doesn't count.
 */
export type FieldState = "ticked" | "partly ticked" | "selected" | "set"

export const fieldState = (nodes: ReadonlyArray<SnapNode>, node: SnapNode): FieldState | undefined => {
  if (TOGGLES.has(node.role)) {
    const c = node.attrs.checked
    return c === undefined || c === "false" ? undefined : c === "mixed" ? "partly ticked" : "ticked"
  }
  if (CHOICES.has(node.role)) return node.attrs.checked === undefined || node.attrs.checked === "false" ? undefined : "selected"
  if (PICKERS.has(node.role)) {
    const options = descendants(nodes, node).filter((n) => n.role === "option")
    const chosen = options.find((o) => o.attrs.selected !== undefined && o.attrs.selected !== "false")
    return chosen !== undefined && !(chosen === options[0] && PLACEHOLDER.test(chosen.name)) ? "set" : undefined
  }
  return undefined
}

/** Regions that name a screen of an app with one address for many (a dialog, a named form). */
const SCREEN_REGIONS = new Set(["dialog", "alertdialog", "form"])

/** The screen's named region: the last named dialog, else the first named form. */
export const screenRegion = (nodes: ReadonlyArray<SnapNode>): SnapNode | undefined => {
  const dialogs = nodes.filter((n) => (n.role === "dialog" || n.role === "alertdialog") && n.name.trim() !== "")
  if (dialogs.length > 0) return dialogs[dialogs.length - 1]
  return nodes.find((n) => SCREEN_REGIONS.has(n.role) && n.name.trim() !== "")
}

/** Messages inside a form or a dialog: a field's or the form's error, never a page-wide banner. */
export const formMessages = (nodes: ReadonlyArray<SnapNode>): Array<string> => {
  const out: Array<string> = []
  for (const n of nodes) {
    if (n.role !== "alert" && n.role !== "status") continue
    if (!ancestors(nodes, n).some((a) => SCREEN_REGIONS.has(a.role))) continue
    const t = [n.name, n.text ?? "", ...descendants(nodes, n).map((d) => d.text ?? d.name)].map((s) => s.trim()).filter((s) => s !== "").join(" ")
    if (t !== "" && !out.includes(t)) out.push(t)
  }
  return out
}

/** Whether a status line or alert shows anywhere: what follows a write. */
export const showsStatus = (nodes: ReadonlyArray<SnapNode>): boolean => nodes.some((n) => n.role === "status" || n.role === "alert")

/** Roles of content: a link in a list row or a table cell opens a record, not a screen of the app. */
const CONTENT = new Set(["row", "cell", "gridcell", "listitem", "article", "treeitem"])
const CHROME = new Set(["navigation", "banner", "menubar", "menu", "tablist", "contentinfo", "toolbar"])

export const isContent = (nodes: ReadonlyArray<SnapNode>, node: SnapNode): boolean => {
  const around = ancestors(nodes, node)
  return around.some((a) => CONTENT.has(a.role)) && !around.some((a) => CHROME.has(a.role))
}

/** Whether the screen has a password field: such a screen is left out entirely. */
export const hasPassword = (nodes: ReadonlyArray<SnapNode>): boolean =>
  nodes.some((n) => isTextField(n.role) && /password|passcode|\bpin\b/i.test(n.name))
