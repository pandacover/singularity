import { describe, expect, it } from "@effect/vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { hookEvents } from "../../src/setup/Agents.ts"
import { codexHooks, trustCodexHooks } from "../../src/setup/CodexHooks.ts"
import { findCommand } from "../../src/setup/Wiring.ts"
import { FAKE_CODEX, fakeCommand, run, tempDir } from "../eval/helpers.ts"

const launch = { node: "node", script: "C:/app/src/workflows/hook.ts" }

/** A home whose Codex holds memory's hooks and one of the user's own, with a fake Codex on PATH. */
const machine = (extra: Record<string, string> = {}) => {
  const root = tempDir()
  const bin = join(root, "bin")
  mkdirSync(bin)
  fakeCommand(bin, "codex", FAKE_CODEX)
  const codexHome = join(root, "codex")
  mkdirSync(codexHome)
  const events = hookEvents("codex", launch, launch)
  writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
    hooks: { ...events, Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }
  }))
  // The home setup wrote the hooks in, even when the environment names none.
  const dirs = { home: join(root, "home"), env: { PATH: bin, PATHEXT: ".EXE;.CMD;.BAT", CODEX_HOME: codexHome, ...extra } }
  return { codexHome, dirs }
}

describe("memory's hooks in Codex", () => {
  it("are listed with their trust, the user's own left out; trusting them keeps what the user trusted before", async () => {
    const { codexHome, dirs } = machine()
    writeFileSync(join(codexHome, "trust.json"), JSON.stringify({ "users-own": { trusted_hash: "sha256:kept" } }))
    const codex = (await run(findCommand("codex", dirs.env)))!
    const before = (await run(codexHooks(codex, dirs)))!
    expect(before.map((h) => [h.event, h.trusted])).toEqual([["userPromptSubmit", false], ["postToolUse", false], ["sessionEnd", false]])
    expect(await run(trustCodexHooks(codex, dirs, before))).toBe(true)
    expect((await run(codexHooks(codex, dirs)))!.every((h) => h.trusted)).toBe(true)
    expect(JSON.parse(readFileSync(join(codexHome, "trust.json"), "utf-8"))["users-own"]).toEqual({ trusted_hash: "sha256:kept" })
  }, 30_000)

  it("need trusting again once setup rewrites one, as Codex trusts a hook's settings, not its name", async () => {
    const { codexHome, dirs } = machine()
    const codex = (await run(findCommand("codex", dirs.env)))!
    await run(trustCodexHooks(codex, dirs, (await run(codexHooks(codex, dirs)))!))
    const file = join(codexHome, "hooks.json")
    writeFileSync(file, readFileSync(file, "utf-8").replace("\"timeout\":3", "\"timeout\":30"))
    expect((await run(codexHooks(codex, dirs)))!.filter((h) => !h.trusted).map((h) => h.event)).toEqual(["sessionEnd"])
  }, 30_000)

  it("have an unknown trust when Codex has no app-server to ask", async () => {
    const { dirs } = machine({ FAKE_CODEX_NO_APP_SERVER: "1" })
    const codex = (await run(findCommand("codex", dirs.env)))!
    expect(await run(codexHooks(codex, dirs))).toBeUndefined()
  }, 30_000)
})
