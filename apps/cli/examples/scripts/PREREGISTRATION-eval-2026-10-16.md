# Pre-registration: every suite, on main as it is (2026-10-16)

Written before any counted run. The user's question: singularity has been
updated; run the complete suite of evals and see how it stands.

## What is measured

Main at `a7ede11`: saved scripts, with other changes' mistakes only through
files few changes touch (`79a7521`, not yet measured in runs), `singularity
changes`, and git run without Effect's tree kill (`519ad3e`). A frozen copy
(`git archive`, `npm ci --omit=dev`) in `C:\singularity-workspaces\eval-1016\app`.
The installed copy (`~/.singularity/app`) is at `79a7521` and isn't used.

Every session: Sonnet at medium effort, `acceptEdits` with Bash, PowerShell,
Read, Edit, Write, Glob and Grep, no MCP servers, auto-memory off, below normal
priority, and `--setting-sources project,local`: the user's own settings,
CLAUDE.md, skills, plugins and advisor tool stay out of both arms (a probe
showed the user's config adds an advisor tool, the recall note and about 40
skills), as the cloud runs' config folder of their own did, with the user's
login. Both arms run here, on this machine, side by side or interleaved.

## Suites

1. **markdownlint, daily use** (`../markdownlint/`, `driver.mjs`): the twelve
   tasks in order, each in a fresh session, in a clone at `314ab18e`, three
   passes per arm, each pass in fresh clones and a fresh memory home. Claude
   Code 2.1.295 (pinned copy), $5 and 60 minutes per task.
   - without: `SINGULARITY_HOOKS=off`, an empty `SINGULARITY_HOME`.
   - with: main's hooks through `--settings` (`--app`), storing each commit,
     handing over at task start and by file, the recall note in the system
     prompt (the user-level CLAUDE.md isn't loaded) and `singularity` on PATH.
2. **excalidraw, long tasks** (`../excalidraw/long.toml`): long-four-changes
   8 runs and long-mixed-changes 4 runs per setup.
3. **excalidraw, short tasks** (`../excalidraw/suite.toml`), the held-out
   tasks: altkey-viewmode-j, altkey-snap-u, toggle-rulers, toggle-presenter,
   midpoint-snap-n, page-breaks, stats-shortcut-k, save-as-in-text,
   dropdown-outside-click; 3 runs each per setup.
4. **validator** (`../validator/suite.toml`), held out: ulid, postal-code-pk;
   3 runs each per setup.

Suites 2-4 run in the harness (`eval run`), `no-memory` against `scripts`
(frozen; the recall note and command come with it), Claude Code 2.1.296
(pinned copy), setups taking turns going first. Their memory was built for
free from earlier runs (`eval learn`): excalidraw from the seed tasks
altkey-zen-m, toggle-minimap, eraser-while-drawing and edit-arrow-crash
(`runs/excalidraw/memory/scripts-1016`, 4 scripts), validator from
aba-routing and iso31661-numeric (`runs/validator/memory/scripts-1016`, 2).
What each task gets, previewed for free (`eval inject`): the seven feature
tasks and both long tasks a script (scores 0.40-0.89); save-as-in-text
(0.376), dropdown-outside-click (0.19) and postal-code-pk (0.26) nothing but
the recall note; ulid iso31661-numeric's script (0.44).

`toy` isn't run: its tasks are commands of the graph memory, removed.

## Bars, set now

1. **Harm first**: every task that passes without memory and fails with it
   (markdownlint: in the same pass; the harness: more failed runs of a task
   with memory) is reported before anything else.
2. **markdownlint**: memory helps only if all hold: (a) no more failures
   than without, counting each run of failures by the task that started it
   (a task that leaves a check failing fails every later task until one fixes
   it); (b) on tasks 3-12, summed over the three passes, agent tokens at least
   20% lower and dollars at least 10% lower; (c) over all twelve tasks,
   dollars lower. Otherwise it doesn't pay off here; it hurts if (a) fails or
   the dollars of (c) are higher. Read out without bars: tasks that got a
   start hand-over against those that got none, the file hand-over, recall
   calls, and whether `npm run build-declaration` failures carry over again
   (the mistake `79a7521` keeps out of other changes' hand-overs).
3. **The harness suites**, per task: memory helps if it fails no more runs
   and its median tokens are at least 20% lower and median dollars at least
   10% lower; it hurts if it fails more runs or its median tokens are more
   than 10% higher. Tasks with nothing handed over should show no difference.

## Known limits

- Three passes or runs per task can't tell differences under about 15-20%
  from noise; earlier runs of one task ranged up to 2x.
- Not comparable with earlier results in absolute terms: they ran in a cloud
  container (Linux; tasks with nothing handed over cost 35% less there) or
  with the user's config. The gap between arms here is the result.
- Claude Code is pinned to the versions of the last saved-scripts runs, not
  today's 2.1.300.
- The arms share Anthropic's prompt cache for what they have in common.
- The harness memory was built from runs of Claude Code 2.1.286; its
  scripts aren't the ones the cloud runs used.

## Cost, estimated

markdownlint about $4 an arm a pass, $24; the harness about $0.15-0.5 a run,
102 runs, about $25. About $50 in all; each run is capped.

## Results (2026-10-16, 01:04-06:24 UTC)

In `RESULTS.md`, "Every suite on main, on Windows". $42.17 spent. In short:

- markdownlint: by the bars, doesn't pay off here. (a) holds, (b) fails
  (tasks 3-12: -8% tokens, -6% dollars), (c) holds (-6% dollars). Harm: t05
  in passes 2 and 3, which memory handed nothing. The driver's pass counts
  (25 and 28 of 36) hide stale type declarations whenever the declaration
  build doesn't type-check; compared in both arms (`check-declarations.mjs`,
  added after pass 1, not planned) they are 16 and 12 of 36, with three runs
  of failures in each arm.
- The harness: all 90 runs passed. Helps on altkey-viewmode-j, altkey-snap-u,
  toggle-rulers, toggle-presenter, page-breaks, long-mixed-changes and ulid;
  no clear difference on midpoint-snap-n, stats-shortcut-k, save-as-in-text,
  postal-code-pk and long-four-changes (-19.5% tokens); hurts, by the rule,
  on dropdown-outside-click (+13% tokens), which got nothing but the recall
  note.
- Recall: no agent ran it (0 of 81 sessions with the note).

Data: `results/eval-2026-10-16/`. The scripts that ran it:
`run-markdownlint-passes.sh` and `run-harness-lane.sh`; scoring:
`score-eval.mjs` and `check-declarations.mjs`.
