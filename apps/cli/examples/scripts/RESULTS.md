# Saved scripts: results

Saved scripts hand over, at task start, the one stored commit whose task is
most like the new one, read from git at use time: the past task, the files it
changed (renames followed), the project commands it ran, its mistakes and
those other changes made in the same files, and its diff. No workflows, no
learning step, no model call. Search is word containment times cosine
(`src/scripts/Search.ts`), with nothing handed over below 0.38.

All runs on 2026-10-14 in a cloud container (Linux), with a clean Claude Code
config folder.

## markdownlint daily driver (12 tasks, Claude Code 2.1.295)

Both arms on the same machine, same version, one pass each
(`results/markdownlint/`).

| | passed | cost | tokens |
|---|---|---|---|
| no memory | 7 of 12 | $3.06 | 6.25M |
| saved scripts | 12 of 12 | $2.65 | 4.84M |

Saved scripts used 13% less money and 23% fewer tokens, with no learning bill.

The saving comes from the hand-overs. On the 7 tasks that got one (t02, t03,
t04, t07, t09, t10, t12) cost fell 20% ($2.21 to $1.77) and tokens 29% (4.69M
to 3.31M). On the 5 that got nothing (t01, t05, t06, t08, t11) both arms cost
about the same ($0.85 and $0.88).

No memory's failures: t05 didn't regenerate `lib/*.d.mts`, and t06, t07 and
t08 failed the same check on the stale files it left. t09 left one branch
untested, so the 100% coverage check failed; with saved scripts t09 was handed
t03's change and passed. One pass per arm: the pass gap is suggestive only.

The older numbers in `../markdownlint/results/` ran on Windows and aren't
comparable: there, tasks with nothing handed over cost 35% more than here.

## excalidraw long tasks (Claude Code 2.1.296)

Memory built from the 6 seed runs (`eval run --setup scripts`). No-memory and
main numbers are from `PREREGISTRATION-v1-edges.md` (same version, also a
cloud container, 2026-10-13), not rerun.

| task | arm | runs | passed | median tokens | range |
|---|---|---|---|---|---|
| long-four-changes | no memory | 8 | 8 | 1,180k | 601k-1,600k |
| long-four-changes | main | 8 | 8 | 1,188k | 672k-1,467k |
| long-four-changes | saved scripts | 8 | 8 | 1,079k | 966k-1,882k |
| long-mixed-changes | no memory | 4 | 4 | 1,051k | |
| long-mixed-changes | main | 4 | 4 | 802k | |
| long-mixed-changes | saved scripts | 4 | 4 | 489k | 409k-559k |

On long-four-changes saved scripts is within the noise of the others (8% below
no memory; the arms there differed by up to 7% between batches). On
long-mixed-changes it used 53% fewer tokens than no memory and 39% fewer than
main, and its highest run is below main's median. Cost: $3.11 for the 8
long-four runs, $0.93 for the 4 long-mixed runs.

## Rerun with staleness checks, smarter cutting and the recall note (2026-10-15)

Same machine and Claude Code versions. Saved scripts now check each file
against today's code, retire stale scripts, give hand-written source the room
first, and the agent has the recall note (CLAUDE.md in markdownlint, the
system prompt in excalidraw) with a `singularity recall` command on PATH
(`results/rerun/`).

| markdownlint | passed | cost | tokens |
|---|---|---|---|
| no memory (second pass) | 12 of 12 | $3.19 | 6.11M |
| saved scripts | 9 of 12 | $2.64 | 4.61M |

Saved scripts used 17% less money and 25% fewer tokens. On the 7 tasks with a
hand-over cost fell 19% ($2.18 to $1.76) and tokens 27%; the 5 without one
cost $1.01 and $0.88. Its failures: t10 ran `npm run build-declaration`,
whose type check failed and left the temporary `dts/` folder, and committed
it; t11 and t12 then failed the same check on those files. t10's hand-over
did warn that `build-declaration` had failed before, with the type error, but
not that a failure leaves `dts/` behind. Over both passes: saved scripts 21 of 24, no memory
19 of 24, each arm losing a run of tasks to one carried-over mistake.

