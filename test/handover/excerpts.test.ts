import { assert, describe, it } from "@effect/vitest"
import { type ExampleSource, EXCERPTS_INTRO, findPlaces, makeExcerpts, type SpotSource } from "../../src/handover/Excerpts.ts"

/** Lines that mark nothing, to keep places apart. */
const filler = (n: number, name = "other") => Array.from({ length: n }, (_, i) => `const ${name}${i} = ${i}`)

// Lines 1-7: the import list. Lines 28-33: the view-mode menu. Lines 44-49: the main menu.
const APP = [
  "import {",
  "  actionCopy,",
  "  actionToggleGridMode,",
  "  actionToggleZenMode,",
  "  actionToggleSnapMode,",
  "  actionPaste,",
  `} from "../actions";`,
  ...filler(20),
  "const viewModeItems = () => {",
  "      return [",
  "        actionToggleGridMode,",
  "        actionToggleZenMode,",
  "      ];",
  "}",
  ...filler(10, "more"),
  "const items = [",
  "  actionToggleGridMode,",
  "  actionToggleSnapMode,",
  "  actionToggleZenMode,",
  "  actionToggleStats,",
  "]",
  ""
]

const spot = (above: string | null, below: string | null, records: Array<string>, extra: Partial<SpotSource> = {}): SpotSource => ({
  step: 1,
  file: "src/App.tsx",
  above,
  below,
  records,
  runs: 3,
  ...extra
})

/** The lines each place shows, numbered from 1. */
const shown = (found: ReturnType<typeof findPlaces>) => found.map((f) => [f.from + 1, f.to + 1])

describe("findPlaces", () => {
  it("finds a spot where its two lines stand, indentation aside, and makes close ones one place", () => {
    const found = findPlaces("src/App.tsx", APP, [
      spot("actionToggleGridMode,", "actionToggleZenMode,", ["r1", "r2"]),
      spot("actionToggleSnapMode,", "actionPaste,", ["r1", "r3"])
    ])
    // The import (both spots), the view-mode menu, and the main menu, where a line has come between the two.
    assert.deepStrictEqual(shown(found), [[2, 7], [29, 32], [44, 48]])
  })

  it("takes a spot found in more than three places for no place at all", () => {
    const pair = ["  <Shortcut", `    kind="plain"`]
    const text = [...filler(3), ...pair, ...filler(9, "a"), ...pair, ...filler(9, "b"), ...pair, ...filler(9, "c"), ...pair, ...filler(3, "d")]
    const everywhere = spot("<Shortcut", `kind="plain"`, ["r1", "r2"])
    assert.deepStrictEqual(findPlaces("src/Help.tsx", text, [everywhere]), [])
    assert.strictEqual(findPlaces("src/Help.tsx", text.slice(0, 30), [everywhere]).length, 3)
  })

  it("hands over a place only when two runs of the kind, and most of them, put an edit there", () => {
    assert.deepStrictEqual(findPlaces("src/App.tsx", APP, [spot("actionToggleStats,", null, ["r1"])]), [])
    // Two runs that chose different neighbours in the same list still agree on the place.
    const two = findPlaces("src/App.tsx", APP, [
      spot("actionToggleZenMode,", "actionToggleStats,", ["r1"]),
      spot("actionToggleGridMode,", "actionToggleSnapMode,", ["r2"])
    ])
    assert.deepStrictEqual(shown(two), [[44, 49]])
    // Of ten runs of the step, two aren't most.
    assert.deepStrictEqual(findPlaces("src/App.tsx", APP, [spot("actionToggleGridMode,", "actionToggleZenMode,", ["r1", "r2"], { runs: 10 })]), [])
  })

  it("finds a line on its own only where it is the single one of its kind", () => {
    const keys = ["export const CODES = {", `  R: "KeyR",`, `  S: "KeyS",`, "} as const;", ...filler(12), "export const KEYS = {", `  ARROW_DOWN: "ArrowDown",`, "} as const;", ""]
    const find = (above: string | null, below: string | null) => shown(findPlaces("src/keys.ts", keys, [spot(above, below, ["r1", "r2"], { file: "src/keys.ts" })]))
    // The pair says which table's end is meant.
    assert.deepStrictEqual(find(`S: "KeyS",`, "} as const;"), [[2, 5]])
    assert.deepStrictEqual(find(null, "} as const;"), [])
    assert.deepStrictEqual(find(`S: "KeyS",`, null), [[2, 4]])
    // The line below has gone since: the one above still marks the place.
    assert.deepStrictEqual(find(`S: "KeyS",`, "somethingGone,"), [[2, 4]])
    assert.deepStrictEqual(find("somethingGone,", "alsoGone,"), [])
  })

  it("shows the spots enough runs agree on, not every neighbour one run chose", () => {
    const found = findPlaces("src/App.tsx", APP, [
      spot("actionToggleZenMode,", "actionToggleStats,", ["r1", "r2"]),
      spot("actionToggleGridMode,", "actionToggleSnapMode,", ["r3"])
    ])
    // Around lines 47-48, where two runs put it; the third run's lines 45-46 don't widen it.
    assert.deepStrictEqual(shown(found), [[46, 49]])
  })

  it("knows a small list around a place, and a small block that a spot's line opens", () => {
    const span = (s: { from: number; to: number } | undefined) => (s === undefined ? undefined : [s.from + 1, s.to + 1])
    const [list] = findPlaces("src/App.tsx", APP, [spot("actionToggleStats,", null, ["r1", "r2"])])
    // A line on each side of the spot; the list it sits in is lines 44-49.
    assert.deepStrictEqual([span(list), span(list.around), span(list.opened)], [[47, 49], [44, 49], undefined])
    const items = [
      ...filler(4),
      "export const PreferencesToggleZenModeItem = () => {",
      "  const { t } = useI18n();",
      "  return <Checkbox>{t(\"buttons.zenMode\")}</Checkbox>;",
      "};",
      ...filler(4, "after")
    ]
    const [block] = findPlaces("src/Items.tsx", items, [spot(null, "export const PreferencesToggleZenModeItem = () => {", ["r1", "r2"], { file: "src/Items.tsx" })])
    assert.deepStrictEqual([span(block), span(block.opened), span(block.around)], [[4, 6], [4, 8], undefined])
    // A long list stays as the lines around the spot.
    const long = ["const all = [", ...Array.from({ length: 60 }, (_, i) => `  somethingRatherLong${i},`), "]"]
    const [inLong] = findPlaces("src/long.ts", long, [spot("somethingRatherLong30,", null, ["r1", "r2"], { file: "src/long.ts" })])
    assert.deepStrictEqual([inLong.around, inLong.opened], [undefined, undefined])
  })
})

