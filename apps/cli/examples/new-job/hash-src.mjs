// The freeze hash of memory code: sha256 over every file of a source folder,
// sorted by its path from the folder; for each, "apps/cli/src/<path>\0",
// its bytes, "\0". The first freeze (69219c63...) was computed this way.
//   node hash-src.mjs [folder]   (default: apps/cli/src)
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const root = process.argv[2] ?? "apps/cli/src"
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
const files = walk(root)
  .map((p) => ({ p, rel: relative(root, p).split(sep).join("/") }))
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
const h = createHash("sha256")
for (const f of files) {
  h.update("apps/cli/src/" + f.rel + "\0")
  h.update(readFileSync(f.p))
  h.update("\0")
}
console.log(`${files.length} files ${h.digest("hex")}`)
