// Hidden check for the "stats-shortcut-k" task: the prompt asks for a test in
// excalidraw.test.tsx. Require that the file gained a test case that presses K
// and looks at the stats panel. Whether that test passes is the vitest check's job.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const FILE = "packages/excalidraw/tests/excalidraw.test.tsx"
// The suite's base commit, not HEAD, in case the agent committed its work.
const BASE = "84e3f5a4"
const before = execFileSync("git", ["show", `${BASE}:${FILE}`], { encoding: "utf8" })
const after = readFileSync(FILE, "utf8")
const added = execFileSync("git", ["diff", BASE, "--", FILE], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .join("\n")

const testCases = (text) => (text.match(/(^|[^\w.])(it|test)(\.each\([^)]*\))?\s*\(/gm) ?? []).length
const problems = []
if (testCases(after) <= testCases(before)) problems.push(`no new test case in ${FILE}`)
if (!/stats/i.test(added)) problems.push("the added lines never mention the stats panel")
if (!/CODES\.K\b|KEYS\.K\b|KeyK|["'][kK]["']/.test(added)) problems.push("the added lines never press K")

if (problems.length > 0) {
  console.error(`agent test check failed: ${problems.join("; ")}`)
  process.exit(1)
}
console.log(`agent test check passed: ${FILE} gained a stats test that presses K`)
