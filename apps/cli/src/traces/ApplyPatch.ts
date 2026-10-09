/**
 * Patches in the format Codex's `apply_patch` takes (and Hermes Agent's
 * `patch` tool in its patch mode), read as the edits Claude Code's tools
 * would have made: a file added is a Write, each hunk of a file updated is an
 * Edit from the hunk's old lines to its new ones.
 *
 *     *** Begin Patch
 *     *** Add File: a.ts
 *     +line
 *     *** Update File: b.ts
 *     *** Move to: c.ts
 *     @@ optional context
 *      context
 *     -removed
 *     +added
 *     *** Delete File: d.ts
 *     *** End Patch
 *
 * Deletions and moves aren't edits Claude Code's tools make; the run's diff
 * has them.
 */

export interface PatchEdit {
  readonly tool: "Write" | "Edit"
  readonly file: string
  readonly input: Readonly<Record<string, unknown>>
}

const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/

/** The edits a patch makes, in order; none for text that isn't a patch. */
export const patchEdits = (patch: string): Array<PatchEdit> => {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n")
  const out: Array<PatchEdit> = []
  let i = 0
  while (i < lines.length) {
    const m = header.exec(lines[i].trim())
    i++
    if (m === null) continue
    const [, kind, raw] = m
    const file = raw.trim()
    const body: Array<string> = []
    while (i < lines.length && !header.test(lines[i].trim()) && lines[i].trim() !== "*** End Patch") body.push(lines[i++])
    // The newline that ends the patch's text isn't a line of context.
    while (body.at(-1) === "") body.pop()
    if (kind === "Add") {
      const content = body.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n")
      out.push({ tool: "Write", file, input: { file_path: file, content: content === "" ? "" : `${content}\n` } })
    } else if (kind === "Update") {
      for (const hunk of hunks(body)) out.push({ tool: "Edit", file, input: { file_path: file, old_string: hunk.old, new_string: hunk.new } })
    }
  }
  return out
}

/** An update's hunks: the lines each had before and after, context in both. */
const hunks = (body: ReadonlyArray<string>): Array<{ readonly old: string; readonly new: string }> => {
  const out: Array<{ old: string; new: string }> = []
  let before: Array<string> = []
  let after: Array<string> = []
  let changed = false
  const flush = () => {
    if (changed) out.push({ old: before.join("\n"), new: after.join("\n") })
    before = []
    after = []
    changed = false
  }
  for (const line of body) {
    if (line.startsWith("@@")) flush()
    else if (line.startsWith("*** ")) continue // Move to, End of File
    else if (line.startsWith("-")) {
      before.push(line.slice(1))
      changed = true
    } else if (line.startsWith("+")) {
      after.push(line.slice(1))
      changed = true
    } else {
      const context = line.startsWith(" ") ? line.slice(1) : line
      before.push(context)
      after.push(context)
    }
  }
  flush()
  return out
}
