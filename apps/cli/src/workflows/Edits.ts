/**
 * What a run did to the code, from its diff: blocks it added, lines it changed
 * or removed, files it created, and test snapshots it regenerated. Each edit
 * knows where it sits in the file as it was before (Places.ts), which is how
 * memory learns where a kind of change goes without keeping the run's lines.
 */
import { diffFiles, isSnapshot } from "../records/Extract.ts"
import { indentOf, type PlaceShape, placeOfAddition, placeOfLine } from "./Places.ts"

export interface Edit {
  readonly file: string
  readonly kind: "add" | "change" | "remove"
  /**
   * Adds: the number of the last line before the block (from 1; 0 at the top).
   * Changes and removals: the first line changed (from 0), in the file before.
   */
  readonly at: number
  /** How far the block's first line that isn't blank is indented (adds), or the first changed line (changes). */
  readonly indent: number
  readonly added: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

export interface Created {
  readonly file: string
  readonly content: string
}

export interface DiffEdits {
  readonly edits: ReadonlyArray<Edit>
  readonly created: ReadonlyArray<Created>
  readonly deleted: ReadonlyArray<string>
  /** Test snapshots the run's change regenerated. */
  readonly snapshots: ReadonlyArray<string>
}

const NOT_TEXT = /^(GIT binary patch|Binary files)/

/** The edits in a git diff. */
export const editsOfDiff = (diff: string): DiffEdits => {
  const edits: Array<Edit> = []
  const created: Array<Created> = []
  const deleted: Array<string> = []
  const snapshots: Array<string> = []
  for (const { path, lines } of diffFiles(diff)) {
    if (isSnapshot(path)) {
      snapshots.push(path)
      continue
    }
    const firstHunk = lines.findIndex((l) => l.startsWith("@@"))
    const head = lines.slice(0, firstHunk < 0 ? lines.length : firstHunk)
    if (head.some((l) => NOT_TEXT.test(l))) continue
    if (head.some((l) => l.startsWith("deleted file mode"))) {
      deleted.push(path)
      continue
    }
    if (head.some((l) => l.startsWith("new file mode"))) {
      const content = lines.slice(Math.max(0, firstHunk)).filter((l) => l.startsWith("+")).map((l) => l.slice(1))
      created.push({ file: path, content: content.join("\n") })
      continue
    }
    if (firstHunk < 0) continue
    let base = 0
    let run: { at: number; added: Array<string>; removed: Array<string>; firstRemoved: number; indent: number } | undefined
    const close = () => {
      if (run === undefined) return
      if (run.removed.length === 0) {
        edits.push({ file: path, kind: "add", at: run.at, indent: Math.max(0, run.indent), added: run.added, removed: [] })
      } else {
        const removedIndent = indentOf(run.removed.find((l) => l.trim() !== "") ?? "")
        edits.push({
          file: path,
          kind: run.added.length === 0 ? "remove" : "change",
          at: run.firstRemoved,
          indent: removedIndent,
          added: run.added,
          removed: run.removed
        })
      }
      run = undefined
    }
    for (const l of lines.slice(firstHunk)) {
      const header = /^@@ -(\d+)/.exec(l)
      if (header !== null) {
        close()
        // A hunk header gives the line it starts at; with no lines before it (`-0,0`), that is 0.
        base = Math.max(0, Number(header[1]) - 1)
        if (/^@@ -0,0 /.test(l)) base = 0
        continue
      }
      if (l.startsWith("\\")) continue
      const tag = l[0]
      if (tag === "+" || tag === "-") {
        if (run === undefined) run = { at: base, added: [], removed: [], firstRemoved: base, indent: -1 }
        if (tag === "+") {
          run.added.push(l.slice(1))
          if (run.indent < 0 && l.slice(1).trim() !== "") run.indent = indentOf(l.slice(1))
        } else {
          if (run.removed.length === 0) run.firstRemoved = base
          run.removed.push(l.slice(1))
          base++
        }
      } else {
        close()
        base++
      }
    }
    close()
  }
  return { edits, created, deleted, snapshots }
}

/** Where an edit sits in the file before the change, `lines`. */
export const placeOfEdit = (lines: ReadonlyArray<string>, edit: Edit): PlaceShape =>
  edit.kind === "add"
    ? placeOfAddition(edit.file, lines, edit.at, edit.indent)
    : placeOfLine(edit.file, lines, Math.min(edit.at, Math.max(0, lines.length - 1)))
