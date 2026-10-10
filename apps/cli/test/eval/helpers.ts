import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Run an effect with Node services and a fresh view of the environment.
 * Effect's default config provider copies process.env once, but tests point
 * CLAUDE_CONFIG_DIR at a new directory each time.
 */
export const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(Layer.suspend(() => ConfigProvider.layer(ConfigProvider.fromEnv())))
    )
  )

export const FAKE_CLAUDE = [process.execPath, fileURLToPath(new URL("./fixtures/fake-claude.ts", import.meta.url))]

export const tempDir = (): string => mkdtempSync(join(tmpdir(), "singularity-test-"))

export const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf-8" }).trim()

/** A source repo with two commits: app.txt is "v1", then "v2". node_modules is ignored. */
export const makeRepo = (root: string): string => {
  const path = join(root, "src-repo")
  mkdirSync(path)
  git(path, "init", "-q")
  writeFileSync(join(path, ".gitignore"), "node_modules/\n")
  writeFileSync(join(path, "app.txt"), "v1\n")
  git(path, "add", ".")
  git(path, "commit", "-qm", "one")
  writeFileSync(join(path, "app.txt"), "v2\n")
  git(path, "commit", "-qam", "two")
  return path
}

/** A suite with task t1 (write 42 to answer.txt, checked by a hidden script) and t2 (no checks). */
export const writeSuite = (root: string, repo: string, body = ""): string => {
  mkdirSync(join(root, "hidden", "t1"), { recursive: true })
  writeFileSync(
    join(root, "hidden", "t1", "check_answer.mjs"),
    `import { readFileSync } from "node:fs"\nprocess.exit(readFileSync("answer.txt", "utf-8").trim() === "42" ? 0 : 1)\n`
  )
  const node = process.execPath.replace(/\\/g, "/")
  const path = join(root, "suite.toml")
  writeFileSync(
    path,
    `
name = "unit"
repo = "${repo.replace(/\\/g, "/")}"
base = "HEAD~1"
${body}
[agent]
model = "haiku"
max_budget_usd = 0.25

[[tasks]]
id = "t1"
family = "f"
prompt = "  Write 42 to answer.txt  "
checks = ['"${node}" check_answer.mjs']
check_files = "hidden/t1"

[[tasks]]
id = "t2"
base = "HEAD"
prompt = "Do nothing"
`
  )
  return path
}

/** What the fake claude recorded about the environment it ran in, and what its hooks printed. */
export const seenByAgent = (
  claudeHome: string,
  sessionId: string
): { args: Array<string>; env: Record<string, string>; hook_outputs: Array<{ event: string; stdout: string }> } => {
  const projects = join(claudeHome, "projects")
  for (const dir of readdirSync(projects)) {
    try {
      return JSON.parse(readFileSync(join(projects, dir, `${sessionId}.env.json`), "utf-8"))
    } catch {
      // not in this project
    }
  }
  throw new Error(`no env record for ${sessionId}`)
}

/** Set environment variables for the duration of `f`. */
export const withEnv = async <A>(vars: Record<string, string>, f: () => Promise<A>): Promise<A> => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await f()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
