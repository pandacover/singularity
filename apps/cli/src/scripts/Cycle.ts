/**
 * Which prompts of a session start a task, for the hand-over (Hook.ts). A
 * prompt that asks for nothing (traces/Requests.ts: "yes", "commit and open a
 * PR", "please read @HANDOFF.md") never does. Of the prompts that ask, the
 * first of a session does, and then the first after each commit: in a long
 * conversation the person asks for a change, it gets committed, and the next
 * request is a new task, while a request before any commit is a follow-up of
 * the one being worked on. Storing cuts a session at its commits the same way
 * (workflows/Commits.ts).
 *
 * A marker per session (`<tenant>/scripts/sessions/<id>`) keeps the commit
 * HEAD was at when its last task started. A marker written before markers
 * kept it (the first prompt's text) says only that the session started:
 * it gets HEAD now, and the session's next task starts after its next commit.
 */

export interface Marker {
  /** HEAD when the session's last task started; null outside a repository. */
  readonly head: string | null
  readonly prompt: string
}

/** A session's marker as written; `legacy` when it holds only the first prompt's text. */
export const readMarker = (text: string): Marker & { readonly legacy: boolean } => {
  try {
    const v = JSON.parse(text) as unknown
    if (typeof v === "object" && v !== null && "head" in v && "prompt" in v) {
      const { head, prompt } = v as { head: unknown; prompt: unknown }
      if ((typeof head === "string" || head === null) && typeof prompt === "string") return { head, prompt, legacy: false }
    }
  } catch {
    // the first prompt's text, as markers were written before
  }
  return { head: null, prompt: text, legacy: true }
}

export const writeMarker = (m: Marker): string => JSON.stringify({ head: m.head, prompt: m.prompt }) + "\n"

/**
 * What a prompt that asks for something does to its session's task: `start`
 * one (the session's first, or the first since HEAD moved), `follow` the one
 * under way, or `upgrade` an old marker without starting one.
 */
export const nextStep = (marker: (Marker & { readonly legacy: boolean }) | undefined, head: string | null): "start" | "follow" | "upgrade" =>
  marker === undefined ? "start" : marker.legacy ? "upgrade" : marker.head === head ? "follow" : "start"