| excalidraw | runs | passed | median tokens | range |
|---|---|---|---|---|
| long-four-changes | 8 | 8 | 1,247k | 823k-2,016k |
| long-mixed-changes | 4 | 4 | 604k | 490k-810k |

Within the noise of the first saved-scripts runs (1,079k and 489k) and still
below no memory on long-mixed-changes (1,051k).

No agent ran `singularity recall` mid-task: 0 calls in 12 markdownlint tasks
and 12 excalidraw runs.

## Hand-over by file, three passes (2026-10-15)

When the task start hands over nothing, the first watched file the agent
edits brings a stored change to that file (`src/scripts/Watch.ts`); start
hand-overs are unchanged. markdownlint only: excalidraw's harness hands over
through the system prompt, so the file hand-over can't fire there. Same
machine and Claude Code 2.1.295 (`results/file-handover/`). Tokens are
counted from the transcripts: in pass 3, t01's result line covers only its
last turn (a command moved to the background), so summing that pass's records
gives 0.55M fewer.

| markdownlint | passed | cost | tokens |
|---|---|---|---|
| no memory, pass 1 (2026-10-14) | 7 of 12 | $3.06 | 6.25M |
| no memory, pass 2 | 12 of 12 | $3.19 | 6.11M |
| no memory, pass 3 | 12 of 12 | $2.84 | 5.38M |
| hand-over by file, pass 1 | 8 of 12 | $2.56 | 4.52M |
| hand-over by file, pass 2 | 12 of 12 | $2.92 | 5.48M |
| hand-over by file, pass 3 | 1 of 12 | $2.70 | 5.10M |

Per pass, the new code cost 10% less than no memory ($2.73 against $3.03)
and used 15% fewer tokens (5.03M against 5.91M). Over all five saved-scripts
passes (these three and the two above), the 7 tasks with a start hand-over
cost 16% less ($1.75 against $2.09) and used 24% fewer tokens (3.22M against
4.21M); the other 5 cost the same ($0.94 both).

The file hand-over fired on t11 in passes 1 and 2: an edit of
`lib/markdownlint.mjs` brought t05's `getRules` change. In pass 3 t05's
commit wasn't stored (its last `npm test` failed on the coverage gap below),
so that file wasn't watched. t11 cost $0.17 and $0.19 with it, $0.15 to $0.22
with no memory: no effect this suite can show.

A task that leaves a check failing fails every later task until an agent
fixes it, so pass counts swing. Pass 3 lost 11 tasks to one branch t02 left
untested in `lib/md062.mjs`; no later agent fixed it. Counting only the task
that started each run of failures: no memory 2 of 36 (t05 and t09 in pass 1),
saved scripts 4 of 60 (t10 in the rerun above, t09 and t10 in pass 1, t02 in
pass 3).

Both t10 failures followed a hand-over that named `npm run
build-declaration` among the mistakes. From t04 on it fails here, on type
errors in `lib/md063.mjs`, and leaves a `dts/` folder, which t10 committed
both times. Over all eight markdownlint passes, agents ran it in 8 of the 10
task runs whose hand-over named it, and in none of the other 78 (t05 aside,
whose task asks for the type declarations). 8 of those 10 hand-overs got it
from "Mistakes other changes to these files made", linked to t05 only
through `README.md` and `test/markdownlint-test.mjs`, files most stored
changes touch (7 and 9 of 11 in pass 1).

One agent ran `singularity recall` in the 36 runs: t01 of pass 2, with
nothing stored yet.

Fix, not yet measured in runs: other changes' mistakes now come only through
a code or test file few stored changes touched (`Search.tellingFiles`).
Replayed on the 37 hand-overs of the five saved-scripts passes
(`check-other-mistakes.ts`), they show 11 of the 81 other changes' mistakes
they showed, and 1 of the 9 hand-overs whose mistakes named
`build-declaration` still does: t05's own, handed over to t11 by file.

## Every suite on main, on Windows (2026-10-16)

