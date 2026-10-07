import { assert, describe, it } from "@effect/vitest"
import { buildGraph, causes, generalize, mechanicalTrigger, namesValue, namesValueFile, stepIdOf } from "../../src/memory/Build.ts"
import { judge, replay } from "../../src/memory/Replay.ts"
import { flagLesson, readRecord, step } from "./fixtures.ts"

const ZEN = "Change the zen mode keyboard shortcut from Alt+Z to Alt+M. Update everything that shows or tests the shortcut."
const VIEW = "Change the view mode keyboard shortcut from Alt+R to Alt+J. Update everything that shows or tests the shortcut."
const STATS = "Change the stats panel shortcut from Alt+/ to Alt+K, and add a test that checks Alt+K toggles the panel."

const KIND = "change an action's keyboard shortcut"
const keyTable = step("add the key code to the key table", "needed", ["src/keys.ts"])
const keyTest = step("change the action's keyTest", "asked", ["src/actions/actionZen.tsx"])
const help = step("list the shortcut in the help dialog", "asked", ["src/HelpDialog.tsx"])
const newTest = (origin: "asked" | "chosen") => step("add a keyboard test for the new shortcut", origin, ["tests/app.test.tsx"])
const snapshots = step("update snapshots and run the tests", "needed")

const shortcutRecords = () => [
  readRecord(ZEN, KIND, [keyTable, keyTest, help, newTest("chosen"), snapshots], { flag: true, lessons: [flagLesson("update snapshots and run the tests")] }),
  readRecord(ZEN, KIND, [keyTable, keyTest, help, snapshots], { flag: true }),
  readRecord(VIEW, KIND, [keyTable, { ...keyTest, files: ["src/actions/actionView.tsx"] }, help, snapshots]),
  readRecord(STATS, KIND, [keyTable, { ...keyTest, files: ["src/actions/actionStats.tsx"] }, help, newTest("asked"), snapshots])
]

