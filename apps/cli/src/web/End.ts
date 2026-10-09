/**
 * end, for the web reader: the session as a record (Records.ts), with how it
 * went when the caller knows (an eval's check and its feedback, a user's
 * verdict), and what came of the memory it was handed.
 */
import { DateTime, Effect } from "effect"
import { parseSession, traceUsage, usageTotal } from "../traces/index.ts"
import { readWebSession } from "./Extract.ts"
import { taskValues } from "./Places.ts"
import { putWebRecord, type WebRecord } from "./Records.ts"
import { readEvents, readWebState, safeId, webTarget } from "./Session.ts"

export interface WebOutcome {
  readonly success: boolean | null
  readonly feedback: string | null
}

/** end, for the web: the session as a record. */
export const webEnd = Effect.fn("web.end")(function*(
  input: { readonly sessionId: string; readonly transcript: string; readonly outcome: WebOutcome; readonly taskId?: string | undefined; readonly prompt?: string | undefined },
  tenantDir: string,
  tenant: string
) {
  const trace = yield* parseSession(input.transcript)
  const state = yield* readWebState(tenantDir, input.sessionId)
  const prompt = input.prompt ?? state?.prompt ?? trace.prompts[0]?.text ?? ""
  const target = webTarget(prompt)
  if (target === undefined) return { record: undefined, reason: "the task names no web app" }
  const values = taskValues(prompt)
  const view = readWebSession(trace.toolCalls.filter((c) => c.agentId === undefined), values, target.subject)
  const events = yield* readEvents(tenantDir, input.sessionId)
  const used = new Set(view.actions.filter((a) => !a.failed && a.place !== undefined).map((a) => a.place!))
  const cost = trace.costState?.totalCostUSD
  const record: WebRecord = {
    id: `w-${safeId(input.sessionId)}`,
    tenant,
    subject: target.subject,
    session_id: input.sessionId,
    task_id: input.taskId ?? null,
    prompt,
    values,
    success: input.outcome.success,
    feedback: input.outcome.feedback,
    actions: view.actions.map((a) => ({
      index: a.index,
      kind: a.kind,
      page: a.page ?? null,
      chain: a.chain === undefined ? null : a.chain.map((r) => ({ role: r.role, name: r.name })),
      place: a.place ?? null,
      text: a.text ?? null,
      was: a.was ?? null,
      failed: a.failed,
      error: a.error ?? null
    })),
    messages: view.messages.map((m) => ({ after: m.after, page: m.page ?? null, text: m.text })),
    forms: view.forms.map((f) => ({ page: f.page, fields: f.fields.map((x) => ({ control: x.control, state: x.state, changed: x.changed })) })),
    turns: trace.responses.filter((r) => r.agentId === undefined).length,
    tokens: usageTotal(traceUsage(trace)),
    cost_usd: typeof cost === "number" ? cost : null,
    memory: state === undefined ? null : {
      version: state.version,
      workflows: state.workflows.map((w) => w.id),
      places: [...state.places],
      pointed: events.filter((e) => e.kind === "pointer").map((e) => e.id),
      used: state.places.filter((p) => used.has(p)),
      fired: events.filter((e) => e.kind === "trigger").map((e) => e.id)
    },
    created_at: DateTime.formatIso(yield* DateTime.now)
  }
  yield* putWebRecord(tenantDir, record)
  return { record: record.id, subject: target.subject, reason: "recorded" }
})
