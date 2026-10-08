/** Expected values are what Python 3.13 gives for the same inputs. */
import { assert, describe, it } from "@effect/vitest"
import { compareCodePoints, floatJson, formatJson, isoformat, repr, zeroPad6 } from "../../src/graph/PythonCompat.ts"

describe("PythonCompat", () => {
  it("writes floats like Python's json module", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [1, "1.0"],
      [0.6, "0.6"],
      [0.1 + 0.2, "0.30000000000000004"],
      [1e-5, "1e-05"],
      [2.5e-5, "2.5e-05"],
      [0.0001, "0.0001"],
      [1e15, "1000000000000000.0"],
      [999999999999999.9, "999999999999999.9"],
      [1e16, "1e+16"],
      [1.5e16, "1.5e+16"],
      [123456789012345680, "1.2345678901234568e+17"],
      [2 / 3 * 1e-7, "6.666666666666665e-08"],
      [5e-324, "5e-324"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
      [-2.5, "-2.5"],
      [-0, "-0.0"],
      [Number.NaN, "NaN"],
      [Number.NEGATIVE_INFINITY, "-Infinity"]
    ]
    for (const [value, expected] of cases) assert.strictEqual(floatJson(value), expected, String(value))
  })

  it("formats JSON like json.dump(indent=2, ensure_ascii=False)", () => {
    const fields = { floats: new Set(["score"]), sorted: new Set(["facts"]) }
    const value = {
      score: 1,
      version: 1,
      empty: [],
      none: {},
      facts: { b: { score: 2 }, "10": [], "9": [], a: null },
      text: "é\n\"🚀\u0000"
    }
    const expected = [
      "{",
      "  \"score\": 1.0,",
      "  \"version\": 1,",
      "  \"empty\": [],",
      "  \"none\": {},",
      "  \"facts\": {",
      "    \"10\": [],",
      "    \"9\": [],",
      "    \"a\": null,",
      "    \"b\": {",
      "      \"score\": 2.0",
      "    }",
      "  },",
      "  \"text\": \"é\\n\\\"🚀\\u0000\"",
      "}",
      ""
    ].join("\n")
    assert.strictEqual(formatJson(value, fields), expected)
  })

  it("sorts strings by code point", () => {
    const words = ["b", "a", "\u{1F680}", "�", "aa", "", "B", "Ａ", "a\u{1F680}", "a￿"]
    assert.deepStrictEqual(words.sort(compareCodePoints), [
      "",
      "B",
      "a",
      "aa",
      "a￿",
      "a\u{1F680}",
      "b",
      "Ａ",
      "�",
      "\u{1F680}"
    ])
  })

  it("quotes strings like repr()", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["bad id", "'bad id'"],
      ["it's", "\"it's\""],
      ["a'b\"c", "'a\\'b\"c'"],
      ["say \"hi\"", "'say \"hi\"'"],
      ["back\\slash", "'back\\\\slash'"],
      ["tab\tnl\nret\r", "'tab\\tnl\\nret\\r'"],
      ["\u0000\u001f\u007f", "'\\x00\\x1f\\x7f'"],
      ["é\u{1F680}", "'é\u{1F680}'"],
      [" ", "'\\u2028'"],
      [" ", "'\\xa0'"],
      ["​", "'\\u200b'"],
      ["\ud800", "'\\ud800'"]
    ]
    for (const [value, expected] of cases) assert.strictEqual(repr(value), expected)
  })

  it("formats times and file numbers like Python", () => {
    assert.strictEqual(isoformat("2026-10-01T12:00:00.000Z"), "2026-10-01T12:00:00+00:00")
    assert.strictEqual(isoformat("2026-10-01T12:00:01.250Z"), "2026-10-01T12:00:01.250000+00:00")
    const pads: ReadonlyArray<readonly [number, string]> = [
      [0, "000000"],
      [3, "000003"],
      [999999, "999999"],
      [1234567, "1234567"],
      [-1, "-00001"],
      [-12345, "-12345"]
    ]
    for (const [n, expected] of pads) assert.strictEqual(zeroPad6(n), expected)
  })
})
