import { assert, describe, it } from "@effect/vitest"
import { extractMechanical, parseDiff, symptomOf } from "../../src/records/Extract.ts"
import { bash, CWD, DIFF, edit, session } from "./fixtures.ts"

const FLAG_ERROR = `$ vitest --update --watch=false --watch=false
Error: Expected a single value for option "-w, --watch", received [false, false]
error Command failed with exit code 1.`

const TESTS_PASS = "Test Files  139 passed (139)\nDone in 99s."

const testFails = (file: string) =>
  `❯ ${file} (32 tests | 1 failed)\nFAIL ${file} > zen > toggles\nAssertionError: expected false to be true\nTest Files  1 failed | 138 passed (139)`

describe("parseDiff", () => {
  it("lists files with their changes", () => {
    assert.deepStrictEqual(parseDiff(DIFF), [
      { path: "src/keys.ts", status: "modified", added: 2, removed: 1, snapshot: false },
      { path: "src/new.ts", status: "added", added: 1, removed: 0, snapshot: false },
      { path: "tests/__snapshots__/a.test.tsx.snap", status: "modified", added: 1, removed: 1, snapshot: true },
      { path: "old.ts", status: "deleted", added: 0, removed: 1, snapshot: false },
      { path: "img.png", status: "modified", added: 0, removed: 0, snapshot: false }
    ])
  })
})

describe("extractMechanical", () => {
  it("finds a command that failed and the run of it that worked", () => {
    const trace = session("Change the shortcut", [
      [bash("yarn tsc 2>&1 | tail -8; yarn test:update --watch=false 2>&1 | tail -30", FLAG_ERROR)],
      [bash("yarn test:update 2>&1 | tail -25", TESTS_PASS)]
    ])
    const m = extractMechanical(trace, DIFF)
    assert.strictEqual(m.detours.length, 1)
    const d = m.detours[0]
    assert.strictEqual(d.kind, "command_error")
    assert.deepStrictEqual(d.removed, ["--watch=false"])
    assert.deepStrictEqual(d.added, [])
    assert.deepStrictEqual(d.keys, ["yarn tsc", "yarn test:update"])
    assert.strictEqual(d.symptom.split("\n")[0], `Error: Expected a single value for option "-w, --watch", received [false, false]`)
    assert.deepStrictEqual(d.cost, { tokens: 20_000, calls: 1, turns: 1 })
    assert.deepStrictEqual(m.commands.map((c) => c.ok), [false, true])
    assert.deepStrictEqual(m.commands[0].keys, ["yarn tsc", "yarn test:update"])
  })

  it("counts a command as fixed once it runs, even if something else then fails", () => {
    const trace = session("Change the shortcut", [
      [bash("yarn test:update --watch=false 2>&1 | tail -30", FLAG_ERROR)],
      [bash("yarn test:update 2>&1 | tail -30", testFails("tests/app.test.tsx"), true)],
      [edit(`${CWD}\\tests\\app.test.tsx`, "<Excalidraw handleKeyboardGlobally />")],
      [bash("yarn vitest run tests/app.test.tsx -t toggles", "1 passed")],
      [bash("yarn test:update", TESTS_PASS)]
    ])
    const m = extractMechanical(trace, DIFF)
    assert.deepStrictEqual(m.detours.map((d) => [d.kind, d.failed.call, d.fixed.call]), [
      ["command_error", 0, 1],
      // The run filtered by test name doesn't show the failure is gone; the full run does.
      ["test_failure", 1, 4]
    ])
    assert.deepStrictEqual(m.detours[1].files_edited, ["tests/app.test.tsx"])
    assert.deepStrictEqual(m.detours[1].cost, { tokens: 30_000 + 40_000 + 50_000, calls: 3, turns: 3 })
  })

  it("closes a failure the run never retested in full, if the run succeeded", () => {
    const trace = session("Add a test", [
      [bash("yarn vitest run tests/app.test.tsx", testFails("tests/app.test.tsx"), true)],
      [edit(`${CWD}/tests/app.test.tsx`, "fixed")],
      [bash("yarn vitest run tests/app.test.tsx -t toggles", "1 passed")]
    ])
    assert.strictEqual(extractMechanical(trace, DIFF).detours.length, 0)
    const [d] = extractMechanical(trace, DIFF, { succeeded: true }).detours
    assert.deepStrictEqual([d.kind, d.failed.call, d.fixed.call, d.failures], ["test_failure", 0, 2, 1])
  })

  it("follows a test failure across repeated failing runs", () => {
    const trace = session("Add a test", [
      [bash("yarn test:app --watch=false", testFails("tests/app.test.tsx"), true)],
      [bash("yarn vitest run tests/app.test.tsx", testFails("tests/app.test.tsx"), true)],
      [bash("yarn vitest run tests/other.test.tsx", "1 passed")],
      [bash("yarn vitest run tests/app.test.tsx", "32 passed")]
    ])
    const [d] = extractMechanical(trace, DIFF).detours
    // Passing tests in another file don't fix the failing ones.
    assert.deepStrictEqual([d.failed.call, d.fixed.call, d.failures], [0, 3, 2])
  })

  it("finds edits that didn't apply and the edit that did", () => {
    const file = `${CWD}\\src\\App.tsx`
    const trace = session("Add a menu item", [
      [edit(file, "a", "<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.</tool_use_error>", true)],
      [edit(file, "a")]
    ])
    const [d] = extractMechanical(trace, DIFF).detours
    assert.strictEqual(d.kind, "edit_mismatch")
    assert.strictEqual(d.failed.file, "src/App.tsx")
    assert.deepStrictEqual(d.cost, { tokens: 20_000, calls: 1, turns: 1 })
  })

  it("doesn't count looking around, or failures never fixed, as detours", () => {
    const trace = session("Find it", [
      [bash("grep -rn foo src", "", true), { name: "Read", input: { file_path: `${CWD}/nope.ts` }, result: "File does not exist.", isError: true }],
      [bash("python3 script.py", "Python was not found", true)],
      [bash("grep -rn bar src", "src/a.ts:1: bar")]
    ])
    const m = extractMechanical(trace, DIFF, { succeeded: true })
    assert.deepStrictEqual(m.detours, [])
    assert.deepStrictEqual(m.commands.map((c) => [c.command, c.ok]), [
      ["grep -rn foo src", false],
      ["python3 script.py", false],
      ["grep -rn bar src", true]
    ])
    assert.deepStrictEqual(m.filesRead, ["nope.ts"])
  })

  it("shows paths relative to the repo", () => {
    const trace = session("x", [[bash(`cat ${CWD}\\src\\a.ts`, "ok")]])
    assert.strictEqual(extractMechanical(trace, "").commands[0].command, "cat src\\a.ts")
  })
})

describe("symptomOf", () => {
  it("picks the lines that name the cause", () => {
    const out = `yarn run v1.22.22\n+ CategoryInfo : NotSpecified\nexcalidraw-app/collab/CollabError.scss 3ms\nAssertionError: expected 1 to be 2\nerror Command failed with exit code 1.`
    assert.strictEqual(symptomOf(out).split("\n")[0], "AssertionError: expected 1 to be 2")
  })
})
