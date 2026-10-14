import { assert, describe, it } from "@effect/vitest"
import { decodeHookInput, eventOfHook } from "../../src/handover/HookInput.ts"
import { callFailed, failedSegments, hiddenFailure, looksAround, mistakeMade } from "../../src/records/Outcome.ts"
import { commandKeys, editedFiles, keyTargets, segmentKey, segmentTargets, sameCode, splitCommand } from "../../src/records/Shell.ts"
import { matchTrigger, type Trigger } from "../../src/records/Triggers.ts"

const shell = (command: string, output: string, isError = false) => ({ tool: "Bash", command, output, isError })

describe("hiddenFailure", () => {
  it("counts a checker's own report only when the call ran that check", () => {
    assert.strictEqual(hiddenFailure("npx vitest run 2>&1 | tail -5", " Test Files  1 failed | 3 passed (4)"), "failed tests")
    assert.strictEqual(hiddenFailure("npx turbo run test 2>&1 | tail", "@app/cli:test: Tests  2 failed | 376 passed (378)"), "failed tests")
    assert.strictEqual(hiddenFailure("node score.mjs", "with 1 failed, $4.29\nTests  2 failed"), undefined)
    assert.strictEqual(hiddenFailure("npm run typecheck 2>&1 | tail -20", "src/a.ts(3,9): error TS2345: no"), "type errors")
    assert.strictEqual(hiddenFailure("node summarize-notes.mjs", "src/a.ts(3,9): error TS2345: no"), undefined)
    assert.strictEqual(hiddenFailure("npm run lint | tail -3", "✖ 2 problems (2 errors, 0 warnings)"), "lint errors")
    assert.strictEqual(hiddenFailure("npm run build-docs | tail -3", "npm error Lifecycle script `build-docs` failed with error:"), "a script that failed")
  })

  it("counts a traceback and a missing command whatever ran", () => {
    assert.strictEqual(hiddenFailure("python x.py | tail", "Traceback (most recent call last):\n  File \"x.py\"\nKeyError: 'a'"), "a traceback")
    assert.strictEqual(hiddenFailure("node x.mjs | tail", "Error: boom\n    at main (x.mjs:3:9)\n\nNode.js v24.15.0"), "a traceback")
    assert.strictEqual(hiddenFailure("yarn test | tail", "bash: yarn: command not found"), "a command not found")
    assert.strictEqual(hiddenFailure("node x.mjs", "Error: boom, handled and logged"), undefined)
  })

  it("takes a missing command only from a shell's own line", () => {
    const missing = (output: string) => hiddenFailure("cd x && node probe.mjs | tail", output) === "a command not found"
    for (
      const shell of [
        "/usr/bin/bash: line 1: singularity: command not found",
        "sh: line 1: x: command not found",
        "./run.sh: line 3: x: command not found",
        "environment: line 1: bc: command not found",
        "zsh: command not found: x",
        "'x' is not recognized as an internal or external command,",
        "x : The term 'x' is not recognized as the name of a cmdlet, function, script file, or operable",
        "x: The term 'x' is not recognized as a name of a cmdlet, function, script file, or executable program.",
        "Python was not found; run without arguments to install from the Microsoft Store"
      ]
    ) assert.isTrue(missing(`done\n${shell}`), shell)
    // A probe that prints another program's words: WSL's `echo "node: $(node --version 2>&1)"`, with one space or two,
    // and a child's stderr inside JSON (record 0b179b6's #129).
    assert.isFalse(missing("node:  /bin/bash: line 1: node: command not found"))
    assert.isFalse(missing("node: /bin/bash: line 1: node: command not found"))
    assert.isFalse(missing(`verbatim true status 1 out "" err "'C:Users\\runner.cmd' is not recognized as an internal or external command,\\r\\noperable program"`))
    assert.isFalse(missing("publish: line 3: foo: command not found"))
    assert.isFalse(missing("foo : The term 'bar' is not recognized as the name of a cmdlet"))
  })
})

