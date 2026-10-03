import { assert, describe, it } from "@effect/vitest"
import {
  classifyKey,
  commandKeys,
  isReadOnlyCommand,
  positionalArgs,
  segmentFor,
  segmentKey,
  splitCommand,
  wordChange,
  words
} from "../../src/records/Shell.ts"

describe("splitCommand", () => {
  it("splits chains and pipes outside quotes", () => {
    const segs = splitCommand(`yarn test:typecheck 2>&1 | tail -8; yarn test:app --watch=false && echo "a; b | c"`)
    assert.deepStrictEqual(segs.map((s) => [s.text, s.piped]), [
      ["yarn test:typecheck 2>&1", false],
      ["tail -8", true],
      ["yarn test:app --watch=false", false],
      [`echo "a; b | c"`, false]
    ])
  })

  it("keeps heredoc bodies in their segment", () => {
    const line = "python3 - <<'E'\np='a.ts'\ns=open(p).read(); print(s | 1)\nE\nyarn tsc"
    const segs = splitCommand(line)
    assert.strictEqual(segs.length, 2)
    assert.isTrue(segs[0].text.startsWith("python3 - <<'E'"))
    assert.isTrue(segs[0].text.includes("print(s | 1)"))
    assert.strictEqual(segs[1].text, "yarn tsc")
  })

  it("keeps PowerShell here-strings in their segment", () => {
    const line = "$t = @'\nfoo; bar | baz\n'@; Set-Content x.txt $t"
    const segs = splitCommand(line)
    assert.deepStrictEqual(segs.map((s) => s.text), ["$t = @'\nfoo; bar | baz\n'@", "Set-Content x.txt $t"])
  })

  it("treats & in redirections as part of the segment", () => {
    assert.deepStrictEqual(splitCommand("a 2>&1 &> log & b").map((s) => s.text), ["a 2>&1 &> log", "b"])
  })
})

describe("words", () => {
  it("drops quotes and redirections", () => {
    assert.deepStrictEqual(words(`yarn vitest run "a b.tsx" 2>&1 > out.txt 2>/dev/null`), ["yarn", "vitest", "run", "a b.tsx"])
  })
})

describe("segmentKey and commandKeys", () => {
  const key = (line: string) => segmentKey(splitCommand(line)[0])

  it("names runners with their subcommand", () => {
    assert.strictEqual(key("yarn test:update --watch=false"), "yarn test:update")
    assert.strictEqual(key("yarn run test:app"), "yarn test:app")
    assert.strictEqual(key("npm run build"), "npm build")
    assert.strictEqual(key("npx vitest run a.test.ts"), "npx vitest")
    assert.strictEqual(key("git -C repo diff --stat"), "git diff")
    assert.strictEqual(key("git diff --stat"), "git diff")
    assert.strictEqual(key(`& "C:\\npm\\yarn.cmd" tsc`), "yarn tsc")
    assert.strictEqual(key("CI=true FOO=1 yarn test"), "yarn test")
    assert.strictEqual(key("python3 -m pytest -q"), "python3 -m pytest")
    assert.strictEqual(key("node -e 'x'"), "node -e")
    assert.strictEqual(key("node src/cli.ts traces x"), "node cli.ts")
    assert.strictEqual(key("/usr/bin/grep -rn x ."), "grep")
  })

  it("leaves out filters on piped output", () => {
    assert.deepStrictEqual(
      commandKeys("yarn tsc 2>&1 | tail -8; yarn test:app --watch=false 2>&1 | Select-Object -Last 30; git status --short"),
      ["yarn tsc", "yarn test:app", "git status"]
    )
    // `sed -i` in a pipe still edits.
    assert.deepStrictEqual(commandKeys("echo x | sed -i s/a/b/ f"), ["echo", "sed"])
  })
})

describe("classification", () => {
  it("knows checks from other commands", () => {
    assert.strictEqual(classifyKey("yarn test:update"), "test")
    assert.strictEqual(classifyKey("yarn vitest"), "test")
    assert.strictEqual(classifyKey("python3 -m pytest"), "test")
    assert.strictEqual(classifyKey("yarn test:typecheck"), "typecheck")
    assert.strictEqual(classifyKey("yarn tsc"), "typecheck")
    assert.strictEqual(classifyKey("yarn lint"), "lint")
    assert.strictEqual(classifyKey("yarn install"), "install")
    assert.strictEqual(classifyKey("git status"), "other")
  })

  it("knows commands that only look around", () => {
    assert.isTrue(isReadOnlyCommand("grep -rn foo src | head -5; git diff --stat"))
    assert.isTrue(isReadOnlyCommand("sed -n 10,20p a.ts"))
    assert.isFalse(isReadOnlyCommand("sed -i s/a/b/ a.ts"))
    assert.isFalse(isReadOnlyCommand("grep -n x a.ts; yarn tsc"))
  })
})

describe("comparing runs of a command", () => {
  it("finds the words a fix dropped or added", () => {
    const before = segmentFor("yarn tsc | tail; yarn test:update --watch=false 2>&1 | tail -30", "yarn test:update")!
    const after = segmentFor("yarn test:update 2>&1 | tail -25", "yarn test:update")!
    assert.deepStrictEqual(wordChange(before, after), { removed: ["--watch=false"], added: [] })
  })

  it("tells filtered test runs from whole-suite runs", () => {
    const seg = (line: string) => splitCommand(line)[0]
    assert.deepStrictEqual(positionalArgs(seg("yarn test:app --watch=false"), "yarn test:app"), [])
    assert.deepStrictEqual(positionalArgs(seg("yarn test:app --watch=false -u contextmenu"), "yarn test:app"), ["contextmenu"])
    assert.deepStrictEqual(positionalArgs(seg("yarn vitest run tests/a.test.tsx"), "yarn vitest"), ["tests/a.test.tsx"])
    assert.deepStrictEqual(positionalArgs(seg("yarn run test:app"), "yarn test:app"), [])
  })
})
