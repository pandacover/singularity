/**
 * A structured model call through the agent memory learns with: Claude Code
 * (`claude -p`, Llm.ts), Codex (`codex exec`, CodexLlm.ts) or Hermes Agent
 * (`hermes chat`, HermesLlm.ts). Each answers with a value of the call's
 * schema, what it cost and the tokens it used, on the user's own account
 * with that agent.
 *
 * Where `Spent` is provided, every call is counted in it, a failed one too,
 * with what the agent said it cost: a learning round that fails half-way
 * has still spent what its calls cost (workflows/Learn.ts).
 */
import { Context, Effect, Option } from "effect"
import { callCodex } from "./CodexLlm.ts"
import { callHermes } from "./HermesLlm.ts"
import { callStructured, type ModelCall } from "./Llm.ts"

/** Claude Code's model when a call names none: what memory's learning was measured with. */
export const CLAUDE_DEFAULT_MODEL = "sonnet"

/** The model calls made while it is provided, and what they cost as far as their agent said. */
export class Spent extends Context.Service<Spent, {
  readonly calls: () => number
  readonly usd: () => number
  readonly add: (usd: number | null | undefined) => void
}>()("singularity/eval/Spent") {
  /** A count from zero. */
  static readonly fresh = () => {
    let calls = 0
    let usd = 0
    return Spent.of({
      calls: () => calls,
      usd: () => usd,
      add: (x) => {
        calls++
        usd += x ?? 0
      }
    })
  }
}

const callAgent = <A>(call: ModelCall<A>) => {
  switch (call.cli.agent) {
    case "claude":
      return callStructured({ ...call, claude: call.cli.command, model: call.model ?? CLAUDE_DEFAULT_MODEL })
    case "codex":
      return callCodex(call)
    case "hermes":
      return callHermes(call)
  }
}

export const callModel = <A>(call: ModelCall<A>) =>
  Effect.serviceOption(Spent).pipe(
    Effect.flatMap((spent) =>
      Option.match(spent, {
        onNone: () => callAgent(call),
        onSome: (s) =>
          callAgent(call).pipe(
            Effect.tap((r) => Effect.sync(() => s.add(r.costUsd))),
            Effect.tapError((e) => Effect.sync(() => s.add(e.costUsd)))
          )
      })
    )
  )
