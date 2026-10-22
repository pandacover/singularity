/**
 * Facts (src/facts/): what records teach about checking a change and the
 * traps on the way, built at store time and looked up at a task's start, a
 * first read and a failure.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildFacts, type Fact, resolvePath, signalOf, trapOf } from "../../src/facts/Facts.ts"
import { writeFacts } from "../../src/facts/Index.ts"
import { cardFacts, factsAt, isLive, readIndex, rehome, renderCard, repoOf } from "../../src/facts/Lookup.ts"
import { filesReadBy } from "../../src/facts/Reads.ts"
import { buildRecord } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import type { Detour, WorkflowRecord } from "../../src/records/Models.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { tempDir } from "../eval/helpers.ts"
import { bash, type CallSpec, CWD, DIFF, session } from "../records/fixtures.ts"

const TEMP = "C:\\Users\\me\\AppData\\Local\\Temp"
const ENV = { TEMP }

const record = (o: { readonly session: string; readonly head: string; readonly at: string; readonly turns: ReadonlyArray<ReadonlyArray<CallSpec>> }): WorkflowRecord =>
  buildRecord({
    tenant: "local",
    subject: "app",
    trace: { ...session("Tidy the sidebar", o.turns), sessionId: o.session },
    diff: DIFF,
    outcome: "success",
    checks: [],
    memory: null,
    run: {
      source: "session",
      log: "session.jsonl",
      run_dir: null,
      run_id: null,
      setup: null,
      task_id: null,
      repo: CWD,
      base_commit: null,
      head_commit: o.head,
      segment: { from: null, to: o.at },
      started_at: o.at,
      cost_usd: null,
      tokens: 0
    },
    createdAt: o.at,
    id: `app-${o.head}`
  })

const TIMEOUT = "page.goto: Timeout 30000ms exceeded.\nname: 'TimeoutError'"

/** A session whose screenshot script timed out until the app was built and the variable unset; then its checks. */
const smoke = (out = "out"): Array<Array<CallSpec>> => [
  [bash(`node "$TEMP/ui/smoke.mjs" ${out}`, TIMEOUT, true)],
  [bash(`bun run build && unset ELECTRON_RUN_AS_NODE; node "$TEMP/ui/smoke.mjs" ${out}`, "PASS sidebar")],
  [bash("bun test", " 12 pass\n 0 fail")],
  [bash("bun run typecheck", "")]
]

const first = record({ session: "aaaaaaaa-0000-0000-0000-000000000001", head: "1111111111aa", at: "2026-10-01T10:00:00.000Z", turns: smoke() })
const second = record({ session: "bbbbbbbb-0000-0000-0000-000000000002", head: "2222222222bb", at: "2026-10-02T10:00:00.000Z", turns: smoke("out2") })

const build = (records: ReadonlyArray<WorkflowRecord>) => buildFacts(records, { subject: "app", env: ENV, now: "2026-10-03T00:00:00.000Z" })
const byKind = (facts: ReadonlyArray<Fact>, kind: Fact["kind"]) => facts.filter((f) => f.kind === kind)

