/**
 * A small refund app as Playwright MCP 0.0.83 shows it, and chores in it as
 * a session's calls: what computer-use memory's tests replay.
 */
import { Effect } from "effect"
import type { SessionInput, TimedCall } from "../../src/computer/Capture.ts"

export const BASE = "http://127.0.0.1:5199"

const answer = (url: string, yaml: string) => `### Page\n- Page URL: ${url}\n- Page Title: Shop\n### Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\``

export const orderPage = (o: { readonly status?: string; readonly refund?: string }) =>
  [
    `- navigation "Main" [ref=e2]:`,
    `  - link "Orders" [ref=e3]`,
    `- main [ref=e4]:`,
    ...(o.status === undefined ? [] : [`  - status [ref=e9]: ${o.status}`]),
    `  - heading "Order" [level=1] [ref=e5]`,
    `  - link "${o.refund ?? "Refund order"}" [ref=e6]`
  ].join("\n")

export const refundForm = (o: { readonly restock?: string; readonly extra?: string; readonly error?: string }) =>
  [
    `- main [ref=e4]:`,
    `  - form "Refund" [ref=e10]:`,
    `    - checkbox "${o.restock ?? "Restock items"}" [checked] [ref=e11]`,
    `    - textbox "Note" [ref=e12]`,
    ...(o.error === undefined ? [] : [`    - alert [ref=e15]: ${o.error}`]),
    ...(o.extra === undefined ? [] : [`    - button "${o.extra}" [ref=e14]`]),
    `    - button "Issue refund" [ref=e13]`
  ].join("\n")

export interface ChoreOptions {
  readonly order: number
  readonly untick?: boolean
  readonly restock?: string
  readonly refund?: string
  readonly extra?: string
  readonly error?: string
  readonly start: string
}

const at = (start: string, i: number) => new Date(Date.parse(start) + i * 1000).toISOString()

/** A refund chore: open the order, open the refund form, maybe untick restock, type a note, send it, see the order. */
export const refundChore = (o: ChoreOptions): Array<TimedCall> => {
  const order = `${BASE}/orders/${o.order}`
  const calls: Array<TimedCall> = []
  const add = (name: string, input: Record<string, unknown>, result: string) => calls.push({ call: { name: `mcp__playwright__${name}`, input, result, failed: false }, at: at(o.start, calls.length) })
  add("browser_navigate", { url: order }, answer(order, orderPage({ refund: o.refund })))
  add("browser_click", { element: "Refund order", target: "e6" }, answer(`${order}/refund`, refundForm(o)))
  if (o.untick === true) add("browser_click", { element: "Restock items", target: "e11" }, answer(`${order}/refund`, refundForm(o).replace(" [checked]", "")))
  add("browser_type", { element: "Note", target: "e12", text: "Priya Naidu asked for this" }, answer(`${order}/refund`, refundForm(o)))
  // A form sent by GET: its address carries what was typed.
  add("browser_click", { element: "Issue refund", target: "e13" }, answer(`${order}?done=1&note=Priya%20Naidu%20asked%20for%20this`, orderPage({ status: "Refund issued", refund: o.refund })))
  return calls
}

export const session = (id: string, calls: ReadonlyArray<TimedCall>, prompts: SessionInput["prompts"] = []): SessionInput => ({
  session: id,
  agent: "claude-code",
  calls,
  prompts,
  readFile: () => Effect.succeed(undefined)
})
