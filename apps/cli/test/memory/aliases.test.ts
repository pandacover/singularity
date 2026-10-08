import { assert, describe, it } from "@effect/vitest"
import { applyAliases, closeCalls, noAliases, resolve } from "../../src/memory/Aliases.ts"
import { readRecord, step } from "./fixtures.ts"

const keys = (name: string) => step(name, "needed", ["src/keys.ts"])

describe("close calls between step names", () => {
  it("proposes names that may be one step, never ones a single run took both of", () => {
    const records = [
      readRecord("task a", "k", [keys("add the key to the KEYS table")]),
      readRecord("task b", "k", [keys("add the key code to the KEYS table")]),
      // Both in one run: two different steps, however alike their names.
      readRecord("task c", "k", [keys("add the key code to the CODES table"), keys("add the key to the KEYS table")])
    ]
    const pairs = closeCalls(records, noAliases).map(([a, b]) => [a.name, b.name].sort()).sort((x, y) => x.join().localeCompare(y.join()))
    assert.deepStrictEqual(pairs, [
      ["add the key code to the CODES table", "add the key code to the KEYS table"],
      ["add the key code to the KEYS table", "add the key to the KEYS table"]
    ])
    // Decided pairs aren't asked about again.
    const decided = { merged: [{ from: "add the key code to the KEYS table", to: "add the key to the KEYS table" }], distinct: [] }
    assert.deepStrictEqual(closeCalls(applyAliases(records, decided), decided).length, 0)
  })

  it("renames merged steps in steps and lessons, following chains", () => {
    const aliases = { merged: [{ from: "a", to: "b" }, { from: "b", to: "c" }], distinct: [] }
    assert.strictEqual(resolve(aliases, "A"), "c")
    const [r] = applyAliases([readRecord("t", "k", [step("a")], { lessons: [{ detour: 0, lesson: "x", step: "a", trigger: null }] })], aliases)
    assert.deepStrictEqual([r.model?.steps[0].name, r.model?.lessons[0].step], ["c", "c"])
  })
})
