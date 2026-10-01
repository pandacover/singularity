import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { constants } from "node:os"
import { join } from "node:path"
import { agentEnv, buildCommand, parseResult } from "../../src/eval/Agent.ts"
import { lowerPriority, runProcess } from "../../src/eval/Proc.ts"
import type { RunRecord } from "../../src/eval/Report.ts"
import { compare, loadRecords, summarize } from "../../src/eval/Report.ts"
import { runSuite } from "../../src/eval/Runner.ts"
import { NoMemory } from "../../src/eval/Setups.ts"
import type { AgentConfig } from "../../src/eval/Suite.ts"
import { loadSuite } from "../../src/eval/Suite.ts"
import { makeWorkspace, resetWorkspace, resolveRef, workspaceDiff } from "../../src/eval/Workspace.ts"
import { FAKE_CLAUDE, run, git, makeRepo, seenByAgent, tempDir, withEnv, writeSuite } from "./helpers.ts"

// Git may check files out with CRLF (core.autocrlf), so compare text with LF.
const readText = (path: string): string => readFileSync(path, "utf-8").replaceAll("\r\n", "\n")


describe("loadSuite", () => {
  it("parses a suite", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const suite = await run(loadSuite(writeSuite(root, repo)))
    assert.strictEqual(suite.repo, repo)
    const [t1, t2] = suite.tasks
    assert.deepStrictEqual([t1.base, t2.base], ["HEAD~1", "HEAD"])
    assert.strictEqual(t1.prompt, "Write 42 to answer.txt")
    assert.strictEqual(t1.checkFiles, join(root, "hidden", "t1"))
    assert.deepStrictEqual(t2.checks, [])
    assert.isUndefined(t2.family)
    assert.strictEqual(suite.agent.model, "haiku")
    assert.strictEqual(suite.agent.permissionMode, "acceptEdits")
  })

  it.each([
    ['name = "x"\nrepo = "."\nbogus = 1\n[[tasks]]\nid = "a"\nprompt = "p"\nbase = "HEAD"', "excess property"],
    ['name = "x"\nrepo = "."\n[[tasks]]\nid = "a"\nprompt = "p"', "no 'base'"],
    ['name = "x"\nrepo = "."\nbase = "HEAD"\n[[tasks]]\nid = "a"\nprompt = "p"\n[[tasks]]\nid = "a"\nprompt = "q"', "duplicate"],
    ['name = "x"\nrepo = "."\nbase = "HEAD"\n[agent]\nmodle = "haiku"\n[[tasks]]\nid = "a"\nprompt = "p"', "modle"]
  ])("rejects a bad suite (%#)", async (toml, error) => {
    const path = join(tempDir(), "s.toml")
    writeFileSync(path, toml)
    const failure = await run(Effect.flip(loadSuite(path)))
    assert.include(failure.message, error)
  })
})

describe("workspace", () => {
  it("resets, diffs, and keeps ignored paths", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const ws = makeWorkspace(repo, join(root, "ws"), ["node_modules"])
    const first = await run(resolveRef(ws, "HEAD~1"))
    await run(resetWorkspace(ws, first))
    assert.strictEqual(readText(join(ws.path, "app.txt")), "v1\n")
    assert.strictEqual(git(ws.path, "remote"), "") // no way back to the source repo

    writeFileSync(join(ws.path, "app.txt"), "changed\n")
    writeFileSync(join(ws.path, "new.txt"), "new\n")
    mkdirSync(join(ws.path, "node_modules"))
    writeFileSync(join(ws.path, "node_modules", "dep.js"), "x")
    const diff = await run(workspaceDiff(ws, first))
    assert.include(diff, "+changed")
    assert.include(diff, "new.txt")
    assert.notInclude(diff, "dep.js")

    await run(resetWorkspace(ws, await run(resolveRef(ws, "HEAD"))))
    assert.strictEqual(readText(join(ws.path, "app.txt")), "v2\n")
    assert.isFalse(existsSync(join(ws.path, "new.txt")))
    assert.isTrue(existsSync(join(ws.path, "node_modules", "dep.js")))
  })

  it("hides later commits", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const ws = makeWorkspace(repo, join(root, "ws"))
    await run(resetWorkspace(ws, await run(resolveRef(ws, "HEAD~1"))))
    assert.strictEqual(git(ws.path, "for-each-ref"), "")
    assert.notInclude(git(ws.path, "log", "--all", "--reflog", "--format=%s"), "two")
    // The later commit is still there to reset to, without a fetch.
    await run(resetWorkspace(ws, await run(resolveRef(ws, "HEAD"))))
    assert.strictEqual(readText(join(ws.path, "app.txt")), "v2\n")
  })

  it("fetches new commits", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const ws = makeWorkspace(repo, join(root, "ws"))
    await run(resetWorkspace(ws, await run(resolveRef(ws, "HEAD"))))
    writeFileSync(join(repo, "app.txt"), "v3\n")
    git(repo, "commit", "-qam", "three")
    await run(resetWorkspace(ws, await run(resolveRef(ws, "HEAD"))))
    assert.strictEqual(readText(join(ws.path, "app.txt")), "v3\n")
  })
})