Main at `a7ede11` (the first runs of the fix above), on the user's Windows
machine, both arms here, side by side or interleaved
(`PREREGISTRATION-eval-2026-10-16.md`; data in `results/eval-2026-10-16/`).
Sessions leave the user's own settings out (`--setting-sources
project,local`): with them, eval agents also got an advisor tool, the user's
CLAUDE.md and about 40 skills. Claude Code 2.1.295 for markdownlint and
2.1.296 for the harness, pinned. Not comparable with the cloud numbers
above in absolute terms; the gap between arms is the result.

### Harm first

markdownlint: t05 failed with memory and passed without in passes 2 and 3
(the type declarations it edited by hand didn't match a fresh build), and
the three tasks after it failed on what it left. Memory handed t05 nothing
in any pass (its best score was 0.34, under the bar). The no-memory arm's
t05 left stale declarations too in pass 3 (hidden there by type errors),
and failed the same check in pass 1 for another reason (a Python edit
rewrote files with CRLF): with the declarations compared in both arms
(below), it is harm in pass 2 only. The harness suites: no run failed
with either setup (90 of 90 passed). By the plan's rule
dropdown-outside-click hurts (median tokens +13%), though memory handed it
nothing but the recall note: its three runs with the note (294k-378k
tokens) all came in above the three without (252k-290k), and none ran
`singularity recall`.

### markdownlint, daily use: three passes

| | without | with |
|---|---|---|
| passed, the driver's checks | 25 of 36 | 28 of 36 |
| passed, declarations compared in both arms | 16 of 36 | 12 of 36 |
| runs of failures, the driver's checks / both arms | 3 / 3 | 2 / 3 |
| dollars | $10.86 | $10.19 (-6%; 95% interval -13% to +1%) |
| tokens | 23.90M | 21.69M (-9%; -18% to -1%) |
| API calls | 608 | 551 |

The bars: (a) no more runs of failures holds; (b) on tasks 3-12, -8% tokens
and -6% dollars against -20% and -10%, fails; (c) fewer dollars over all
twelve holds. By the plan: **doesn't pay off here**. The intervals are a
bootstrap over the 36 task pairs.

The driver's pass counts mislead. It compares the committed type
declarations with a fresh build only when that build type-checks, which the
prompts don't ask for. In pass 1 the with arm's build stopped type-checking
at t02, which hid that its t05 left `lib/exports.d.mts` a typedef short; the
no-memory arm's still type-checked when its t05 went wrong, so that miss
failed the five tasks after it too. `check-declarations.mjs` builds the
declarations anyway (tsc writes them despite type errors) for every task:
then each arm has one run of failures a pass, all starting at t05 but the
no-memory arm's pass 2 (t09). The cloud passes above had the same blind
spot: in 7 of 8 the declaration build had stopped type-checking by t04; in
the first no-memory pass it held until t09, and that pass lost four tasks to
t05. Its 12 of 12 against 7 of 12 may be this artifact.

What memory did, task by task (medians of three passes; the hand-overs were
the same in every pass):

- t09, an option on MD014, was handed t03's (an option on MD024) and passed
  3 of 3; without memory it failed 3 of 3 (twice the new option's branch
  left untested, once on t05's leftover). It cost 12% more.
- t03 was handed t01's new rule for an option on an existing rule: +25%
  dollars and +37% tokens, in all three passes.
- t11, a bug fix, got t05's change by file in all three passes (both edit
  `lib/markdownlint.mjs`): +24% dollars, no help.
- t01, where memory is still empty, came out 15% cheaper with memory: about
  the noise of one task over three passes.
- Tasks with a start hand-over cost 6% less, tasks without one 8% less: the
  saving isn't where the hand-overs are.

21 start hand-overs (median 9.4k characters) and 3 by file. Six showed other
changes' mistakes, all about this work (test assertion counts, coverage,
lint), none `build-declaration`; no agent ran it after a hand-over. No agent
ran `singularity recall` (0 of 36 sessions with memory).

The no-memory arm's pass-1 t05 failed on Windows alone: a Python script it
edited with rewrote whole files with CRLF line endings.

### excalidraw, long tasks

| task | runs | passed | median tokens | median $ |
|---|---|---|---|---|
| long-four-changes, no memory | 8 | 8 | 1,590k | $0.55 |
| long-four-changes, scripts | 8 | 8 | 1,280k (-20%) | $0.44 (-21%) |
| long-mixed-changes, no memory | 4 | 4 | 1,307k | $0.50 |
| long-mixed-changes, scripts | 4 | 4 | 763k (-42%) | $0.30 (-39%) |

Both got toggle-minimap's script. long-mixed-changes clears the bar (helps);
long-four-changes misses it by a hair (-19.5% tokens against -20%), as in
the cloud runs, where it was within the noise.

### excalidraw, short tasks, and validator

Three runs a task with each setup; every run passed. Medians, no memory to
scripts:

| task | handed over (score) | tokens | dollars | by the plan |
|---|---|---|---|---|
| altkey-viewmode-j | altkey-zen-m (0.80) | 255k to 140k (-45%) | $0.12 to $0.08 (-33%) | helps |
| altkey-snap-u | altkey-zen-m (0.73) | 352k to 143k (-59%) | $0.17 to $0.07 (-56%) | helps |
| toggle-rulers | toggle-minimap (0.89) | 631k to 322k (-49%) | $0.31 to $0.21 (-34%) | helps |
| toggle-presenter | toggle-minimap (0.81) | 689k to 349k (-49%) | $0.29 to $0.15 (-50%) | helps |
| page-breaks | toggle-minimap (0.73) | 269k to 192k (-28%) | $0.13 to $0.10 (-26%) | helps |
| midpoint-snap-n | altkey-zen-m (0.40) | 410k to 262k (-36%) | $0.18 to $0.17 (-4%) | no clear difference |
| stats-shortcut-k | altkey-zen-m (0.63) | 824k to 684k (-17%) | $0.25 to $0.24 (-4%) | no clear difference |
| save-as-in-text | nothing (0.376) | 404k to 338k (-16%) | $0.15 to $0.14 (-6%) | no clear difference |
| dropdown-outside-click | nothing (0.19) | 261k to 294k (+13%) | $0.11 to $0.13 (+20%) | hurts |
| validator ulid | iso31661-numeric (0.44) | 177k to 113k (-36%) | $0.08 to $0.07 (-13%) | helps |
| validator postal-code-pk | nothing (0.26) | 196k to 195k (-1%) | $0.07 to $0.07 (0%) | no clear difference |

Pooled (each task's mean, summed; bootstrap 95% intervals over runs within
tasks): the seven short tasks with a hand-over -44% tokens (-54% to -30%)
and -35% dollars (-45% to -24%); the two without one +2% and +3% (-9% to
+16%); the long tasks -27% tokens (-37% to -14%) and -29% dollars (-37% to
-19%); validator -10% tokens (-27% to +11%) and -7% dollars.

### Why markdownlint's hand-overs didn't help

Every API call of the 72 markdownlint sessions, priced at its own usage
(summed per session it equals the record's cost; `where-money-goes.mjs`,
its output in `results/eval-2026-10-16/where-money-goes.txt`). A session's
first edit is its first write by any tool, the shell's included.

- Without memory, finding the past change is cheap. On the 7 tasks that got
  a hand-over, 19 of 21 sessions without memory read earlier commits before
  their first edit, nearly always one of the last three tasks', for 12% of
  their dollars. With the hand-over, 16 of 21 still did, 12 of them the
  very commit handed over, for 16% of theirs.
- The money goes to checking and fixing. On tasks 2-12, 45% of the
  no-memory arm's dollars came after its first check run, 24% between its
  first failing check and its last. On the 7 tasks, every session in both
  arms had a failing check run (a median of 4), mostly of kinds earlier
  tasks of the pass had hit: test assertion counts, snapshots, the config
  schema, the README's rule list.
- The hand-overs hid what those failures need. The assertion counts are in
  `test/markdownlint-test.mjs`, which every change edits, so it had always
  changed since: 18 of the 21 start hand-overs didn't show its change.
  Memory had stored the failures and their fixes (t01's record in pass 1:
  "plan expected 132 assertions", then `sed -i 's/files.length,
  62)/files.length, 63)/…'`), but a hand-over leaves out a mistake whose
  command spans lines (`mistakesToShow` in `src/scripts/Render.ts`): 42 of
  the 65 stored, 10 of them about assertion counts.

