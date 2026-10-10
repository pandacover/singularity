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
 *   Codex does when a plan's limit is reached.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
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

console.error(`fake codex: no such command: ${args.join(" ")}`)
process.exit(2)