describe("agent", () => {
  it("builds the command and environment", () => {
    const cfg: AgentConfig = {
      model: "haiku",
      effort: "low",
      permissionMode: "acceptEdits",
      allowedTools: ["Read"],
      disallowedTools: [],
      maxTurns: 30,
      maxBudgetUsd: 1.5,
      timeoutS: 60,
      extraArgs: ["--safe-mode"]
    }
    const cmd = buildCommand(["claude"], cfg, "sid", "mem.md")
    const joined = cmd.join(" ")
    for (const part of [
      "-p",
      "--output-format json",
      "--session-id sid",
      "--model haiku",
      "--effort low",
      "--max-budget-usd 1.5",
      "--max-turns 30",
      "--append-system-prompt-file mem.md",
      "--strict-mcp-config",
      "--permission-prompts none"
    ]) {
      assert.include(joined, part)
    }
    assert.strictEqual(cmd.at(-1), "--safe-mode")

    const env = agentEnv({ PATH: "x", CLAUDECODE: "1", CLAUDE_EFFORT: "max", CLAUDE_CONFIG_DIR: "c", ANTHROPIC_API_KEY: "k" })
    assert.deepStrictEqual(env, { PATH: "x", CLAUDE_CONFIG_DIR: "c", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })
  })

  it("parses the result despite noise", () => {
    assert.strictEqual(parseResult('warning: something\n{"type": "result", "subtype": "success"}\n')?.subtype, "success")
    assert.isUndefined(parseResult("not json"))
  })
})

describe("runSuite", () => {
  it("runs end to end", async () => {
    const root = tempDir()
    const home = join(root, "claude-home")
    const repo = makeRepo(root)
    await withEnv({ CLAUDE_CONFIG_DIR: home, CLAUDECODE: "1" }, async () => {
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const out = join(root, "out")
      const records = await run(
        runSuite(suite, NoMemory, out, FAKE_CLAUDE, { workspaces: join(root, "workspaces"), reps: 2, taskIds: ["t1"] })
      )

      assert.strictEqual(records.length, 2)
      const r = records[0] as Record<string, any>
      assert.deepStrictEqual([r.status, r.success, r.task_id, r.family, r.rep], ["completed", true, "t1", "f", 0])
      assert.strictEqual(r.base_sha, git(repo, "rev-parse", "HEAD~1"))
      assert.strictEqual(r.cost_usd, 0.0123)
      // Headline tokens come from the result, which includes side calls.
      assert.strictEqual(r.tokens_source, "result")
      assert.strictEqual(r.tokens.total, 10 + 40 + 200 + 100 + 1000 + 10)
      assert.strictEqual(r.trace.tool_calls, 1)
      assert.strictEqual(r.trace.usage.total, 2 * 175)
      assert.deepStrictEqual(r.models, ["claude-fake"])
      assert.strictEqual(r.agent.num_turns, 2)
      assert.strictEqual(r.diff_lines, 1)
      assert.deepStrictEqual(r.files_changed, ["answer.txt"])

      const runDir = join(out, "runs", r.run_id)
      assert.isTrue(existsSync(join(runDir, "transcript", `${r.session_id}.jsonl`)))
      assert.include(readFileSync(join(runDir, "diff.patch"), "utf-8"), "answer.txt")
      const lines = readFileSync(join(out, "results.jsonl"), "utf-8").trim().split("\n")
      assert.deepStrictEqual(lines.map((l) => JSON.parse(l).run_id), records.map((x) => x.run_id))
      assert.strictEqual(JSON.parse(readFileSync(join(out, "meta.json"), "utf-8")).claude_version, "0.0.0 (fake)")

      const seen = seenByAgent(home, r.session_id)
      assert.notProperty(seen.env, "CLAUDECODE")
      assert.strictEqual(seen.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1")

      const table = summarize(await run(loadRecords([out])))
      assert.include(table, "| no-memory | t1")
      assert.include(table, "2/2")
    })
  })

  it("records a failed check", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    await withEnv({ CLAUDE_CONFIG_DIR: join(root, "claude-home") }, async () => {
      const suite = await run(loadSuite(writeSuite(root, repo)))
      writeFileSync(join(root, "hidden", "t1", "check_answer.mjs"), "process.exit(1)\n")
      const [r] = (await run(
        runSuite(suite, NoMemory, join(root, "out"), FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] })
      )) as Array<Record<string, any>>
      assert.strictEqual(r.status, "completed")
      assert.isFalse(r.success)
      assert.strictEqual(r.checks[0].exit_code, 1)
    })
  })

  it("skips the agent when setup fails", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const home = join(root, "claude-home")
    await withEnv({ CLAUDE_CONFIG_DIR: home }, async () => {
      const suite = await run(loadSuite(writeSuite(root, repo, 'setup = ["exit 3"]')))
      const [r] = await run(
        runSuite(suite, NoMemory, join(root, "out"), FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] })
      )
      assert.strictEqual(r.status, "setup_failed")
      assert.isFalse(existsSync(home))
    })
  })

  it("passes the suite env to the agent and the checks", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const home = join(root, "claude-home")
    const check = join(root, "check_env.mjs")
    writeFileSync(check, "process.exit(process.env.MY_CAP === '4' ? 0 : 1)\n")
    await withEnv({ CLAUDE_CONFIG_DIR: home }, async () => {
      const loaded = await run(loadSuite(writeSuite(root, repo, "env = { MY_CAP = 4 }")))
      assert.deepStrictEqual(loaded.env, { MY_CAP: "4" })
      const node = process.execPath.replace(/\\/g, "/")
      const suite = {
        ...loaded,
        tasks: [{ ...loaded.tasks[0], checks: [`"${node}" "${check.replace(/\\/g, "/")}"`] }, loaded.tasks[1]]
      }
      const [r] = (await run(
        runSuite(suite, NoMemory, join(root, "out"), FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] })
      )) as Array<Record<string, any>>
      assert.isTrue(r.success) // the check saw MY_CAP
      assert.strictEqual(seenByAgent(home, r.session_id).env.MY_CAP, "4")
    })
  })
})