describe("buildGraph", () => {
  it("makes routes: steps every run took are required, the agent's own extras never are", () => {
    const g = buildGraph(shortcutRecords(), { tenant: "local" })
    assert.strictEqual(g.kinds.length, 1)
    const route = g.kinds[0].route
    const entry = (name: string) => route.find((e) => e.step === stepIdOf(name))!
    assert.isTrue(entry("add the key code to the key table").required)
    assert.isTrue(entry("list the shortcut in the help dialog").required)
    const test = entry("add a keyboard test for the new shortcut")
    assert.isFalse(test.required)
    assert.deepStrictEqual([test.taken, test.asked, test.chosen], [2, 1, 1])
    assert.strictEqual(test.condition, "when the task asks for it")
    // In route order.
    assert.deepStrictEqual(route.map((e) => e.step).slice(0, 2), [stepIdOf("add the key code to the key table"), stepIdOf("change the action's keyTest")])
  })

  it("keeps the files most runs of a step edited, with how many did", () => {
    const g = buildGraph(shortcutRecords(), { tenant: "local" })
    const keyTestStep = g.steps.find((s) => s.id === stepIdOf("change the action's keyTest"))!
    assert.strictEqual(keyTestStep.where.repo.runs, 4)
    assert.deepStrictEqual(keyTestStep.where.repo.files.map((f) => [f.path, f.seen]), [
      ["src/actions/actionZen.tsx", 2],
      ["src/actions/actionStats.tsx", 1],
      ["src/actions/actionView.tsx", 1]
    ])
  })

  it("merges the same mistake from several runs into one warning, with the model's lesson and the log's trigger", () => {
    const g = buildGraph(shortcutRecords(), { tenant: "local" })
    assert.strictEqual(g.warnings.length, 1)
    const w = g.warnings[0]
    assert.strictEqual(w.lesson, "test:update already passes --watch=false; run it without the flag.")
    assert.deepStrictEqual(w.trigger, { on: "command", all: ["test:update", "--watch=false"], none: [], file: null })
    assert.strictEqual(w.step, stepIdOf("update snapshots and run the tests"))
    assert.strictEqual(w.moment, "both")
    assert.strictEqual(w.seen, 2)
    assert.deepStrictEqual(w.cost, { tokens: 20_000, turns: 1 })
  })

  it("puts every run of one task in the kind most of them were given", () => {
    const records = [...shortcutRecords(), readRecord(ZEN, "add a shortcut to a toggle", [keyTable, keyTest, help, snapshots])]
    const g = buildGraph(records, { tenant: "local" })
    assert.deepStrictEqual(g.kinds.map((k) => k.name), [KIND])
  })

  it("keeps a false lead only once two runs report it", () => {
    const lead = { what: "the arrowhead picker's keyBinding r is another feature", file: "src/actionProperties.tsx", anchors: ["keyBinding"] }
    const one = buildGraph([readRecord(ZEN, KIND, [keyTable], { falseLeads: [lead] })], { tenant: "local" })
    assert.strictEqual(one.warnings.length, 0)
    const two = buildGraph([
      readRecord(ZEN, KIND, [keyTable], { falseLeads: [lead] }),
      readRecord(VIEW, KIND, [keyTable], { falseLeads: [{ ...lead, what: "keyBinding r in the arrowhead picker is a different feature" }] })
    ], { tenant: "local" })
    assert.strictEqual(two.warnings.length, 1)
    assert.match(two.warnings[0].lesson, /^False lead: .*\(src\/actionProperties\.tsx\)$/)
    assert.strictEqual(two.warnings[0].kind, two.kinds[0].id)
  })

  it("words steps without one task's values", () => {
    const values = [{ name: "new key", value: "Alt+M (CODES.M)" }, { name: "old key", value: "Z" }]
    const r = readRecord(ZEN, KIND, [{ ...keyTable, purpose: "Add M so Alt+M works." }], { values })
    assert.isTrue(namesValue("Verify Alt+M toggles zen mode", r))
    assert.isFalse(namesValue("Make sure the shortcut works", r))
    assert.strictEqual(generalize("Press Z, then the Alt+M shortcut, not Alt+Z.", r), "Press the old key, then the new key shortcut, not Alt+the old key.")
    const g = buildGraph([r], { tenant: "local" })
    assert.strictEqual(g.steps[0].purpose, "Add M so the new key works.")
  })

  it("doesn't take a task's own files for where a step happens", () => {
    const values = [{ name: "action", value: "zen mode (actionToggleZenMode)" }]
    const r = readRecord(ZEN, KIND, [{ ...keyTest, files: ["src/actions/actionToggleZenMode.tsx", "src/actions/shortcuts.ts"] }], { values })
    assert.isTrue(namesValueFile("src/actions/actionToggleZenMode.tsx", r))
    assert.isFalse(namesValueFile("src/actions/shortcuts.ts", r))
    // Words inside a name count too: "minimap" names actionToggleMinimap.tsx, and not contextmenu.test.tsx.
    const minimap = readRecord(ZEN, KIND, [], { values: [{ name: "action name", value: "minimap" }] })
    assert.isTrue(namesValueFile("src/actions/actionToggleMinimap.tsx", minimap))
    assert.isFalse(namesValueFile("tests/contextmenu.test.tsx", minimap))
    const g = buildGraph([r], { tenant: "local" })
    assert.deepStrictEqual(g.steps[0].where.repo.files.map((f) => f.path), ["src/actions/shortcuts.ts"])
  })

  it("keeps where a step's edits went: the spots in its files, with the runs behind each", () => {
    const MINIMAP = "Add a Minimap toggle setting, with Alt+M, in the right-click menu."
    const menus = step("add the action to the menus", "asked", ["src/App.tsx", "src/actions/actionToggleMinimap.tsx"])
    const values = [{ name: "action name", value: "minimap" }]
    const afterSnap = { file: "src/App.tsx", above: "actionToggleSnapMode,", below: "actionToggleStats," }
    const afterGrid = { file: "src/App.tsx", above: "actionToggleGridMode,", below: null }
    const first = {
      ...readRecord(MINIMAP, "add a toggle setting", [menus], { values }),
      spots: [
        afterSnap,
        // Names the task's own value: its place, not the step's.
        { file: "src/App.tsx", above: `label: "labels.minimap",`, below: "viewMode: true," },
        // The task's own file, and a file the step doesn't edit.
        { file: "src/actions/actionToggleMinimap.tsx", above: "export const somethingElse = 1", below: null },
        { file: "src/other.ts", above: null, below: "registerEverything()," }
      ]
    }
    const second = { ...readRecord(MINIMAP, "add a toggle setting", [menus], { values }), spots: [afterSnap, afterGrid] }
    const place = buildGraph([first, second], { tenant: "local" }).steps[0].where.repo
    assert.deepStrictEqual(place.spots, [
      { ...afterSnap, records: [first.id, second.id] },
      { ...afterGrid, records: [second.id] }
    ])
    // A step no run has spots for reads as it did before spots existed.
    const without = buildGraph(shortcutRecords(), { tenant: "local" }).steps[0].where.repo
    assert.deepStrictEqual(Object.keys(without), ["runs", "files", "landmarks", "checks"])
  })

  it("keeps, for a step that writes a new file, the files next to it that its runs read and left alone", () => {
    const create = step("create the action and register it", "asked", ["src/actions/actionToggleMinimap.tsx", "src/actions/index.ts"])
    const run = (read: Array<string>) => {
      const r = readRecord("Add a Minimap toggle setting", "add a toggle setting", [create])
      return {
        ...r,
        files: [
          { path: "src/actions/actionToggleMinimap.tsx", status: "added" as const, added: 27, removed: 0, snapshot: false },
          { path: "src/actions/index.ts", status: "modified" as const, added: 1, removed: 0, snapshot: false }
        ],
        files_read: read
      }
    }
    const first = run(["src/actions/actionToggleSnapMode.tsx", "src/actions/index.ts", "src/App.tsx"])
    const second = run(["src/actions/actionToggleSnapMode.tsx", "src/actions/actionToggleGridMode.tsx"])
    const place = buildGraph([first, second], { tenant: "local" }).steps[0].where.repo
    // Not index.ts, which they changed, and not App.tsx, which is somewhere else.
    assert.deepStrictEqual(place.examples, [
      { path: "src/actions/actionToggleSnapMode.tsx", records: [first.id, second.id] },
      { path: "src/actions/actionToggleGridMode.tsx", records: [second.id] }
    ])
    // A step that only edits files that were there has none.
    const edits = buildGraph([{ ...first, files: first.files.map((f) => ({ ...f, status: "modified" as const })) }], { tenant: "local" })
    assert.isUndefined(edits.steps[0].where.repo.examples)
  })
})

