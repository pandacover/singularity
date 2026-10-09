import { assert, describe, it } from "@effect/vitest"
import { readWebSession } from "../../src/web/Extract.ts"
import { webInductionPrompt, webEvidence } from "../../src/web/Induce.ts"
import { webLearnWait } from "../../src/web/Learn.ts"
import { taskValues } from "../../src/web/Places.ts"
import { presetNotes } from "../../src/web/Presets.ts"
import type { WebRecord } from "../../src/web/Records.ts"
import { isPresetNote } from "../../src/web/Session.ts"
import { fieldState, parseSnapshot } from "../../src/web/Snapshot.ts"
import { renderWebHandover } from "../../src/web/Start.ts"
import type { ToolCall } from "../../src/traces/index.ts"
import { FORMAT, type WorkflowMemory } from "../../src/workflows/Models.ts"

// A checkout form as Playwright shows it: a select still asking to choose, a box ticked by default, a note.
const FORM = `- generic [active] [ref=e1]:
  - main [ref=e2]:
    - heading "Check out" [level=1] [ref=e3]
    - generic [ref=e4]:
      - combobox "Loan length" [ref=e5]:
        - option "— choose —" [selected]
        - option "Two weeks"
      - combobox "Branch" [ref=e6]:
        - option "Main library" [selected]
        - option "East branch"
      - paragraph [ref=e7]:
        - checkbox "Send SMS reminder" [checked] [ref=e8]
        - text: Send SMS reminder
      - checkbox "Print receipt" [ref=e9]
      - textbox "Note" [ref=e10]
      - textbox "Desk" [ref=e11]: Front desk
      - button "Confirm checkout" [ref=e12]`

const result = (url: string, yaml?: string) =>
  `### Page\n- Page URL: ${url}\n- Page Title: Check out\n### Snapshot\n${yaml === undefined ? "- [Snapshot](x.yml)" : "```yaml\n" + yaml + "\n```"}`

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

const URL_ = "http://localhost:5190/books/102/checkout"

/** A session on the form: a snapshot, then the given actions. */
const session = (actions: ReadonlyArray<ToolCall>) => [call("snapshot", {}, result(URL_, FORM)), ...actions]

