import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findLearner, LearnerError, learnerConfig, resolveLearner } from "../../src/setup/Learner.ts"
import { readLearn, writeLearn } from "../../src/setup/Preferences.ts"
import { FAKE_CLAUDE, FAKE_CODEX, FAKE_HERMES, fakeCommand, run, tempDir } from "../eval/helpers.ts"

/** A home and a PATH holding only the agents named. */
const machine = (onPath: ReadonlyArray<"claude" | "codex" | "hermes">) => {
  const root = tempDir()
  const bin = join(root, "bin")
  mkdirSync(bin)
  const fakes = { claude: FAKE_CLAUDE, codex: FAKE_CODEX, hermes: FAKE_HERMES }
  for (const name of onPath) fakeCommand(bin, name, fakes[name])
  const home = join(root, "home")
  mkdirSync(home)
  return { root, bin, home, dirs: { home, env: { PATH: bin, PATHEXT: ".EXE;.CMD;.BAT", HERMES_HOME: join(root, "hermes") } } }
}

const agentOf = (cli: { readonly agent: string }) => cli.agent

describe("the agent memory learns with", () => {
  it("is the one the user chose, else Claude Code first, as before there was a choice", async () => {
    const both = machine(["claude", "codex"])
    expect(agentOf(await run(resolveLearner(undefined, both.dirs)))).toBe("claude")
    expect(agentOf(await run(resolveLearner("codex", both.dirs)))).toBe("codex")
    const codexOnly = machine(["codex"])
    const codex = await run(resolveLearner(undefined, codexOnly.dirs))
    // npm's codex.cmd runs as the script it runs: node won't start a .cmd without a shell.
    expect(codex.command).toEqual(process.platform === "win32"
      ? [process.execPath, join(codexOnly.bin, "node_modules", "fake-codex", "cli.js")]
      : [join(codexOnly.bin, "codex")])
  })

  it("never moves to another agent on its own: the chosen one missing is an error that says so", async () => {
    const m = machine(["claude", "codex"])
    const error = await run(Effect.flip(resolveLearner("hermes", m.dirs)))
    expect(error).toBeInstanceOf(LearnerError)
    expect(error.message).toContain("Hermes Agent")
    expect((await run(Effect.flip(resolveLearner(undefined, machine([]).dirs)))).message).toContain("none")
  })

  it("finds Hermes Agent by its home, never a `hermes` on PATH alone", async () => {
    const m = machine(["hermes"])
    expect(await run(findLearner("hermes", m.dirs))).toBeUndefined()
    const hermes = join(m.root, "hermes")
    fakeCommand(join(hermes, "bin"), "hermes", FAKE_HERMES)
    const found = await run(findLearner("hermes", m.dirs))
    expect(found?.agent).toBe("hermes")
    expect(found?.command.join(" ")).toContain(process.platform === "win32" ? "fake-hermes" : join(hermes, "bin", "hermes"))
  })

  it("learns with Sonnet through Claude Code, and with the agent's own model through the others, at high effort", () => {
    expect(learnerConfig({ agent: "claude", command: ["claude"] }, "/w")).toEqual({ cli: { agent: "claude", command: ["claude"] }, cwd: "/w", model: "sonnet", effort: "high" })
    expect(learnerConfig({ agent: "codex", command: ["codex"] }, "/w")).toMatchObject({ model: undefined, effort: "high" })
    expect(learnerConfig({ agent: "hermes", command: ["hermes"] }, "/w")).toMatchObject({ model: undefined, effort: "high" })
  })

  it("is kept with the other learning preferences, and a name this version doesn't know leaves the rest", async () => {
    const root = tempDir()
    await run(writeLearn({ auto: true, every: 3, max_usd_per_day: 2, with: "codex" }, root))
    expect(await run(readLearn(root))).toEqual({ auto: true, every: 3, max_usd_per_day: 2, with: "codex" })
    writeFileSync(join(root, "config.json"), JSON.stringify({ tenant: "local", learn: { auto: true, every: 3, max_usd_per_day: 2, with: "some-agent" } }))
    expect(await run(readLearn(root))).toEqual({ auto: true, every: 3, max_usd_per_day: 2 })
  })
})
