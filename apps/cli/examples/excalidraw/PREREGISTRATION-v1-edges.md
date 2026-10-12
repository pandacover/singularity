# Pre-registration: what memory's edges say, at task start

Written 2026-10-12, before any counted run, in a cloud session that couldn't
run them: the runs need the sealed memory and the pinned Claude Code on the
user's machine.

## The question

Memory v1 learns a graph: edges between workflows, each with a relation
(`LEADS_TO`, `TRIGGERS`, ...), a condition, guidance and pitfalls. Until now
the hand-over used the edges only to order the workflows the cues picked;
what they say never reached the agent, and a `TRIGGERS` edge brought nothing
in. Do the agents do the long tasks for fewer tokens when the hand-over says
what the edges say?

Two stages, each a commit on branch `edge-handover`:

1. **stage1** (`a0b4331`): under a workflow handed over, a line for each edge
   to a workflow handed over after it (or the finish in the last section):
   its guidance and pitfalls, with the task's values filled in.
2. **stage2** (`05195f0`, on top of stage1): a workflow picked brings in what
   it `TRIGGERS`, hop by hop, marked "only if" when an edge has a condition;
   and the hand-over names, once each and at most three in all, the branches
   with a condition it didn't hand over.

## What the free checks already say

From the memory in `how-v1-works.html` (8 workflows, 16 edges: 13 with a
condition, 3 with guidance, 2 `TRIGGERS`), the hand-overs of the long tasks
and four single tasks rendered by each version, without places (so without
excerpts):

- stage1 adds 449 characters to four of the six (both long tasks and the two
  toggles) and none to stats-shortcut-k and midpoint-snap-n: on toggle-rulers
  the toggle action's "The
  action's perform flips the new field", the context menu's "The
  context-menu test needs the action's shortcut name, so do the shortcut
  workflow first if both are asked", and the snapshots' guidance with the
  `--watch=false` pitfall.
- stage2 picks no other workflow on these tasks: the cues already pick the
  snapshots workflow. It names two branches on midpoint-snap-n (the context
  menu and Preferences), about 250 characters.
- A first stage2 that also said each condition between workflows handed
  over, and listed each branch with its steps under every workflow that
  leads to it, added 1.2k-1.4k characters, some of it contradicting the
  hand-over ("This makes 6 needed, if no Preferences step follows" above
  the Preferences workflow). That was cut before this was written.

To check on the user's machine before the runs, for each version and both
tasks (`workflows handover "<prompt>" --cwd <excalidraw> --at <base> --home
<copy of v1-finish> --parts 2`, run with that version's `cli.ts`): both parts
under 9,800 characters, and the excerpt lines shown against main's (the
added lines take room from the code shown; any place shown shorter is
reported).

## Runs

`bash apps/cli/examples/excalidraw/run-edges-measurement.sh 0 1` (lane 1)
and the same with `LANE=2` a few minutes later: for each of
`long-four-changes` and `long-mixed-changes`, 4 runs of each version (main,
stage1, stage2), the versions taking turns going first, into
`runs/excalidraw/edges/<task>/<version>[-lane2]`. The `v1-finish` home,
sealed (sha256 of `versions/000003.json`
`2a7fb6eb672009857f7f3e0361fe2803996daa0f93a9f7416121630d9b3b44d8`),
`--setup workflows-split`, Claude Code 2.1.286 (pinned), Sonnet 5.5 at medium
effort, below normal priority. `DRY_RUN=1` first.

Cost: the long tasks' earlier memory runs cost $0.18-0.50 each: about $8-10
for the 24 runs. Each run stops at $6.

Main's arm is run again rather than compared with the long tasks' earlier
memory runs: the code has changed since (learning, daily use), and runs made
side by side share whatever else changed.

## What counts

For each stage, against main's runs of the same task:

1. **Success**: no more failed runs than main's (of 4).
2. **No worse**: median tokens no more than 10% above main's on either task.
3. **Better**: median tokens at least 10% below main's on at least one task,
   with 1 and 2 holding.

A stage is kept if 1 and 2 hold, and said to help only if 3 holds too.
stage2 is judged against main and against stage1: it is kept over stage1
only if it is no worse than stage1 by rule 2.

Reported, no rule (from `apps/cli`, with `E=runs/excalidraw/edges/<task>`:
`node examples/excalidraw/score-long.ts main=$E/main,$E/main-lane2
stage1=$E/stage1,$E/stage1-lane2 stage2=$E/stage2,$E/stage2-lane2 --task
<task> -v`, main first as the base): per change, whether its
test passed; turns before the first edit; whether runs did the context-menu
step after the shortcut step (stage1's guidance); whether a run did work a
named branch offered but the task didn't ask for (a context-menu entry or a
Preferences toggle for midpoint snapping in `long-four-changes`); the
hand-over's characters and excerpt lines per version.

Four runs per version can't tell small differences apart: the earlier
memory runs ranged 293k-498k tokens on `long-four-changes` and 671k-920k on
`long-mixed-changes`. A result inside that spread is reported as such.
