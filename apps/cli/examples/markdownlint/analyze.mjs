// What each session of the markdownlint long task did, from its transcript:
// tool calls, the looking before the first edit, the commands it ran, what
// singularity handed over, and whether the agent reached for singularity.
//
//   node analyze.mjs --runs <dir with with/ and without/> [--json out.json]
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const { values: opts } = parseArgs({ options: { runs: { type: "string" }, json: { type: "string" } } })
if (!opts.runs) {
  console.error("usage: node analyze.mjs --runs <dir> [--json out.json]")
  process.exit(2)
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
// Agents here often write files from the shell: heredocs, sed -i, python or node scripts.
const SHELL_WRITE = /cat\s*>|>\s*["']?[\w./\-]+\.(m?js|cjs|md|json|jsonc|ya?ml|ts)|sed\s+-i|tee\s|open\([^)]*["'][wa]["']|\.write(File)?(Sync)?\(|Set-Content|Out-File|git\s+(apply|mv)|mv\s|cp\s/
// The singularity command or skill, not paths that happen to contain the word.
const SINGULARITY = /(^|[\s;&|(])singularity(\s|$)/
const LOOKS = new Set(["Read", "Grep", "Glob"])

const analyze = (file) => {
  const tools = {}
  const commands = []
  let firstEdit = null
  let calls = 0
  let looksBeforeEdit = 0
  let handoverChars = 0
  let handoverParts = 0
  const singularityUse = []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain) continue
    if (d.type === "attachment" && d.attachment?.type === "hook_additional_context") {
      for (const part of [d.attachment.content].flat()) {
        if (typeof part === "string") {
          handoverChars += part.length
          handoverParts++
        }
      }
    }
    if (d.type !== "assistant" || !Array.isArray(d.message?.content)) continue
    for (const item of d.message.content) {
      if (item.type !== "tool_use") continue
      calls++
      tools[item.name] = (tools[item.name] ?? 0) + 1
      const command0 = typeof item.input?.command === "string" ? item.input.command : ""
      const edits = EDITS.has(item.name) || ((item.name === "Bash" || item.name === "PowerShell") && SHELL_WRITE.test(command0))
      if (edits && firstEdit === null) firstEdit = calls
      if (firstEdit === null && (LOOKS.has(item.name) || item.name === "Bash" || item.name === "PowerShell")) looksBeforeEdit++
      const command = item.input?.command
      if (typeof command === "string") {
        commands.push(command.replace(/\s+/g, " ").slice(0, 160))
        if (SINGULARITY.test(command)) singularityUse.push(command.slice(0, 160))
      }
      if (item.name === "Skill" && /singularity/i.test(JSON.stringify(item.input))) singularityUse.push(`Skill ${JSON.stringify(item.input).slice(0, 120)}`)
    }
  }
  const count = (re) => commands.filter((c) => re.test(c)).length
  return {
    calls, tools, first_edit_at: firstEdit, looks_before_first_edit: looksBeforeEdit,
    handover_chars: handoverChars, handover_parts: handoverParts,
    npm_test: count(/npm (run )?test\b|node --test/),
    lint: count(/npm run lint|eslint/),
    builds: count(/build-config|build-docs|build-declaration|serial-config-docs/),
    update_snapshots: count(/update-snapshots|test-update-snapshots/),
    commits: count(/git (-c \S+ )*commit\b/),
    singularity: singularityUse,
    commands
  }
}

const out = {}
for (const arm of ["without", "with"]) {
  const dir = path.join(opts.runs, arm)
  if (!fs.existsSync(dir)) continue
  for (const task of fs.readdirSync(dir).filter((t) => /^t\d\d-/.test(t)).sort()) {
    const file = path.join(dir, task, "transcript.jsonl")
    if (!fs.existsSync(file)) continue
    const a = analyze(file)
    out[`${arm}/${task}`] = a
    console.log(`${arm.padEnd(7)} ${task.padEnd(26)} calls ${String(a.calls).padStart(3)}  first edit at ${String(a.first_edit_at ?? "-").padStart(3)}  looks before ${String(a.looks_before_first_edit).padStart(3)}  tests ${a.npm_test} lint ${a.lint} builds ${a.builds} snaps ${a.update_snapshots} commits ${a.commits}${a.handover_chars ? `  handover ${a.handover_chars} chars/${a.handover_parts}` : ""}${a.singularity.length ? `  SINGULARITY USED: ${a.singularity.join(" | ")}` : ""}`)
  }
}
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(out, null, 2) + "\n")