### What memory stored, and the most warning about it could save

`stored-mistakes.mjs` (output in `results/eval-2026-10-16/stored-mistakes.txt`)
sorts the 65 mistakes the with arm stored (a record's detours: a failed
call, the call that then worked, and the turns between; their token costs
match the transcripts in all 65) by what they teach:

| teaches about | stored | says what fixed it | made again later in the pass | left out of hand-overs | cost |
|---|---|---|---|---|---|
| this repository | 33 | 20 | 16 | 19 | $1.52 |
| this machine or its tools | 14 | 9 | 8 | 14 | $0.77 |
| only its own task | 4 | 4 | 0 | 2 | $0.18 |
| can't tell (says only that tests failed) | 9 | 7 | 0 | 4 | $0.43 |
| noise (a tool's own error, the agent's own assert) | 5 | 4 | 0 | 3 | $0.12 |

The repository's mistakes that came back are almost all the test counts
(`plan expected N assertions but received M`, 17 stored): the test run
prints the numbers, and they can't be known before it. Lint rules rarely
came back; each task tripped its own. The machine's are Python reading UTF-8
files as cp1252 on Windows (11) and Python string escapes breaking the
JavaScript it wrote (3), all in commands that span lines. A third record no
fix: the edit went through the shell, and the record keeps the passing
rerun.

