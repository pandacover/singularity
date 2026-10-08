import { assert, describe, it } from "@effect/vitest"
import { editsOfDiff, placeOfEdit } from "../../src/workflows/Edits.ts"
import {
  describeChain,
  IMPORTS,
  placeKey,
  placeOfAddition,
  placeOfLine,
  resolvePlace,
  sharedStart,
  statementStart
} from "../../src/workflows/Places.ts"

const APP = `import {
  actionToggleGridMode,
  actionToggleZenMode,
} from "../actions";
import { foo } from "./foo";

class App extends React.Component<AppProps, AppState> {
  private getContextMenuItems = (
    type: "canvas" | "element",
  ): ContextMenuItems => {
    const options: ContextMenuItems = [];

    if (type === "canvas") {
      if (this.state.viewModeEnabled) {
        return [
          ...options,
          actionToggleGridMode,
          actionToggleZenMode,
        ];
      }

      return [
        actionPaste,
        actionToggleGridMode,
        actionToggleZenMode,
      ];
    }

    return options;
  };
}
`.split("\n")

/** Line numbers from 1, as diffs count them. */
const lineOf = (lines: ReadonlyArray<string>, text: string, nth = 1): number => {
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === text && ++seen === nth) return i + 1
  }
  throw new Error(`no line ${text}`)
}

describe("places", () => {
  it("tells the view-mode list from the other one by the blocks around them", () => {
    const viewMode = placeOfAddition("App.tsx", APP, lineOf(APP, "actionToggleZenMode,", 2), 10)
    const other = placeOfAddition("App.tsx", APP, lineOf(APP, "actionToggleZenMode,", 3), 8)
    assert.deepStrictEqual(viewMode.chain.map((b) => b.head), [
      "class App extends React.Component<AppProps, AppState> {",
      "private getContextMenuItems = (",
      'if (type === "canvas") {',
      "if (this.state.viewModeEnabled) {",
      "return ["
    ])
    assert.deepStrictEqual(other.chain.map((b) => b.head).slice(-2), ['if (type === "canvas") {', "return ["])
    // The method's head runs over three lines; its block opens on the third.
    assert.strictEqual(other.chain[1].open, "): ContextMenuItems => {")
    assert.notStrictEqual(placeKey(viewMode), placeKey(other))
    const v = resolvePlace(APP, viewMode)!
    const o = resolvePlace(APP, other)!
    assert.strictEqual(APP[v.openLine!].trim(), "return [")
    assert.isTrue(v.from < o.from, "the view-mode list comes first")
    assert.strictEqual(APP[o.from + 1].trim(), "actionPaste,")
    assert.strictEqual(describeChain(other, 2), '… › if (type === "canvas") { › return [')
  })

  it("finds a place again after the file changed around it", () => {
    const other = placeOfAddition("App.tsx", APP, lineOf(APP, "actionToggleZenMode,", 3), 8)
    const later = [
      "// a new header comment",
      ...APP.slice(0, 7),
      "  private somethingNew = () => {",
      "    return 1;",
      "  };",
      ...APP.slice(7).map((l) => l.replace("actionPaste,", "actionPaste,\n        actionCut,"))
    ].join("\n").split("\n")
    const r = resolvePlace(later, other)!
    assert.strictEqual(later[r.from + 1].trim(), "actionPaste,")
    assert.strictEqual(later[r.from + 2].trim(), "actionCut,")
  })

  it("finds a block whose first line grew, by its first words", () => {
    const types = ["export interface AppState {", "  zenModeEnabled: boolean;", "}"]
    const place = placeOfAddition("types.ts", types, 2, 2)
    const grown = ["export interface AppState extends Base {", "  zenModeEnabled: boolean;", "  gridSize: number;", "}"]
    const r = resolvePlace(grown, place)!
    assert.deepStrictEqual([r.from, r.to], [0, 3])
    assert.isUndefined(resolvePlace(["export interface Other {", "}"], place))
  })

  it("tells import lists apart by the line that closes them", () => {
    const place = placeOfAddition("App.tsx", APP, lineOf(APP, "actionToggleGridMode,"), 2)
    assert.deepStrictEqual(place.chain, [{ head: "import {", open: null, opener: null, close: '} from "../actions";' }])
    const moved = ["import {", "  bar,", '} from "./bar";', ...APP]
    const r = resolvePlace(moved, place)!
    assert.strictEqual(moved[r.closeLine!], '} from "../actions";')
  })

  it("has unions without a closing line", () => {
    const lines = ["export type ActionName =", '  | "zenMode"', '  | "gridMode";', "", "export type Other = string;"]
    const place = placeOfAddition("types.ts", lines, 2, 2)
    assert.deepStrictEqual(place.chain, [{ head: "export type ActionName =", open: null, opener: null, close: null }])
    const r = resolvePlace(lines, place)!
    assert.deepStrictEqual([r.from, r.to], [0, 2])
  })

  it("lifts a tag's closing > and a function's }) => { to the start of their statement", () => {
    const lines = [
      "export const Preferences = ({",
      "  children,",
      "}: {",
      "  children?: React.ReactNode;",
      "}) => {",
      "  return (",
      "    <Island",
      '      caption="view"',
      "    >",
      "      <Row />",
      "    </Island>",
      "  );",
      "};"
    ]
    assert.strictEqual(statementStart(lines, 4), 0)
    assert.strictEqual(statementStart(lines, 8), 6)
    const place = placeOfAddition("x.tsx", lines, 10, 6)
    assert.deepStrictEqual(place.chain.map((b) => b.head), ["export const Preferences = ({", "return (", "<Island"])
    assert.strictEqual(place.chain[2].opener, '<Island caption="view" >')
    assert.strictEqual(place.chain[2].close, "</Island>")
  })

  it("names top-level groups by the start their statements share", () => {
    assert.strictEqual(sharedStart("const PreferencesToggleGridModeItem = () => {", "const PreferencesToggleZenModeItem = () => {"), "PreferencesToggle")
    // Stopping inside a word keeps only whole camel-case parts.
    assert.strictEqual(sharedStart("const PreferencesToggleZenModeItem = 1", "const PreferencesToggleZoomItem = 2"), "PreferencesToggle")
    assert.isNull(sharedStart("export const a = 1;", "export const b = 2;"))
    const lines = [
      'import { a } from "a";',
      'import { b } from "b";',
      "",
      "const PreferencesToggleGridItem = () => {",
      "  return 1;",
      "};",
      "",
      "const PreferencesToggleZenItem = () => {",
      "  return 2;",
      "};",
      "",
      "export const Preferences = () => null;"
    ]
    const place = placeOfAddition("DefaultItems.tsx", lines, 6, 0)
    assert.strictEqual(place.group, "PreferencesToggle")
    const r = resolvePlace(lines, place)!
    assert.deepStrictEqual(r.members, [3, 7])
    assert.strictEqual(r.to, 9)
    assert.strictEqual(placeOfAddition("DefaultItems.tsx", lines, 0, 0).group, IMPORTS)
    assert.strictEqual(placeOfAddition("DefaultItems.tsx", lines, 2, 0).group, IMPORTS)
  })

  it("takes a changed row among look-alike rows as the list, but stops at a list told apart by its tag", () => {
    const lines = [
      "const Help = () => (",
      "  <Section>",
      "    <Island",
      '      caption="tools"',
      "    >",
      "      <Shortcut",
      '        label="hand"',
      '        keys="H"',
      "      />",
      "    </Island>",
      "    <Island",
      '      caption="view"',
      "    >",
      "      <Shortcut",
      '        label="zen"',
      '        keys="Alt+Z"',
      "      />",
      "      <Shortcut",
      '        label="grid"',
      '        keys="Alt+G"',
      "      />",
      "    </Island>",
      "  </Section>",
      ");"
    ]
    const place = placeOfLine("Help.tsx", lines, 15)
    assert.deepStrictEqual(place.chain.map((b) => b.head), ["const Help = () => (", "<Section>", "<Island"])
    assert.strictEqual(place.chain[2].opener, '<Island caption="view" >')
    const r = resolvePlace(lines, place)!
    assert.deepStrictEqual([r.from, r.to], [10, 21])
  })
})

