import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Queue, Terminal } from "effect"
import { askDollars, askMany, confirm, makeStyle, makeTree } from "../../src/setup/Ui.ts"

/** A terminal where the person presses Ctrl+C: its keys end, as Node's terminal ends them on Ctrl+C. */
const pressingCtrlC = Layer.succeed(Terminal.Terminal, Terminal.make({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  readInput: Effect.gen(function*() {
    const keys = yield* Queue.make<Terminal.UserInput, Cause.Done>()
    yield* Queue.end(keys)
    return keys
  }),
  readLine: Effect.fail(new Terminal.QuitError({})),
  display: () => Effect.void
}))

const quits = (exit: Exit.Exit<unknown>) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

describe("questions", () => {
  it.live("quit on Ctrl+C, as everywhere else, instead of going on with the default", () =>
    Effect.gen(function*() {
      expect(quits(yield* Effect.exit(confirm("Go on?", true, true)))).toBe(true)
      expect(quits(yield* Effect.exit(askDollars("How much?", 1, true)))).toBe(true)
      expect(quits(yield* Effect.exit(askMany("Which?", [{ title: "a", value: "a", selected: true }], true)))).toBe(true)
    }).pipe(Effect.provide(pressingCtrlC), Effect.provide(NodeServices.layer)))

  it.effect("take what is ticked to begin with when there is nobody to ask", () =>
    Effect.gen(function*() {
      const picked = yield* askMany("Which?", [
        { title: "a", value: "a", selected: true },
        { title: "b", value: "b", selected: false },
        { title: "c", value: "c", selected: true }
      ], false)
      expect(picked).toEqual(["a", "c"])
    }).pipe(Effect.provide(pressingCtrlC), Effect.provide(NodeServices.layer)))
})

describe("trees", () => {
  it.live("draw siblings and the last of them, with notes under an item", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const log = console.log
      console.log = (...args: Array<unknown>) => void lines.push(args.map(String).join(" "))
      yield* Effect.gen(function*() {
        const t = makeTree(makeStyle(false))
        yield* t.section("Agents")
        yield* t.item("one")
        yield* t.item("two")
        yield* t.note("a note")
        yield* t.note("another")
        yield* t.item("three")
        yield* t.close
      }).pipe(Effect.ensuring(Effect.sync(() => (console.log = log))))
      expect(lines.join("\n")).toBe([
        "",
        "  Agents",
        "  ├─ one",
        "  ├─ two",
        "  │  ├─ a note",
        "  │  └─ another",
        "  └─ three"
      ].join("\n"))
    }))
})
