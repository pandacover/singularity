/**
 * The Claude desktop server's entry point (Proxy.ts), which setup registers in
 * Claude desktop's config as `singularity-browser`:
 *
 *     node src/computer/server.ts [-- COMMAND ARGS...]
 *
 * It starts Playwright MCP as its child (by default `npx -y
 * @playwright/mcp@0.0.83 --browser chrome --isolated`, pinned: its answers'
 * shape changes between versions), with an output folder of its own in the
 * system's temp folder, emptied when the server starts and stops: Playwright
 * writes each page's snapshot there. Messages are a line each on stdin and
 * stdout, which carries nothing else.
 *
 * `SINGULARITY_HANDOVER=off` keeps capture and hands nothing over (an eval's
 * no-memory arm: the same tools, memory the only switch). Like a hook, it
 * never breaks the app it serves: errors go to `<home>/hook-errors.log`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { loadHome } from "../local/Home.ts"
import { makeProxy } from "./Proxy.ts"

export const PLAYWRIGHT_MCP = ["npx", "-y", "@playwright/mcp@0.0.83", "--browser", "chrome", "--isolated"]

/**
 * npx as npm's own script, run by this node: no shell (npx is a .cmd on
 * Windows), and no other node picked up from PATH. Other commands stay as given.
 */
const withoutShell = (command: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (command[0] !== "npx") return command
  const dir = dirname(process.execPath)
  const cli = [join(dir, "node_modules", "npm", "bin", "npx-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js")].find((f) => existsSync(f))
  return cli === undefined ? command : [process.execPath, cli, ...command.slice(1)]
}

/** One word of a Windows command line, quoted when it holds spaces or quotes. */
const quoted = (word: string) => (/[\s"]/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word)

const home = () => process.env.SINGULARITY_HOME || join(homedir(), ".singularity")

const logError = (error: unknown) => {
  try {
    mkdirSync(home(), { recursive: true })
    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
    appendFileSync(join(home(), "hook-errors.log"), `${new Date().toISOString()} computer server: ${text}\n`)
  } catch {
    // Nowhere to report it.
  }
}

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const main = async () => {
  const { tenantDir, root } = await run(loadHome())
  const dash = process.argv.indexOf("--")
  const command = dash === -1 ? PLAYWRIGHT_MCP : process.argv.slice(dash + 1)
  // The child runs in the temp folder, not in its output folder, which Windows won't delete while it is a process's folder.
  const outputDir = join(tmpdir(), `singularity-browser-${process.pid}`)
  const empty = () => {
    try {
      rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (e) {
      logError(e)
    }
  }
  empty()
  mkdirSync(outputDir, { recursive: true })
  const [file, ...args] = withoutShell([...command, "--output-dir", outputDir])
  // A script other than npx on Windows (a .cmd) still needs a shell: given one command line, quoted here.
  const shell = process.platform === "win32" && !/\.exe$/i.test(file)
  const child = spawn(shell ? [file, ...args].map(quoted).join(" ") : file, shell ? [] : args, {
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "inherit"],
    shell,
    windowsHide: true
  })
  const step0 = existsSync(join(root, "step0"))
  const proxy = makeProxy({
    toClient: (line) => process.stdout.write(`${line}\n`),
    toChild: (line) => child.stdin.write(`${line}\n`),
    run: (effect) => run(effect).catch((e: unknown) => (logError(e), undefined)),
    tenantDir,
    childCwd: tmpdir(),
    now: () => Date.now(),
    processId: `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
    logMeta: step0
      ? (meta) => {
        try {
          appendFileSync(join(root, "step0", "proxy-meta.jsonl"), JSON.stringify({ at: new Date().toISOString(), meta: meta ?? null }) + "\n")
        } catch {
          // Step 0's log is a nicety.
        }
      }
      : undefined
  })
  const childLines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  childLines.on("line", (line) => {
    proxy.fromChild(line).catch((e: unknown) => {
      logError(e)
      process.stdout.write(`${line}\n`)
    })
  })
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await proxy.settle()
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r))
      child.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
    }
    empty()
    process.exit(0)
  }
  child.on("exit", (code) => {
    if (!closing) logError(new Error(`Playwright MCP exited (${code}): ${command.join(" ")}`))
    void shutdown()
  })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    try {
      proxy.fromClient(line)
    } catch (e) {
      logError(e)
    }
  })
  lines.on("close", () => void shutdown())
}

main().catch(logError)
