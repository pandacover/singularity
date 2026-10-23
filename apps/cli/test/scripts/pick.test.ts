/**
 * A model's pick of the past change (src/scripts/Pick.ts): what it reads, how
 * its answer is read, the command it runs, and where the person's choice is
 * kept (local/Home.ts, setup/Setup.ts `askPicks`).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadHome, savePicks } from "../../src/local/Home.ts"
import { askModel, pickInput, pickList, readAnswer } from "../../src/scripts/Pick.ts"
import { askPicks } from "../../src/setup/Setup.ts"
import { run, tempDir } from "../eval/helpers.ts"

const DOCS = [
  { prompt: "yes", message: "Show the installer's steps one per line, with a spinner\n\nThe steps were printed on one line." },
  { prompt: "the singularity command takes ages before it shows the options, can you make it start faster", message: "wip" },
  { prompt: "Add a visualise command" }
]

describe("what the model reads", () => {
  it("lists each change by its commit's title, then the start of its request, numbered from 1", () => {
    expect(pickList(DOCS).split("\n")).toEqual([
      "1. Show the installer's steps one per line, with a spinner — request: yes",
      // A message that says too little: the request names it.
      "2. the singularity command takes ages before it shows the options, can you make it start faster — request: the singularity command takes ages before it shows the options, can you make it start faster",
      "3. Add a visualise command — request: Add a visualise command"
    ])
    expect(pickList([{ prompt: "x".repeat(400), message: "Make the hook start faster by loading less" }])).toMatch(/request: x{150} …$/)
    expect(pickInput("make it start faster", DOCS)).toMatch(/^NEW MESSAGE:\nmake it start faster\n\nEARLIER CHANGES:\n1\. /)
  })

  it("reads its answer as a change listed, none, or no answer", () => {
    expect(readAnswer("{\"pick\": 2}", 3)).toBe(1)
    expect(readAnswer("Sure.\n```json\n{\"pick\": null}\n```", 3)).toBe(null)
    expect(readAnswer("{\"pick\": 4}", 3)).toBeUndefined()
    expect(readAnswer("{\"pick\": 1.5}", 3)).toBeUndefined()
    expect(readAnswer("the second one", 3)).toBeUndefined()
  })
})

describe("asking the model", () => {
  it("runs the agent's command with the task on stdin, and reads the change it picks", async () => {
    const dir = tempDir()
    // A stand-in for `claude -p --output-format json`: it notes what it was given and picks the second change.
    const fake = join(dir, "fake-claude.mjs")
    writeFileSync(fake, [
      "import { writeFileSync } from 'node:fs'",
      "let input = ''",
      "for await (const chunk of process.stdin) input += chunk",
      `writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({ args: process.argv.slice(2), input, hooks: process.env.SINGULARITY_HOOKS }))`,
      "console.log(JSON.stringify({ result: '{\"pick\": 2}', total_cost_usd: 0.0017 }))"
    ].join("\n"))
    const picked = await run(askModel({ agent: "claude", model: "haiku" }, "make the command start faster", DOCS, dir, [process.execPath, fake]))
    expect(picked).toMatchObject({ index: 1, costUsd: 0.0017 })
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf-8"))
    expect(seen.args.slice(0, 5)).toEqual(["-p", "--model", "haiku", "--effort", "low"])
    // No tools, no settings (none of memory's hooks either), no session kept.
    expect(seen.args).toEqual(expect.arrayContaining(["--tools", "", "--setting-sources", "--no-session-persistence"]))
    expect(seen.hooks).toBe("off")
    expect(seen.input).toBe(pickInput("make the command start faster", DOCS))

    // An answer that picks nothing listed fails, so word search picks instead.
    writeFileSync(fake, "console.log(JSON.stringify({ result: 'I think the third.' }))")
    const failed = await run(askModel({ agent: "claude", model: "haiku" }, "x", DOCS, dir, [process.execPath, fake]).pipe(Effect.flip))
    expect(failed.message).toContain("picks nothing listed")
  })
})

describe("the person's choice", () => {
  it("is kept in config.json beside the tenant, the cheapest model suggested the first time, the earlier answer after", async () => {
    const root = tempDir()
    const home = await run(loadHome(root))
    expect(home.picks).toBe(null)
    // Asked with no one to answer: the default, the cheapest model.
    expect(await run(askPicks(home, false))).toEqual({ agent: "claude", model: "haiku" })
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf-8"))).toEqual({ tenant: "local", picks: { agent: "claude", model: "haiku" } })
    expect((await run(loadHome(root))).picks).toEqual({ agent: "claude", model: "haiku" })
    // Word search, once chosen, stays the default.
    await run(savePicks(await run(loadHome(root)), null))
    expect(await run(askPicks(await run(loadHome(root)), false))).toBe(null)
    // A model chosen before stays the default too.
    await run(savePicks(await run(loadHome(root)), { agent: "claude", model: "claude-sonnet-5-5" }))
    expect(await run(askPicks(await run(loadHome(root)), false))).toEqual({ agent: "claude", model: "claude-sonnet-5-5" })
  })
})
