# Pre-registration: a long stretch of work, with singularity as installed and without

Written 2026-10-11, before any counted run. Not committed (commits wait for
the user).

## The question

The user's: do a very long task with and without singularity, using
singularity the way any agent would, isolated, and let it do its job without
forcing it.

Every earlier measurement handed agents memory that was built by hand and
frozen, on tasks of the repositories memory was developed against. This one
measures the product as installed: a repository singularity has never seen,
memory starting empty, every change stored by the hooks when the agent
commits, learning on its own in the background, hand-overs at each task's
start. Does that loop pay for itself over a long stretch of work, its
learning included, without making the work worse?

## The work

[markdownlint](https://github.com/DavidAnson/markdownlint), upstream
`3f1f4793` (2026-07-27), plus one commit of ours (`314ab18e`): its docs build
wrote `os.EOL`, so on Windows regenerating the docs dirtied an LF checkout;
it now writes LF as it does on Linux. The repo was picked because its changes
follow a heavy convention: a new rule touches about ten places (rule module,
registry, doc source, generated docs, README list and tag lines, schema
builder, generated schema, config examples and types, test fixtures with
markers, snapshots), and `npm test` holds coverage at 100% and counts
assertions in places.

Twelve tasks (`tasks.json`), asked in this order, each in a fresh session, as
a maintainer would ask an agent, each ending "commit when you're done":

| # | task | kind | what memory could do |
|---|---|---|---|
| 1 | MD061 `heading-max-level` | new rule | nothing yet (empty) |
| 2 | MD062 `code-block-max-lines` | new rule | nothing yet; a first build follows (2 changes) |
| 3 | MD024 `ignore_case` | parameter on an existing rule | help: shares the schema, docs and test steps |
| 4 | MD063 `list-max-depth` | new rule | help |
| 5 | `getRules()` export | one-off | nothing to give; could mislead |
| 6 | rename `doc-build` to `doc-src` | update | makes learned paths wrong |
| 7 | MD064 `link-url-scheme` | new rule | help, if it follows the rename; hurt if it hands over the old folder |
| 8 | example custom rule `todo-comments` in `test/rules` | look-alike | its words match "add a rule"; the steps don't |
| 9 | MD014 `prompts` | parameter on an existing rule | help |
| 10 | MD065 `ol-delimiter-style`, fixable | new rule | help; one new step (the fixable list) |
| 11 | circular `extends` in `readConfig` | one-off bug fix | nothing to give; could mislead |
| 12 | MD066 `no-empty-headings`, no parameters | new rule | help |

The new rules differ in logic and parameters (none is a copy of another with
names changed). Defaults were chosen so that four of the six new rules report
nothing until configured (as upstream's MD060 does) and two fire on one or
two existing fixtures, measured before writing the prompts.

## The two arms

Both: Claude Code 2.1.295 (a pinned copy), `claude -p`, Sonnet, medium
effort, `acceptEdits` with Bash, PowerShell, Read, Edit, Write, Glob and Grep
allowed, no MCP servers, $5 and 60 minutes at most per task, Claude Code's
auto-memory off (as in every eval here), below normal priority. Each arm has
its own clone with its own `node_modules`; the two run side by side, task 1
started at the same moment in both.

- **without**: `SINGULARITY_HOOKS=off`, so the installed hooks exit at once.
  The singularity skill stays in the agent's skill list in both arms (it's
  installed user-wide); here `SINGULARITY_HOME` points at an empty folder, so
  the skill or command would find nothing.
- **with**: the installed hooks (singularity at `10f5749`; the later commits
  change setup's printing only) fire as in the user's sessions, with
  `SINGULARITY_HOME` pointing at a memory home of the experiment's own, so
  nothing reaches the user's `~/.singularity`. Its `config.json` is the
  user's: learning on its own on, every 3 changes, $10 a day, through Claude
  Code. Memory starts empty. Nothing is built, picked or handed over by hand.
  Between tasks the driver waits until singularity's background storing and
  learning are done (the pause a user leaves between tasks); the wait is
  reported.

`driver.mjs` runs an arm. A smoke session (2026-10-11, $0.06) checked that a
commit made in a `claude -p` session with the installed hooks is stored.

## Checks

On the commit the session left (uncommitted work fails and is cleared before
the next task), in a throwaway clone:

1. the task's hidden test (`hidden/<task>.test.mjs`), written by two other
   agents before any run, from the prompts alone, and checked to fail at the
   base and pass against reference implementations (`reference/`);
2. `npm test` (the repo's own suite, 100% coverage);
3. `npm run lint`;
4. regenerating the schema and docs leaves no change, nor do the type
   declarations when their build succeeds.

A task passes when the session committed and all four pass. The declaration
build also type-checks `lib/` with tsc; the prompts don't ask for that, so it
is reported for each task (`types`) and not counted.

The writers' reports led to clearer wording in four prompts before any run
(t02: how lines and languages are counted; t07: schemes without the colon,
an autolink's context; t08: what a whole word is, every line; t09: today's
rule for `$`, generalized), and one check was relaxed (t05 lets an extra key
through). Every hidden test fails at the base and passes against its
reference, also after the rename for the tasks that follow it (checked again
independently, `tools/validate.mjs`), and all twelve pass in one cumulative
tree.

## Measures

Per task and in total, per arm: pass or fail; dollars (`total_cost_usd`);
tokens (new input, cache writes, cache reads, output); turns; wall time.
With singularity also: what each task start handed over (characters,
workflows), what was stored or left out, and what each learning round cost.

## Bars, set now

1. **Harm first**: every task that passes without singularity and fails with
   it is reported before anything else.
2. **Singularity helps** only if all three hold:
   a. no more failed tasks than without;
   b. on tasks 3-12 (the ones memory could reach), agent tokens at least 20%
      lower and agent dollars at least 10% lower;
   c. over all twelve tasks, dollars with singularity, its learning included,
      lower than without.
3. Otherwise: **doesn't pay off here**; and **hurts** if (a) fails or the
   dollars of (c) are higher.

Read out per kind, without bars: the new rules memory could reach (4, 7, 10,
12), the parameters (3, 9), the one-offs (5, 11), the rename and the task
right after it (6, 7), the look-alike (8).

## Known limits

- One run per task per arm. Earlier measurements here saw large spreads
  between runs of the same task; a single task's difference means little,
  the totals more.
- Each arm builds on its own earlier work, so later tasks start from
  slightly different code.
- The two arms share Anthropic's prompt cache for what their sessions have
  in common (Claude Code's own prompt; the task prompt when both start a
  task within the hour).
- The waits between tasks favour singularity over a user who starts the next
  task the moment the last one ends.

## Cost, estimated

Agent runs about $1 a task, $10-25 an arm; learning about $0.5 a round, four
rounds. About $25-50 in all.

## Results (2026-10-11, 01:25-02:40 UTC)

Both arms ran all twelve tasks to the end, side by side. Records, scores,
hand-overs and singularity's logs are in `results/`; the transcripts stay in
`C:\singularity-workspaces\long\runs`.

**Harm first: none.** All 24 sessions passed all four checks. No task passed
without singularity and failed with it.

**Singularity cost more, and the verdict by the bars is: hurts.**

| | without | with singularity |
|---|---|---|
| tasks passed | 12 of 12 | 12 of 12 |
| agent dollars | $3.93 | $4.44 (+13%) |
| learning | none | $2.59 (4 rounds) |
| all-in dollars | $3.93 | $7.04 (+79%) |
| tokens | 8.46M | 9.92M (+17%) |
| turns | 220 | 226 |
| agent time | 27 min | 30 min, plus 41 min waiting for singularity |

On tasks 3-12, the ones memory could reach: tokens +12%, dollars +8%. (a)
holds; (b) fails (it asked -20% and -10%); (c) fails. The spread between
single runs is large (task 2, before any memory, cost +50% in one arm), so a
task's own difference means little; the totals and the learning bill don't
hang on one task.

| # | task | kind | without | with | handed over |
|---|---|---|---|---|---|
| 1 | heading-max-level | new rule | $0.37 | $0.39 | nothing (empty) |
| 2 | code-block-max-lines | new rule | $0.49 | $0.74 | nothing (empty) |
| 3 | MD024 ignore_case | parameter | $0.22 | $0.25 | new-rule docs and schema steps, `{tag}` filled with "# Install" |
| 4 | list-max-depth | new rule | $0.24 | $0.31 | all six new-rule workflows, 10.7k chars |
| 5 | getRules() | one-off | $0.22 | $0.37 | new-rule workflows ("built-in rules" in the prompt matched) |
| 6 | rename doc-build | update | $0.07 | $0.09 | the new-rule docs workflow |
| 7 | link-url-scheme | new rule | $0.40 | $0.43 | all six, with `doc-build/` (gone since task 6) and garbage fills |
| 8 | todo-comments example | look-alike | $0.49 | $0.33 | fixtures, test counts, finish |
| 9 | MD014 prompts | parameter | $0.39 | $0.33 | "add a parameter to an existing rule", 3.9k chars |
| 10 | ol-delimiter-style | new rule | $0.49 | $0.57 | five new-rule workflows |
| 11 | circular extends | one-off | $0.22 | $0.26 | the finish only |
| 12 | no-empty-headings | new rule | $0.33 | $0.37 | five new-rule workflows |

What the runs show:

1. **The baseline had a procedural memory of its own: the repo's history.**
   Without singularity, agents looked up earlier commits before their first
   edit in 8 of 12 sessions (`git log --stat` on upstream's MD059 and MD060
   in task 1; `git show --stat HEAD~1`, then its diff, from task 4 on) and
   copied the whole procedure from the last rule added. Their cost fell from
   $0.49 (task 2) to $0.24 (task 4) with no memory. With singularity, agents
   did the same in 6 of 12 sessions, after reading the hand-over: they paid
   for both. In task 9 the hand-over replaced the lookup, and it was cheaper.
2. **Hand-overs were picked by surface words and often didn't fit.** Round 1's
   cues were generic ("documentation", "schema", "add tests", "npm test"), so
   the parameter task, the API export and the rename got new-rule steps.
   Blanks are filled by position (`{tag}` = the prompt's second code span:
   "# Install" in task 3). A one-rule prompt written as a bulleted spec was
   read as four changes (tasks 7, 10, 12), with fills like `{tag}` = `npm
   test`. Task 7 was told to create the doc source in `doc-build/`, renamed
   away one task earlier. Several steps say to hand-edit files `npm run
   build-config` generates. The text says files are "named like the 66 there
   that start with ``" (an empty prefix). Agents ignored what didn't fit (no
   failures) and paid to read it.
3. **Learning cost two thirds of the whole baseline's agent bill.** Four rounds:
   $0.30 (6 workflows from 2 changes), $0.53 (rejected by its own replay
   gate: the revision fit the runs worse), $0.78 (9 workflows and 2 known
   mistakes, sharper cues), $0.98 (rejected). Half the spend changed nothing.
   Rounds took 2.5 to 14 minutes; a user who started the next task at once
   would have worked with the older memory.
4. **Where it helped**: after round 3, the parameter task got one precise
   workflow (task 9: -14% dollars, -36% turns) and the look-alike got only
   test steps (task 8: -32%). The workflows learned for the rename, the
   custom-rule example and the API export never had a second use: none of
   those kinds came back.
5. Nobody reached for singularity on their own: no agent in either arm ran
   the command or the skill. Memory arrived only through the hooks.

Not counted, reported: the declaration build's type check failed from task 4
on without singularity and from task 9 on with it (one type error introduced
in each arm, which then stayed).

## A second with arm, with the daily-learning fixes

Written 2026-10-12, before its run.

**Why.** Memory's parts didn't work in the first run's daily use. The
search deciding which words are a task's own timed out, so learning dropped
steps and whole workflows. Task labels merged six rule tasks into one.
Failures piped through other commands went unseen, so memory learned 2 known
mistakes instead of the repo's real traps. Lookups and hand-overs never
reached learning. Rounds counted places over the new changes only. Numbered
file names had no kind. All are fixed on `t3/daily-learning-fixes` (not
committed yet), with two changes to learning the user agreed to: a rejected
round keeps its new known mistakes, and the replay gate counts a place it
misses twice one it shows for nothing. Replays of learning alone on the first
run's stored changes ($8.63 in all, no agent runs) learned the traps. Only
running the tasks again says whether that helps the agents.

**What runs.** The with arm only (the user's choice), measured against the
first run's without arm. Everything is as in the first run: the tasks and
their order, Claude Code 2.1.295, Sonnet, medium effort, the limits and the
checks, memory starting empty with the same `config.json`, and the waits
between tasks. Three things differ:

- Singularity's code is the branch as of today: main `9d241f2`, which
  differs from the first run's `10f5749` in setup's printing only, plus the
  fixes. It runs from a frozen copy (`sg-app-2`, with its diff). It isn't
  installed, so the sessions get twins of the installed hooks through
  `--settings`, run by `run-hook.mjs` on the copy, while the installed ones
  exit at once as in the without arm (`driver.mjs --app`). A smoke session
  ($0.05) checked that the twins fire on every event and store a commit, and
  that the user's own memory home stays untouched.
- Learning runs the pinned copy of Claude Code (`SINGULARITY_CLAUDE`). The
  first run's learning ran the one on PATH, which was the same version.
- The clone is fresh (`arm-with-2`), from the same source at `314ab18e`,
  with the first arms' `node_modules`.

**Bars.** The first run's, against its without arm.

**Known limits.**

- The baseline ran a day earlier, side by side with the first with arm. This
  arm runs alone, so it shares no prompt cache with a baseline running at the
  same time, and a day's drift isn't controlled.
- The fixes were found in these twelve tasks' sessions, so a result here is
  on the tasks they came from. Whether they help elsewhere needs a repo they
  weren't found on.
- One run per task, as before. Single runs vary a lot: task 2 cost 50% more
  in one arm before any memory existed.

**Cost, estimated.** About $7: agents about $4.5, learning about $2.5-3.

### Results (2026-10-11, 19:43-22:08 UTC)

The arm ran all twelve tasks. Records, scores, hand-overs, singularity's logs
and the code's diff are in `results/rerun/`. One interruption: at 20:29, 2.4
minutes into task 9, the run's console window got a Ctrl+C or was closed.
Windows Terminal, the default terminal here, had shown the started console in
a window of its own. The driver died with it. Task 9's cut-off session (about
$0.51) isn't counted; its work was saved and cleared, and the run resumed from
task 9 at 21:47 with memory as it was and no window (`launch.ps1` now starts
hidden). Task 9 started on a cold prompt cache.

**Harm first: task 3** passed without singularity and failed with it. Its
committed docs missed the new parameter's line, so regenerating them changed
them. Memory's closing command listed `npm run build-docs` before `npm run
build-config`, and the agent ran them in that order, but the docs build reads
the schema the config build writes. The first run's hand-overs had the same
order (tasks 3, 4 and 7); those agents didn't follow it.

**The verdict by the bars is "hurts", as in the first run.**

| | without (first run) | first with | second with |
|---|---|---|---|
| tasks passed | 12 of 12 | 12 of 12 | 11 of 12 |
| agent dollars | $3.93 | $4.44 (+13%) | $4.29 (+9%) |
| learning | none | $2.59 | $2.63 |
| all-in dollars | $3.93 | $7.04 (+79%) | $6.92 (+76%) |
| tokens, tasks 3-12 | | +12% | +6% |
| dollars, tasks 3-12 | | +8% | +6% |

| # | task | without | second with | handed over |
|---|---|---|---|---|
| 1 | heading-max-level | $0.37 | $0.42 | nothing (empty) |
| 2 | code-block-max-lines | $0.49 | $0.61 | nothing (empty) |
| 3 | MD024 ignore_case | $0.22 | $0.28, failed | new-rule docs, schema and test counts, 9.7k chars |
| 4 | list-max-depth | $0.24 | $0.34 | five new-rule workflows, 14.6k |
| 5 | getRules() | $0.22 | $0.27 | four new-rule workflows, 11.3k |
| 6 | rename doc-build | $0.07 | $0.08 | nothing |
| 7 | link-url-scheme | $0.40 | $0.45 | five new-rule workflows, 15.4k |
| 8 | todo-comments example | $0.49 | $0.30 | nothing |
| 9 | MD014 prompts | $0.39 | $0.48 | "add a parameter to an existing rule", 6.0k |
| 10 | ol-delimiter-style | $0.49 | $0.48 | five new-rule workflows, 15.6k |
| 11 | circular extends | $0.22 | $0.23 | nothing |
| 12 | no-empty-headings | $0.33 | $0.34 | five new-rule workflows, 17.6k |

What the run shows:

1. **Learning now works, at the same price.** Four rounds cost $2.63. The
   third was rejected by its gate and kept its 4 new known mistakes. Memory
   ended with 10 workflows and 12 known mistakes; the first run's had 9 and 2.
2. **It didn't make the agents cheaper.** Where memory handed nothing over
   (tasks 1, 2, 6, 8 and 11), the two arms spent the same in total ($1.64
   each): the spread between single runs evened out there. Where it handed
   something over (the other seven), agents spent 15% more ($2.64 against
   $2.29).
3. **The baseline's own memory still wins.** Agents looked up the last rule's
   commit before their first edit in 7 of 12 sessions without singularity and
   6 of 12 with it. On the new rules (4, 7, 10 and 12) they read a hand-over
   of 15-18k characters and then looked the commit up anyway.
4. **Picking still goes by surface words.** The parameter task (3) and the
   API export (5) got new-rule workflows, and `{tag}` was again filled with
   "# Install". The rename, the look-alike and the bug fix got nothing, which
   cost nothing.
5. Task 4's session took 12.5 minutes: a command hung, Claude Code moved it
   to the background after two minutes, and the session waited for it after
   its work was done. Its tokens are counted over all its turns: `score.mjs`
   now sums `model_usage`, because the result's `usage` holds only the last
   turn.

Not counted, reported: the declaration build's type check failed from task 2
on.
