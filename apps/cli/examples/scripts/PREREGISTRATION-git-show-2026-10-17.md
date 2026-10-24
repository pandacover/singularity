# Pre-registration: the hand-over on git show, in daily use (2026-10-17)

Written before any counted run.

## Question

Does memory on main, with the hand-over by commit (PR #34, `86d454a`: after
a `git show` or `git log -p|--stat` of a stored commit, the tool-call hook
adds "What git doesn't show about <sha>": the request, the project commands,
the mistakes; `src/scripts/History.ts`), cut the dollars of daily use against
no memory?

On 2026-10-16 the same suite gave -6% dollars (95% interval -13% to +1%),
and agents `git show`ed the previous commit in 12 of the 21 sessions that got
a start hand-over anyway. A free replay of those sessions
(`replay-git-handover.ts`) had the add-on fire 15 times in 13 of 36 sessions;
12 named a mistake, and in 5 the session made that mistake later.

## Arms

The markdownlint daily-use design of `PREREGISTRATION-eval-2026-10-16.md`,
unchanged, so results compare:

- **without**: `SINGULARITY_HOOKS=off`, an empty `SINGULARITY_HOME`;
- **with**: main at `daa5146`, frozen (`git archive`, `npm ci --omit=dev`) in
  `C:\singularity-workspaces\eval-1017\app`, its hooks through `--settings`
  (`driver.mjs --app`), a fresh memory home per pass, the recall note in the
  system prompt, `singularity` on PATH.

The twelve tasks in order, each in a fresh session, in a clone at `314ab18e`
(`C:\singularity-workspaces\eval-1017\ml`), three passes, the arms of a pass
side by side. Claude Code 2.1.295, the 10-16 copy
(`C:\singularity-workspaces\_claude\2.1.295\claude.exe`, byte-identical to
`~/.local/share/claude/versions/2.1.295`), Sonnet, effort medium,
`--setting-sources project,local`, $5 and 60 minutes per task, below normal
priority. Script: `run-markdownlint-passes.sh` with `ROOT`, `APP` and `CC`.

**What the arms differ in.** `daa5146` is not `a7ede11` (the 10-16 with arm)
plus the add-on: main also files records under the prompt that asked
(`Requests.ts`, `Task.ts`), finds them by commit message, renders hand-overs
differently (`Render.ts`), hands over again after each commit (`Cycle.ts`;
every session here is one task, so this rarely applies), and stores a commit
once. The start hand-overs' picks on the 10-16 memory were unchanged by these
(36 of 36, `check-search-messages.ts`). So the arm difference measures main;
the add-on's own part is read from its fires (outcome 3), not from it.

## Outcomes and bars

Read in this order:

1. **Harm first.** A task that passed without memory and failed with it in
   the same pass; runs of failures per arm (a failure after a pass, counted by
   the task that started it). Passes counted with the declarations compared
   in both arms (`check-declarations.mjs`), the driver's checks reported too.
2. **Dollars per task, with against without**, every task's session, paired
   by task and pass, bootstrap 95% interval over the 36 pairs (`score-eval.mjs`):
   - **helps**: -10% or better, the interval below zero, and no more runs of
     failures;
   - **hurts**: +10% or worse, or more runs of failures;
   - else **no clear difference**.
   Tokens and tasks 3-12 alone are reported, without a bar.
3. **The add-on's own part** (the informative measure; no bar, see power):
   - fires: from the with arm's `handovers.jsonl` (`moment: "git"`): how many,
     in how many sessions, their size, on which tasks;
   - for each fire that names a mistake (by kind, `keysOf` in
     `replay-git-handover.ts`: plan counts, snapshots, the schema, the README,
     lint rules, …): whether the session made a mistake of that kind after
     the fire, against the replay's 5 of 12, and whether the paired session
     without memory (same task, same pass) made it;
   - dollars of the sessions with a fire against their paired sessions
     without memory, and of the sessions without one.
4. Reported only: start and file hand-overs, `singularity recall` calls, and
   a reference row for the 10-16 with arm (another day, another cache; no
   bar against it).

**Power.** Three passes of twelve tasks told -6% from zero only within -13%
to +1%. The add-on fires in about a third of the sessions and can at most
shorten their check-and-fix loops, so outcome 2 will likely read no clear
difference whatever the add-on does. Outcome 3 is where its effect shows, if
it has one.

## Cost and stops

10-16 spent $21.05 on this suite (both arms, three passes); estimate $21-23.
Each task is capped at $5. No pass starts once $25 is spent. On a 429 or a
usage-limit message, the run stops and waits for the user; a pass a 429 cut
short is rerun whole, not counted.

## Known limits

- One repository, tasks written by us, not sealed by another agent; each task
  a fresh session, not the user's long conversations.
- Claude Code 2.1.295, as on 10-16, not today's 2.1.300; Windows.
- The arms share Anthropic's prompt cache for what they have in common.
- Whether a session "made a mistake later" is read from failed calls'
  output by pattern; a kind the patterns don't know is missed in both arms.

## Results (2026-10-17, 17:05-19:21 UTC)

In `RESULTS.md`, "The hand-over by commit, paid, in daily use". $21.27
spent, no rate limit. In short:

- Harm: five tasks in pass 2, all from one miss: t05 committed stale
  declarations, and t06, t07, t08 and t10 carried it (t09, t11 and t12
  failed without memory too). Memory handed that t05 session nothing. Runs of failures, declarations
  compared: with 3, without 5.
- Dollars: -1.9% (95% interval -11.7% to +7.7%): no clear difference.
- The add-on fired 12 times in 12 of 36 sessions; 8 named a mistake, and 6
  of those sessions made it anyway (all five plan-count warnings). Sessions
  with a fire: +6% dollars against their pairs.

Data: `results/git-show-2026-10-17/`; scoring: `score-eval.mjs`,
`check-declarations.mjs`, `score-git-show.mjs`.