describe("editsOfDiff", () => {
  const diff = [
    "diff --git a/src/keys.ts b/src/keys.ts",
    "index 1..2 100644",
    "--- a/src/keys.ts",
    "+++ b/src/keys.ts",
    "@@ -1,4 +1,5 @@",
    " export const CODES = {",
    '   Z: "KeyZ",',
    '+  M: "KeyM",',
    " } as const;",
    "@@ -10,3 +11,3 @@ x",
    " const a = 1;",
    '-const key = "Alt+Z";',
    '+const key = "Alt+M";',
    " const b = 2;",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0..1",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const x = 1;",
    "+export const y = 2;",
    "diff --git a/src/__snapshots__/a.snap b/src/__snapshots__/a.snap",
    "index 1..2 100644",
    "--- a/src/__snapshots__/a.snap",
    "+++ b/src/__snapshots__/a.snap",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    ""
  ].join("\n")

  it("splits a diff into additions, changes, new files and snapshots", () => {
    const d = editsOfDiff(diff)
    assert.deepStrictEqual(d.edits.map((e) => [e.kind, e.at, e.indent]), [["add", 2, 2], ["change", 10, 0]])
    assert.deepStrictEqual(d.edits[1].removed, ['const key = "Alt+Z";'])
    assert.deepStrictEqual(d.created, [{ file: "src/new.ts", content: "export const x = 1;\nexport const y = 2;" }])
    assert.deepStrictEqual(d.snapshots, ["src/__snapshots__/a.snap"])
  })

  it("places an addition in the block it went into", () => {
    const before = ["export const CODES = {", '  Z: "KeyZ",', "} as const;"]
    const p = placeOfEdit(before, editsOfDiff(diff).edits[0])
    assert.deepStrictEqual(p.chain.map((b) => [b.head, b.close]), [["export const CODES = {", "} as const;"]])
  })
})
