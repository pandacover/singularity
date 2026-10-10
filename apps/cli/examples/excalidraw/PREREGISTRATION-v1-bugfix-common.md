# Pre-registration: what bug fixes share, learned across bugs

Written 2026-10-07, before any counted run. Not committed (commits wait for
the user); the hashes below pin the memories.

## The question

In the eighth session memory didn't help bug fixes (`PREREGISTRATION-v1-new-kinds.md`,
part a): learning from two bugs made a workflow of each bug, cued by its own
words, and the held-out bugs got nothing (save-as) or a wrong workflow
(dropdown: a Preferences toggle, cued by "main menu"). What bug fixes in one
repository share is how a bug is reproduced in a test and how the fix is
checked, not where the fix goes. Does memory of that, learned across bugs,
make a new bug fix cheaper?

## What changed in memory

- **Learning across tasks of a kind** (`src/workflows/Common.ts`, `workflows
  common`): one model call reads the runs of several tasks of one kind and
  proposes only what runs of at least two different tasks did. Checked
  mechanically, with induction's other checks: a workflow from one task's
  runs is dropped, and so is a place one task's runs used. The workflows join
  memory as the kind's own ("fixing a bug"); the per-task workflows stay.
- **Places runs read** (`src/workflows/Reads.ts`, `placesOfRead` in
  `Places.ts`): the blocks runs read in code they didn't change (a `Read` with
  a range, `sed -n`, a search in one file that printed its lines), such as the
  test helpers' `Keyboard` class. The hand-over shows one as an outline from
  the code at task start: the block's first line and its members' first lines.
  A search whose matches fall in more than 5 blocks is a search, not a read.
- **The kind's workflows are never folded into the finish**: their steps are
  what tasks had to find out; their checks join the one command.
- Cues are written again for all of memory with the bug tasks as examples:
  the setting and shortcut workflows now have `none: ["bug:"]`, which removes
  the eighth session's "main menu" misfire.

## Memory: one per held-out bug

Each held-out bug gets memory learned from the other three bugs' runs
(leave one out), so neither has seen its own task. Both start from the
learned excalidraw memory (`v1-learned`, version 4), as the eighth session's
bug-fix memory did, and add a `workflows common` pass and `workflows cues`:

| Held out | Learned from (runs) | Memory | sha256 of `versions/000006.json` | Model calls |
|---|---|---|---|---|
| save-as-in-text | eraser 2, edit-arrow 2, dropdown 6 | `runs/excalidraw/memory/v1-common-wo-saveas` | `83fc3162e568c853d0944c2367a081aeabb42614a5a3b3f2ca477722e60bcb24` | $0.11 + $0.10 |
| dropdown-outside-click | eraser 2, edit-arrow 2, save-as 6 | `runs/excalidraw/memory/v1-common-wo-dropdown` | `cb3aec224d86e3e683e429c6618b38dccc2d79c4a11deaea1d4838981d912131` | $0.17 + $0.15 |

The held-out task's own records were removed from its memory home.

What each held-out task gets (`workflows handover --at <base> --parts 2`, one
part each):

- **save-as-in-text** (5,929 characters): three workflows. Reproduce the bug in
  a regression test (where test files are, `render(<Excalidraw />)` and
  `window.h`, render with `handleKeyboardGlobally` when the test presses keys,
  drawing on the canvas, which comes in because the task says "saves the
  drawing"); show the test fails without the fix (`git stash push {fixed
  files}`, run, `git stash pop`, and read the failure); format, typecheck,
  whole suite once. Pitfalls: key presses without global handling, a test
  failing for its setup rather than the bug, typed test elements, `yarn
  test:update --watch=false`, `prettier --check` over several paths. No place:
  of the places runs read, none was read by two of these three bugs. One
  command at the end: `yarn prettier --write {changed files}; yarn
  test:typecheck; yarn vitest run {test file}; git stash push {fixed files};
  yarn vitest run {test file}; git stash pop; yarn vitest run`.
- **dropdown-outside-click** (6,476 characters): one workflow of seven steps,
  the same knowledge in other words, with two places runs read: the
  `Keyboard` class in `tests/helpers/ui.ts` (its 10 methods' first lines), for
  tests that press keys, and `App.onKeyDown` (the first line of each of its
  guards), for bugs about keyboard shortcuts. Both are conditional steps the
  dropdown bug doesn't need; the cues gave the steps no cues of their own, so
  they come with their conditions. From save-as's runs: press keys on the
  right target (the textarea while editing text), and spy on side effects such
  as saving. Six pitfalls, among them a chained stash that stops before `git
  stash pop`. One command: `yarn test:typecheck; yarn vitest run {test file};
  git stash push {fixed files}; yarn vitest run {test file}; git stash pop;
  yarn vitest run`.

Neither names the held-out bug's place, its test file, or its own trap (the
save-as keys must go to the text editor's textarea; nothing in the dropdown
fold's sources is about outside clicks).

## Runs

`bash examples/run-bugfix-common.sh memory 0 2` (lane 1): 3 runs of each
held-out task with its memory, `workflows-split` setup, the tasks taking turns
going first; then `bash examples/run-bugfix-common.sh drift 3`: one run of
each without memory. 8 runs, about $1.5 (the eighth session's runs of these
tasks cost $0.14-0.23 each). Claude Code 2.1.286 (pinned), Sonnet 5.5 at
medium effort, below normal priority, as the baseline.

**Baseline**: the eighth session's 3 runs of each task without memory
(`runs/excalidraw/bugfix/nomem-lane2`, 2026-10-06, the same Claude Code and
checks): save-as 396k tokens / $0.205 / 12 turns (346k-499k), dropdown 374k /
$0.167 / 12 turns (282k-454k).

**Drift check**: if a new run without memory lands more than 15% outside the
range of the baseline's tokens, that is reported, and the new run joins the
baseline. Either way the baseline is reported with and without it.

Every memory run's transcript is checked for its hand-over
(`hook_additional_context`) and the hook error log for errors; a run that got
less is reported, and counts.

## What counts

The eighth session's rule for new kinds of task, unchanged:

1. **Success**: memory's runs fail no more often than no memory's, give or
   take one run.
2. **Cheaper**: memory's median tokens below no memory's on both held-out
   tasks, and its median dollars no more than 10% above no memory's on either.

Reported, no rule (`node examples/score-phases.ts
no-memory=runs/excalidraw/bugfix/nomem-lane2
memory=runs/excalidraw/bugfix-common/memory -v`, and the transcripts): turns
before the first edit and after the last; whether runs ran the one command and
the stash check in it; whether they made the mistakes memory warns of
(`--watch=false`, key presses without global handling); what they still looked
up about tests. Three runs per task can't tell small differences apart: a
result inside the spread of the baseline is reported as such.
