/**
 * The CLI door of the memory layer's one API (src/layer/Api.ts), for anything
 * that can run a command: an agent without hooks, a harness, a script. Each
 * call takes a JSON request on stdin and prints a JSON answer:
 *
 *     singularity layer start   {"session_id","prompt","cwd"}
 *     singularity layer step    {"session_id","tool_name","tool_input","tool_response"?,"error"?,"cwd"?}
 *     singularity layer end     {"session_id","transcript_path","cwd","outcome"?:{"success","feedback"},"task_id"?,"prompt"?}
 *     singularity layer learn   {"subject","model"?,"effort"?,"every"?,"now"?}
 */
import { Console, Effect, Path, Predicate, Schema } from "effect"
import { Command } from "effect/cli"
import { defaultClaude } from "../eval/Agent.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import * as Api from "../layer/Api.ts"
import { DEFAULT_INDUCE_EFFORT, DEFAULT_INDUCE_MODEL } from "../workflows/Induce.ts"

export class LayerError extends Schema.TaggedError<LayerError>()("LayerError", { message: Schema.String }) {}

const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf-8")
}

const request = Effect.gen(function*() {
  const text = yield* Effect.promise(readStdin)
  const parsed = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => new LayerError({ message: "the request on stdin isn't JSON" }) })
  if (!Predicate.isObject(parsed)) return yield* new LayerError({ message: "the request must be a JSON object" })
  return parsed as Record<string, unknown>
})

const str = (r: Record<string, unknown>, key: string): string | undefined => (typeof r[key] === "string" ? (r[key] as string) : undefined)

const need = (r: Record<string, unknown>, key: string) =>
  str(r, key) === undefined ? Effect.fail(new LayerError({ message: `the request needs "${key}"` })) : Effect.succeed(str(r, key)!)

const print = (value: unknown) => Console.log(JSON.stringify(value))

const start = Command.make("start", {}, () =>
  Effect.gen(function*() {
    const r = yield* request
    const out = yield* Effect.promise(() => Api.start({ sessionId: str(r, "session_id") ?? "", prompt: str(r, "prompt") ?? "", cwd: str(r, "cwd") ?? process.cwd() }))
    yield* print(out)
  })).pipe(Command.withDescription("a task begins: what memory knows for it"))

const step = Command.make("step", {}, () =>
  Effect.gen(function*() {
    const r = yield* request
    const out = yield* Effect.promise(() =>
      Api.step({
        sessionId: str(r, "session_id") ?? "",
        toolName: str(r, "tool_name") ?? "",
        toolInput: Predicate.isObject(r.tool_input) ? (r.tool_input as Record<string, unknown>) : {},
        toolResponse: r.tool_response,
        error: str(r, "error"),
        cwd: str(r, "cwd")
      })
    )
    yield* print(out)
  })).pipe(Command.withDescription("after an action: a pointer or a warning, or nothing"))

const end = Command.make("end", {}, () =>
  Effect.gen(function*() {
    const r = yield* request
    const outcome = Predicate.isObject(r.outcome) ? (r.outcome as Record<string, unknown>) : undefined
    const out = yield* Effect.promise(() =>
      Api.end({
        sessionId: str(r, "session_id") ?? "",
        transcript: str(r, "transcript_path") ?? "",
        cwd: str(r, "cwd") ?? process.cwd(),
        outcome: outcome === undefined ? undefined : {
          success: typeof outcome.success === "boolean" ? outcome.success : null,
          feedback: typeof outcome.feedback === "string" ? outcome.feedback : null
        },
        taskId: str(r, "task_id"),
        prompt: str(r, "prompt")
      })
    )
    yield* print(out)
  })).pipe(Command.withDescription("the session is over: record it, with how it went"))

const learn = Command.make("learn", {}, () =>
  Effect.gen(function*() {
    const r = yield* request
    const subject = yield* need(r, "subject")
    const path = yield* Path.Path
    const out = yield* Effect.promise(async () =>
      Api.learn({
        subject,
        config: {
          claude: await Effect.runPromise(defaultClaude().pipe(Effect.provide((await import("@effect/platform-node")).NodeServices.layer))),
          cwd: path.join(defaultWorkspaces(), "_learner"),
          model: str(r, "model") ?? DEFAULT_INDUCE_MODEL,
          effort: str(r, "effort") ?? DEFAULT_INDUCE_EFFORT,
          every: typeof r.every === "number" ? r.every : undefined,
          now: r.now === true
        }
      })
    )
    yield* print(out)
  })).pipe(Command.withDescription("a learning round for a subject, when it is time"))

export const layerCommand = Command.make("layer").pipe(
  Command.withDescription("the memory layer's one API: start, step, end, learn (JSON on stdin)"),
  Command.withSubcommands([start, step, end, learn])
)