describe("mechanicalTrigger and causes", () => {
  it("takes a trigger from a command that worked once a flag was dropped", () => {
    const r = readRecord(ZEN, KIND, [keyTable], { flag: true })
    assert.deepStrictEqual(mechanicalTrigger(r.detours[0]), { on: "command", all: ["test:update", "--watch=false"], none: [], file: null })
    // A fix that changed more than flags says nothing about which word was wrong.
    assert.isNull(mechanicalTrigger({ ...r.detours[0], added: ["--write"] }))
  })

  it("doesn't let a command trigger claim a failing test, or an edit trigger a bad command", () => {
    const d = readRecord(ZEN, KIND, [keyTable], { flag: true }).detours[0]
    const command = { on: "command" as const, all: ["test:update"], none: [], file: null }
    const edit = { on: "edit" as const, all: ["<Excalidraw"], none: [], file: null }
    assert.isTrue(causes(command, d))
    assert.isFalse(causes(command, { ...d, kind: "test_failure" }))
    assert.isFalse(causes(edit, d))
    assert.isTrue(causes(edit, { ...d, kind: "test_failure" }))
  })
})

describe("replay and judge", () => {
  it("hands each past task what it needed, and never a step it didn't ask for", () => {
    const records = shortcutRecords()
    const report = replay(buildGraph(records, { tenant: "local" }), records)
    assert.deepStrictEqual([report.cases.length, report.extra, report.unasked, report.missing, report.wrongKind], [4, 0, 0, 0, 0])
    assert.deepStrictEqual([report.detours, report.warned, report.falseAlarms], [1, 1, 0])
    assert.isTrue(judge(report, undefined).commit)
  })

  it("rejects a graph that makes an unasked step required: the zen runs' extra test", () => {
    const records = shortcutRecords()
    const g = buildGraph(records, { tenant: "local" })
    const broken = {
      ...g,
      kinds: g.kinds.map((k) => ({ ...k, route: k.route.map((e) => ({ ...e, required: true, condition: null })) }))
    }
    const report = replay(broken, records)
    assert.isAbove(report.unasked, 0)
    const verdict = judge(report, replay(g, records))
    assert.isFalse(verdict.commit)
    assert.match(verdict.reason, /didn't ask for them/)
  })

  it("rejects triggers that fire on commands that worked", () => {
    const records = shortcutRecords()
    const g = buildGraph(records, { tenant: "local" })
    const noisy = { ...g, warnings: g.warnings.map((w) => ({ ...w, trigger: { on: "command" as const, all: ["test:update"], none: [], file: null } })) }
    const report = replay(noisy, records)
    assert.isAbove(report.falseAlarms, 0)
    assert.match(judge(report, replay(g, records)).reason, /fire on \d+ commands that worked/)
  })
})
