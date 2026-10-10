/**
 * Stands in for `codex` in tests of learning through Codex (CodexLlm.ts).
 *
 * - `features list`: a few of Codex's features, one of them removed.
 * - `mcp list --json`: a server from the user's config, one switched off
 *   already, and one a plugin brings, unless plugins are disabled.
 * - `exec`: answers with the next entry of the JSON array in
 *   $FAKE_CODEX_ANSWERS (the last one repeats), written to the
 *   --output-last-message file, and prints the events `--json` prints, with
 *   usage. Each call is recorded as `<that file>.call<n>.json`: its
 *   arguments, the instructions file's text, the schema, the prompt and the
 *   environment's SINGULARITY_HOOKS. With $FAKE_CODEX_FAIL it fails the way
 *   Codex does when a plan's limit is reached; with $FAKE_CODEX_REFUSE, the
 *   way a ChatGPT plan refuses that model (the call's `--model`, else the
 *   one in $CODEX_HOME/config.toml).
 * - `app-server`: JSON-RPC on stdin and stdout, as long as stdin is open.
 *   `hooks/list` lists the hooks in the Codex home's hooks.json, each with
 *   the hash of its settings and whether trust.json holds that hash;
 *   `config/value/write` to `hooks.state` merges into trust.json. With
 *   $FAKE_CODEX_NO_APP_SERVER it is a Codex without one. The Codex home is
 *   $CODEX_HOME only, never the real one.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
// Never the real ~/.codex: without CODEX_HOME there is no Codex home.
const codexHome = process.env.CODEX_HOME ?? join("/nonexistent", "codex-home")
const value = (flag: string) => args[args.indexOf(flag) + 1]
const disabled = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []))
const configs = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []))
const config = (key: string) => configs.find((c) => c.startsWith(`${key}=`))?.slice(key.length + 1)
const event = (e: Record<string, unknown>) => console.log(JSON.stringify(e))

if (args[0] === "exec") {
  const file = process.env.FAKE_CODEX_ANSWERS!
  const answers: Array<unknown> = JSON.parse(readFileSync(file, "utf-8"))
  const counter = `${file}.calls`
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf-8")) : 0
  writeFileSync(counter, String(n + 1))
  const instructions = config("model_instructions_file")
  writeFileSync(`${file}.call${n}.json`, JSON.stringify({
    args,
    cwd: process.cwd(),
    system: instructions === undefined ? null : readFileSync(JSON.parse(instructions), "utf-8"),
    schema: JSON.parse(readFileSync(value("--output-schema"), "utf-8")),
    prompt: readFileSync(0, "utf-8"),
    hooks: process.env.SINGULARITY_HOOKS ?? null
  }))
  event({ type: "thread.started", thread_id: "thread-1" })
  event({ type: "turn.started" })
  if (process.env.FAKE_CODEX_FAIL) {
    event({ type: "turn.failed", error: { message: "You've hit your usage limit." } })
    process.exit(1)
  }
  const configText = existsSync(join(codexHome, "config.toml")) ? readFileSync(join(codexHome, "config.toml"), "utf-8") : ""
  const model = args.includes("--model") ? value("--model") : configText.match(/^model\s*=\s*"([^"]*)"/m)?.[1]
  if (process.env.FAKE_CODEX_REFUSE !== undefined && model === process.env.FAKE_CODEX_REFUSE) {
    const refusal = { type: "error", status: 400, error: { type: "invalid_request_error", message: `The '${model}' model is not supported when using Codex with a ChatGPT account.` } }
    event({ type: "error", message: JSON.stringify(refusal) })
    event({ type: "turn.failed", error: { message: JSON.stringify(refusal) } })
    process.exit(1)
  }
  const answer = JSON.stringify(answers[Math.min(n, answers.length - 1)])
  writeFileSync(value("--output-last-message"), answer)
  event({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: answer } })
  event({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 } })
  process.exit(0)
}

if (args[0] === "features" && args[1] === "list") {
  console.log([
    "hooks                                    stable             true",
    "js_repl                                  removed            false",
    "plugins                                  stable             true",
    "shell_tool                               stable             true"
  ].join("\n"))
  process.exit(0)
}

if (args.includes("mcp") && args.includes("list")) {
  const servers = [
    { name: "docs", enabled: true },
    { name: "off-already", enabled: false },
    ...(disabled.includes("plugins") ? [] : [{ name: "plugin-tools", enabled: true }])
  ]
  console.log(JSON.stringify(servers.map((s) => ({ ...s, transport: { type: "stdio", command: "x" } })), null, 2))
  process.exit(0)
}

if (args[0] === "app-server" && !process.env.FAKE_CODEX_NO_APP_SERVER) {
  const snake = (event: string) => event.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, "")
  const trustFile = join(codexHome, "trust.json")
  const trust = (): Record<string, { trusted_hash: string }> => (existsSync(trustFile) ? JSON.parse(readFileSync(trustFile, "utf-8")) : {})
  const hooks = () => {
    const file = join(codexHome, "hooks.json")
    if (!existsSync(file)) return []
    const events: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> = JSON.parse(readFileSync(file, "utf-8")).hooks ?? {}
    return Object.entries(events).flatMap(([event, groups]) =>
      groups.flatMap((group, i) =>
        group.hooks.map((handler, j) => {
          const key = `${file}:${snake(event)}:${i}:${j}`
          const hash = `sha256:${createHash("sha256").update(JSON.stringify({ event, matcher: group.matcher, handler })).digest("hex")}`
          const eventName = event.charAt(0).toLowerCase() + event.slice(1)
          return { key, eventName, command: handler.command, currentHash: hash, trustStatus: trust()[key]?.trusted_hash === hash ? "trusted" : "untrusted" }
        })
      )
    )
  }
  const reply = (id: number, result: unknown) => console.log(JSON.stringify({ id, result }))
  createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
    if (msg.id === undefined) return
    if (msg.method === "initialize") return reply(msg.id, { userAgent: "fake" })
    if (msg.method === "hooks/list") return reply(msg.id, { data: [{ cwd: "x", hooks: hooks(), warnings: [], errors: [] }] })
    if (msg.method === "config/value/write" && msg.params?.keyPath === "hooks.state" && msg.params.mergeStrategy === "upsert") {
      writeFileSync(trustFile, JSON.stringify({ ...trust(), ...(msg.params.value as object) }))
      return reply(msg.id, { status: "ok" })
    }
    console.log(JSON.stringify({ id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } }))
  })
} else {
  console.error(`fake codex: no such command: ${args.join(" ")}`)
  process.exit(2)
}
