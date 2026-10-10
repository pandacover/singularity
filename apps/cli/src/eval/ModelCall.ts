/**
 * A structured model call through the agent memory learns with: Claude Code
 * (`claude -p`, Llm.ts), Codex (`codex exec`, CodexLlm.ts) or Hermes Agent
 * (`hermes chat`, HermesLlm.ts). Each answers with a value of the call's
 * schema, what it cost and the tokens it used, on the user's own account
 * with that agent.
 */
import { callCodex } from "./CodexLlm.ts"
import { callHermes } from "./HermesLlm.ts"
import { callStructured, type ModelCall } from "./Llm.ts"

/** Claude Code's model when a call names none: what memory's learning was measured with. */
export const CLAUDE_DEFAULT_MODEL = "sonnet"

export const callModel = <A>(call: ModelCall<A>) => {
  switch (call.cli.agent) {
    case "claude":
      return callStructured({ ...call, claude: call.cli.command, model: call.model ?? CLAUDE_DEFAULT_MODEL })
    case "codex":
      return callCodex(call)
    case "hermes":
      return callHermes(call)
  }
}
