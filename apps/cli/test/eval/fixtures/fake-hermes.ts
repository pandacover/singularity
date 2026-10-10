/**
 * Stands in for Hermes Agent's `hermes` in tests of learning through it
 * (HermesLlm.ts).
 *
 * `chat -Q --query-file - --format stream-json …` reads the prompt from
 * stdin and answers with the next entry of the JSON array in
 * $FAKE_HERMES_ANSWERS (strings, as a model writes them; the last one
 * repeats). It prints the stream-json events, ending with the result line,
 * and keeps the session in $HERMES_HOME/state.db with its cost, as Hermes
 * does. Each call is recorded as `<that file>.call<n>.json`: its arguments,
 * the system prompt it was given and the prompt.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const args = process.argv.slice(2)
const value = (flag: string) => args[args.indexOf(flag) + 1]
const event = (e: Record<string, unknown>) => console.log(JSON.stringify({ ...e, timestamp: 1 }))

if (args[0] !== "chat" || !args.includes("-Q") || value("--query-file") !== "-") {
  console.error(`fake hermes: not a single query: ${args.join(" ")}`)
  process.exit(2)
}

const file = process.env.FAKE_HERMES_ANSWERS!
const answers: Array<string> = JSON.parse(readFileSync(file, "utf-8"))
const counter = `${file}.calls`
const n = existsSync(counter) ? Number(readFileSync(counter, "utf-8")) : 0
writeFileSync(counter, String(n + 1))
const prompt = readFileSync(0, "utf-8")
writeFileSync(`${file}.call${n}.json`, JSON.stringify({ args, cwd: process.cwd(), system: process.env.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? null, prompt }))

const sessionId = `20261010_120000_${String(n).padStart(6, "0")}`
event({ type: "system", subtype: "init", model: "fake/model", session_id: sessionId })
const text = answers[Math.min(n, answers.length - 1)]
event({ type: "text", text })
const db = new DatabaseSync(join(process.env.HERMES_HOME!, "state.db"))
db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, cwd TEXT)")
db.prepare("INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens, estimated_cost_usd, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run(sessionId, value("--source") ?? "cli", "fake/model", 1_791_633_600, 500, 100, 0.02, process.cwd())
db.close()
event({
  type: "result",
  session_id: sessionId,
  exit_code: 0,
  text,
  tokens: { input: 500, output: 100, total: 600, cache_read: 0, cache_write: 0 },
  duration_ms: 1000
})
console.error(`\nsession_id: ${sessionId}`)
