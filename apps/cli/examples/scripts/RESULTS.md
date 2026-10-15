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
