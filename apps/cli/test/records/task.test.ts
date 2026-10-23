import { describe, expect, it } from "@effect/vitest"
import { withPersonTask } from "../../src/records/Build.ts"
import type { WorkflowRecord } from "../../src/records/Models.ts"
import { changeMessage, changeTitle, messageText, taskKeys, taskOf, taskShown } from "../../src/records/Task.ts"

const ASK = "Show the installer's steps one per line, with a spinner for the one running"
const MESSAGE = "Show the installers' steps one per line, with a spinner\n\nThe steps were printed on one line."

describe("a stored change's task", () => {
  it("is the first prompt that asks for something, the others its follow-ups", () => {
    expect(taskOf(["please read @HANDOFF.md", ASK, "commit and open a PR"])).toEqual({ prompt: ASK, followups: ["please read @HANDOFF.md", "commit and open a PR"] })
    expect(taskOf([ASK, "yes"])).toEqual({ prompt: ASK, followups: ["yes"] })
    // None asks: the first, as it was.
    expect(taskOf(["commit and open a PR", "yes"])).toEqual({ prompt: "commit and open a PR", followups: ["yes"] })
    expect(taskOf([])).toEqual({ prompt: "", followups: [] })
  })

  it("keeps its commit message without trailers, each message once", () => {
    expect(messageText("Add MD061\r\n\r\n\r\nIts rule.\r\n\r\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\r\nSigned-off-by: T <t@example.com>\r\n"))
      .toBe("Add MD061\n\nIts rule.")
    expect(changeMessage(["Add MD061\n", "Add MD061", "", "Fix lint\n"])).toBe("Add MD061\n\nFix lint")
  })

  it("is found by its message, by its request only when the message says too little, never by a prompt that asks for nothing", () => {
    expect(taskKeys({ prompt: ASK, message: MESSAGE })).toEqual([MESSAGE])
    expect(taskKeys({ prompt: "I have a hypothetical question about memory and agents", message: MESSAGE })).toEqual([MESSAGE])
    expect(taskKeys({ prompt: "commit and open a PR", message: MESSAGE })).toEqual([MESSAGE])
    // A saved eval run has no message: its prompt, as before. A message of a word tells nothing apart.
    expect(taskKeys({ prompt: "Add MD061" })).toEqual(["Add MD061"])
    expect(taskKeys({ prompt: ASK, message: "wip" })).toEqual([ASK])
    expect(taskKeys({ prompt: "commit and open a PR", message: "wip" })).toEqual([])
    expect(taskShown({ prompt: "yes", message: MESSAGE })).toBe(MESSAGE)
    expect(taskShown({ prompt: ASK, message: MESSAGE })).toBe(ASK)
  })

  it("is named by its commit message, by its task when the message says too little", () => {
    expect(changeTitle({ prompt: "I have a hypothetical question about memory and agents", message: MESSAGE })).toBe(MESSAGE)
    expect(changeTitle({ prompt: ASK, message: "wip" })).toBe(ASK)
    expect(changeTitle({ prompt: ASK })).toBe(ASK)
  })

  it("is read again from a stored record led by the prompt that asked, its message kept", () => {
    const stored = { task: { prompt: "commit and open a PR", followups: [ASK], message: MESSAGE } } as unknown as WorkflowRecord
    expect(withPersonTask(stored).task).toEqual({ prompt: ASK, followups: ["commit and open a PR"], message: MESSAGE })
    const old = { task: { prompt: "yes", followups: [] } } as unknown as WorkflowRecord
    expect(withPersonTask(old).task).toEqual({ prompt: "yes", followups: [] })
  })
})