describe("facts from records", () => {
  it("keeps a trap: what failed, and the commands that then worked besides it", () => {
    const [trap] = byKind(build([first]).facts, "trap")
    assert.strictEqual(trap.text, "`node \"$TEMP/ui/smoke.mjs\" out` failed: name: 'TimeoutError'. What worked: `bun run build`, then `unset ELECTRON_RUN_AS_NODE`.")
    assert.deepStrictEqual(trap.keys, ["node smoke.mjs"])
    assert.strictEqual(trap.signal, "name: 'TimeoutError'")
    assert.deepStrictEqual(trap.paths, ["C:/Users/me/AppData/Local/Temp/ui/smoke.mjs"])
    // The change's source and test files, not its snapshot.
    assert.deepStrictEqual(trap.files, ["img.png", "old.ts", "src/keys.ts", "src/new.ts"])
  })

  it("keeps the project's checks and a check script with what its line set up first", () => {
    const checks = byKind(build([first]).facts, "check")
    assert.deepStrictEqual(checks.filter((f) => f.project).map((f) => f.text).sort(), ["`bun run build`", "`bun run typecheck`", "`bun test`"])
    const script = checks.find((f) => !f.project)!
    assert.strictEqual(script.text, "`bun run build; unset ELECTRON_RUN_AS_NODE; node \"$TEMP/ui/smoke.mjs\" out`")
    assert.deepStrictEqual(script.package_scripts, ["build"])
    assert.deepStrictEqual(checks.find((f) => f.keys[0] === "bun typecheck")?.package_scripts, ["typecheck"])
  })

  it("counts a fact once a record, newest wording first, its commits newest first", () => {
    const index = build([second, first])
    const script = index.facts.find((f) => f.kind === "check" && !f.project)!
    assert.strictEqual(script.recurrence, 2)
    assert.include(script.text, "out2")
    assert.deepStrictEqual(script.commits, ["2222222222bb", "1111111111aa"])
    assert.deepStrictEqual(index.by_key["node smoke.mjs"]?.length, 2)
    assert.include(index.by_file["src/keys.ts"] ?? [], script.id)
  })

  it("retires a trap once a later record ran its failing command as it was, and it worked", () => {
    const later = record({
      session: "cccccccc-0000-0000-0000-000000000003",
      head: "3333333333cc",
      at: "2026-10-05T10:00:00.000Z",
      turns: [[bash(`node "$TEMP/ui/smoke.mjs" out`, "PASS sidebar")]]
    })
    const index = build([first, later])
    assert.deepStrictEqual(byKind(index.facts, "trap"), [])
    assert.strictEqual(index.retired, 1)
  })

  it("leaves out detours that teach nothing about the repo, and says why", () => {
    const d = first.detours[0]
    const call = (command: string | null, tool = "Bash") => ({ ...d.failed, tool, command })
    const as = (patch: Partial<Detour>) => trapOf(first, { ...d, ...patch }, ENV)
    assert.strictEqual(as({ fixed: call(null, "Edit") }), "fixed another way")
    assert.strictEqual(as({ kind: "test_failure" }), "failing tests")
    assert.strictEqual(as({ failed: call("python - <<'EOF'\nassert False\nEOF"), keys: ["python -"] }), "inline code")
    assert.strictEqual(as({ symptom: "bash: -c: line 3: unexpected EOF while looking for matching `''" }), "shell syntax")
    assert.strictEqual(as({ files_edited: ["src/keys.ts"] }), "code fix")
    assert.strictEqual(as({ fixed: call(`node "$TEMP/ui/smoke.mjs" out 2>&1 | tail -5`) }), "no other command")
  })

  it("leaves out a failure's paths, numbers and words any failure says", () => {
    assert.strictEqual(
      signalOf("test/chat.test.ts(1,51): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations."),
      "Cannot find module 'bun:test' or its corresponding type declarations."
    )
    assert.strictEqual(signalOf("Exit code 1"), null)
  })

  it("finds a typed path on this machine", () => {
    assert.strictEqual(resolvePath("$TEMP/ui/x.mjs", { TEMP: "C:\\T" }, undefined), "C:/T/ui/x.mjs")
    assert.strictEqual(resolvePath("%TEMP%\\ui\\x.mjs", { TEMP: "C:\\T" }, undefined), "C:/T/ui/x.mjs")
    assert.strictEqual(resolvePath("/tmp/x.mjs", { TEMP: "C:\\T" }, undefined), "C:/T/x.mjs")
    assert.strictEqual(resolvePath("/c/a/b.mjs", {}, undefined), "C:/a/b.mjs")
    assert.strictEqual(resolvePath("scripts/x.mjs", {}, "C:/work/repo"), "C:/work/repo/scripts/x.mjs")
    assert.strictEqual(resolvePath("$NOPE/x.mjs", {}, undefined), undefined)
  })
})

