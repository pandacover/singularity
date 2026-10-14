import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { decodeHookInput, eventOfHook } from "../../src/handover/HookInput.ts"
import { loadHome } from "../../src/local/Home.ts"
import type { Trigger } from "../../src/records/Triggers.ts"
import { HOOK_SCRIPT } from "../../src/setup/Wiring.ts"
import { mayFire } from "../../src/workflows/HookFilter.ts"
import { asClaudeCall, firing } from "../../src/workflows/HookTool.ts"
import type { Pitfall } from "../../src/workflows/Models.ts"
import { writeSession } from "../../src/workflows/Session.ts"
import { run, tempDir } from "../eval/helpers.ts"

const pitfall = (id: string, trigger: Trigger | null): Pitfall => ({ id, subject: "app", text: `Mind ${id}.`, trigger, evidence: [], cost_tokens: 0 })
const sessionText = (triggers: ReadonlyArray<Pitfall>) => JSON.stringify({ session_id: "s", triggers })

/** Calls as each agent's hook reports them: Claude Code's, Codex's, Gemini CLI's and Hermes Agent's. */
const calls: ReadonlyArray<Record<string, unknown>> = [
  {
    tool_name: "Bash",
    tool_input: { command: "npm run build-docs && npm test -- --watch=false" },
    tool_response: { stdout: "> build-docs\nError: Cannot find module './schema/.markdownlint.jsonc'\n", stderr: "npm ERR! code 1\nnpm ERR! path C:\\repo", interrupted: false }
  },
  { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" }, error: "src/a.ts(3,9): error TS1002: Unterminated string literal.\nExit code 2" },
  {
    tool_name: "Edit",
    tool_input: { file_path: "C:\\repo\\src\\App.tsx", old_string: "<App />", new_string: "<Excalidraw\n  handleKeyboardGlobally\n/>" },
    tool_response: { filePath: "C:\\repo\\src\\App.tsx", oldString: "<App />", newString: "<Excalidraw\n  handleKeyboardGlobally\n/>", structuredPatch: [] }
  },
  {
    tool_name: "MultiEdit",
    tool_input: { file_path: "/repo/lib/md061.mjs", edits: [{ old_string: "a", new_string: "export default {\n  names: [\"MD061\"]" }, { old_string: "b", new_string: "  tags: [\"headings\"]\n}" }] }
  },
  { tool_name: "Write", tool_input: { file_path: "/repo/doc/md061.md", content: "# `MD061` - Heading level\n\nTags: `headings`\n" } },
  { tool_name: "exec_command", tool_input: { cmd: ["bash", "-lc", "npx vitest run test/app.test.ts"] }, tool_response: "1 failed | 3 passed\nAssertionError: expected 2 to be 3" },
  { tool_name: "run_shell_command", tool_input: { command: "yarn test:update" }, tool_response: { stdout: "Snapshots: 2 written", stderr: "" } },
  { tool_name: "terminal", tool_input: { command: "python3 -m pytest" }, tool_response: "{\"output\": \"bash: python3: command not found\\n\", \"exit_code\": 127, \"error\": null}" },
  { tool_name: "patch", tool_input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const x = 1\n+const x = \"two\\nlines\"\n+export { x }\n*** End Patch" } }
]

/** What a trigger may look for in an event: stretches of its command, its text and its output, across spaces and lines too. */
const stretches = (s: string | undefined): Array<string> => {
  if (s === undefined) return []
  const out: Array<string> = []
  for (const len of [3, 6, 11, 17, 29]) for (let i = 0; i + len <= s.length; i += 4) out.push(s.slice(i, i + len))
  return out
}

