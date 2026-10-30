/**
 * What a computer-use tool call did and showed, for each family of tools
 * (computer-use-memory.md, "Tools"): the action, the controls it named, and
 * the screen its answer showed, as a page address and a snapshot read as
 * text. Each family has its own translator.
 *
 * - **Playwright MCP** (`mcp__<server>__browser_*`, the proxy's too): actions
 *   name a control by the `ref` it had in the last snapshot, and answer with
 *   `- Page URL:` and the snapshot inline or as a linked file (0.0.83).
 * - **Claude's built-in browser** (`mcp__Claude_Browser__*`) and **Claude in
 *   Chrome** (`mcp__claude-in-chrome__*`): `read_page` answers with a tree
 *   whose controls are tagged `[ref_N]`; `computer` clicks a `ref` or a point
 *   on a screenshot, and a click at a point names no control; `form_input`
 *   sets a field by `ref`; `browser_batch` runs several. Written from their
 *   tool descriptions; Step 0's samples check them (no session here has
 *   called them yet).
 * - **Desktop computer use** (`mcp__computer-use__*`): the app and menu paths
 *   only. Clicks are points on screenshots, with nothing to anchor a note to.
 *
 * Nothing typed or chosen is kept: an action says which controls it used,
 * never the text.
 */

export type Family = "playwright" | "builtin" | "chrome" | "desktop"

export interface Call {
  /** The tool's full name as the agent called it. */
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  /** The answer's text, images as `[image]`. */
  readonly result: string | undefined
  readonly failed: boolean
}

export type ActKind = "click" | "fill" | "select" | "key" | "navigate" | "back" | "other"

export interface Act {
  readonly kind: ActKind
  /** The controls it used, by the refs of the last screen read. */
  readonly refs: ReadonlyArray<string>
  /** A key pressed (`Enter`): keys are the app's, not the task's. */
  readonly key?: string | undefined
  /** Where a navigation went. */
  readonly url?: string | undefined
  /** A click at a point on a screenshot, which names no control. */
  readonly atPoint?: boolean | undefined
  /** For a field set to a value: whether it was ticked on (true) or off (false), when the call says. */
  readonly on?: boolean | undefined
}

export interface Observation {
  readonly family: Family
  readonly tool: string
  readonly act: Act | undefined
  /** The page's address after the call, when the answer says. */
  readonly url: string | undefined
  /** The screen read as text after the call, inline. */
  readonly yaml: string | undefined
  /** Or Playwright's snapshot file, as the answer linked it. */
  readonly file: string | undefined
  readonly failed: boolean
  /** Desktop: the app the call named, and a menu path it used. */
  readonly app?: string | undefined
  readonly menu?: ReadonlyArray<string> | undefined
}

/** The tool's server and short name: `mcp__playwright__browser_click` → playwright, browser_click. */
const parts = (name: string): { server: string; tool: string } | undefined => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m === null ? undefined : { server: m[1], tool: m[2] }
}

export const familyOf = (name: string): Family | undefined => {
  const p = parts(name)
  if (p === undefined) return undefined
  if (p.server === "Claude_Browser") return "builtin"
  if (p.server === "claude-in-chrome") return "chrome"
  if (p.server === "computer-use") return "desktop"
  if (p.tool.startsWith("browser_")) return "playwright"
  return undefined
}

/** The hook's raw-input check, before anything is parsed: the tool families memory reads. */
export const COMPUTER_TOOL = /"tool_name"\s*:\s*"mcp__(?:Claude_Browser|claude-in-chrome|computer-use|[^"]*?__browser_)/

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const obj = (v: unknown): Readonly<Record<string, unknown>> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

const PLAYWRIGHT_KINDS: Readonly<Record<string, ActKind>> = {
  browser_click: "click",
  browser_type: "fill",
  browser_fill_form: "fill",
  browser_select_option: "select",
  browser_press_key: "key",
  browser_navigate: "navigate",
  browser_navigate_back: "back",
  browser_hover: "other",
  browser_drag: "other",
  browser_file_upload: "other",
  browser_handle_dialog: "other"
}

