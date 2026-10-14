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

  it("finds failing tests and lint errors that a pipe hid, from what node's test runner and ESLint print", () => {
    const lint = `${CWD}\\test\\x.mjs\n  195:40  error  Unexpected space before function parentheses  space-before-function-paren\n\n✖ 1 problem (1 error, 0 warnings)`
    const trace = session("Add a rule", [
      [bash(`npm test 2>&1 | grep -E "^ℹ (pass|fail)"`, "ℹ pass 1235\nℹ fail 1")],
      [edit(`${CWD}\\test\\markdownlint-test.mjs`, "t.plan(144);")],
      [bash(`npm test 2>&1 | grep -E "^ℹ (pass|fail)"`, "ℹ pass 1236\nℹ fail 0")],
      [bash("npm run lint 2>&1 | tail -5", lint)],
      [edit(`${CWD}\\test\\x.mjs`, "async(t) => {")],
      [bash("npm run lint 2>&1 | tail -5", "> eslint --max-warnings 0")]
    ])
    const m = extractMechanical(trace, DIFF)
    assert.deepStrictEqual(m.detours.map((d) => [d.kind, d.failed.call, d.fixed.call]), [["test_failure", 0, 2], ["command_error", 3, 5]])
    assert.strictEqual(m.detours[1].symptom.split("\n")[0], "195:40 error Unexpected space before function parentheses space-before-function-paren")
    assert.deepStrictEqual(m.commands.map((c) => c.ok), [false, true, false, true])
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

  it("judges a call by its error status, whatever it printed", () => {
    const trace = session("Build it", [
      [bash("npm run build", "built 3 files", true)],
      [bash("npm run build", "built 3 files")]
    ])
    const m = extractMechanical(trace, DIFF)
    assert.deepStrictEqual(m.commands.map((c) => c.ok), [false, true])
    assert.deepStrictEqual(m.detours.map((d) => [d.kind, d.failed.call, d.fixed.call]), [["command_error", 0, 1]])
  })

  it("never judges what a read or a search printed", () => {
    const trace = session("Look around", [
      [bash("grep -n failed notes.md", "notes.md:3: with 1 failed, $4.29 + learning $2.63")],
      [bash("cat run.log", "Traceback (most recent call last):\n  File \"x.py\", line 1\nKeyError: 'a'")],
      [bash("sed -n 1,40p HANDOFF.md", "src/a.ts(3,9): error TS1002: Unterminated string literal.")],
      [bash("npm run build", "built")]
    ])
    const m = extractMechanical(trace, DIFF, { succeeded: true })
    assert.deepStrictEqual(m.commands.map((c) => c.ok), [true, true, true, true])
    assert.deepStrictEqual(m.detours, [])
  })

  it("takes a script's own words for what it printed, not for its failure", () => {
    // Record 4fc4bcb's detour #16: a scoring script that printed "with 1 failed".
    const trace = session("Score the runs", [
      [bash("node score.mjs --runs C:/runs", "with 1 failed, $4.29 + learning $2.63 = $6.92\nall 12: without 0 failed")],
      [bash("npx vitest run test/workflows/evidence.test.ts 2>&1 | tail -15", TESTS_PASS)]
    ])
    const m = extractMechanical(trace, DIFF, { succeeded: true })
    assert.deepStrictEqual(m.commands.map((c) => c.ok), [true, true])
    assert.deepStrictEqual(m.detours, [])
  })

  it("finds failures a pipe hides from the status: a traceback, a missing command, a test runner's summary", () => {
    const trace = session("Fix it", [
      [bash("python scripts/count.py 2>&1 | tail -5", "Traceback (most recent call last):\n  File \"count.py\", line 3\nKeyError: 'items'")],
      [edit(`${CWD}\\scripts\\count.py`, "data.get('items', [])")],
      [bash("python scripts/count.py 2>&1 | tail -5", "42")],
      [bash("npx vitest run 2>&1 | tail -5", " FAIL  tests/app.test.tsx > zen > toggles\n Test Files  1 failed | 138 passed (139)")],
      [bash("npx vitest run 2>&1 | tail -5", TESTS_PASS)],
      [bash("yarn lint 2>&1 | tail -3", "bash: yarn: command not found")],
      [bash("npm run lint 2>&1 | tail -3", "> eslint .")]
    ])
    const m = extractMechanical(trace, DIFF)
    assert.deepStrictEqual(m.detours.map((d) => [d.kind, d.failed.call, d.fixed.call]), [
      ["command_error", 0, 2],
      ["test_failure", 3, 4],
      ["not_found", 5, 6]
    ])
    assert.deepStrictEqual(m.detours[0].files_edited, ["scripts/count.py"])
  })

  it("closes a failure when what failed later works, even through another command", () => {
    const trace = session("Run the build script", [
      [bash("python3 tools/build.py", "Python was not found; run without arguments to install from the Microsoft Store", true)],
      [bash("python tools/build.py", "built")]
    ])
    const [d] = extractMechanical(trace, DIFF).detours
    assert.deepStrictEqual([d.kind, d.failed.call, d.fixed.call], ["not_found", 0, 1])
    assert.deepStrictEqual([d.removed, d.added], [["python3"], ["python"]])
  })

  it("doesn't take a read that failed in a line of commands for a mistake, nor close it by another command", () => {
    // Record 4fc4bcb's detour #0: `tail` of a missing log, once "fixed" by a `git checkout`.
    const trace = session("Lint the docs", [
      [bash("git checkout -q -- . && npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log", "tail: cannot open '/tmp/lint.log' for reading: No such file or directory", true)],
      [bash("git checkout -- doc-build/build-rules.mjs", "")]
    ])
    assert.deepStrictEqual(extractMechanical(trace, DIFF, { succeeded: true }).detours, [])
  })

  it("closes a check only when the same check passes", () => {
    const trace = session("Add a test", [
      [bash("npx vitest run", testFails("tests/app.test.tsx"), true)],
      [bash("node -e 'console.log(process.version)'", "v24.15.0")],
      [bash("npm run build", "built")],
      [bash("npx vitest run tests/app.test.tsx", TESTS_PASS)]
    ])
    assert.deepStrictEqual(extractMechanical(trace, DIFF).detours.map((d) => [d.kind, d.failed.call, d.fixed.call]), [["test_failure", 0, 3]])
  })

  it("closes a broken scripted edit at the next edit of its file that works, by the editor too", () => {
    const trace = session("Rename it", [
      [bash("sed -i 's|a(b|c|' src/x.ts", "sed: -e expression #1, char 10: unknown option to `s'", true)],
      [bash("sed -i 's/one/two/' src/other.ts", "")],
      [edit(`${CWD}\\src\\x.ts`, "c")]
    ])
    const [d] = extractMechanical(trace, DIFF).detours
    assert.deepStrictEqual([d.kind, d.failed.call, d.fixed.call, d.fixed.tool], ["command_error", 0, 2, "Edit"])
  })

  it("tells inline scripts apart: only the same script, fixed, closes its failure", () => {
    const failing = `node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync("runs.json","utf8")); console.log(data.items.length)'`
    const fixed = `node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync("runs.json","utf8")); console.log(data.rows.length)'`
    const trace = session("Count the runs", [
      [bash(failing, "TypeError: Cannot read properties of undefined (reading 'length')\n\nNode.js v24.15.0")],
      [bash("node -e 'console.log(process.version)'", "v24.15.0")],
      [bash(fixed, "12")]
    ])
    assert.deepStrictEqual(extractMechanical(trace, DIFF).detours.map((d) => [d.kind, d.failed.call, d.fixed.call]), [["command_error", 0, 2]])
  })

  it("closes a failure only with a run in the same place", () => {
    // Record 4ce5a7c's detour #96: a scratch copy's tests, once "fixed" by this repo's own test run 108 turns later.
    const scratch = session("Try the agent elsewhere", [
      [bash("cd /c/scratch/excalidraw-copy && npx vitest run 2>&1 | tail -5", " FAIL  tests/app.test.tsx > zen\n Test Files  1 failed | 3 passed (4)")],
      [bash("npm run build", "built")],
      [bash("npm test 2>&1 | tail -5", TESTS_PASS)]
    ])
    assert.deepStrictEqual(extractMechanical(scratch, DIFF, { succeeded: true }).detours, [])
    // Run there again, it closes: `mkdir -p x && cd x && …` runs in x.
    const there = session("Try the agent elsewhere", [
      [bash("cd /c/scratch/excalidraw-copy && npx vitest run 2>&1 | tail -5", " FAIL  tests/app.test.tsx > zen\n Test Files  1 failed | 3 passed (4)")],
      [bash("npm test 2>&1 | tail -5", TESTS_PASS)],
      [bash("mkdir -p /c/scratch && cd /c/scratch && cd excalidraw-copy && npx vitest run", TESTS_PASS)]
    ])
    assert.deepStrictEqual(extractMechanical(there, DIFF).detours.map((d) => [d.failed.call, d.fixed.call]), [[0, 2]])
  })

  // A check stays where it ran (the test above); a script is the same script by its name wherever its file is.
  it("closes a script's failure where a copy of it works", () => {
    // Record 0d8fcf2's detour #61: a scratch script outside the repo can't load its packages; copied inside, it runs.
    const crash = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@effect/platform-node' imported from C:\\scratch\\try.ts\n\nNode.js v24.15.0"
    const trace = session("Try the evidence", [
      [bash("cat > /c/scratch/try.ts <<'EOF'\nimport { NodeServices } from \"@effect/platform-node\"\nEOF\nnode /c/scratch/try.ts", crash)],
      [bash("mkdir -p scratch && cp /c/scratch/try.ts scratch/try.ts && node scratch/try.ts", "ok")]
    ])
    assert.deepStrictEqual(extractMechanical(trace, DIFF).detours.map((d) => [d.kind, d.failed.call, d.fixed.call]), [["command_error", 0, 1]])
  })

  it("keeps closing what this repo's files did when run from elsewhere", () => {
    const trace = session("Check the installer", [
      [bash("cd /tmp/inst && sh /c/work/repo/install.sh --dry-run", "/c/work/repo/install.sh: line 40: syntax error near unexpected token `fi'", true)],
      [bash("cd /tmp/x && sed -i 's/a(b/c/' /c/work/repo/src/x.ts", "sed: -e expression #1, char 9: Unmatched ( or \\(", true)],
      [edit(`${CWD}\\src\\x.ts`, "c")],
      [bash("sh install.sh --dry-run", "would install")]
    ])
    assert.deepStrictEqual(extractMechanical(trace, DIFF).detours.map((d) => [d.failed.call, d.fixed.call]), [[0, 3], [1, 2]])
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
