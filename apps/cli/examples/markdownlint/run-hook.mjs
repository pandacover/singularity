// The with arm's own singularity hook, for a run of memory code that isn't
// installed (driver.mjs --app <dir>):
//
//   node run-hook.mjs <app dir> <event> [args...]
//
// The agent's environment silences the installed hooks (SINGULARITY_HOOKS=off).
// This clears it again and runs <app dir>'s hook as the installed one runs:
// the same event and arguments, storing and learning as in daily use. Each
// call is noted in <memory home>/run-hook.log.
import { appendFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [app] = process.argv.splice(2, 1)
delete process.env.SINGULARITY_HOOKS
try {
  appendFileSync(path.join(process.env.SINGULARITY_HOME, "run-hook.log"), `${new Date().toISOString()} ${process.argv.slice(2).join(" ")}\n`)
} catch {}
await import(pathToFileURL(path.join(app, "apps", "cli", "src", "workflows", "hook.ts")).href)
