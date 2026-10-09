import { assert, describe, it } from "@effect/vitest"
import { readWebSession } from "../../src/web/Extract.ts"
import { checkWebAnswer, webEvidence } from "../../src/web/Induce.ts"
import { replayWeb } from "../../src/web/Learn.ts"
import { blankText, chainOf, findPlace, pagePattern, taskValues, webPlace, webSubjectId } from "../../src/web/Places.ts"
import type { WebRecord } from "../../src/web/Records.ts"
import { webTriggerFires } from "../../src/web/Session.ts"
import { renderWebHandover } from "../../src/web/Start.ts"
import { messagesOf, pageOf, parseSnapshot } from "../../src/web/Snapshot.ts"
import type { ToolCall } from "../../src/traces/index.ts"
import { FORMAT, type WorkflowMemory } from "../../src/workflows/Models.ts"

const ORDER_PAGE = `- generic [active] [ref=e1]:
  - navigation "Main" [ref=e2]:
    - link "Orders" [ref=e3] [cursor=pointer]:
      - /url: /orders
  - main [ref=e5]:
    - 'heading "Order #4821" [level=1] [ref=e6]'
    - region "Actions" [ref=e7]:
      - button "Edit" [ref=e8]
      - group [ref=e9]:
        - generic "More actions" [active] [ref=e10]
        - button "Refund" [ref=e19]
    - alert [ref=e30]: Refunds over $500 need a manager note.
    - table [ref=e11]:
      - row [ref=e16]:
        - cell "Lamp" [ref=e17]`

const result = (url: string, yaml?: string) =>
  `### Page\n- Page URL: ${url}\n- Page Title: Order\n### Snapshot\n${yaml === undefined ? "- [Snapshot](x.yml)" : "```yaml\n" + yaml + "\n```"}`

const call = (name: string, input: Record<string, unknown>, res: string, isError = false): ToolCall => ({
  id: Math.random().toString(36).slice(2),
  name: `mcp__playwright__browser_${name}`,
  input,
  agentId: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  result: res,
  isError
})

describe("web snapshots", () => {
  it("reads roles, names, references, parents and inline text", () => {
    const nodes = parseSnapshot(ORDER_PAGE)
    const refund = nodes.find((n) => n.ref === "e19")!
    assert.strictEqual(refund.role, "button")
    assert.strictEqual(refund.name, "Refund")
    assert.strictEqual(nodes[refund.parent!].role, "group")
    assert.strictEqual(nodes.find((n) => n.ref === "e6")!.name, "Order #4821")
    assert.deepStrictEqual(messagesOf(nodes), ["Refunds over $500 need a manager note."])
  })

  it("reads a tool result's address and inline snapshot", () => {
    const view = pageOf(result("http://localhost:5101/orders/4821", ORDER_PAGE))
    assert.strictEqual(view.url, "http://localhost:5101/orders/4821")
    assert.isTrue(view.yaml!.includes("Refund"))
    assert.strictEqual(pageOf(result("http://localhost:5101/x")).yaml, undefined)
  })
})

describe("web places", () => {
  it("leaves a task's values and ids out of pages and names", () => {
    const values = taskValues("Refund order 4821 for Maria Chen; reason: damaged on arrival. Amount $612.50.")
    assert.isTrue(values.includes("Maria Chen"))
    assert.isTrue(values.includes("4821"))
    assert.strictEqual(pagePattern("http://localhost:5101/orders/4821?tab=items", values), "/orders/{n}?tab=items")
    assert.strictEqual(blankText("Order #4821 for Maria Chen", values), "Order #{n} for {value}")
  })

  it("keeps the regions around a control, and finds it again in a later page", () => {
    const nodes = parseSnapshot(ORDER_PAGE)
    const chain = chainOf(nodes, "e19", ["4821"])!
    assert.deepStrictEqual(chain.map((r) => r.role), ["navigation", "main", "region", "button"].filter((r) => r !== "navigation"))
    const place = webPlace("web-x", "/orders/{n}", chain, ["a", "b"], ["t1", "t2"], 2)
    const later = parseSnapshot(ORDER_PAGE.replace("e19", "e44").replace("Order #4821", "Order #9000"))
    assert.strictEqual(findPlace(place, later, "/orders/{n}")?.node.ref, "e44")
    assert.strictEqual(findPlace(place, later, "/customers/{n}"), undefined)
    // Moved out of the Actions region: not the same place any more.
    const moved = parseSnapshot(ORDER_PAGE.replace('region "Actions"', 'region "Danger zone"'))
    assert.strictEqual(findPlace(place, moved, "/orders/{n}"), undefined)
  })

  it("names one subject per web app", () => {
    assert.strictEqual(webSubjectId("http://localhost:5101"), "web-localhost-5101")
  })
})