describe("facts at a moment", () => {
  const index = build([first])
  const other = { sessionId: "zzzzzzzz", given: new Set<string>(), live: () => true }

  it("picks at a task's start the project's checks, then the rest but traps", () => {
    const picked = factsAt(index, { kind: "start" }, other)
    assert.strictEqual(picked.project.length, 3)
    assert.deepStrictEqual(picked.facts.map((f) => f.kind), ["check"])
  })

  it("makes the card of check scripts run for two changes or more, each with the change it last checked", () => {
    // A script one change ran is a scratch script as often as a harness.
    assert.deepStrictEqual(cardFacts(index, other), [])
    const both = build([first, second])
    const card = cardFacts(both, other)
    assert.deepStrictEqual(card.map((f) => f.keys), [["node smoke.mjs"]])
    const { text, facts } = renderCard(card, (commit) => (commit === "2222222222bb" ? "Tidy the sidebar" : undefined))
    assert.deepStrictEqual(facts, card)
    assert.include(text, "# Check scripts earlier sessions here ran")
    assert.include(text, "- `bun run build; unset ELECTRON_RUN_AS_NODE; node \"$TEMP/ui/smoke.mjs\" out2` (2 changes, last 2222222222 \"Tidy the sidebar\")")
    assert.notInclude(text, "bun test")
    assert.deepStrictEqual(renderCard([], () => undefined), { text: undefined, facts: [] })
    // Given already, or only the session's own: no card.
    assert.deepStrictEqual(cardFacts(both, { ...other, given: new Set(card.map((f) => f.id)) }), [])
    assert.deepStrictEqual(cardFacts(both, { ...other, sessionId: first.run.session_id }).length, 1)
  })

  it("leads the card with the scripts of the change the task is pointed to, whatever their recurrence", () => {
    const header = record({
      session: "dddddddd-0000-0000-0000-000000000004",
      head: "4444444444dd",
      at: "2026-10-03T10:00:00.000Z",
      turns: [[bash(`cd "$TEMP/cv2-header" && bun run build && node shots.mjs out`, "PASS")]]
    })
    const both = build([first, second, header])
    const lead = cardFacts(both, other, "4444444444dd")
    assert.deepStrictEqual(lead.map((f) => f.paths), [["C:/Users/me/AppData/Local/Temp/cv2-header/shots.mjs"], ["C:/Users/me/AppData/Local/Temp/ui/smoke.mjs"]])
    // Not pointed to it: only the repo's scripts run for two changes or more.
    assert.deepStrictEqual(cardFacts(both, other).map((f) => f.paths), [["C:/Users/me/AppData/Local/Temp/ui/smoke.mjs"]])
  })

  it("tells scripts of one name in two folders apart", () => {
    const at = (head: string, folder: string, day: number) =>
      record({ session: `eeeeeeee-0000-0000-0000-00000000000${day}`, head, at: `2026-10-0${day}T10:00:00.000Z`, turns: [[bash(`cd "$TEMP/${folder}" && node shots.mjs out`, "PASS")]] })
    const index = build([at("5555555555ee", "cv2-header", 4), at("6666666666ee", "upd-ui", 5)])
    assert.deepStrictEqual(index.facts.filter((f) => f.kind === "check").map((f) => [f.recurrence, f.paths[0]]).sort(), [
      [1, "C:/Users/me/AppData/Local/Temp/cv2-header/shots.mjs"],
      [1, "C:/Users/me/AppData/Local/Temp/upd-ui/shots.mjs"]
    ])
  })

  it("says where a script is when its command names it only by its name", () => {
    const fact = { ...cardFacts(build([first, second]), other)[0], text: "`node smoke.mjs out`" }
    assert.include(renderCard([fact], () => undefined).text, "- `node smoke.mjs out` in C:/Users/me/AppData/Local/Temp/ui (2 changes")
  })

  it("gives a file's check scripts at its first read", () => {
    assert.deepStrictEqual(factsAt(index, { kind: "read", file: "src/keys.ts" }, other).facts.map((f) => f.kind), ["check"])
    assert.deepStrictEqual(factsAt(index, { kind: "read", file: "README.md" }, other).facts, [])
  })

  it("gives a failure the traps whose signal its output shows, of the same script or another", () => {
    const at = (keys: Array<string>, output: string) => factsAt(index, { kind: "fail", keys, output }, other).facts.map((f) => f.kind).sort()
    assert.deepStrictEqual(at(["node smoke.mjs"], TIMEOUT), ["check", "trap"])
    assert.deepStrictEqual(at(["node smoke.mjs"], "SyntaxError: Unexpected token"), ["check"])
    assert.deepStrictEqual(at(["node shots.mjs"], TIMEOUT), ["trap"])
    assert.deepStrictEqual(at(["bun test"], TIMEOUT), [])
  })

  it("gives a fact once a session, and none only the session itself taught", () => {
    const trap = byKind(index.facts, "trap")[0]
    const fail = { kind: "fail", keys: ["node smoke.mjs"], output: TIMEOUT } as const
    assert.deepStrictEqual(factsAt(index, fail, { ...other, given: new Set([trap.id]) }).facts.map((f) => f.kind), ["check"])
    assert.deepStrictEqual(factsAt(index, fail, { ...other, sessionId: first.run.session_id }).facts, [])
  })

  it("gives a fact only while its script is on disk and its package script in package.json", () => {
    const script = index.facts.find((f) => f.kind === "check" && !f.project)!
    assert.isFalse(isLive(script, "C:/work/repo", undefined, () => false))
    assert.isTrue(isLive(script, "C:/work/repo", new Set(["build"]), () => true))
    assert.isFalse(isLive(script, "C:/work/repo", new Set(["test"]), () => true))
  })
})

