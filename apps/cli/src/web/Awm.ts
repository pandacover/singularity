/**
 * The Agent Workflow Memory baseline (Wang et al., arXiv 2409.07429), as the
 * paper does it offline: for each website, a model reads the successful past
 * trajectories (the instruction and its actions) and writes the common
 * workflows, with the non-fixed values as variables; every later task on that
 * website gets all of them. No places, no graph, no gate, no learning after.
 *
 * Here the trajectories are the benchmark's runs without memory in its learn
 * phase that passed their check.
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { callStructured } from "../eval/Llm.ts"
import { parseSession } from "../traces/index.ts"
import { readWebSession } from "./Extract.ts"
import { firstUrl, originOf, taskValues, webSubjectId } from "./Places.ts"

export const AWM_PROMPT = `Given a list of web navigation tasks, your task is to extract the common workflows to solve these tasks.
Each given task contains a natural language instruction, and a series of actions to solve the task. You need to find the repetitive subset of actions across multiple tasks, and extract each of them out as a workflow.
Each workflow should be a commonly-reused sub-routine of the tasks. Do not generate similar or overlapping workflows. Each workflow should have at least two steps. Represent the non-fixed elements (input text, button strings) with descriptive variable names as shown in the example.

Write each workflow as:

## <workflow name>
<when to use it, in one sentence>
1. <action> on <element description> [with {variable}]
2. ...`

const Answer = Schema.Struct({ workflows: Schema.String })

const describe = (a: { kind: string; page?: string | undefined; chain?: ReadonlyArray<{ role: string; name: string }> | undefined; text?: string | undefined; failed: boolean }) => {
  const target = a.chain === undefined ? "" : ` ${a.chain.map((c) => (c.name === "" ? c.role : `${c.role} "${c.name}"`)).join(" > ")}`
  return `${a.kind}${a.kind === "navigate" ? ` ${a.page ?? ""}` : target}${a.text === undefined ? "" : ` with "${a.text}"`}${a.failed ? " (failed)" : ""}`
}

export const awmHandover = Effect.fn("awmHandover")(function*(o: { readonly results: string; readonly out: string; readonly claude: ReadonlyArray<string>; readonly cwd: string; readonly model: string; readonly effort: string }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const lines = (yield* fs.readFileString(path.join(o.results, "results.jsonl"))).split(/\r?\n/).filter((l) => l.trim() !== "")
  const byOrigin = new Map<string, Array<string>>()
  for (const l of lines) {
    const r = JSON.parse(l) as { run_id: string; phase: string; success: boolean; session_id: string }
    if (r.phase !== "learn" || r.success !== true) continue
    const dir = path.join(o.results, "runs", r.run_id)
    const prompt = yield* fs.readFileString(path.join(dir, "prompt.txt"))
    const origin = originOf(firstUrl(prompt) ?? "")
    const transcript = (yield* fs.readDirectory(dir)).find((n) => n.endsWith(".jsonl"))
    if (origin === undefined || transcript === undefined) continue
    const trace = yield* parseSession(path.join(dir, transcript))
    const values = taskValues(prompt)
    const view = readWebSession(trace.toolCalls.filter((c) => c.agentId === undefined), values, webSubjectId(origin))
    const task = [`### Task: ${prompt.trim().split(/\r?\n/)[0]}`, ...view.actions.map((a, i) => `${i + 1}. ${describe({ kind: a.kind, page: a.page, chain: a.chain, text: a.text, failed: a.failed })}`)].join("\n")
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), task])
  }
  const handover: Record<string, string> = {}
  let costUsd = 0
  for (const [origin, tasks] of byOrigin) {
    const answer = yield* callStructured({
      claude: o.claude,
      system: AWM_PROMPT,
      prompt: `Website: ${origin}\n\n${tasks.join("\n\n")}`,
      schema: Answer,
      model: o.model,
      effort: o.effort,
      cwd: o.cwd,
      maxBudgetUsd: 2,
      timeoutS: 900
    })
    costUsd += answer.costUsd ?? 0
    handover[origin] = `Workflows from earlier tasks on this website (Agent Workflow Memory):\n\n${answer.value.workflows.trim()}`
  }
  yield* fs.writeFileString(o.out, JSON.stringify({ by_origin: handover }, null, 2) + "\n")
  return { apps: byOrigin.size, costUsd }
})