The most the later tasks (3-12, $7.65 with memory) could have saved,
counting a mistake memory warned of as never made, by the same extractor
on both sides:

| memory tells the agent | all | without the test counts |
|---|---|---|
| what the hand-overs showed | 2.6% | 0% |
| every mistake of the change handed over | 5.1% | 0.7% |
| every mistake stored so far | 11.9% | 4.1% |

Of the 11.9%, the test counts are 7.8 points, the machine's mistakes 3.0,
the rest of the repository's 1.1. Bar (b) needed about 4.5 points more on
these tasks. Showing the mistakes the hand-overs dropped can't reach it
(0.7% beyond the counts). A list of every stored mistake could, on paper:
no warning spares a count mistake's first rerun ($0.19), but one naming
where the counts live could spare looking for them ($0.11) and the runs
after the first ($0.29), which leaves at most 9.4%. That needs most
warnings to work; 3.0 points of it are the Python trap, which `PYTHONUTF8=1`
removes for every agent without memory; and the runs after the first often
come from other failures in the same stretch.

`~/.singularity`, read only (57 records, 55 of this repository): 250 stored
mistakes, 131 left out of hand-overs as spanning lines, 99 with the files
edited recorded. In a sample of 21, about half are tool trips (a scripted
edit missing its anchor, `/tmp` paths on Windows, string escapes in code
written through a heredoc) and a third only their own task's.

### What it says

Where memory hands over a past change the agent can't see otherwise, it
pays. Harness runs start from the base commit, so the seed tasks' changes
exist only in memory, and excalidraw runs with a hand-over cost about a
third less; nothing handed over costs nothing either way. In daily use the
past changes are also in the repo's own history, and agents of both arms
read it unprompted (above). What git lacks, the failures past sessions hit
and what fixed them, memory stored but mostly didn't hand over, and handing
all of it over would have saved later tasks at most 9.4% of their dollars
if every warning worked, 3 points of it a Python setting. On
markdownlint memory saved 6% of dollars, inside the noise, and passed no
more tasks once both arms are checked alike. No agent ran `singularity
recall` in the 81 sessions that had the note.

Spent: $42.17 ($21.06 markdownlint, $20.94 harness, $0.17 probes of the
config and the hooks).

Also found: 217 of 218 unit tests pass here; `fresh.test.ts` "hands a second
clone of the repo the same script" fails on Windows on its own clone's CRLF
checkout (`core.autocrlf`), after the hand-over check it makes has passed.
The installed copy (`~/.singularity/app`) is at `79a7521`, two commits
behind main.

