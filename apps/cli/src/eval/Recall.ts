/**
 * Recall mid-run, for eval runs of the `scripts` setup, as daily use has it:
 * the recall note (setup/Instructions.ts) goes before whatever is handed over,
 * and a `singularity` command on the run's PATH answers `singularity recall
 * TASK...` from the run's own memory directory, through
 * `node src/cli.ts eval recall --memory DIR`. Nothing else of singularity is
 * reachable from a run.
 */
import { Effect, FileSystem, Path } from "effect"
import { fileURLToPath } from "node:url"
import { RECALL_NOTE } from "../setup/Instructions.ts"
import { rankRecall } from "../scripts/Search.ts"
import { makeScripts, renderEntry } from "./SavedScripts.ts"
import type { MemorySetup } from "./Setups.ts"
import { MemoryError } from "./Setups.ts"

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url))

/** What `singularity recall TASK` prints in a run: the hand-over a task like it would get, or a line saying there's none. */
export const recallText = Effect.fn("eval.recallText")(function*(memoryDir: string, task: string) {
  const all = yield* makeScripts(memoryDir, true).entries
  const top = rankRecall(task, all.map((e) => ({ ...e, files: e.files_changed })))[0]
  if (top === undefined || !top.matches) return "singularity: memory has nothing for this in this repository yet."
  return renderEntry(top.doc, all.filter((e) => e.id !== top.doc.id).reverse())
})

/** The `singularity` command of a run: POSIX shell and Windows batch, both only `recall`. */
const shims = (node: string, memoryDir: string) => ({
  sh: [
    "#!/bin/sh",
    "# singularity in an eval run: only recall, from the run's memory.",
    `if [ "$1" = recall ]; then shift; exec "${node}" "${CLI}" eval recall --memory "${memoryDir}" "$@"; fi`,
    `echo "singularity: only recall is available here" >&2`,
    "exit 2",
    ""
  ].join("\n"),
  cmd: [
    "@echo off",
    `if /I "%~1"=="recall" (`,
    "  shift",
    `  "${node}" "${CLI}" eval recall --memory "${memoryDir}" %1 %2 %3 %4 %5 %6 %7 %8 %9`,
    "  exit /b %ERRORLEVEL%",
    ")",
    "echo singularity: only recall is available here 1>&2",
    "exit /b 2",
    ""
  ].join("\r\n")
})

/** `setup` with the recall note before its hand-over and the `singularity` command on the run's PATH. */
export const withRecall = (setup: MemorySetup, memoryDir: string): MemorySetup => ({
  ...setup,
  beforeRun: (task, workspace, runDir) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const injection = yield* setup.beforeRun(task, workspace, runDir)
      const memory = path.resolve(memoryDir)
      const bin = `${memory.replace(/[\\/]+$/, "")}-bin`
      const s = shims(process.execPath, memory)
      yield* Effect.gen(function*() {
        yield* fs.makeDirectory(bin, { recursive: true })
        yield* fs.writeFileString(path.join(bin, "singularity"), s.sh)
        yield* fs.chmod(path.join(bin, "singularity"), 0o755)
        yield* fs.writeFileString(path.join(bin, "singularity.cmd"), s.cmd)
      }).pipe(Effect.mapError((e) => new MemoryError({ message: `recall command in ${bin}: ${e.message}` })))
      const sep = process.platform === "win32" ? ";" : ":"
      return {
        ...injection,
        systemPrompt: [RECALL_NOTE, injection.systemPrompt].filter((t) => t !== undefined).join("\n\n"),
        env: { ...injection.env, PATH: `${bin}${sep}${process.env.PATH ?? ""}` },
        info: { ...injection.info, recall: true }
      }
    })
})
