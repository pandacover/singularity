import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { claudeCli } from "../../src/eval/Llm.ts"
import { loadHome } from "../../src/local/Home.ts"
import type { ToolCall } from "../../src/traces/index.ts"
import { readWebSession } from "../../src/web/Extract.ts"
import { webEvidence } from "../../src/web/Induce.ts"
import { learnWebSubject } from "../../src/web/Learn.ts"
import { taskValues } from "../../src/web/Places.ts"
import { putWebRecord, type WebRecord } from "../../src/web/Records.ts"
import * as JsonWorkflowStore from "../../src/workflows/JsonWorkflowStore.ts"
import { FORMAT, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { WorkflowStore } from "../../src/workflows/WorkflowStore.ts"
import { FAKE_CLAUDE, run, tempDir, withEnv } from "../eval/helpers.ts"

const FORM = `- generic [active] [ref=e1]:
  - main [ref=e2]:
    - dialog "Check out" [ref=e3]:
      - checkbox "Send SMS reminder" [checked] [ref=e8]
      - button "Confirm checkout" [ref=e12]`
const URL_ = "http://localhost:5190/books/102?checkout=1"
const result = (yaml?: string) => `### Page\n- Page URL: ${URL_}\n- Page Title: Check out\n### Snapshot\n${yaml === undefined ? "- [Snapshot](x.yml)" : "```yaml\n" + yaml + "\n```"}`
const call = (name: string, input: Record<string, unknown>, res: string): ToolCall => ({
  id: Math.random().toString(36).slice(2),
  name: `mcp__playwright__browser_${name}`,
  input,
  agentId: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  result: res,
  isError: false
})
const snapshot = call("snapshot", {}, result(FORM))
const untick = call("click", { element: "Send SMS reminder", target: "e8" }, result())
const confirm = call("click", { element: "Confirm checkout", target: "e12" }, result())

const record = (id: string, prompt: string, success: boolean, calls: ReadonlyArray<ToolCall>, feedback: string): WebRecord => {
  const values = taskValues(prompt)
  const view = readWebSession(calls, values, "web-x")
  return {
    id,
    tenant: "local",
    subject: "web-x",
    session_id: id,
    task_id: id,
    prompt,
    values,
    success,
    feedback,
    actions: view.actions.map((a) => ({ index: a.index, kind: a.kind, page: a.page ?? null, chain: a.chain === undefined ? null : [...a.chain], place: a.place ?? null, text: a.text ?? null, was: a.was ?? null, failed: a.failed, error: a.error ?? null })),
    messages: [],
    forms: view.forms.map((f) => ({ page: f.page, fields: [...f.fields] })),
    turns: 5,
    tokens: 1000,
    cost_usd: 0.01,
    memory: null,
    created_at: `2026-10-09T00:00:0${id.slice(-1)}Z`
  }
}

describe("a learning round whose workflows the replay turns down", () => {
  it("keeps the round's rules, and writes the notes on fields that start set", async () => {
    const root = tempDir()
    const homeDir = join(root, "home")
    const learner = join(root, "learner")
    mkdirSync(learner, { recursive: true })
    const home = await run(loadHome(homeDir))
    const records = [
      record("r1", "Lend book 102 to member 7, no text reminders please.", true, [snapshot, untick, confirm], "Done, thanks."),
      record("r2", "Lend book 103 to member 9, no text reminders please.", true, [snapshot, untick, confirm], "Done, thanks."),
      record("r3", "Lend book 104 to member 8.", false, [snapshot, confirm], "The member never asked for reminders, and got one.")
    ]
    const confirmPlace = records[0].actions.find((a) => a.chain?.at(-1)?.name === "Confirm checkout")!.place!
    // Memory as it is: a workflow that shows the place every session used.
    const current: WorkflowMemory = {
      format: FORMAT,
      tenant: "local",
      places: webEvidence("web-x", records).places.filter((p) => p.id === confirmPlace),
      workflows: [{
        id: "lend-book",
        subject: "web-x",
        name: "Lend a book",
        use_when: "a task asks to lend a book",
        cues: { any: ["lend"], none: [], steps: [], fills: [] },
        only_if_asked: false,
        blanks: [],
        steps: [{ do: "Click Confirm checkout.", place: confirmPlace, when: null }],
        checks: [],
        pitfalls: [],
        evidence: ["r1", "r2"],
        tasks: ["r1", "r2"]
      }],
      edges: [],
      pitfalls: []
    }
    // The model's revision drops the workflow (the replay can only score it worse) and adds a rule from r3's feedback.
    const answers = join(root, "answers.json")
    writeFileSync(answers, JSON.stringify([{
      workflows: [],
      edges: [],
      pitfalls: [{ id: "reminders-only-when-asked", text: "Untick Send SMS reminder unless the member asked for reminders.", detours: ["r3#feedback"], trigger: { on: "page", all: ["Send SMS reminder"], none: [], file: null } }],
      entries: [],
      rationale: "a rule from the feedback"
    }]))
    const stores = JsonWorkflowStore.layer(join(home.tenantDir, "workflows"), home.tenant)
    const out = await withEnv({ FAKE_CLAUDE_ANSWERS: answers }, () =>
      run(Effect.gen(function*() {
        const store = yield* WorkflowStore
        const proposed = yield* store.propose(current, { rationale: "as it was", records: ["r1", "r2"], model: "sonnet", costUsd: 0, report: { problems: [], replay: null } })
        yield* store.commit(proposed.id)
        for (const r of records) yield* putWebRecord(home.tenantDir, r)
        const outcome = yield* learnWebSubject("web-x", { cli: claudeCli(FAKE_CLAUDE), cwd: learner, model: "sonnet" }, home.tenantDir)
        return { outcome, memory: yield* store.memory() }
      }).pipe(Effect.provide(stores))))
    expect(out.outcome).toMatchObject({ kind: "rules-only" })
    expect(out.memory.workflows.map((w) => w.id)).toEqual(["lend-book"])
    const rule = out.memory.pitfalls.find((p) => p.id === "reminders-only-when-asked")!
    expect(rule.evidence).toEqual(["r3"])
    const note = out.memory.pitfalls.find((p) => p.id.startsWith("preset-"))!
    expect(note.text).toContain('checkbox "Send SMS reminder" ticked (earlier sessions changed it in 2 of 3; one that left it failed)')
  })
})