## What daily memory stores, and storing what was asked (2026-10-16)

Every benchmark session is one clean prompt. The memory of the user's own
sessions (`~/.singularity`, read only; `replay-real-memory.ts`, output in
`results/eval-2026-10-16/replay-real-memory.txt`) isn't: of its 59 changes,
29 were filed under a prompt that asks for nothing, such as "yes", "commit
and open a PR" or "please read @HANDOFF.md". A record's task was the first
prompt of its part of the log, and in a conversation that is the approval,
not the request. Search matched on that text only, so "please read
@HANDOFF.md" got the excalidraw eval-suite change at a score of 1.00, "yes"
got "Learn what a repo's changes share", and a real request for the
installer's spinner got nothing: that change was filed under "commit and
open a PR". Two changes filed under the same "commit and then start" also
counted as one change made twice, so the older would have been retired.
And the hand-over came only at a session's first prompt, so in a long
conversation every later task got none. Since setup, 4 task starts and 1
file hand-over were logged in daily use, and only the file hand-over handed
anything over.

The fix (`src/traces/Requests.ts`, `src/records/Task.ts`,
`src/scripts/Cycle.ts`):

- a prompt asks for something when, without filler, approval, commit and
  read-this words, at least four words of its own are left and it isn't a
  question about how things stand; all 31 benchmark task prompts do;
- a record's task is the first prompt of its part of the log that asks,
  else the session's last that asked before it, and it keeps its commit
  message; records stored before get the message from git when read;
- a change is found by its task only when that asks, and by its commit
  message when that has four words of its own (a one-word "MD061" matched
  every prompt naming the rule);
- the hand-over is tried at the first prompt that asks for something, and
  again at the first after each commit, never at one that asks for nothing.

Replayed on the 59 changes, with nothing written:

| | before | after |
|---|---|---|
| filed under a prompt that asks | 30 | 57 (49 from its own part of the log, 8 from before it) |
| findable by a commit message | 0 | 59 |
| prompts that ask for nothing ("yes", "commit and open a PR", "please read @HANDOFF.md", …) that got a random change | 7 of 7 | 0 of 7 |
| changes found again from the request that asked for them, among other sessions' changes | 2, both related | 4, all related |

Related means it changed a source or test file the change itself changed.
Most real requests still find nothing: they share too few words with any
earlier change, even when a related one exists (42 of 55 have one by that
measure), and word matching takes "installer" and "installers" for two
different words. The
markdownlint runs' picks are unchanged (36 of 36, `check-search-messages.ts`),
and the harness's are by construction (its saved runs have no message, and
all its prompts ask). 228 unit tests, 227 passing: the one failing is the
Windows-only CRLF test above.

## Does the note's wording make agents run recall? (2026-10-17)

No agent ran `singularity recall` in the 81 eval sessions of 2026-10-16
that had the note; in the user's own sessions one did, and it found nothing.
Six markdownlint tasks were each started from the repo and memory that pass 1
of that eval had before the task, with nothing handed over. Each was asked in
a fresh session under the note setup installs (A), and under a note that ties
recall to reading git history and drops "Don't run it at every step" (B). A
session ended at its first edit (`PREREGISTRATION-note-2026-10-17.md`,
`../markdownlint/note-test.mjs`; data in `C:\singularity-workspaces\note-test`).
Sonnet, Claude Code 2.1.296.

| | A, the installed note | B, before reading git history |
|---|---|---|
| ran recall before the first edit | 0 of 6 | 3 of 6 |
| read git history before the first edit | 4 of 6 | 3 of 6 |
| cost to the first edit, by tokens | $0.59 | $0.61 |

By the pre-registered rule (B in 4 or more of 6, A in at most 1), this is
inconclusive at this size. Seen afterwards, not planned:
- B's agents ran recall in each of the 3 sessions where they went to git
  history: as their first command, in the same call as `git show` of the
  previous commit. They didn't run it in the 3 sessions that didn't read
  history.