describe("looking facts up from a hook", () => {
  it("finds the repo a folder is in, the deepest checkout first", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "subjects.json"), JSON.stringify({ subjects: [{ id: "app", paths: ["C:/work/repo"] }, { id: "wt", paths: ["C:/work/repo/.wt/x"] }] }))
    assert.deepStrictEqual(repoOf(dir, "c:\\work\\repo\\src"), { subject: "app", root: "C:/work/repo" })
    assert.deepStrictEqual(repoOf(dir, "C:/work/repo/.wt/x/src"), { subject: "wt", root: "C:/work/repo/.wt/x" })
    assert.strictEqual(repoOf(dir, "C:/work/repository"), undefined)
  })

  it("names the checkout it is shown in, where a command named another checkout", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "subjects.json"), JSON.stringify({ subjects: [{ id: "app", paths: ["C:/work/repo", "C:/work/repo-wt"] }, { id: "other", paths: ["C:/work/lib"] }] }))
    const here = rehome(dir, "app", "D:/clone")
    assert.strictEqual(here("cd C:/work/repo && bun test"), "cd D:/clone && bun test")
    assert.strictEqual(here("node e2e.mjs \"C:\\work\\repo-wt\\out\""), "node e2e.mjs \"D:\\clone\\out\"")
    assert.strictEqual(here("ls /c/work/repo/src"), "ls /d/clone/src")
    // Another subject's checkout, and a path that only starts like one, stay.
    assert.strictEqual(here("cat C:/work/lib/a.ts C:/work/repository/b.ts"), "cat C:/work/lib/a.ts C:/work/repository/b.ts")
    assert.strictEqual(rehome(dir, "app", "C:/work/repo")("cd C:/work/repo"), "cd C:/work/repo")
    assert.strictEqual(rehome(dir, "app", "C:/a$&b")("cd C:/work/repo"), "cd C:/a$&b")
  })

  it("reads the files a shell command prints", () => {
    assert.deepStrictEqual(filesReadBy("sed -n '1,80p' src/a.ts"), ["src/a.ts"])
    assert.deepStrictEqual(filesReadBy("grep -n \"foo\" src/b.ts src/c.ts | head -5"), ["src/b.ts", "src/c.ts"])
    assert.deepStrictEqual(filesReadBy("cat src/a.ts && head -n 20 src/d.ts"), ["src/a.ts", "src/d.ts"])
    assert.deepStrictEqual(filesReadBy("sed -i 's/a/b/' src/a.ts"), [])
  })
})

const tenantLayer = (tenantDir: string) => JsonRecordStore.layer(tenantDir, "local")