describe("web sessions", () => {
  const calls = [
    call("navigate", { url: "http://localhost:5101/orders/4821" }, result("http://localhost:5101/orders/4821")),
    call("snapshot", {}, result("http://localhost:5101/orders/4821", ORDER_PAGE)),
    call("click", { element: "Refund", target: "e19" }, result("http://localhost:5101/orders/4821")),
    call("click", { element: "Ghost", target: "e99" }, "### Error\nError: no element e99", true)
  ]

  it("places each action in the snapshot it was taken from", () => {
    const view = readWebSession(calls, ["4821"], "web-x")
    assert.strictEqual(view.actions.length, 3)
    assert.strictEqual(view.actions[0].kind, "navigate")
    assert.strictEqual(view.actions[1].page, "/orders/{n}")
    assert.strictEqual(view.actions[1].chain?.at(-1)?.name, "Refund")
    assert.isDefined(view.actions[1].place)
    assert.isTrue(view.actions[2].failed)
    assert.deepStrictEqual(view.messages.map((m) => m.text), ["Refunds over {n} need a manager note."])
  })

  const record = (id: string, prompt: string, success: boolean): WebRecord => {
    const values = taskValues(prompt)
    const view = readWebSession(calls, values, "web-x")
    return {
      id,
      tenant: "t",
      subject: "web-x",
      session_id: id,
      task_id: id,
      prompt,
      values,
      success,
      feedback: success ? "Done, thanks." : "Refunds over $500 need a manager note.",
      actions: view.actions.map((a) => ({ index: a.index, kind: a.kind, page: a.page ?? null, chain: a.chain === undefined ? null : [...a.chain], place: a.place ?? null, text: a.text ?? null, failed: a.failed, error: a.error ?? null })),
      messages: view.messages.map((m) => ({ after: m.after, page: m.page ?? null, text: m.text })),
      turns: 5,
      tokens: 1000,
      cost_usd: 0.01,
      memory: null,
      created_at: `2026-10-09T00:00:0${id.length}Z`
    }
  }

  it("pools places across sessions and checks an answer against them", () => {
    const records = [record("r1", "Refund order 4821 at http://localhost:5101", true), record("r2", "Refund order 4822 at http://localhost:5101", false)]
    const evidence = webEvidence("web-x", records)
    const refund = evidence.places.find((p) => p.chain.at(-1)?.head === 'button "Refund"')!
    assert.strictEqual(refund.evidence.length, 2)
    const checked = checkWebAnswer({
      workflows: [{ id: "issue-refund", name: "Issue a refund", use_when: "a task asks to refund an order", blanks: [{ name: "order", meaning: "the order" }], steps: [{ do: "Open More actions, then Refund for {order}.", place: refund.id, when: null }, { do: "Refund 4821.", place: null, when: null }], checks: [], pitfalls: ["refund-note"], from_runs: ["r1"], only_if_asked: false }],
      edges: [],
      pitfalls: [
        { id: "refund-note", text: "Refunds over {amount} need a manager note first.", detours: ["r2#feedback"], trigger: { on: "page", all: ["Refund amount"], none: [], file: null } },
        { id: "made-up", text: "Something nobody saw.", detours: ["r9#3"], trigger: null }
      ],
      entries: [],
      rationale: ""
    }, evidence, "t")
    const w = checked.memory.workflows[0]
    assert.strictEqual(w.steps.length, 1, "the step naming the task's own value is dropped")
    assert.strictEqual(w.steps[0].place, refund.id)
    assert.deepStrictEqual(checked.memory.pitfalls.map((p) => p.id), ["refund-note"])
    assert.strictEqual(checked.memory.pitfalls[0].trigger?.on, "page")
    assert.strictEqual(checked.memory.places[0].kind, "web")

    const memory: WorkflowMemory = { ...checked.memory, workflows: checked.memory.workflows.map((x) => ({ ...x, cues: { any: ["refund"], none: [], steps: [], fills: [] } })) }
    const replayed = replayWeb(memory, records)
    assert.strictEqual(replayed.shown_and_edited, 2)
    assert.strictEqual(replayed.shown_unused, 0)

    const handover = renderWebHandover(memory, [{ workflow: memory.workflows[0], skip: [], why: "" }], undefined, "http://localhost:5101")
    assert.isTrue(handover.text!.includes('region "Actions" › button "Refund"'))
    assert.isTrue(handover.text!.includes("manager note"))
    assert.deepStrictEqual(handover.places, [refund.id])
  })

  it("fires web triggers on what the page shows, the control used, or a failure", () => {
    const t = { on: "page" as const, all: ["Confirm refund"], none: [], file: null }
    assert.isTrue(webTriggerFires(t, { page: "Confirm refund\nCancel", control: undefined, error: undefined }))
    assert.isFalse(webTriggerFires(t, { page: "Orders", control: undefined, error: undefined }))
    assert.isTrue(webTriggerFires({ on: "action", all: ["Delete"], none: [], file: null }, { page: undefined, control: "Delete attachments", error: undefined }))
    assert.isFalse(webTriggerFires({ on: "command", all: ["yarn test"], none: [], file: null }, { page: "yarn test", control: undefined, error: undefined }))
  })

  it("leaves memory empty for an app it has nothing on", () => {
    const empty: WorkflowMemory = { format: FORMAT, tenant: "t", places: [], workflows: [], edges: [], pitfalls: [] }
    assert.strictEqual(renderWebHandover(empty, [], undefined, "http://localhost:5101").text, undefined)
  })
})