const playwright = (tool: string, c: Call): Observation => {
  const kind = PLAYWRIGHT_KINDS[tool]
  const ref = str(c.input.target) ?? str(c.input.ref)
  let act: Act | undefined
  if (kind === "fill" && Array.isArray(c.input.fields)) {
    const fields = (c.input.fields as Array<unknown>).map(obj)
    act = { kind, refs: fields.map((f) => str(f.target) ?? str(f.ref)).filter((r): r is string => r !== undefined) }
    const toggles = fields.filter((f) => f.type === "checkbox" || f.value === "true" || f.value === "false")
    if (toggles.length === 1 && fields.length === 1) act = { ...act, on: toggles[0].value === true || toggles[0].value === "true" }
  } else if (kind !== undefined) {
    act = {
      kind: kind === "fill" && c.input.submit === true ? "fill" : kind,
      refs: ref === undefined ? [] : [ref],
      key: kind === "key" ? str(c.input.key) : kind === "fill" && c.input.submit === true ? "Enter" : undefined,
      url: kind === "navigate" ? str(c.input.url) : undefined
    }
  }
  const url = /^- Page URL: (.+)$/m.exec(c.result ?? "")?.[1]?.trim()
  const yaml = /```yaml\r?\n([\s\S]*?)```/.exec(c.result ?? "")?.[1]
  const file = /^- \[Snapshot\]\(([^)]+\.ya?ml)\)/m.exec(c.result ?? "")?.[1]
  return { family: "playwright", tool, act, url, yaml, file, failed: c.failed || /(^|\n)### Error/.test(c.result ?? "") }
}

/** A tree read as text: the answer when its lines are `- role "name"` lines with refs. */
const treeOf = (text: string | undefined): string | undefined =>
  text !== undefined && /^\s*- [A-Za-z][\w-]*(?: "|\s*\[| ?:|$)/m.test(text) && /\bref_\d+\b|\[ref=/.test(text) ? text : undefined

/** An address the answer states: a `URL:` line, or the first web address on its first lines. */
const statedUrl = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined
  const line = /^(?:-\s*)?(?:Page )?URL:\s*(\S+)/im.exec(text)?.[1]
  return line ?? /https?:\/\/[^\s"'<>)\]]+/.exec(text.split("\n").slice(0, 3).join("\n"))?.[0]
}

const browserCall = (family: "builtin" | "chrome", tool: string, input: Readonly<Record<string, unknown>>, result: string | undefined, failed: boolean): Observation => {
  const ref = str(input.ref)
  const base = { family, tool, failed, file: undefined }
  switch (tool) {
    case "navigate": {
      const url = str(input.url)
      const back = url === "back" || url === "forward"
      return { ...base, act: { kind: back ? "back" : "navigate", refs: [], url: back ? undefined : url }, url: back ? statedUrl(result) : url, yaml: undefined }
    }
    case "read_page":
    case "find":
      return { ...base, act: undefined, url: statedUrl(result), yaml: tool === "read_page" ? treeOf(result) : undefined }
    case "form_input": {
      const v = input.value
      return { ...base, act: { kind: "fill", refs: ref === undefined ? [] : [ref], on: typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined }, url: undefined, yaml: undefined }
    }
    case "computer": {
      const action = str(input.action) ?? ""
      if (/click/.test(action)) {
        return { ...base, act: { kind: "click", refs: ref === undefined ? [] : [ref], atPoint: ref === undefined && Array.isArray(input.coordinate) }, url: undefined, yaml: undefined }
      }
      if (action === "key") return { ...base, act: { kind: "key", refs: [], key: str(input.text) }, url: undefined, yaml: undefined }
      if (action === "type") return { ...base, act: { kind: "fill", refs: ref === undefined ? [] : [ref] }, url: undefined, yaml: undefined }
      return { ...base, act: undefined, url: undefined, yaml: undefined }
    }
    default:
      return { ...base, act: undefined, url: undefined, yaml: undefined }
  }
}

const desktop = (tool: string, c: Call): Observation => {
  const app = str(c.input.app) ?? str(c.input.application) ?? str(c.input.bundle_id) ?? str(c.input.bundleId) ?? str(c.input.app_name)
  const path = c.input.path ?? c.input.menu ?? c.input.menu_path
  const menu = tool === "app_menu" && Array.isArray(path) ? path.filter((p): p is string => typeof p === "string") : undefined
  return { family: "desktop", tool, act: undefined, url: undefined, yaml: undefined, file: undefined, failed: c.failed, app, menu }
}

/** What a call did and showed; a batch gives one observation per action in it. Empty for other tools. */
export const observe = (c: Call): Array<Observation> => {
  const family = familyOf(c.name)
  const p = parts(c.name)
  if (family === undefined || p === undefined) return []
  if (family === "playwright") return [playwright(p.tool, c)]
  if (family === "desktop") return [desktop(p.tool, c)]
  if (p.tool === "browser_batch" && Array.isArray(c.input.actions)) {
    // The batch's answer can't be split by action: only the last action is given it.
    const items = (c.input.actions as Array<unknown>).map(obj)
    return items.map((item, i) => browserCall(family, str(item.name) ?? "", obj(item.input), i === items.length - 1 ? c.result : undefined, c.failed))
  }
  return [browserCall(family, p.tool, c.input, c.result, c.failed)]
}
