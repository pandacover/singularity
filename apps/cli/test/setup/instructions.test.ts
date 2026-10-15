import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  installNote,
  NOTE_BLOCK,
  NOTE_END,
  NOTE_START,
  noteIn,
  noteState,
  RECALL_NOTE,
  removeNote,
  withNote,
  withoutNote
} from "../../src/setup/Instructions.ts"
import { tempDir } from "../eval/helpers.ts"

describe("the recall note's text", () => {
  it("tells the agent to recall mid-task, plainly", () => {
    expect(RECALL_NOTE).toContain("singularity recall \"<what you are about to do>\"")
    expect(RECALL_NOTE.replace(/\n/g, " ")).toContain("\"A past change in this repository like your task\"")
    expect(RECALL_NOTE).not.toMatch(/—/)
    expect(NOTE_BLOCK.startsWith(NOTE_START)).toBe(true)
    expect(NOTE_BLOCK.endsWith(NOTE_END)).toBe(true)
  })

  it("goes at the end after a blank line, and comes out leaving the file as it was", () => {
    for (const before of ["# Mine\n", "# Mine\n\nMore.\n", "a\r\nb\r\n"]) {
      const after = withNote(before)
      expect(after.startsWith(before)).toBe(true)
      expect(noteState(after)).toBe("current")
      expect(withoutNote(after)).toBe(before)
    }
    // An empty file gets the note alone, and is empty again without it.
    expect(withNote("")).toBe(`${NOTE_BLOCK}\n`)
    expect(withoutNote(withNote(""))).toBe("")
    // A file with no newline at its end keeps the one added.
    expect(withoutNote(withNote("no newline"))).toBe("no newline\n")
    // CRLF files get CRLF.
    expect(withNote("a\r\n")).toBe(`a\r\n\r\n${NOTE_BLOCK.replace(/\n/g, "\r\n")}\r\n`)
  })

  it("is added once, and replaced in place when its text changes", () => {
    const once = withNote("# Mine\n")
    expect(withNote(once)).toBe(once)
    const old = `${NOTE_START}\nold words\n${NOTE_END}`
    const withOld = `# Top\n\n${old}\n\n# Mine, after it\n`
    expect(noteState(withOld)).toBe("outdated")
    const replaced = withNote(withOld)
    expect(replaced).toBe(`# Top\n\n${NOTE_BLOCK}\n\n# Mine, after it\n`)
    expect(noteState(replaced)).toBe("current")
    // Out from the middle: the user's text around it stays.
    expect(withoutNote(replaced)).toBe("# Top\n\n\n# Mine, after it\n")
    expect(noteState("# Mine\n")).toBe("missing")
    expect(withoutNote("# Mine\n")).toBe("# Mine\n")
  })

  it("isn't fooled by the marker inside a line, or a start with no end", () => {
    const quoted = `Say \`${NOTE_START}\` to see it.\n`
    expect(noteState(quoted)).toBe("missing")
    expect(withoutNote(`${NOTE_START}\nno end\n`)).toBe(`${NOTE_START}\nno end\n`)
  })
})

describe("the recall note's file", () => {
  it.live("goes in the first file with text, else the one to create; a file left empty goes", () =>
    Effect.gen(function*() {
      const dir = tempDir()
      const override = join(dir, "AGENTS.override.md")
      const agents = join(dir, "AGENTS.md")
      const files = { reads: [override, agents], create: agents }
      // Nothing there: the file to create, made with its folder.
      const nested = { reads: [join(dir, "new", "AGENTS.md")], create: join(dir, "new", "AGENTS.md") }
      expect(yield* installNote(nested)).toEqual({ file: nested.create, changed: true })
      expect(readFileSync(nested.create, "utf-8")).toBe(`${NOTE_BLOCK}\n`)
      expect(yield* removeNote(nested.create)).toBe(true)
      expect(existsSync(nested.create)).toBe(false)

      // An empty override is skipped, as Codex skips it.
      writeFileSync(override, "")
      writeFileSync(agents, "Mine.\n")
      expect((yield* installNote(files)).file).toBe(agents)
      expect(yield* installNote(files)).toEqual({ file: agents, changed: false })
      expect(yield* noteIn(files)).toEqual({ file: agents, state: "current" })
      expect(yield* removeNote(agents)).toBe(true)
      expect(readFileSync(agents, "utf-8")).toBe("Mine.\n")
      expect(yield* removeNote(agents)).toBe(false)
      expect(yield* removeNote(join(dir, "missing.md"))).toBe(false)
      mkdirSync(join(dir, "x"))
      expect(yield* noteIn({ reads: [join(dir, "x", "A.md")], create: join(dir, "x", "A.md") })).toMatchObject({ state: "missing" })
    }).pipe(Effect.provide(NodeServices.layer)))
})