describe("the fact index at store time", () => {
  it.effect("writes the repo's live facts, and only once when asked only if missing", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "facts-" })
      const tenantDir = path.join(dir, "tenants", "local")
      const temp = path.join(dir, "temp")
      mkdirSync(join(temp, "ui"), { recursive: true })
      writeFileSync(join(temp, "ui", "smoke.mjs"), "")
      const repo = path.join(dir, "repo")
      mkdirSync(repo)
      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "x", typecheck: "y" } }))
      yield* Effect.gen(function*() {
        yield* (yield* RecordStore).put(first)
        const written = yield* writeFacts(tenantDir, "app", repo, { env: { TEMP: temp } })
        assert.deepStrictEqual(written?.facts.map((f) => f.kind).sort(), ["check", "check", "check", "check", "trap"])
        const file = path.join(tenantDir, "facts", "app.json")
        assert.deepStrictEqual(readIndex(file)?.facts.length, 5)
        // The script gone: the facts that run it go with it.
        writeFileSync(file, "{}")
        assert.strictEqual(yield* writeFacts(tenantDir, "app", repo, { env: { TEMP: temp }, onlyIfMissing: true }), undefined)
        assert.strictEqual(readFileSync(file, "utf-8"), "{}")
        const without = yield* writeFacts(tenantDir, "app", repo, { env: { TEMP: path.join(dir, "elsewhere") } })
        assert.deepStrictEqual(without?.facts.map((f) => f.kind), ["check", "check", "check"])
      }).pipe(Effect.provide(tenantLayer(tenantDir)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reads a record's commands again from its log when they were cut short, once", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "facts-" })
      const tenantDir = path.join(dir, "tenants", "local")
      const temp = path.join(dir, "temp")
      mkdirSync(join(temp, "cv2-header"), { recursive: true })
      writeFileSync(join(temp, "cv2-header", "shots.mjs"), "")
      const repo = path.join(dir, "repo")
      mkdirSync(repo)
      // A session that wrote its screenshot script and ran it in one line, after a long heredoc.
      const code = Array.from({ length: 30 }, (_, i) => `const shot${i} = await page.screenshot()`).join("\n")
      const line = `mkdir -p "$TEMP/cv2-header" && cd "$TEMP/cv2-header" && cat > shots.mjs <<'EOF'\n${code}\nEOF\nnode shots.mjs out`
      const at = (s: number) => `2026-10-01T10:00:0${s}.000Z`
      const log = path.join(dir, "session.jsonl")
      const usage = { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }
      writeFileSync(log, [
        { type: "user", timestamp: at(0), cwd: repo, sessionId: "ffffffff", message: { role: "user", content: "Inset the chat header" } },
        { type: "assistant", timestamp: at(1), cwd: repo, message: { id: "m1", model: "claude-test", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: line } }], usage } },
        { type: "user", timestamp: at(2), cwd: repo, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "PASS", is_error: false }] } }
      ].map((l) => JSON.stringify(l)).join("\n") + "\n")
      // As records were stored before commands were cut at their code: 500 characters of the line.
      const old: WorkflowRecord = {
        ...first,
        run: { ...first.run, log, repo, segment: { from: null, to: at(3) } },
        commands: [{ command: line.slice(0, 500) + "...", keys: ["mkdir", "cat", "node shots.mjs"], ok: true, error: null, turn: 0 }],
        detours: []
      }
      assert.deepStrictEqual(buildFacts([old], { subject: "app", env: { TEMP: temp }, now: "" }).facts.filter((f) => f.kind === "check"), [])
      yield* Effect.gen(function*() {
        yield* (yield* RecordStore).put(old)
        const index = yield* writeFacts(tenantDir, "app", repo, { env: { TEMP: temp } })
        assert.deepStrictEqual(index?.facts.map((f) => f.paths), [[join(temp, "cv2-header", "shots.mjs").replace(/\\/g, "/")]])
        // Kept for the next build, the record itself as it was stored.
        assert.isTrue(yield* fs.exists(path.join(tenantDir, "facts", "commands", `${old.id}.json`)))
        assert.include((yield* (yield* RecordStore).get(old.id)).commands[0].command, "...")
      }).pipe(Effect.provide(tenantLayer(tenantDir)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

