# Pre-registration: memory in a day of work (2026-10-16)

## Why

The full eval of 2026-10-16 (`PREREGISTRATION-eval-2026-10-16.md`) found
memory paying where the past change isn't in git (the harness, about a
third less) and not in the markdownlint daily driver (-6%, inside the
noise). The user's reading: the benchmarks show the mechanism works, and day
to day memory fails at storing what it should. The memory home of their own
sessions bears that out (`replay-real-memory.ts`): 29 of its 59 changes
were filed under a prompt that asks for nothing (an approval, a commit
instruction, a pointer to a file to read, a question), and "please read
@HANDOFF.md" or "yes" pulled a random change at full confidence. Every benchmark session is one
clean prompt, so none could see it. This measures memory, as it was and as
fixed, in a run shaped like the user's day.

## What is measured

Three arms, each in its own markdownlint clone (`314ab18e`) and, with
memory, its own empty memory home per pass:

- **without**: no memory (hooks off, an empty home);
- **old**: main at `a7ede11` (`C:\singularity-workspaces\eval-1016\app`);
- **new**: `a7ede11` with `apps/cli/src` of the `t3/eval-2026-10-16` working
  tree (`eval-1016\app-new`, `COMMIT.txt`): a record filed under the prompt
  that asked for the change (`src/traces/Requests.ts`, `src/records/Task.ts`)
  and found by its commit message too; a hand-over at the first prompt that
  asks for something and again at the first after each commit, never for one
  that asks for nothing (`src/scripts/Cycle.ts`).

The suite (`examples/markdownlint/day-driver.mjs`, `tasks-day.json`): the
twelve markdownlint tasks in order, their hidden checks, as four
conversations (tasks 1-2, 3-5, 6-8 and 9-12), each a Claude Code session
resumed for every prompt (`claude -p --resume`). Each opens on a task of
another kind than the one before (a new rule, a rule's option, a rename, an
option): memory as it was files a conversation's first change under the
opening prompt, so the next opening matches it word for word, and with every
conversation opening on a new rule that chance hand-over would always fit.

- it opens with "Morning! We'll make a few changes to our markdownlint fork
  today. Have a look around first (…) so you know your way around; don't
  change anything yet.", the same each time, as the user's own sessions open
  with "please read @HANDOFF.md";
- each task is asked for in its own prompt with the same spec as before but
  without the list of what every change of its kind needs ("Do it the way the
  existing rules are done: documentation, README, config schema …"), and
  without "Commit when you're done"; t02, t05, t08 and t11 ask for a plan
  first, approved with "sounds good, go ahead";
- then "looks good, commit it", and the next task follows in the same
  session;
- after each task the driver commits eight unrelated changes (CI and
  dependabot settings, files no task touches), so a task's look-alike sits at
  least nine commits down.

Same for every arm: Claude Code 2.1.296 (pinned copy), Sonnet, effort
medium, `--setting-sources project,local` (the user's settings, CLAUDE.md
and skills left out), a session cost limit of $12. With memory, the hooks
setup writes, run on the arm's code through `--settings`, the recall note in
the system prompt and `singularity` on PATH. SessionEnd is left out of the
hooks: Claude Code fires it after every `-p` turn, where a session in T3
Code goes on between prompts. Three passes, the arms of a pass side by side,
below normal priority.

Checks per task, on its commit, in a throwaway clone: hidden tests,
`npm test`, `npm run lint`, and regenerate, which now compares the type
declarations whether or not lib/ type-checks (tsc writes them anyway): the
same for every arm, unlike the driver's earlier check. `types` (lib/
type-checks) is reported only.

## Outcomes and bars

Read from the records (`score-day.mjs`), in this order:

1. **Harm first**: a task that passed without memory and failed with it in
   the same pass; runs of failures (a failure after a pass, carried over or
   not) per arm.
2. **new against without**, dollars of every turn of the day (the person's
   bill, the openings included), paired by task and pass (the opening counted
   with its conversation's first task), with a bootstrap 95% interval over the
   36 pairs: **helps** at -10% or better with the interval below zero and no
   more runs of failures; **hurts** at +10% or worse, or with more runs of
   failures; else no clear difference. Tasks 2-12 alone and tokens are
   reported too.
3. **new against old**, by the same rules: whether the fix pays.
4. **How** (reported, no bar): each arm's hand-overs, by the prompt that got
   one (opening, request, approval, commit instruction) and by moment (start,
   file), whether what was handed over is a change of the same kind; and the
   tasks the records were filed under.

Without the list of what a change of its kind needs, both arms can miss
docs, the schema or snapshots, and a miss fails the tasks after it until an
agent fixes it: pass counts will swing more than before, and a swing alone
isn't harm. Old and new differ in two things at once (what is stored, and
when a hand-over is tried); the hand-over log tells which hand-overs only
the new rule made.

## Cost

About $5 an arm and pass, $45 in all; no pass starts once $60 is spent.

## Known limits

- One repository, tasks that build on each other, prompts written by us, not
  sealed by another agent.
- Commits made outside the agent (T3 Code's commit button) aren't in the
  suite; memory still finds no boundary at them (`lastCommitBefore` in
  `src/workflows/Commits.ts`), which this fix doesn't change.
- Windows; one Claude Code version.
