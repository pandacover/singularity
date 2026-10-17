// For markdownlint tasks whose declaration build failed on type errors (a
// record's `types: false`), the regenerate check couldn't compare the type
// declarations: driver.mjs compares them only when the build succeeds. tsc
// still writes them despite type errors, so this writes them anyway for the
// commit the session left and says which committed lib/*.d.?ts files differ.
// It makes the regenerate check the same for both arms. Free: no model call.
//
//   node apps/cli/examples/scripts/check-declarations.mjs [--ml <root>] [--pass N]... [--json <file>]
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const { values: opts } = parseArgs({
  options: {
    ml: { type: "string", default: "C:/singularity-workspaces/eval-1016/ml" },
    pass: { type: "string", multiple: true, default: [] },
    json: { type: "string" }
  }
})
const FILES = ["exports.d.mts", "exports-async.d.mts", "exports-promise.d.mts", "exports-sync.d.mts", "markdownlint.d.mts", "resolve-module.d.cts"]

const readJsonl = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) : []

const results = []
for (const dir of fs.readdirSync(opts.ml).filter((d) => /^runs-p\d+$/.test(d)).sort()) {
  const pass = Number(dir.slice(6))
  if (opts.pass.length > 0 && !opts.pass.map(Number).includes(pass)) continue
  for (const arm of ["without", "with"]) {
    const byTask = new Map()
    for (const r of readJsonl(path.join(opts.ml, dir, arm, "records.jsonl"))) byTask.set(r.task, r)
    for (const r of [...byTask.values()].sort((a, b) => a.index - b.index)) {
      if (r.types !== false) continue
      const repo = path.join(opts.ml, `arm-${arm}-p${pass}`)
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decl-"))
      execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--shared", "--no-checkout", repo, tmp])
      execFileSync("git", ["-C", tmp, "config", "core.autocrlf", "false"])
      execFileSync("git", ["-C", tmp, "checkout", "--quiet", r.post])
      const modules = path.join(tmp, "node_modules")
      fs.symlinkSync(path.join(repo, "node_modules"), modules, "junction")
      try {
        const tsc = path.join(repo, "node_modules", "typescript", "bin", "tsc")
        spawnSync(process.execPath, [tsc, "--project", "./declaration/tsconfig.json"], { cwd: tmp, encoding: "utf8" })
        const stale = FILES.filter((f) => {
          const built = path.join(tmp, "dts", "lib", f)
          const committed = path.join(tmp, "lib", f)
          if (!fs.existsSync(built)) return false
          return !fs.existsSync(committed) || !fs.readFileSync(built).equals(fs.readFileSync(committed))
        })
        results.push({ pass, arm, task: r.task, passed: r.passed, stale })
        console.log(`pass ${pass} ${arm} ${r.task}: ${stale.length === 0 ? "declarations match" : `stale ${stale.join(", ")}`}${r.passed ? "" : " (failed anyway)"}`)
      } finally {
        // Remove the junction itself first, never what it points to.
        if (process.platform === "win32") fs.rmdirSync(modules)
        else fs.unlinkSync(modules)
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    }
  }
}
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(results, null, 2) + "\n")
