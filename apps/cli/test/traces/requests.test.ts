import { describe, expect, it } from "@effect/vitest"
import { isRequest } from "../../src/traces/Requests.ts"

describe("whether a prompt asks for a change", () => {
  it("takes task prompts, long or short, for requests", () => {
    for (const p of [
      "This is our fork of markdownlint. Add a new built-in rule: MD061, alias `heading-max-level`. Commit when you're done.",
      "I tried this command in wsl and it won't start",
      "I want reading support for hermes and codex as well",
      "make singularity installable and usable by hermes agent as well",
      "okay replace the current landing page with the article page and don't keep a backup, commit and push to main",
      "Rule MD061 reports headings inside code blocks: fix it, and add tests.",
      "How about we cache the parsed config between runs, keep it next to the lockfile and drop it when the lockfile changes",
      "Fix the off-by-one in the line counter of MD062, but don't change anything else"
    ]) expect(isRequest(p), p).toBe(true)
  })

  it("takes approvals, commit instructions, pointers to read and questions for what they are", () => {
    for (const p of [
      "",
      "yes",
      "alright",
      "perfect, please do",
      "no, go on with the suggested order",
      "It matches with my limited understanding. you can continue",
      "Right. Claude, I'll go sleep. you can continue with work.",
      "commit and open a PR",
      "push and merge to main",
      "commit first, let us see whether we actually want to combine them or not.",
      "create a PR for this and merge, then go to step 2",
      "please read @HANDOFF.md",
      "Please take a look at the [HANDOFF.md](HANDOFF.md)",
      "can you read the [HANDOFF.md](HANDOFF.md) and tell me what are the next series of steps?",
      "What's our benchmark numbers so far?",
      "what's the progress of the run so far",
      "Do you think the current singularity is ready for users as a local memory?",
      "Morning! We'll make a few changes to our markdownlint fork today. Have a look around first (README.md, CONTRIBUTING.md, lib/ and test/) so you know your way around; don't change anything yet."
    ]) expect(isRequest(p), p).toBe(false)
  })
})