describe("processes", () => {
  it("run below normal priority once lowered", async () => {
    await run(lowerPriority)
    const r = await run(
      runProcess(process.execPath, ["-e", "console.log(require('os').getPriority())"], {
        cwd: tempDir(),
        timeoutS: 30,
        env: process.env
      })
    )
    assert.strictEqual(r.stdout.trim(), String(constants.priority.PRIORITY_BELOW_NORMAL))
  })

  it("time out and kill the process tree", async () => {
    const script = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); setInterval(() => {}, 1000)"
    const r = await run(runProcess(process.execPath, ["-e", script], { cwd: tempDir(), timeoutS: 1, env: process.env }))
    assert.isTrue(r.timedOut)
    assert.isUndefined(r.exitCode)
  })
})

describe("reports", () => {
  const rec = (setup: string, task: string, success: boolean, cost: number, status = "completed"): RunRecord => ({
    setup,
    task_id: task,
    success,
    cost_usd: cost,
    status,
    tokens: { total: 1000 },
    wall_time_s: 10,
    trace: { tool_calls: 4 }
  })

  it("summarizes per task and per setup", () => {
    const table = summarize([rec("a", "x", true, 0.1), rec("a", "x", false, 0.3, "timeout"), rec("a", "y", true, 0.2), rec("b", "x", true, 0.05)])
    const lines = table.split("\n")
    assert.isTrue(lines[2].startsWith("| a     | x       | 2    | 1/2     | 0.20 (0.10-0.30)"))
    assert.include(lines[2], "1 timeout")
    assert.isTrue(lines.some((l) => l.startsWith("| a     | **all**") && l.includes("2/3")))
  })

  it("compares exact repeats and similar tasks", () => {
    const r = (setup: string, task: string, calls: number, retrieved?: string): RunRecord => ({
      setup,
      task_id: task,
      success: true,
      cost_usd: calls / 100,
      tokens: { total: calls * 1000 },
      wall_time_s: calls,
      trace: { tool_calls: calls },
      injection: retrieved ? { retrieved: { task_id: retrieved } } : {},
      status: "completed"
    })
    const records = [r("no-memory", "a", 40), r("no-memory", "a", 50), r("no-memory", "b", 40), r("saved", "a", 10, "a"), r("saved", "b", 30, "a")]
    const out = compare(records)
    const rows = new Set(
      out.split("\n").filter((l) => l.startsWith("| saved")).map((l) => l.split("|").slice(1, 4).map((c) => c.trim()).join("/"))
    )
    assert.isTrue(rows.has("saved/a/exact repeat"))
    assert.isTrue(rows.has("saved/b/similar task"))
    assert.include(out, "45 -> 10 (-78%)") // median 45 against 10
    assert.include(out, "40 -> 30 (-25%)")
    assert.include(out, "**exact repeat**")
    assert.include(out, "**similar task**")
    assert.include(out.replace(/ {2,}/g, " "), "| -78% ") // one task per group: its own change
    assert.throws(() => compare(records.slice(0, 3)))
  })
})