describe("the tool-call hook's first look", () => {
  it("never passes over a call a trigger of the session's pitfalls matches", () => {
    let matched = 0
    for (const call of calls) {
      const stdin = JSON.stringify({ session_id: "s", cwd: "/repo", hook_event_name: "PostToolUse", ...call })
      const event = eventOfHook(asClaudeCall(decodeHookInput(stdin)!), "/repo")!
      const tried: Array<Pitfall> = [
        ...stretches(event.command).map((s, i) => pitfall(`c${i}`, { on: "command", all: [s], none: [], file: null })),
        ...stretches(event.text).map((s, i) => pitfall(`e${i}`, { on: "edit", all: [s], none: [], file: null })),
        ...stretches(event.output).map((s, i) => pitfall(`f${i}`, { on: "error", all: [s], none: [], file: null }))
      ].filter((p) => p.trigger!.all[0].trim() !== "")
      for (const p of tried) {
        if (firing([p], new Set(), event).length === 0) continue
        matched++
        expect(mayFire(stdin, sessionText([pitfall("other", { on: "command", all: ["no such words"], none: [], file: null }), p])), `${call.tool_name}: ${JSON.stringify(p.trigger)}`).toBe(true)
      }
    }
    // Enough pairs to mean something; reads and calls that didn't fail match no trigger, so not every stretch does.
    expect(matched).toBeGreaterThan(400)
  })

  it("passes over a call none can match, and leaves to the match what it can't read", () => {
    const stdin = JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "git status" }, tool_response: { stdout: "nothing to commit", stderr: "" } })
    const triggers = [
      pitfall("p-tsc", { on: "error", all: ["Unterminated string literal"], none: [], file: null }),
      pitfall("p-docs", { on: "command", all: ["build-docs", "build-config"], none: [], file: null }),
      pitfall("p-page", { on: "page", all: ["git status"], none: [], file: null }),
      pitfall("p-start", null)
    ]
    expect(mayFire(stdin, sessionText(triggers))).toBe(false)
    expect(mayFire(stdin, sessionText([]))).toBe(false)
    // Every word, wherever it is: a trigger's string is matched whole later.
    expect(mayFire(stdin, sessionText([pitfall("p-git", { on: "command", all: ["git  commit"], none: [], file: null })]))).toBe(true)
    expect(mayFire("not json", sessionText(triggers))).toBe(true)
    expect(mayFire(stdin, "{}")).toBe(true)
    expect(mayFire(stdin, sessionText([{ ...pitfall("p-odd", null), trigger: { on: "command" } as unknown as Trigger }]))).toBe(true)
  })

  it("warns through the hook when a trigger matches, and says nothing otherwise", async () => {
    const homeDir = tempDir()
    const home = await run(loadHome(homeDir))
    await run(writeSession(home.tenantDir, {
      session_id: "s1",
      tenant: home.tenant,
      subject: "app",
      repo: null,
      head: null,
      started_at: "2026-10-12T10:00:00Z",
      prompt: "Fix the build",
      version: 1,
      workflows: [],
      shown: [],
      missing: [],
      pitfalls: [],
      triggers: [pitfall("p-tsc", { on: "error", all: ["Unterminated string literal"], none: [], file: null })],
      selection: null
    }))
    const hook = (call: Record<string, unknown>) =>
      spawnSync(process.execPath, [HOOK_SCRIPT, "post-tool-use"], {
        input: JSON.stringify({ session_id: "s1", cwd: join(homeDir, "repo"), hook_event_name: "PostToolUse", ...call }),
        encoding: "utf-8",
        env: { ...process.env, SINGULARITY_HOME: homeDir, SINGULARITY_HOOKS: "on", SINGULARITY_AUTOLEARN: "off" }
      })
    const quiet = hook({ tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" }, tool_response: { stdout: "", stderr: "" } })
    expect([quiet.status, quiet.stdout]).toEqual([0, ""])
    // A helper agent reading notes that quote the message: a read, never a failure.
    const read = hook({ agent_id: "a1", tool_name: "Bash", tool_input: { command: "sed -n 1,80p notes.md" }, tool_response: { stdout: "error TS1002: Unterminated string literal. exit code 1", stderr: "" } })
    expect([read.status, read.stdout]).toEqual([0, ""])
    const failed = hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" }, error: "a.ts(1,7): error TS1002: Unterminated string literal." })
    expect(failed.status).toBe(0)
    expect(JSON.parse(failed.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUseFailure", additionalContext: expect.stringContaining("Mind p-tsc.") })
    // Made again after the warning: not said twice, but kept for the tally.
    const again = hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" }, error: "b.ts(2,1): error TS1002: Unterminated string literal." })
    expect([again.status, again.stdout]).toEqual([0, ""])
    const log = readFileSync(join(home.tenantDir, "workflows", "handovers.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { moment: string; pitfalls: Array<string> })
    expect(log.map((l) => [l.moment, l.pitfalls])).toEqual([["trigger", ["p-tsc"]], ["again", ["p-tsc"]]])
  }, 60_000)

  it("looks at every trigger of a pitfall, its others too", () => {
    const stdin = JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "node edit.mjs" }, error: "Error: missing: const x = 1" })
    const merged = { ...pitfall("p-edit", { on: "error", all: ["Unterminated string literal"], none: [], file: null }), also: [{ on: "error" as const, all: ["missing:"], none: [], file: null }] }
    expect(mayFire(stdin, sessionText([merged]))).toBe(true)
    expect(mayFire(stdin, sessionText([{ ...merged, also: [] }]))).toBe(false)
    const event = eventOfHook(asClaudeCall(decodeHookInput(stdin)!), "/repo")!
    expect(firing([merged], new Set(), event).map((p) => p.id)).toEqual(["p-edit"])
  })
})
