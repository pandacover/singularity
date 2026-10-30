# Singularity's memory layer: an honest critique

Written 2026-10-14 from the repo at `e6f97d9` (main). Every number below comes from the repo's own eval write-ups or code, cited by path. Paths are relative to `apps/cli/`.

## How it works, in one paragraph

When an agent commits a change and its last check passed, a hook stores a record: the prompt, files and code blocks edited, commands, errors (`src/workflows/Commits.ts`). After every 3 new changes in a repo, a model (Sonnet via Claude Code by default) reads the records and writes "workflows": reusable steps with blanks like `{field}`, the places in code they touch, and known mistakes (`src/workflows/Induce.ts`, `Learn.ts`). It also writes "cues", plain phrases that decide when a workflow applies (`CueWriter.ts`). A new version is kept only if a replay over past changes scores at least as well (`Evolve.ts:164`). At task start, a hook picks workflows whose cue phrase appears in the prompt, fills blanks from values in the prompt, finds each place in today's code and injects it all, up to 9,800 characters per part (`Cues.ts`, `Render.ts:32`). During the task, warnings fire when a known error or command shows up.

## The short verdict

The one test that measures the product as a user would get it says it **costs more and does not make agents faster**. The big headline number comes from a lab setup that does not match daily use. The core idea has a strong free competitor (the repo's own git history) that it has not yet beaten.

## 1. The repo already is a procedural memory, and it is free

In the markdownlint daily-use test, agents **without** singularity looked up earlier commits before their first edit in 7 to 8 of 12 sessions (`git show --stat HEAD~1`, `git log --stat`) and copied the whole procedure from the last similar change. Their cost fell from $0.49 to $0.24 by task 4 with no memory at all. With singularity, agents read the hand-over **and then looked up the commit anyway** in 6 of 12 sessions, so they paid twice (`examples/markdownlint/PREREGISTRATION-long-daily.md`, "What the runs show" 1 and 3).

Git history is always current, exact, and costs nothing to build. Singularity's workflows are a lossy, model-written summary of that same history. For "do the same kind of change again in the same repo", which is the only case where memory clearly helps, git log is the baseline to beat, and it has not been beaten.

## 2. In real daily use, it hurts

The markdownlint test is the only one where memory starts empty, learns on its own, and is used through the installed hooks on a repo it was never developed on. Results, same file:

| | without | with (1st run) | with (2nd run, after fixes) |
|---|---|---|---|
| tasks passed | 12 of 12 | 12 of 12 | **11 of 12** |
| agent dollars | $3.93 | $4.44 (+13%) | $4.29 (+9%) |
| learning | none | $2.59 | $2.63 |
| all-in dollars | $3.93 | $7.04 (+79%) | $6.92 (+76%) |

Its own pre-set bars call this "hurts", twice. In the second run memory **caused a failure**: its learned closing command put `build-docs` before `build-config`, the agent obeyed, and the docs came out wrong (task 3).

Where memory handed something over, agents spent 15% more than without it ($2.64 vs $2.29). Where it handed nothing over, the two arms cost the same.

## 3. The headline win is a lab result

The README leads with "28.5 turns to 9.5, $0.81 to $0.30" (`README.md`, Results). That test (`examples/excalidraw/PREREGISTRATION-v1-long.md`):

- used memory **built by hand and frozen**, on excalidraw, the repo the memory was developed and tuned against for weeks;
- asked for changes that are near twins of the seed tasks (toggle-rulers is described as "a twin of the seed toggle-minimap");
- added a code change (`partsChoice`) for this exact task right before the runs, after a preview showed it filling the wrong values;
- partly won by avoiding one known keyboard trap.

It is a real result, but it shows the best case, not the typical case. Daily use (section 2) is the typical case.

## 4. Picking by matching words is too blunt

A workflow is picked if any of its cue phrases appears as a substring of the prompt (`src/workflows/Cues.ts:36-45`, `54-66`). There is no notion of meaning. What the evals saw:

- **Look-alikes get the wrong memory.** The `getRules()` export task got all the new-rule workflows because the prompt said "built-in rules". A parameter task got new-rule steps. A dropdown bug got a "Preferences toggle" workflow because it said "main menu". On the web practice app, "Renew the loan" got the checkout workflows.
- **Paraphrases get nothing.** The save-as bug matched no cue at all, so memory runs were no-memory runs (`examples/PREREGISTRATION-v1-new-kinds.md`).

Agents mostly ignored wrong hand-overs, so they did not fail, but they paid to read 10-18k characters of irrelevant text, reread every turn.

## 5. Filling blanks by position is fragile, and wrong values are worse than none

Blanks are filled with "the Nth code span" or "the Nth quoted string" or "the Nth key combo" in the prompt (`Cues.ts:124-142`). So:

- `{tag}` was filled with "# Install" (task 3) and with `npm test` (tasks 7, 10, 12) in markdownlint.
- Before the late `partsChoice` fix, a 4-part excalidraw task told every change to use the first field and told the stats change to use Alt+N, another change's key.

A wrong value stated confidently in the first prompt is a trap memory sets itself.

## 6. Memory goes stale, and only part of it is checked

Places are re-found in today's code, which is good. But the step **text** is never checked. Examples:

- After a folder rename (`doc-build` to `doc-src`), the next task was told to create files in `doc-build/`, which no longer existed (markdownlint task 7).
- On the web benchmark, a learned step "pick the option with ArrowDown + Enter" submitted the wrong form after a UI update (`examples/new-job/RESULTS-v2.md`, section 5).

Real repos change constantly. Memory learns slowly (every 3 commits, and half of rounds are rejected), so it is always somewhat behind.

## 7. Learning costs more than it can save

In markdownlint, learning cost $2.59 to $2.63, which is **two thirds of the entire no-memory agent bill** ($3.93). Half the rounds were rejected by the gate, so half of that spend changed nothing. Rounds took 2.5 to 14 minutes, so a user who starts the next task right away works with old memory.

For the math to work, the saving per task must be large and the same kinds of change must repeat many times. The evals show neither in daily use: the rename, the look-alike and the API export workflows "never had a second use".

## 8. The gate measures the wrong thing, on the data it learned from

A new version is kept if `2 × (places shown and edited) − (places shown and not used)` does not drop (`src/workflows/Evolve.ts:161-167`). Two problems:

- **It is in-sample.** It replays over the same changes the model just learned from. A version that memorizes those changes will always look good.
- **It is a proxy.** It never measures whether agents got cheaper, faster, or more correct. It rewards pointing at the right files, which agents find on their own in 2-3 turns on small tasks (validator.js result: "Memory's hand-over then costs about what it saves").

## 9. It does not generalize across tasks

From two bug fixes, the model "kept what each did, not what both did" (`examples/PREREGISTRATION-v1-new-kinds.md`). The `Common.ts` pass was added to fix that. On validator.js, a second repo, memory did not help. So the value is narrow: repeats of the same kind of change in the same repo.

## 10. A one-page guide still beats it on success

On the web benchmark, a plain onboarding guide passed 23 of 23, memory v2 passed 21, no memory 20 (`examples/new-job/RESULTS-v2.md`, section 7). Memory v2 failed its pre-set bars (3 of 6 held). If a short hand-written doc (or a good `CLAUDE.md`) beats learned memory, the learning is not earning its cost.

## 11. The evidence is thin

- Daily-use test: one run per task per arm, and the write-up itself says the spread between single runs is large (task 2 cost +50% in one arm before any memory existed).
- Other tests: 3-4 runs per side; validator.js says "the spread within each setup is wider than the difference between them".
- Many fixes were found on the same tasks they were then tested on (stated openly in the markdownlint rerun and new-job v2 write-ups).

The team is honest about this, which is good. But it means no result outside the excalidraw lab case is a clear win.

## 12. Agents never ask for it

"No agent in either arm ran the command or the skill. Memory arrived only through the hooks" (markdownlint, point 5). So `recall` and the skill add surface without use, and every bad pick lands in the agent's first prompt whether it wants it or not.

## 13. Scope grew before value was proven

`src/workflows/` alone is about 7,700 lines. There is a frozen v0, v1, a web reader, an API layer, and setup for six agents (Claude Code, Codex, Hermes, Gemini CLI, Droid, Cursor/OpenCode). All of that is built on a core loop that has not yet shown a net win in daily use.

## What I would do before launch

1. **Beat the free baseline first.** Add an eval arm that injects `git log --stat` of the last 2-3 commits touching similar files (no model, no learning). If singularity cannot beat that, the workflows layer is not worth its cost.
2. **Lean on what seems to work: the warnings.** The clearest wins came from known traps (the `handleKeyboardGlobally` test trap, the `--watch=false` error, fewer trap hits on the web). Traps are the knowledge git log does not show. A product that only learns and fires mistakes is cheaper, smaller and easier to explain.
3. **Stop guessing blank values.** Show blanks unfilled, or let the agent fill them. Wrong values hurt more than empty ones.
4. **Hand over less, or on demand.** Short pointers ("a similar change: commit abc123, see its diff") instead of 15k characters reread every turn.
5. **Gate on held-out results.** Keep a version only if it helps on changes it did not learn from, ideally measured by cost, not places shown.
6. **Be careful with the launch claim.** "28.5 to 9.5 turns" is true but is the lab best case. The installed product measured +76% all-in cost on markdownlint. A launch message that leads with the first and not the second will not survive users trying it.