describe("callFailed and mistakeMade", () => {
  it("go by the error status, and never by what a read or a search printed", () => {
    assert.isTrue(callFailed(shell("npm run build", "built", true)))
    assert.isFalse(callFailed(shell("grep -rn 'Traceback' notes.md", "notes.md:1: Traceback (most recent call last):")))
    assert.isTrue(callFailed(shell("grep -rn nothing src", "", true)))
    assert.isFalse(mistakeMade(shell("grep -rn nothing src", "", true)))
    assert.isFalse(mistakeMade({ tool: "Read", command: undefined, output: "File does not exist.", isError: true }))
    assert.isTrue(mistakeMade({ tool: "Edit", command: undefined, output: "String to replace not found in file.", isError: true }))
    assert.isTrue(looksAround("Bash", "for f in a b; do grep -c x $f; done"))
    assert.isTrue(looksAround("Bash", "date -u; sleep 5; cat out.txt"))
  })

  it("leave out a line whose failure was only a read's", () => {
    const command = "npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log"
    const output = "tail: cannot open '/tmp/lint.log' for reading: No such file or directory"
    assert.isTrue(callFailed(shell(command, output, true)))
    assert.isFalse(mistakeMade(shell(command, output, true)))
  })

  it("blame the part of a line the output shows failed", () => {
    const keys = (command: string, output: string) => failedSegments(command, output).map((s) => segmentKey(s))
    assert.deepStrictEqual(keys("date; python -c 'print(1)' ; powershell -Command 'Get-Date'", "Traceback (most recent call last):\nUnicodeEncodeError: 'charmap'"), ["python -c"])
    assert.deepStrictEqual(keys("cd app && python3 x.py && npm test", "bash: python3: command not found"), ["python3 x.py"])
    assert.deepStrictEqual(keys("npm run build && npm test", "Exit code 1"), ["npm build", "npm test"])
  })
})

describe("targets", () => {
  it("names what a command runs, whichever command runs it", () => {
    assert.deepStrictEqual(keyTargets("python3 count.py"), ["count.py"])
    assert.deepStrictEqual(keyTargets("python count.py"), ["count.py"])
    assert.deepStrictEqual(keyTargets("yarn test:update"), ["test:update", "check:test"])
    assert.deepStrictEqual(keyTargets("npm lint"), ["lint", "check:lint"])
    assert.deepStrictEqual(keyTargets("node -e"), ["node (inline)"])
    assert.deepStrictEqual(keyTargets("git checkout"), ["git checkout"])
    assert.deepStrictEqual(commandKeys("python -X utf8 - <<'EOF'\nprint(1)\nEOF"), ["python -"])
    assert.deepStrictEqual(commandKeys("for f in a b; do npm test -- $f; done"), ["npm test"])
  })

  it("names the files a command edits in place", () => {
    const [sed] = splitCommand("sed -i 's/a/b/' src/x.ts src/y.ts")
    assert.deepStrictEqual(editedFiles(sed), ["src/x.ts", "src/y.ts"])
    assert.deepStrictEqual(segmentTargets(sed), ["file:x.ts", "file:y.ts"])
    const [node] = splitCommand(`node -e 'const fs=require("fs"); fs.writeFileSync("src/App.tsx", s)'`)
    assert.deepStrictEqual(segmentTargets(node), ["file:app.tsx"])
    const [read] = splitCommand(`node -e 'console.log(require("fs").readFileSync("a.json","utf8"))'`)
    assert.deepStrictEqual(segmentTargets(read), ["node (inline)"])
  })

  it("tells one inline script from another", () => {
    const a = `node -e 'const data=JSON.parse(fs.readFileSync("runs.json")); console.log(data.items.length)'`
    assert.isTrue(sameCode(a, a.replace("items", "rows")))
    assert.isFalse(sameCode(a, "node -e 'console.log(process.version)'"))
    assert.isFalse(sameCode("node -e ' '", "node -e ' '"))
  })
})

describe("triggers on what the hook reports", () => {
  const error: Trigger = { on: "error", all: ["Unterminated string literal"], none: [], file: null }
  const commit: Trigger = { on: "command", all: ["git add"], none: [], file: null }
  const event = (input: Record<string, unknown>) =>
    eventOfHook(decodeHookInput(JSON.stringify({ session_id: "s", cwd: "/repo", hook_event_name: "PostToolUse", ...input }))!, "/repo")!

  it("fire on a call that failed and printed the mistake's message", () => {
    const failed = event({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" }, error: "src/a.ts(3,9): error TS1002: Unterminated string literal.\nExit code 2" })
    assert.isTrue(failed.failed)
    assert.isTrue(matchTrigger(error, failed))
  })

  it("stay silent on reads and searches that print it, a helper agent's as much as the main thread's", () => {
    // Both misfires so far: a read of a notes file that quotes the message.
    const read = event({ agent_id: "a1b2", tool_name: "Bash", tool_input: { command: "sed -n 360,600p previous-findings.txt" }, tool_response: { stdout: "trigger: Unterminated string literal; exit code 1", stderr: "" } })
    assert.isFalse(read.failed)
    assert.isFalse(matchTrigger(error, read))
    const grep = event({ tool_name: "Bash", tool_input: { command: "grep -rn \"git add\" HANDOFF.md" }, tool_response: { stdout: "HANDOFF.md:3: git add", stderr: "" } })
    assert.isFalse(matchTrigger(commit, grep))
    const add = event({ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m 'x'" }, tool_response: { stdout: "", stderr: "" } })
    assert.isTrue(matchTrigger(commit, add))
  })
})