describe("makeExcerpts", () => {
  const SNAP = ["export const actionToggleSnapMode = register({", `  name: "snapMode",`, "});", ""].join("\n")
  const texts = new Map([
    ["src/App.tsx", APP.join("\n")],
    ["src/actions/actionToggleSnapMode.tsx", SNAP],
    ["src/small.ts", ["const a = 1", "export const smallThing = 2", "const b = 3", ""].join("\n")]
  ])
  const spots = [
    spot("actionToggleSnapMode,", "actionPaste,", ["r1", "r2"], { step: 2 }),
    spot(null, "export const smallThing = 2", ["r1", "r2"], { step: 1, file: "src/small.ts" }),
    // Gone from the code since: finds nothing.
    spot("actionToggleRemoved,", null, ["r1", "r2"], { step: 2 })
  ]
  const example: ExampleSource = { step: 3, path: "src/actions/actionToggleSnapMode.tsx", records: ["r1", "r2"], runs: 3 }

  it("renders the lines as they are, by file in step order, with the file to read first", () => {
    const e = makeExcerpts(spots, [example], texts, 5000)
    assert.include(e.text, EXCERPTS_INTRO)
    // The import list is small, so all of it is shown.
    assert.include(e.text, "`src/App.tsx` (step 2):\n```\n@@ lines 1-7 @@\nimport {\n  actionCopy,\n  actionToggleGridMode,\n  actionToggleZenMode,\n  actionToggleSnapMode,\n  actionPaste,\n} from \"../actions\";\n```\n")
    assert.include(e.text, "`src/small.ts` (step 1):\n```\n@@ lines 1-3 @@\nconst a = 1\nexport const smallThing = 2\nconst b = 3\n```\n")
    assert.include(e.text, "`src/actions/actionToggleSnapMode.tsx` (step 3: earlier tasks read this file before writing their new one), whole:\n```\nexport const actionToggleSnapMode = register({\n  name: \"snapMode\",\n});\n```\n")
    assert.isBelow(e.text.indexOf("`src/small.ts` (step 1)"), e.text.indexOf("`src/App.tsx` (step 2)"))
    assert.notInclude(e.text, "actionToggleRemoved")
    assert.deepStrictEqual(e.shown, [
      { file: "src/App.tsx", from: 1, to: 7, steps: [2] },
      { file: "src/small.ts", from: 1, to: 3, steps: [1] }
    ])
    assert.deepStrictEqual(e.examples, [{ step: 3, path: "src/actions/actionToggleSnapMode.tsx", whole: true }])
    assert.strictEqual(e.leftOut, 0)
  })

  it("fits the room it is given: whole lists give way first, then the file to read first, then places", () => {
    const all = makeExcerpts(spots, [example], texts, 5000)
    const tight = makeExcerpts(spots, [example], texts, all.text.length - 1)
    assert.deepStrictEqual(tight.shown[0], { file: "src/App.tsx", from: 4, to: 7, steps: [2] })
    assert.deepStrictEqual(tight.examples.map((x) => x.whole), [true])
    const tighter = makeExcerpts(spots, [example], texts, tight.text.length - 1)
    assert.deepStrictEqual(tighter.examples.map((x) => x.whole), [false])
    assert.strictEqual(tighter.shown.length, 2)
    for (const room of [tighter.text.length - 1, 420, 330, 200, 0, -50]) {
      assert.isAtMost(makeExcerpts(spots, [example], texts, room).text.length, Math.max(room, 0))
    }
    assert.deepStrictEqual(makeExcerpts(spots, [example], texts, 0), { text: "", shown: [], examples: [], leftOut: 3 })
  })

  it("names a file to read first that is too long to hand over, and only one most runs read", () => {
    const long = new Map([...texts, ["src/actions/actionToggleSnapMode.tsx", "// a long file\n".repeat(200)]])
    const e = makeExcerpts([], [example, { ...example, path: "src/small.ts", records: ["r1"] }], long, 5000)
    assert.include(e.text, "Step 3: earlier tasks read `src/actions/actionToggleSnapMode.tsx` before writing their new file.")
    assert.deepStrictEqual(e.examples, [{ step: 3, path: "src/actions/actionToggleSnapMode.tsx", whole: false }])
    assert.strictEqual(makeExcerpts([], [{ ...example, records: ["r1"] }], texts, 5000).text, "")
  })
})
