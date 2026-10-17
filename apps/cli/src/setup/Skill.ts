/**
 * The skill that tells an agent what singularity's memory is and how to use
 * its command: `<skills dir>/singularity/SKILL.md`, in the format of the
 * Agent Skills standard, which Claude Code, Codex, Gemini CLI, Cursor,
 * OpenCode, Droid and Hermes Agent all read.
 *
 * Only the skill's description stays in an agent's context; the rest loads
 * when the agent uses it. At task start memory arrives through hooks; the
 * skill is for when the user asks about memory, and for recalling mid-task
 * (which the recall note, Instructions.ts, tells the agents that read it).
 * An agent that looked memory up for every task would pay a turn each time.
 */
import { Effect, FileSystem, Path } from "effect"

export const SKILL_NAME = "singularity"

/** The line that marks a skill as installed by setup, so uninstalling never removes a skill of the user's own. */
const MARKER = "<!-- Installed by `singularity setup`; `singularity uninstall` removes it. -->"

export const SKILL_TEXT = `---
name: ${SKILL_NAME}
description: Procedural memory for this machine's git repositories, kept from earlier coding sessions. Use when the user asks to use or check singularity memory or what it knows about a repository, or mid-task when you are about to do something likely done before in this repository. Memory usually arrives on its own when a task starts; don't look it up at every step.
---

${MARKER}

# singularity memory

singularity keeps the changes coding sessions commit in a repository, with
their checks passing: the task, the files, the commands that worked and the
mistakes made on the way. When a similar task starts, it hands over the one
most like it, read from git as it is now, as a message headed "A past change
in this repository like your task". When you read a stored commit with
\`git show\` or \`git log\`, it adds what git doesn't show about it, headed
"What git doesn't show about <commit>".

Run these in the repository:

- \`singularity recall "<what you are about to do>"\` prints the past change
  most like it, read from git as it is now, or says there is none. It calls no
  model. Use it when the user asks you to use memory and nothing was handed
  over, or mid-task when you are about to do something likely done before
  here (a kind of change, a fix, a command that keeps failing). Not at every
  step, and not for the task you were just handed a change for.
- \`singularity status\` shows the agents memory is set up in and how many
  changes it has stored for each repository.
- \`singularity changes\` lists the changes stored for this repository,
  newest first, with their commits; \`singularity changes <commit>\` prints
  one as it would be handed over now. Use it when the user asks what memory
  has stored.
- \`singularity store\` stores the changes earlier sessions in this
  repository committed. It calls no model; new ones are stored as they are
  committed.
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
