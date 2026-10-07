/**
 * The skill that tells an agent what singularity's memory is and how to use
 * its command: `<skills dir>/singularity/SKILL.md`, in the format of the
 * Agent Skills standard, which Claude Code, Codex, Gemini CLI, Cursor,
 * OpenCode and Droid all read.
 *
 * Only the skill's description stays in an agent's context; the rest loads
 * when the agent uses it. It is for when the user asks about memory: at task
 * start memory arrives through hooks, and an agent that looked it up for
 * every task would pay a turn each time.
 */
import { Effect, FileSystem, Path } from "effect"

export const SKILL_NAME = "singularity"

/** The line that marks a skill as installed by setup, so uninstalling never removes a skill of the user's own. */
const MARKER = "<!-- Installed by `singularity setup`; `singularity uninstall` removes it. -->"

export const SKILL_TEXT = `---
name: ${SKILL_NAME}
description: Procedural memory for this machine's git repositories, learned from earlier coding sessions. Use when the user asks to use, check or teach singularity memory, or asks what memory knows about a repository. Memory usually arrives on its own when a task starts; don't look it up for every task.
---

${MARKER}

# singularity memory

singularity learns how tasks get done in a repository: the places in the
code a kind of change goes, the commands that check it, and mistakes earlier
sessions paid for. When a similar task starts, it hands them over as a
message headed "Workflows from earlier work in this repository". Places are
found in the code as it is now; memory never stores code.

Run these in the repository:

- \`singularity recall "<the task, as the user wrote it>"\` prints what memory
  has for that task, or says it has nothing. Use it when the user asks you to
  use memory and nothing was handed over.
- \`singularity status\` shows the agents memory is set up in and what it has
  learned for each repository.
- \`singularity learn\` turns recorded sessions into workflows. It calls a
  model on the user's Claude account, a few cents a round: run it only when
  the user asks.
`

export type SkillState = "missing" | "current" | "outdated" | "foreign"

const skillFile = (path: Path.Path, dir: string) => path.join(dir, SKILL_NAME, "SKILL.md")

/** Whether a skills directory has memory's skill, as this version writes it. */
export const skillState = Effect.fn("skillState")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = skillFile(path, dir)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
    // A folder of that name without the file is someone else's.
    return (yield* fs.exists(path.join(dir, SKILL_NAME)).pipe(Effect.orElseSucceed(() => false))) ? "foreign" : "missing"
  }
  const text = (yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))).replace(/\r\n/g, "\n")
  if (!text.includes(MARKER)) return "foreign"
  return text === SKILL_TEXT ? "current" : "outdated"
})

/** Write the skill into a skills directory; a skill of that name that isn't ours is left alone. */
export const installSkill = Effect.fn("installSkill")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const state = yield* skillState(dir)
  if (state === "foreign") return state
  yield* fs.makeDirectory(path.join(dir, SKILL_NAME), { recursive: true })
  yield* fs.writeFileString(skillFile(path, dir), SKILL_TEXT)
  return state
})

/** Remove memory's skill from a skills directory; whether it was there. */
export const removeSkill = Effect.fn("removeSkill")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const state = yield* skillState(dir)
  if (state !== "current" && state !== "outdated") return false
  yield* fs.remove(path.join(dir, SKILL_NAME), { recursive: true })
  return true
})
