import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { constants } from "node:os"
import { join } from "node:path"
import { agentEnv, buildCommand, defaultClaude, parseResult } from "../../src/eval/Agent.ts"
import { makeSetup } from "../../src/eval/Memory.ts"
import { lowerPriority, runProcess } from "../../src/eval/Proc.ts"
import type { RunRecord } from "../../src/eval/Report.ts"
import { compare, loadRecords, runKind, summarize } from "../../src/eval/Report.ts"
import { runSuite } from "../../src/eval/Runner.ts"
import { NoMemory } from "../../src/eval/Setups.ts"
import type { AgentConfig } from "../../src/eval/Suite.ts"
import { loadSuite } from "../../src/eval/Suite.ts"
import { makeWorkspace, resetWorkspace, resolveRef, workspaceDiff } from "../../src/eval/Workspace.ts"
import { HOOK_SCRIPT, withOurHooks } from "../../src/handover/Install.ts"
import { identifyRepo } from "../../src/local/Git.ts"
import { loadHome } from "../../src/local/Home.ts"
import { buildGraph } from "../../src/memory/Build.ts"
import * as JsonMemoryStore from "../../src/memory/JsonMemoryStore.ts"
import { diffGraphs, emptyGraph } from "../../src/memory/Models.ts"
import { MemoryStore } from "../../src/memory/MemoryStore.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { flagLesson, readRecord, step } from "../memory/fixtures.ts"
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
    assert.deepStrictEqual(env, {
      PATH: "x",
      CLAUDE_CONFIG_DIR: "c",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTOUPDATER: "1",
      SINGULARITY_HOOKS: "off"
    })
  })

  it("finds claude where SINGULARITY_CLAUDE says: a path, or a command with its first arguments", async () => {
    await withEnv({ SINGULARITY_CLAUDE: "C:/tools/claude.exe" }, async () =>
      assert.deepStrictEqual(await run(defaultClaude()), ["C:/tools/claude.exe"]))
    await withEnv({ SINGULARITY_CLAUDE: JSON.stringify(FAKE_CLAUDE) }, async () =>
      assert.deepStrictEqual(await run(defaultClaude()), FAKE_CLAUDE))
    await withEnv({ SINGULARITY_CLAUDE: "[1]" }, async () =>
      assert.include((await run(Effect.flip(defaultClaude()))).message, "SINGULARITY_CLAUDE"))
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
      assert.strictEqual(seen.env.SINGULARITY_HOOKS, "off")

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

describe("the hooks setup", () => {
  /** A memory home that knows the repo: one kind of task like t1, with the doubled-flag warning on its test step. */
  const seedHome = (homeDir: string, repo: string) =>
    run(Effect.gen(function*() {
      const home = yield* loadHome(homeDir)
      return yield* Effect.gen(function*() {
        const subject = (yield* (yield* RecordStore).subjectFor((yield* identifyRepo(repo))!, { create: true }))!
        const g = buildGraph([
          readRecord("Write 41 to answer.txt", "write an answer", [step("write the answer file", "asked", ["answer.txt"]), step("run the tests", "needed")], {
            subject: subject.id,
            flag: true,
            lessons: [flagLesson("run the tests")]
          })
        ], { tenant: home.tenant })
        const memory = yield* MemoryStore
        yield* memory.commit((yield* memory.propose(diffGraphs(emptyGraph, g), { rationale: "test", records: [] })).id)
        return g.kinds[0]
      }).pipe(Effect.provide(Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonMemoryStore.layer(join(home.tenantDir, "memory"), home.tenant)
      )))
    }))

  it("hands memory over through the hooks during the run, and counts the route's model call", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const claudeHome = join(root, "claude-home")
    const homeDir = join(root, "memory-home")
    const answers = join(root, "answers.json")
    await withEnv({
      CLAUDE_CONFIG_DIR: claudeHome,
      SINGULARITY_WORKSPACES: join(root, "workspaces"),
      FAKE_CLAUDE_ANSWERS: answers,
      FAKE_CLAUDE_BASH: "yarn test:update --watch=false"
    }, async () => {
      const kind = await seedHome(homeDir, repo)
      const route = kind.route.map((e) => e.step)
      writeFileSync(answers, JSON.stringify([{ kind: kind.id, why: "same task", steps: route.map((id) => ({ id, why: "needed", applies: true })) }]))
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const setup = await run(makeSetup("hooks", homeDir, true, { selector: { claude: FAKE_CLAUDE, cwd: join(root, "llm"), model: "sonnet" } }))
      const out = join(root, "out")
      const [r] = (await run(
        runSuite(suite, setup, out, FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] })
      )) as Array<Record<string, any>>
      const runDir = join(out, "runs", r.run_id)
      assert.isTrue(r.success)

      // The hooks ran in the agent's session, against the run's own copy of the home.
      const seen = seenByAgent(claudeHome, r.session_id)
      // Hooks installed for daily work stay off; the run's own fire, marked by the flag.
      assert.strictEqual(seen.env.SINGULARITY_HOOKS, "off")
      assert.strictEqual(seen.env.SINGULARITY_HOME, join(runDir, "memory-home"))
      assert.include(seen.args, "--settings")
      const said = (event: string): Array<string> =>
        seen.hook_outputs.filter((o) => o.event === event && o.stdout !== "").map((o) => JSON.parse(o.stdout).hookSpecificOutput.additionalContext)
      // The route at the first prompt; the warning once its trigger appeared, and only then.
      assert.include(said("UserPromptSubmit")[0], "**write the answer file**")
      assert.deepStrictEqual(said("PostToolUse").length, 1)
      assert.include(said("PostToolUse")[0], "--watch=false")

      // The run's record says what was handed over, and the route's model call ($0.01 and 150 tokens) counts toward it.
      assert.deepStrictEqual([r.injection.task_start, r.injection.kind, r.injection.nodes, r.injection.hook_errors], [true, kind.id, route, 0])
      assert.deepStrictEqual(r.injection.fired.map((f: { tool: string }) => f.tool), ["Bash"])
      assert.strictEqual(r.injection.version, 1)
      assert.strictEqual(runKind(r), "similar task")
      assert.include(readFileSync(join(runDir, "injected.md"), "utf-8"), "**write the answer file**")
      assert.strictEqual(r.memory_spent.cost_usd, 0.01)
      assert.strictEqual(r.memory_spent.tokens.total, 150)
      assert.closeTo(r.cost_usd, 0.0123 + 0.01, 1e-9)
      assert.strictEqual(r.tokens.total, 1360 + 150)

      // The home is as it was; the run's copy keeps only what the session wrote.
      const tenant = (home: string) => join(home, "tenants", "local")
      assert.isFalse(existsSync(join(tenant(homeDir), "sessions")))
      assert.isFalse(existsSync(join(tenant(homeDir), "handovers.jsonl")))
      assert.isTrue(existsSync(join(tenant(join(runDir, "memory-home")), "handovers.jsonl")))
      assert.isFalse(existsSync(join(tenant(join(runDir, "memory-home")), "memory")))
    })
  }, 60_000)

  it("runs next to hooks installed for daily work, which stay silent, so memory is handed over once", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const claudeHome = join(root, "claude-home")
    const homeDir = join(root, "memory-home")
    const answers = join(root, "answers.json")
    mkdirSync(claudeHome)
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(withOurHooks({}, process.execPath, HOOK_SCRIPT)))
    await withEnv({
      CLAUDE_CONFIG_DIR: claudeHome,
      SINGULARITY_WORKSPACES: join(root, "workspaces"),
      FAKE_CLAUDE_ANSWERS: answers,
      FAKE_CLAUDE_BASH: "yarn test:update --watch=false"
    }, async () => {
      const kind = await seedHome(homeDir, repo)
      writeFileSync(answers, JSON.stringify([{ kind: kind.id, why: "same task", steps: kind.route.map((e) => ({ id: e.step, why: "needed", applies: true })) }]))
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const setup = await run(makeSetup("hooks", homeDir, true, { selector: { claude: FAKE_CLAUDE, cwd: join(root, "llm"), model: "sonnet" } }))
      const [r] = (await run(
        runSuite(suite, setup, join(root, "out"), FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] })
      )) as Array<Record<string, any>>
      assert.isTrue(r.success)
      const seen = seenByAgent(claudeHome, r.session_id)
      const ran = (event: string) => seen.hook_outputs.filter((o) => o.event === event)
      // Both copies ran at each event; only the run's own said anything.
      assert.strictEqual(ran("UserPromptSubmit").length, 2)
      assert.strictEqual(ran("UserPromptSubmit").filter((o) => o.stdout !== "").length, 1)
      assert.strictEqual(ran("PostToolUse").filter((o) => o.stdout !== "").length, 1)
      assert.strictEqual(r.injection.hook_errors, 0)
    })
  }, 60_000)
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
