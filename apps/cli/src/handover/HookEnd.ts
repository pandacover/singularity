/**
 * The SessionEnd hook: record the session if its change was committed and
 * its tests pass (SessionEnd.ts). Prints nothing: the session is over.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Path } from "effect"
import { loadHome } from "../local/Home.ts"
import * as JsonMemoryStore from "../memory/JsonMemoryStore.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import { decodeHookInput } from "./HookInput.ts"
import { recordSession, type SessionOutcome } from "./SessionEnd.ts"

export const sessionEnd = (stdin: string): Promise<SessionOutcome | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const input = decodeHookInput(stdin)
      if (input === undefined || input.transcript_path === undefined || input.transcript_path === null) return undefined
      const home = yield* loadHome()
      const path = yield* Path.Path
      return yield* recordSession(
        { sessionId: input.session_id, transcript: input.transcript_path, cwd: input.cwd ?? process.cwd() },
        home.tenantDir
      ).pipe(Effect.provide(Layer.merge(
        JsonRecordStore.layer(home.tenantDir, home.tenant),
        JsonMemoryStore.layer(path.join(home.tenantDir, "memory"), home.tenant)
      )))
    }).pipe(Effect.provide(NodeServices.layer))
  )
