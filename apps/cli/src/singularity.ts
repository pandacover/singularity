/**
 * The `singularity` command that setup puts on PATH: daily use only.
 *
 *     singularity setup [--yes] [--agent ID ...] [--no-path]    set memory up in this machine's coding agents
 *     singularity status | recall TASK... | learn [--past] [--all] | uninstall [--purge]
 *
 * The commands for building and measuring memory (eval, records, workflows,
 * ...) are in src/cli.ts, which has these too: run it from the repo. Memory's
 * own background work (`record commits`, `learn --auto`) runs through it as
 * well (src/setup/Background.ts), so nothing here needs to offer it.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { Command } from "effect/cli"
import { setupCommands } from "./commands/Setup.ts"
import { VERSION } from "./setup/Status.ts"

// Exit quietly when the reader goes away early, e.g. `... | head`.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0)
  throw e
})

/** Expected failures get one line and exit code 2, not a stack trace. */
const reportError = (e: { readonly message: string }) =>
  Console.error(`error: ${e.message}`).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 2))))

Command.make("singularity").pipe(
  Command.withDescription("procedural memory for coding agents"),
  Command.withSubcommands(setupCommands),
  Command.run({ version: VERSION }),
  Effect.catchTags({
    AgentError: reportError,
    PlatformError: reportError,
    StoreError: reportError,
    CandidateNotFound: reportError,
    Conflict: reportError,
    HomeError: reportError
  }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
