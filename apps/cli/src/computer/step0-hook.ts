/**
 * Step 0 of computer-use memory (docs/research/computer-use-design/build.md):
 * a hook that only logs. `computer-use step0 on` (Step0.ts) puts it in
 * Claude Code's settings for every MCP tool (`mcp__.*`), after calls and
 * after failed ones, and `step0 off` takes it out.
 *
 *     node src/computer/step0-hook.ts
 *
 * For each call, a line in `<home>/step0/calls.jsonl`: the tool, the sizes
 * of its input and answer, the answer's shape (a string, or blocks and their
 * types), whether it held an image, and what a reader of screens would need
 * from it: a page address, controls tagged with refs, field states, clicks
 * at a point. The first three answers of each tool are kept whole, images
 * left out, in `<home>/step0/samples/`. It never fails the session: errors
 * go to `hook-errors.log`, and it prints nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const home = () => process.env.SINGULARITY_HOME || join(homedir(), ".singularity")

const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf-8")
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** An answer's text, with each image as `[image]`: a string, MCP content blocks, or `{ content: [...] }`. */
const textOf = (response: unknown): { text: string; kind: string; blocks: Array<string> } => {
  if (typeof response === "string") return { text: response, kind: "string", blocks: [] }
  const list = Array.isArray(response) ? response : isObject(response) && Array.isArray(response.content) ? response.content : undefined
  if (list === undefined) return { text: JSON.stringify(response) ?? "", kind: typeof response, blocks: [] }
  const blocks: Array<string> = []
  const parts: Array<string> = []
  for (const b of list) {
    const type = isObject(b) && typeof b.type === "string" ? b.type : typeof b
    blocks.push(type)
    if (isObject(b) && typeof b.text === "string") parts.push(b.text)
    else if (type === "image") parts.push("[image]")
  }
  return { text: parts.join("\n"), kind: Array.isArray(response) ? "blocks" : "object.content", blocks }
}

/** The input with long strings cut and anything like base64 left out. */
const shrink = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}… (${v.length} chars)` : v
  if (Array.isArray(v)) return v.slice(0, 20).map(shrink)
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" && x.length > 2000 ? `(${x.length} chars)` : shrink(x)]))
  return v
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length

const started = Date.now()
try {
  const stdin = await readStdin()
  const input = JSON.parse(stdin) as Json
  const tool = typeof input.tool_name === "string" ? input.tool_name : ""
  if (tool.startsWith("mcp__")) {
    const dir = join(home(), "step0")
    mkdirSync(join(dir, "samples"), { recursive: true })
    const toolInput = isObject(input.tool_input) ? input.tool_input : {}
    const answer = input.tool_response !== undefined ? textOf(input.tool_response) : { text: String(input.error ?? ""), kind: "error", blocks: [] }
    const t = answer.text
    const url = /Page URL: (\S+)/.exec(t)?.[1] ?? /\bhttps?:\/\/[^\s"'<>)\]]+/.exec(t)?.[0]
    const line = {
      at: new Date().toISOString(),
      event: input.hook_event_name,
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      cwd: input.cwd,
      tool,
      stdin_bytes: stdin.length,
      input_bytes: JSON.stringify(toolInput).length,
      input: shrink(toolInput),
      answer_kind: answer.kind,
      answer_blocks: answer.blocks,
      answer_chars: t.length,
      has_image: answer.blocks.includes("image") || /"type"\s*:\s*"image"/.test(stdin),
      url: url ?? null,
      refs_playwright: count(t, /\[ref=[^\]]+\]/g),
      refs_underscore: count(t, /\bref_\d+\b/g),
      roles: count(t, /^\s*-\s*(?:button|link|checkbox|radio|combobox|textbox|tab|menuitem|option)\b/gm),
      checked: count(t, /\[checked(?:=[^\]]*)?\]|\bchecked\b/gi),
      selected: count(t, /\[selected\]|\bselected\b/gi),
      click_at_point: Array.isArray(toolInput.coordinate) || (Array.isArray(toolInput.actions) && JSON.stringify(toolInput.actions).includes("coordinate")),
      click_by_ref: typeof toolInput.ref === "string" || typeof toolInput.target === "string",
      error: typeof input.error === "string" ? input.error.slice(0, 300) : null,
      hook_ms: Date.now() - started
    }
    appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(line) + "\n")
    const safe = tool.replace(/[^A-Za-z0-9_.-]+/g, "_")
    const kept = readdirSync(join(dir, "samples")).filter((f) => f.startsWith(`${safe}.`)).length
    if (kept < 3) {
      const file = join(dir, "samples", `${safe}.${kept + 1}.txt`)
      if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(shrink(toolInput), null, 2)}\n---- answer (${answer.kind}${answer.blocks.length > 0 ? `: ${answer.blocks.join(", ")}` : ""}) ----\n${t}\n`)
    }
  }
} catch (error) {
  try {
    mkdirSync(home(), { recursive: true })
    appendFileSync(join(home(), "hook-errors.log"), `${new Date().toISOString()} step0: ${error instanceof Error ? error.message : String(error)}\n`)
  } catch {
    // Nowhere to report it.
  }
}
process.exitCode = 0
