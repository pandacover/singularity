/**
 * Finding memory's places in the code as it is: each in its file, by the
 * blocks around it (Places.ts); and when its file is gone or no longer has
 * it, in whatever files now have the outermost block's first line (or the
 * group's start), since code moves between files. A block's first line
 * (`export interface AppState {`) is distinctive enough to search a whole
 * repo for; a neighbouring line (`actionToggleZenMode,`) wouldn't be.
 *
 * Code is read from the working tree, or from a commit (previews, checks
 * against older code).
 */
import { Effect, FileSystem, Option, Path } from "effect"
import { fileAt, git } from "../local/Git.ts"
import { shapeOf } from "./Evidence.ts"
import type { Place } from "./Models.ts"
import { IMPORTS, type Region, resolvePlace } from "./Places.ts"

/** Where the code is read from: the working tree, or a commit (previews, checks against older code). */
export type CodeSource =
  | { readonly kind: "tree"; readonly root: string }
  | { readonly kind: "commit"; readonly repo: string; readonly commit: string }

/** A file next to where a new one goes, named alike, with its lines. */
export interface Sibling {
  readonly name: string
  readonly lines: ReadonlyArray<string>
}

/** A place as found: in its own file or one it moved to, or, for new files, the siblings they go next to. */
export type Located =
  | { readonly kind: "block"; readonly file: string; readonly lines: ReadonlyArray<string>; readonly region: Region; readonly moved: boolean }
  | { readonly kind: "new-file"; readonly dir: string; readonly prefix: string; readonly siblings: ReadonlyArray<Sibling> }

/** Whether a file or directory is in the code read from `source`. */
export const pathExists = Effect.fn("pathExists")(function*(source: CodeSource, file: string) {
  if (!inside(file)) return false
  if (source.kind === "commit") {
    return yield* git(source.repo, ["cat-file", "-e", `${source.commit}:${file}`]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.exists(path.join(source.root, file)).pipe(Effect.orElseSucceed(() => false))
})

/** Other files to look in when a place's own file no longer has it. */
const MAX_CANDIDATES = 5

const inside = (file: string) => file !== "" && !file.startsWith("/") && !/^[A-Za-z]:/.test(file) && !file.split(/[\\/]/).includes("..")

export const locatePlaces = Effect.fn("locatePlaces")(function*(source: CodeSource, places: ReadonlyArray<Place>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const texts = new Map<string, ReadonlyArray<string> | undefined>()
  const linesOf = Effect.fnUntraced(function*(file: string) {
    if (!inside(file)) return undefined
    if (!texts.has(file)) {
      const text = source.kind === "commit"
        ? yield* fileAt(source.repo, source.commit, file)
        : Option.getOrUndefined(yield* fs.readFileString(path.join(source.root, file)).pipe(Effect.option))?.replace(/\r\n?/g, "\n")
      texts.set(file, text?.split("\n"))
    }
    return texts.get(file)
  })
  const repo = source.kind === "commit" ? source.repo : source.root
  /** Files that contain `text`, by git (fixed string). */
  const filesWith = Effect.fnUntraced(function*(text: string) {
    const args = ["grep", "-l", "-F", "-e", text, ...(source.kind === "commit" ? [source.commit, "--"] : ["--"])]
    const out = yield* git(repo, args).pipe(Effect.orElseSucceed(() => ""))
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
      .map((l) => (source.kind === "commit" && l.startsWith(`${source.commit}:`) ? l.slice(source.commit.length + 1) : l))
  })
  const listDir = Effect.fnUntraced(function*(dir: string) {
    if (!inside(dir)) return [] as Array<string>
    if (source.kind === "commit") {
      const out = yield* git(source.repo, ["ls-tree", "--name-only", source.commit, `${dir}/`]).pipe(Effect.orElseSucceed(() => ""))
      return out.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.trim().split("/").pop()!)
    }
    return yield* fs.readDirectory(path.join(source.root, dir)).pipe(Effect.orElseSucceed(() => [] as Array<string>))
  })

  const located = new Map<string, Located>()
  for (const p of places) {
    if (p.new_file !== null) {
      const nf = p.new_file
      const siblings: Array<Sibling> = []
      for (const name of (yield* listDir(nf.dir)).filter((n) => n.startsWith(nf.prefix) && n.endsWith(nf.ext)).sort()) {
        const lines = yield* linesOf(`${nf.dir}/${name}`)
        if (lines !== undefined) siblings.push({ name, lines })
      }
      if (siblings.length > 0) located.set(p.id, { kind: "new-file", dir: nf.dir, prefix: nf.prefix, siblings })
      continue
    }
    const shape = shapeOf(p)
    const own = yield* linesOf(p.file)
    const here = own === undefined ? undefined : resolvePlace(own, shape)
    if (own !== undefined && here !== undefined) {
      located.set(p.id, { kind: "block", file: p.file, lines: own, region: here, moved: false })
      continue
    }
    // Moved: look where the outermost block's first line (or the group's start) now is.
    const key = p.chain[0]?.head ?? (p.group !== null && p.group !== IMPORTS ? p.group : undefined)
    if (key === undefined) continue
    const ext = p.file.slice(p.file.lastIndexOf("."))
    const candidates = (yield* filesWith(key)).filter((f) => f !== p.file && f.endsWith(ext)).slice(0, MAX_CANDIDATES)
    for (const file of candidates) {
      const lines = yield* linesOf(file)
      const r = lines === undefined ? undefined : resolvePlace(lines, shape)
      if (lines !== undefined && r !== undefined) {
        located.set(p.id, { kind: "block", file, lines, region: r, moved: true })
        break
      }
    }
  }
  return located as ReadonlyMap<string, Located>
})
