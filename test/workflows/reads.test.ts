import { assert, describe, it } from "@effect/vitest"
import type { ToolCall } from "../../src/traces/index.ts"
import { membersOf, placesOfRead, resolvePlace } from "../../src/workflows/Places.ts"
import { grepPattern, linesOfSpan, readSpans } from "../../src/workflows/Reads.ts"

const HELPERS = `import { fireEvent } from "@testing-library/react";

const { h } = window;

export class Keyboard {
  static withModifierKeys = (modifiers: KeyboardModifiers, cb: () => void) => {
    cb();
  };

  static keyDown = (
    key: string,
    target: HTMLElement | Document | Window = document,
  ) => {
    fireEvent.keyDown(target, { key });
  };

  static keyPress = (key: string, target?: HTMLElement | Document | Window) => {
    Keyboard.keyDown(key, target);
  };
}

export class Pointer {
  public clientX = 0;

  click(dx = 0, dy = 0) {
    this.down(dx, dy);
  }
}
`.split("\n")

const at = (text: string) => HELPERS.findIndex((l) => l.includes(text))

const call = (name: string, input: Record<string, unknown>): ToolCall => ({
  id: "c1",
  name,
  input,
  agentId: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  result: "",
  isError: false
})

const relative = (p: string) => p.replace(/^c:\/repo\//i, "")

describe("what runs read", () => {
  it("takes a range of lines from Read, sed and head, and a search in one file from Grep and grep", () => {
    assert.deepStrictEqual(readSpans(call("Read", { file_path: "C:\\repo\\tests\\helpers\\ui.ts", offset: 82, limit: 30 }), relative), [
      { file: "tests/helpers/ui.ts", from: 82, to: 111 }
    ])
    // A whole file says nothing about which part mattered.
    assert.deepStrictEqual(readSpans(call("Read", { file_path: "C:\\repo\\tests\\helpers\\ui.ts" }), relative), [])
    assert.deepStrictEqual(readSpans(call("Grep", { pattern: "static keyPress", path: "C:\\repo\\tests\\helpers\\ui.ts", output_mode: "content" }), relative), [
      { file: "tests/helpers/ui.ts", pattern: "static keyPress", flags: "" }
    ])
    // Only file names, or a whole directory: nothing read.
    assert.deepStrictEqual(readSpans(call("Grep", { pattern: "keyPress", path: "C:\\repo\\tests\\helpers\\ui.ts" }), relative), [])
    assert.deepStrictEqual(readSpans(call("Grep", { pattern: "keyPress", path: "C:\\repo\\tests", output_mode: "content" }), relative), [])
    assert.deepStrictEqual(
      readSpans(call("Bash", { command: "cd /c/repo/packages/excalidraw && sed -n 60,110p actions/actionFlip.test.tsx; head -n 40 tests/api.ts" }), relative),
      [
        { file: "packages/excalidraw/actions/actionFlip.test.tsx", from: 60, to: 110 },
        { file: "packages/excalidraw/tests/api.ts", from: 1, to: 40 }
      ]
    )
    assert.deepStrictEqual(
      readSpans(call("Bash", { command: 'grep -n "keyDown\\|keyPress =" tests/helpers/ui.ts | head; grep -rn "x" tests' }), relative),
      [{ file: "tests/helpers/ui.ts", pattern: "keyDown|keyPress =", flags: "" }]
    )
  })

  it("reads basic grep patterns as JavaScript ones", () => {
    assert.strictEqual(grepPattern("a\\|b\\(c\\)", false), "a|b(c)")
    assert.strictEqual(grepPattern("a|b", true), "a|b")
  })

  it("finds the lines a span covers", () => {
    assert.deepStrictEqual(linesOfSpan(HELPERS, { file: "ui.ts", pattern: "static key(Down|Press)" }), [at("static keyDown"), at("static keyPress")])
    assert.deepStrictEqual(linesOfSpan(HELPERS, { file: "ui.ts", from: 2, to: 3 }), [1, 2])
    assert.deepStrictEqual(linesOfSpan(HELPERS, { file: "ui.ts", pattern: "(" }), [])
  })

  it("places what was read in the class it belongs to, and leaves imports out", () => {
    const read = placesOfRead("ui.ts", HELPERS, [at("static keyDown"), at("fireEvent.keyDown(target"), at("static keyPress"), 0])
    assert.deepStrictEqual(read.map((p) => p.chain.map((b) => b.head)), [["export class Keyboard {"]])
    // A class's own first line reads the class; a line of another class, that class.
    const both = placesOfRead("ui.ts", HELPERS, [at("export class Keyboard"), at("this.down(dx")])
    assert.deepStrictEqual(both.map((p) => p.chain.map((b) => b.head)), [["export class Keyboard {"], ["export class Pointer {"]])
  })

  it("reads a long class member by member", () => {
    const read = placesOfRead("ui.ts", HELPERS, [at("fireEvent.keyDown(target")], 10)
    assert.deepStrictEqual(read[0].chain.map((b) => b.head), ["export class Keyboard {", "static keyDown = ("])
  })

  it("lists the members of a block's one inner function", () => {
    const handler = [
      "class App {",
      "  private onKeyDown = withBatchedUpdates(",
      "    (event: KeyboardEvent) => {",
      "      if (event.key === KEYS.ESCAPE) {",
      "        this.close();",
      "      }",
      "      if (this.actionManager.handleKeyDown(event)) {",
      "        return;",
      "      }",
      "    },",
      "  );",
      "}"
    ]
    const [place] = placesOfRead("App.tsx", handler, [4], 10)
    assert.deepStrictEqual(place.chain.map((b) => b.head), ["class App {", "private onKeyDown = withBatchedUpdates("])
    const r = resolvePlace(handler, place)!
    assert.deepStrictEqual(membersOf(handler, r).map((i) => handler[i].trim()), [
      "(event: KeyboardEvent) => {",
      "if (event.key === KEYS.ESCAPE) {",
      "if (this.actionManager.handleKeyDown(event)) {"
    ])
  })

  it("lists a found block's members", () => {
    const [keyboard] = placesOfRead("ui.ts", HELPERS, [at("static keyPress")])
    const r = resolvePlace(HELPERS, keyboard)!
    assert.deepStrictEqual(membersOf(HELPERS, r).map((i) => HELPERS[i].trim()), [
      "static withModifierKeys = (modifiers: KeyboardModifiers, cb: () => void) => {",
      "static keyDown = (",
      "static keyPress = (key: string, target?: HTMLElement | Document | Window) => {"
    ])
  })
})
