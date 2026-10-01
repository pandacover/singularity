/**
 * Run a child process with a timeout, collecting its output.
 *
 * On timeout or interruption the process's scope closes, and the Node spawner
 * kills the whole process tree (`taskkill /T` on Windows, the process group
 * elsewhere), so an agent never outlives its run.
 */
import { Duration, Effect, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { constants, setPriority } from "node:os"

export interface ProcResult {
  /** Undefined when the process timed out. */
  readonly exitCode: number | undefined
  readonly timedOut: boolean
  readonly durationS: number
  readonly stdout: string
  readonly stderr: string
}

export const procOk = (r: ProcResult): boolean => r.exitCode === 0 && !r.timedOut

export interface RunOptions {
  readonly cwd: string
  readonly timeoutS: number
  /** The child's complete environment; nothing else is inherited. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Written to stdin, which is then closed. */
  readonly input?: string | undefined
}

/** Run `command` with `args` (no shell). */
export const runProcess = (command: string, args: ReadonlyArray<string>, options: RunOptions) =>
  run(ChildProcess.make(command, args, commandOptions(options)), options.timeoutS)

/** Run a shell command line (`cmd.exe` on Windows, `/bin/sh` elsewhere). */
export const runShell = (commandLine: string, options: RunOptions) =>
  run(ChildProcess.make(commandLine, [], { ...commandOptions(options), shell: true }), options.timeoutS)

const commandOptions = (options: RunOptions): ChildProcess.CommandOptions => ({
  cwd: options.cwd,
  env: options.env,
  extendEnv: false,
  stdin: options.input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(options.input))
})

const run = Effect.fn("Proc.run")(function*(command: ChildProcess.Command, timeoutS: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Collected as it arrives, so output written before a timeout is kept.
  const stdout: Array<Uint8Array> = []
  const stderr: Array<Uint8Array> = []
  const started = performance.now()
  const exitCode = yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(command)
      const [, , code] = yield* Effect.all(
        [
          Stream.runForEach(handle.stdout, (chunk) => Effect.sync(() => stdout.push(chunk))),
          Stream.runForEach(handle.stderr, (chunk) => Effect.sync(() => stderr.push(chunk))),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      )
      return code as number
    })
  ).pipe(Effect.timeoutOption(Duration.seconds(timeoutS)))
  return {
    exitCode: Option.getOrUndefined(exitCode),
    timedOut: Option.isNone(exitCode),
    durationS: (performance.now() - started) / 1000,
    stdout: decode(stdout),
    stderr: decode(stderr)
  } satisfies ProcResult
})

const decode = (chunks: ReadonlyArray<Uint8Array>): string => {
  const decoder = new TextDecoder("utf-8")
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode()
}

/**
 * Run this process, and so everything it starts, below normal priority, so
 * long evals don't make the machine sluggish. On Windows child processes
 * inherit the priority class; elsewhere they inherit the nice value.
 */
export const lowerPriority = Effect.sync(() => {
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Not permitted (e.g. some containers): run at normal priority.
  }
})
