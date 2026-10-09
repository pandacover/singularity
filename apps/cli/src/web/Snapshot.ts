/**
 * Pages as a browser agent sees them: Playwright's accessibility snapshot,
 * an indented list of roles and names, each element with a reference the
 * agent's actions name (`button "Refund" [ref=e19]`).
 *
 *     - main [ref=e5]:
 *       - region "Actions" [ref=e7]:
 *         - button "Edit" [ref=e8]
 *         - group [ref=e9]:
 *           - button "Refund" [ref=e19]
 *
 * Like code, a page is read from its indentation: an element's place is the
 * chain of named regions around it (Places.ts). Nothing here keeps a page.
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
      ref: typeof attrs.ref === "string" ? attrs.ref : undefined,
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
  readonly title: string | undefined
  /** The snapshot's text, when the result carried one inline. */
  readonly yaml: string | undefined
}

/** What a browser tool's result says of the page: its address and title, and the snapshot when it is inline. */
export const pageOf = (result: string | undefined): PageView => {
  if (result === undefined) return { url: undefined, title: undefined, yaml: undefined }
  const url = /^- Page URL: (.+)$/m.exec(result)?.[1]?.trim()
  const title = /^- Page Title: (.*)$/m.exec(result)?.[1]?.trim()
  const yaml = /```yaml\r?\n([\s\S]*?)```/.exec(result)?.[1]
  return { url, title, yaml }
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

/** Roles that say where on a page something is, named or not. */
const LANDMARKS = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "tablist", "tabpanel", "form", "toolbar"])
/** Roles that say where only when they have a name. */
const NAMED_REGIONS = new Set(["region", "group", "table", "grid", "list", "listbox", "tree", "section", "article", "fieldset", "radiogroup", "treegrid"])

export const isRegion = (n: SnapNode): boolean => LANDMARKS.has(n.role) || (NAMED_REGIONS.has(n.role) && n.name.trim() !== "")

/** Text the page shows as messages: alerts, status lines, error text in a dialog. */
export const messagesOf = (nodes: ReadonlyArray<SnapNode>): Array<string> => {
  const out: Array<string> = []
  const inside = (n: SnapNode, roles: ReadonlySet<string>) => ancestors(nodes, n).some((a) => roles.has(a.role)) || roles.has(n.role)
  const roles = new Set(["alert", "status", "alertdialog"])
  for (const n of nodes) {
    if (!inside(n, roles)) continue
    const t = [n.name, n.text ?? ""].map((s) => s.trim()).filter((s) => s !== "").join(" ")
    if (t !== "" && !out.includes(t)) out.push(t)
  }
  return out
}

/** All the text of a snapshot in one string, for warnings that watch what a page shows. */
export const pageText = (nodes: ReadonlyArray<SnapNode>): string =>
  nodes.map((n) => [n.name, n.text ?? ""].filter((s) => s !== "").join(" ")).filter((s) => s !== "").join("\n")