const record = (id: string, prompt: string, success: boolean, actions: ReadonlyArray<ToolCall>, feedback?: string): WebRecord => {
  const values = taskValues(prompt)
  const view = readWebSession(session(actions), values, "web-x")
  return {
    id,
    tenant: "t",
    subject: "web-x",
    session_id: id,
    task_id: id,
    prompt,
    values,
    success,
    feedback: feedback ?? (success ? "Done, thanks." : null),
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

const confirm = call("click", { element: "Confirm checkout", target: "e12" }, result(URL_))
const untick = call("click", { element: "Send SMS reminder", target: "e8" }, result(URL_))

describe("fields that start set", () => {
  it("reads what each field is set to, and which count as set before anyone touches them", () => {
    const nodes = parseSnapshot(FORM)
    const state = (ref: string) => fieldState(nodes, nodes.find((n) => n.ref === ref)!)
    assert.deepStrictEqual(state("e5"), { state: "— choose —", set: false })
    assert.deepStrictEqual(state("e6"), { state: "Main library", set: true })
    assert.deepStrictEqual(state("e8"), { state: "ticked", set: true })
    assert.deepStrictEqual(state("e9"), { state: "unticked", set: false })
    assert.deepStrictEqual(state("e10"), { state: "empty", set: false })
    assert.deepStrictEqual(state("e11"), { state: "filled", set: true })
    assert.strictEqual(fieldState(nodes, nodes.find((n) => n.ref === "e12")!), undefined)
  })

  it("keeps the fields a page opened with set, whether the session changed them, and what an action's field was before", () => {
    const left = readWebSession(session([confirm]), [], "web-x")
    assert.deepStrictEqual(left.forms, [{
      page: "/books/{n}/checkout",
      fields: [
        { control: 'combobox "Branch"', state: "Main library", changed: false },
        { control: 'checkbox "Send SMS reminder"', state: "ticked", changed: false },
        { control: 'textbox "Desk"', state: "filled", changed: false }
      ]
    }])
    const changed = readWebSession(session([untick, confirm]), [], "web-x")
    assert.isTrue(changed.forms[0].fields.find((f) => f.control === 'checkbox "Send SMS reminder"')!.changed)
    assert.strictEqual(changed.actions[0].was, "ticked")
    // Ticked again: back as it was.
    const twice = readWebSession(session([untick, untick, confirm]), [], "web-x")
    assert.isFalse(twice.forms[0].fields.find((f) => f.control === 'checkbox "Send SMS reminder"')!.changed)
    // A form only looked at, or filled in and never sent, says nothing about its fields.
    assert.deepStrictEqual(readWebSession(session([]), [], "web-x").forms, [])
    assert.deepStrictEqual(readWebSession(session([untick]), [], "web-x").forms, [])
  })

  it("keeps an option's own numbers, and blanks only the task's values", () => {
    const WEEKS = FORM.replace(`- option "Main library" [selected]`, `- option "4 weeks at Main library" [selected]`)
    const view = readWebSession([call("snapshot", {}, result(URL_, WEEKS)), confirm], taskValues("Lend book 102 to member 7 at the Main desk."), "web-x")
    assert.strictEqual(view.forms[0].fields[0].state, "4 weeks at {value} library")
  })

  it("takes a field's start from the first snapshot that shows it: a form behind a disclosure opens at the same address", () => {
    const LOANS = `- generic [active] [ref=e1]:
  - main [ref=e2]:
    - list "Open loans" [ref=e3]:
      - listitem [ref=e4]:
        - group [ref=e5]:
          - generic "More" [ref=e6]`
    const OPENED = LOANS.replace(`- generic "More" [ref=e6]`, `- generic "More" [ref=e6]
          - checkbox "Charge renewal fee" [checked] [ref=e7]
          - button "Renew" [ref=e8]`)
    const loans = "http://localhost:5190/loans"
    const view = readWebSession([
      call("snapshot", {}, result(loans, LOANS)),
      call("click", { element: "More", target: "e6" }, result(loans)),
      call("snapshot", {}, result(loans, OPENED)),
      call("click", { element: "Renew", target: "e8" }, result(loans))
    ], [], "web-x")
    assert.deepStrictEqual(view.forms, [{ page: "/loans", fields: [{ control: 'checkbox "Charge renewal fee"', state: "ticked", changed: false }] }])
  })

  it("writes a note per page from the sessions, without a model and without a task's values", () => {
    const records = [
      record("r1", "Lend book 102 to member 7, no text reminders please.", true, [untick, confirm]),
      record("r2", "Lend book 103 to member 9.", false, [confirm], "The member asked for no messages, and got one."),
      record("r3", "Lend book 104 to member 8 at the Main library desk.", true, [confirm])
    ]
    const notes = presetNotes("web-x", records)
    assert.strictEqual(notes.length, 1)
    const note = notes[0]
    assert.isTrue(isPresetNote(note))
    assert.include(note.text, 'checkbox "Send SMS reminder" ticked (earlier sessions changed it in 1 of 3; one that left it failed)')
    // Text already in a box is in plain sight: no note.
    assert.notInclude(note.text, "Desk")
    // "Main library" is a task's own value in r3: the field stays, its value doesn't.
    assert.include(note.text, 'combobox "Branch" already set')
    assert.notInclude(note.text, "Main library")
    assert.deepStrictEqual(note.trigger, { on: "page", all: ["Send SMS reminder"], none: [], file: null })
    assert.deepStrictEqual(note.evidence, ["r1", "r2", "r3"])
  })

  it("looks for a field whose name has a blank by the rest of its name", () => {
    const fee = { ...record("r1", "Renew the loan.", false, [confirm], "First renewals are free."), forms: [{ page: "/loans", fields: [{ control: 'checkbox "Charge renewal fee ({n})"', state: "ticked", changed: false }] }] }
    assert.deepStrictEqual(presetNotes("web-x", [fee])[0].trigger, { on: "page", all: ["Charge renewal fee"], none: [], file: null })
  })

  it("shows the model what each session found set, and what it did with it", () => {
    const records = [record("r1", "Lend book 102 to member 7, no text reminders please.", true, [untick, confirm])]
    const prompt = webInductionPrompt(webEvidence("web-x", records), undefined)
    assert.include(prompt, "(was ticked)")
    assert.include(prompt, 'checkbox "Send SMS reminder" ticked, changed')
    assert.include(prompt, 'textbox "Desk" filled in, left as it was')
  })
})

describe("learning right after a failure with feedback", () => {
  const ok = record("r1", "Lend book 102 to member 7.", true, [confirm])
  const bad = record("r2", "Lend book 103 to member 9.", false, [confirm], "The member asked for no messages, and got one.")
  const silent = { ...record("r3", "Lend book 104 to member 8.", false, [confirm]), feedback: null }

  it("learns at once from a failure the manager explained, even from one session", () => {
    assert.strictEqual(webLearnWait([bad], new Set(), false, 3, false), undefined)
    assert.strictEqual(webLearnWait([ok, bad], new Set(["r1"]), true, 3, false), undefined)
  })

  it("otherwise keeps the schedule: two sessions for a first build, then every three", () => {
    assert.strictEqual(webLearnWait([ok], new Set(), false, 3, false), "1 of 2 sessions recorded for a first build")
    assert.strictEqual(webLearnWait([ok, silent], new Set(["r1"]), true, 3, false), "1 of 3 new sessions recorded")
    assert.strictEqual(webLearnWait([ok, bad], new Set(["r1", "r2"]), true, 3, false), "nothing new since the last round")
  })
})

describe("the app's rules at every start", () => {
  const memory: WorkflowMemory = {
    format: FORMAT,
    tenant: "t",
    places: [],
    workflows: [{
      id: "lend-book",
      subject: "web-x",
      name: "Lend a book",
      use_when: "a task asks to lend a book",
      cues: { any: ["lend"], none: [], steps: [], fills: [] },
      only_if_asked: false,
      blanks: [],
      steps: [{ do: "Open the book's page, then Check out.", place: null, when: null }],
      checks: [],
      pitfalls: ["no-sms-unless-asked"],
      evidence: ["r1"],
      tasks: ["r1"]
    }],
    edges: [],
    pitfalls: [
      { id: "no-sms-unless-asked", subject: "web-x", text: "Members get no SMS unless they asked for it: untick Send SMS reminder.", trigger: null, evidence: ["r2"], cost_tokens: 0 },
      { id: "overdue-cant-borrow", subject: "web-x", text: "A member with an overdue loan can't borrow.", trigger: null, evidence: ["r1", "r3"], cost_tokens: 0 },
      { id: "preset-abcd1234", subject: "web-x", text: 'On /books/{n}/checkout, the form opens with checkbox "Send SMS reminder" ticked.', trigger: { on: "page", all: ["Send SMS reminder"], none: [], file: null }, evidence: ["r1"], cost_tokens: 0 }
    ]
  }

  it("hands over every rule and the fields that start set, with no workflow picked", () => {
    const h = renderWebHandover(memory, [], undefined, "http://localhost:5190")
    assert.include(h.text!, "## Rules of this app")
    assert.include(h.text!, "Members get no SMS unless they asked for it")
    assert.include(h.text!, "overdue loan")
    assert.include(h.text!, "## Forms that open with fields already set")
    assert.notInclude(h.text!, "## Lend a book")
    assert.deepStrictEqual(h.pitfalls.sort(), ["no-sms-unless-asked", "overdue-cant-borrow", "preset-abcd1234"])
  })

  it("puts the picked workflow's rules first, and doesn't repeat them under its steps", () => {
    const h = renderWebHandover(memory, [{ workflow: memory.workflows[0], skip: [], why: "" }], undefined, "http://localhost:5190")
    const text = h.text!
    assert.isBelow(text.indexOf("Members get no SMS"), text.indexOf("overdue loan"))
    assert.strictEqual(text.split("Members get no SMS").length, 2)
    assert.include(text, "## Lend a book\n1. Open the book's page, then Check out.")
  })
})
