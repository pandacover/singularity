import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Path } from "effect"
import { isPersonPrompt, ownWords, parseSession, personPrompts, personTask, personText, sliceTrace } from "../../src/traces/index.ts"

const NOTICE = `<task-notification>
<task-id>b0sp6b082</task-id>
<tool-use-id>toolu_01CYMKVKzNgXAcbPpp57KUUK</tool-use-id>
<status>completed</status>
<summary>Background command "Run the approved first learning round for singularity" completed (exit code 0)</summary>
</task-notification>`

const quoteLink = (text: string, comment?: string) =>
  `[Assistant quote](t3-citation://v1/7d538f6b/bf7804ed/message%3Aprovider?text=${encodeURIComponent(text)}&start=1&end=2` +
  `${comment === undefined ? "" : `&comment=${encodeURIComponent(comment)}`})`

describe("personText", () => {
  it("drops what the tools sent: notices, reminders, slash commands' output, interruptions", () => {
    assert.strictEqual(personText(NOTICE), "")
    assert.strictEqual(personText("[Request interrupted by user]"), "")
    assert.strictEqual(personText("[Request interrupted by user for tool use]"), "")
    assert.strictEqual(personText("<local-command-stdout>Compacted </local-command-stdout>"), "")
    assert.strictEqual(
      personText(`<system-reminder>\n"Auto-fix pull requests" is enabled for this session.\n</system-reminder>\n\n\ncommit and push to a different branch`),
      "commit and push to a different branch"
    )
    assert.strictEqual(personText("<create-pr-command>\n## Overview\n\nCreate a pull request for the changes.\n</create-pr-command>"), "")
  })

  it("keeps what the person typed after a slash command", () => {
    const goal = `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>keep it and work on all the steps</command-args>`
    assert.strictEqual(personText(goal), "keep it and work on all the steps")
    assert.strictEqual(personText(`<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>`), "")
  })

  it("drops T3's image notes and attachment context", () => {
    const text = `this [Image: {7491DA6D}.png; ref=image_bd36373a]  causes layout shifts\n\n<t3_context version="1">\n<context kind="image" id="image_bd36373a">\nname: x.png\n</context>\n</t3_context>`
    assert.strictEqual(personText(text), "this causes layout shifts")
    assert.strictEqual(personText(`[User attached one or more files without additional text. Respond using the attached files.]\n\n[Attached image "{1B1B}.png" is saved at: C:\\Users\\luvma\\.t3\\a.png]`), "")
    assert.strictEqual(
      personText("what does each command do ![{A89A}.png](t3-context://v1/image/image_232e)\n\nAttachment metadata:\n- {A89A}.png (image/png, 117606 bytes)"),
      "what does each command do"
    )
  })

  it("keeps only the person's comment on a quote of the assistant", () => {
    const text = `${quoteLink("Learning runs sooner.", "understood, but let the user set the day cap")} ${quoteLink("Do you want docs to count?")}`
    assert.strictEqual(personText(text), "understood, but let the user set the day cap")
    const older = `I would say yes to [assistant-quote-1] when tests pass\n\n<assistant_citations>\nThe following citations refer to earlier assistant responses.\n[\n  {"id": "assistant-quote-1", "citation": {"version": 1, "text": "Storage: JSON files in this repo.", "comment": "why not a graph db?"}}\n]\n</assistant_citations>`
    assert.strictEqual(personText(older), "I would say yes to why not a graph db? when tests pass")
    assert.strictEqual(personText("[Preview annotation: remove this; ref=preview-annotation_annotation_d]"), "remove this")
  })

  it("marks pasted text as quoted lines, and own words leave it out", () => {
    const draft = "I was writing a post for reddit. Clean it up\n---\nHey guys. Give it a try:\ncurl -fsSL https://x/install.sh | sh\n"
    assert.strictEqual(personText(draft), "I was writing a post for reddit. Clean it up\n> Hey guys. Give it a try:\n> curl -fsSL https://x/install.sh | sh")
    assert.strictEqual(ownWords(draft), "I was writing a post for reddit. Clean it up")
    const comment = "a comment from reddit\n---\nCurious how you decide when to save?\n---\nmy understanding - whenever there's a commit the traces are saved"
    assert.strictEqual(ownWords(comment), "a comment from reddit\nmy understanding - whenever there's a commit the traces are saved")
    assert.strictEqual(ownWords("> Make the logo bigger\nyes, do that"), "yes, do that")
  })

  it("gives the same text when applied again", () => {
    for (const t of [NOTICE, "a\n---\nb\n---\nc", `${quoteLink("x", "y")} z`, "plain words", "> quoted\nown"]) {
      assert.strictEqual(personText(personText(t)), personText(t))
    }
  })
})

describe("person prompts", () => {
  const at = (s: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, 0, s))

  it("leaves out prompts the harness sent and prompts with nothing of the person's", () => {
    const prompts = [
      { text: "Background command finished", timestamp: at(0), harness: true },
      { text: NOTICE, timestamp: at(1) },
      { text: "fix the shortcut", timestamp: at(2) },
      { text: "[Request interrupted by user]", timestamp: at(3) }
    ]
    assert.deepStrictEqual(personPrompts(prompts).map((p) => p.text), ["fix the shortcut"])
    assert.deepStrictEqual(prompts.map(isPersonPrompt), [false, false, true, false])
    assert.deepStrictEqual(personTask([NOTICE, "commit, push and merge", "[Request interrupted by user]", "yes"]), { prompt: "commit, push and merge", followups: ["yes"] })
  })

  it("reads Claude Code's promptSource, and leads a part of the log with the person's prompt, not a notice", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "prompts-" })
      const ts = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString()
      const lines = [
        { type: "user", timestamp: ts(0), cwd: "/repo", promptSource: "sdk", message: { role: "user", content: "add a dark mode toggle" } },
        { type: "assistant", timestamp: ts(1), message: { id: "m1", model: "claude-test", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }], usage: {} } },
        { type: "user", timestamp: ts(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } },
        { type: "user", timestamp: ts(3), promptSource: "system", turnOrigin: "task_notification", message: { role: "user", content: "Background command \"npm test\" completed (exit code 0)" } },
        { type: "assistant", timestamp: ts(5), message: { id: "m2", model: "claude-test", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "git commit -m x" } }], usage: {} } },
        { type: "user", timestamp: ts(6), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok", is_error: false }] } }
      ]
      const file = path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl")
      yield* fs.writeFileString(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
      const trace = yield* parseSession(file)
      assert.deepStrictEqual(trace.prompts.map((p) => p.harness === true), [false, true])
      // A part that opens after the notice: the prompt still being worked on is the person's.
      const part = sliceTrace(trace, { from: Date.UTC(2026, 9, 1, 10, 0, 4), to: Date.UTC(2026, 9, 1, 10, 0, 6) })
      assert.deepStrictEqual(personPrompts(part.prompts).map((p) => p.text), ["add a dark mode toggle"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