- The 4 of A's agents that read history never ran it.
- All 3 of B's recalls were on new rules (t04, t07, t10). Its t09 agent
  went straight to the rule's code.

Recall found the right change all three times, at score 1, because the
agents asked for the previous rule by its name ("add new rule MD062
code-block-max-lines"), which the session's recent commits show. They didn't
describe their own task. Then they read that commit with `git show` anyway,
one by the hash recall printed. Asked about their own task ("add a new
built-in rule MD063 list-max-depth"), recall finds nothing (the free dry
run): the new rule's name is the rarest word, so it weighs most (`QUERY_MIN`).
The pre-registered replay (`replay-note-queries.mjs`) changes nothing. No
query held the new rule's names, and as written each got the previous rule.
On t08 and t11, where nothing like them was stored, no agent under either
note ran recall.

Deviation: the first session (t04, A) wrote its files through Bash
(`cat > lib/md063.mjs`), which the stop hook didn't catch. It was stopped by
hand after 12 calls, and the hook was changed to stop at shell writes too for
the other eleven. Its measures are read up to its first edit like the
others'. It reported no cost, so its tokens give it. Spent: $1.27, the probe
included.

## The tool-call hook's crash at exit on Windows, reproduced and fixed (2026-10-17)

In the user's own sessions the tool-call hook died at exit on 2.4% of
matched tool calls on `79a7521`, and on 47% on v1 phase 2. The error was a
libuv assertion, `!(handle->flags & UV_HANDLE_CLOSING)`, async.c line 76,
exit 127. Claude Code logs that as a non-blocking hook error, and drops
whatever the hook printed. Hand-overs mid-task come through this hook, so
they'd be lost on those calls too.

Run on its own, the hook didn't crash: 1,200 runs exited 0, one at a time,
8 at once, and 24 at once, with a 200 kB input too. Under load it did. With
8 busy processes and 16 hooks at once (session end, with a watch folder), 215
of 608 runs aborted with the same assertion; the full test suite hit it once
too. The cause is `process.exit(0)` at the end of `src/workflows/hook.ts`,
called while other threads are still finishing work. The hook now ends by
running out of work (`process.exitCode = 0`), with a 5-second timer as a
backstop that doesn't hold the process open. Under the same load, 608 of 608
runs exited 0. No path got slower:

| path | time |
|---|---|
| a call that ends at the first check | 110-150 ms |
| session end | 113 ms |
| a committing command, which starts storing in the background | 175 ms |
| task start | about 0.8 s |

## A hand-over by commit, built and replayed for free (2026-10-17)

In the note test, the first command of every session that added a rule like
an earlier one was `git show` of that earlier rule's commit, under either
note. So memory now comes at that moment: after a call that reads a stored
commit (`git show`, or `git log` printing a diff or a stat), the tool-call
hook adds what git doesn't show about it. That's the request that asked for
it, the project commands its session ran, its mistakes, and other changes'
mistakes in its files (`src/scripts/History.ts`; docs/development.md, "A
hand-over by commit"). A session gets each commit once and never its own.
Nothing is added after a survey of more than two commits.

Replayed on past sessions, with memory as it stood at each call
(`replay-git-handover.ts`):

| | sessions | calls reading commits | hand-overs | sessions with one | size |
|---|---|---|---|---|---|
| note test | 12 | 16 | 4 | 4 | 1.2k-2.5k chars |
| the user's own, since 10-13 | 12 | 6 | 2 | 1 | 3.6k-3.7k |
| markdownlint, 10-16, memory arm | 36 | 46 | 15 | 13 | 1.2k-2.5k |

- Note test: the 4 were the sessions under note A. The 3 sessions under B
  that read the previous rule had already printed it with recall in the same
  call. `recall` now notes what it printed for the agent's session, so the
  hook doesn't add it again.
- The user's own sessions: reading a stored commit is rare there, 6 of 776
  shell calls. Both hand-overs came in one long session, looking into which
  commits had added two files.
- Harm: each hand-over adds about 300-1,000 tokens, re-read on every later
  turn. That's under 1 cent a hand-over in the markdownlint sessions. The
  user's long session re-read its two about 300 times, about 640k cached
  tokens. No hand-over gave a session its own commit or followed a survey.
- Effect, a ceiling only: 12 of the 15 markdownlint hand-overs named a
  mistake. In 5 the session made that mistake later: 4 test plan counts and
  1 missing snapshot. A count mismatch is what a test run reports anyway
  (above), so whether naming it saves anything needs a paid run.

## The hand-over by commit, paid, in daily use (2026-10-17)

Main at `daa5146` (the hand-over by commit, PR #34) against no memory, the
markdownlint daily-use suite of 2026-10-16 unchanged: twelve tasks, each in
a fresh session, three passes, the arms side by side, Claude Code 2.1.295
(the same pinned copy), `--setting-sources project,local`
(`PREREGISTRATION-git-show-2026-10-17.md`; data in
`results/git-show-2026-10-17/`). Spent: $21.27. No session hit a rate limit.

### Harm first

Five tasks passed without memory and failed with it, all in pass 2 and
all from one miss: t05 committed `lib/markdownlint.d.mts` stale, and t06,
t07, t08 and t10 carried it (t09, t11 and t12 failed without memory too).
Memory handed that t05 session nothing: no start, file or commit hand-over.
It's the same task and the same miss as on 10-16. Counting
with the declarations compared in both arms (`check-declarations.mjs`),
memory had fewer runs of failures than no memory, not more: 3 against 5.

| | without | with |
|---|---|---|
| passed, the driver's checks | 30 of 36 | 36 of 36 |
| passed, declarations compared in both arms | 15 of 36 | 18 of 36 |
| runs of failures, declarations compared | 5 | 3 |
| dollars | $10.74 | $10.53 (-1.9%; 95% interval -11.7% to +7.7%) |
| tokens | 23.30M | 22.87M (-1.8%; -15.9% to +12.3%) |
| dollars, tasks 3-12 | $8.41 | $8.33 (-1.0%; -13.2% to +11.3%) |
| reference: 10-16, main at `a7ede11` | $10.86 | $10.19 (-6%; -13% to +1%) |

By the pre-registered bars: **no clear difference**. It isn't -10% with the
interval below zero, and it isn't +10% or more runs of failures. The
intervals are a bootstrap over the 36 task pairs (`score-git-show.mjs`).
The 10-16 row is another day's pair of arms, for reference only.

### What the add-on did

It fired 12 times, in 12 of the 36 sessions with memory: on t04, t07 and
t12 in every pass, t10 in passes 1 and 3, and t05 in pass 1. Each added
1.2k-2.8k characters, at the session's first or second shell call every time
(`git show <previous rule's commit> --stat`). This matches the free replay (15 in 13).

| | |
|---|---|
| fires that named a mistake | 8 of 12 |
| the session made a mistake of that kind after the fire | 6 of 8 |
| the paired session without memory made it | 4 of 8 |
| dollars, sessions with a fire, against their pairs | $3.81 against $3.59 (+6%) |
| dollars, sessions without one, against their pairs | $6.72 against $7.15 (-6%) |

Naming a mistake didn't stop it. Five of the eight named the test plan's
assertion count (`plan-count`), and all five sessions failed on it anyway.
The count changes with every rule, so a warning that it changed last time
doesn't tell the agent the new number; a test run does, as the replay
expected. The other three named coverage, none repeated; one also named a
file count, which that session then hit. The sessions with a fire cost 6%
more than their pairs, those without one 6% less; at 12 and 24 pairs
neither is outside the noise.

Start hand-overs: 21, plus 3 by file, as many as on 10-16. No agent ran
`singularity recall` (0 of 36).

### What it says

The add-on reaches agents: it fires where predicted, at the moment they
read the earlier change, and it costs little (under a cent a hand-over, by
the replay's estimate). It doesn't pay here, because what it warns about most in this repository is
a mistake the test run reports at once and cheaply. Bars and data:
`PREREGISTRATION-git-show-2026-10-17.md`, `score-markdownlint.txt`,
`score-git-show.txt` (`score-git-show.mjs`).
