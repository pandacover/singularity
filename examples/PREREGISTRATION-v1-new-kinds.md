# Pre-registration: memory v1 beyond settings and shortcuts

Written 2026-10-06, before any counted run (the seed runs, which memory learns
from, aren't counted). Not committed (commits wait for the user); the hashes
below pin the memories.

## The question

Every result so far comes from two tasks' runs in one repository (settings
and shortcuts in excalidraw). Do the workflows, their cues and the hand-over
help on (a) a new kind of task in the same repository, bug fixes, and (b) a
second repository? Memory learns from two seed tasks' runs without memory,
then is measured on two held-out tasks against no memory.

## (a) Bug fixes in excalidraw (`examples/excalidraw/suite.toml`)

Real upstream fixes, each asked at its parent commit, checked by the fix's own
test file and the typecheck:

| Task | Role | The bug |
|---|---|---|
| eraser-while-drawing | seed | E switches to the eraser while a line is being drawn |
| edit-arrow-crash | seed | "Edit arrow" crashes when the label comes before the arrow |
| save-as-in-text | held out | Ctrl+Shift+S does nothing while editing text |
| dropdown-outside-click | held out | dropdowns don't close on outside clicks after reopening |

They share how a bug is reproduced in a test and checked, not where the fix
goes. The dropdown prompt was corrected before any run (the menus never close
on an outside click, not only after reopening; the fix's own comment says the
listener never attached). The held-out tasks' runs without memory start
before memory is built, in lane 2, to save time: they can't depend on it. Memory: `runs/excalidraw/memory/v1-bugfix`, version 5 (sha256 of
`versions/000005.json`
`22cfb2f25c8ca7498371bfeb61026062cf55028bb71eea11a693aebd8a89f99d`): the learned excalidraw memory (option 2, version 4) after one more
learning round ($0.64) on the seeds' 4 runs (all passed, $0.16-0.49 each), with
cues written again for all seven tasks it has learned from. It added four
workflows, each specific to its seed bug (guard a tool shortcut while a line
is being drawn; its multi-point regression test; fix the linear editor's
selection with bound text; its element-order regression test), with cues
such as "multi-point" and "bound text", and two pitfalls (a multi-point test
needs pointer moves between clicks; test element types).

Free check, before any memory run: save-as-in-text gets nothing (no cue
matches); dropdown-outside-click gets the wrong workflow, adding a toggle to
Preferences in the main menu (its cue "main menu" matches "the main menu and
the toolbar's ... dropdown"). The learned bug-fix workflows fit only their
own seed bugs.

## (b) A second repository: validator.js (`examples/validator/suite.toml`)

Real upstream changes, each asked at its parent commit, checked by the build,
the linter and the change's own tests:

| Task | Role | The change |
|---|---|---|
| aba-routing | seed | a new validator, `isAbaRouting` |
| iso31661-numeric | seed | a new validator, `isISO31661Numeric` |
| ulid | held out | a new validator, `isULID` (the same kind, other logic) |
| postal-code-pk | held out | a locale for `isPostalCode` (a variant: no new file, no export) |

Memory: `runs/validator/memory/v1`, version 2 (sha256 of `versions/000002.json`
`e0c87b67428f2a8e46fae9c6651d25a216cfb00c588c1bbeebfae52b46e98dc7`), built from
scratch from the seeds' 4 runs (all passed, $0.10-0.17 each): one induction
call ($0.105) and the cues ($0.024). 4 workflows (create the validator's file,
register it in src/index.js, a row in the README, its tests), 7 places, 1
pitfall (a README edit whose text appears twice).

Free check (`workflows handover --parts 2` at each task's base): ulid gets all
four workflows, finishing with `npm run lint; npm run build; npm test`;
postal-code-pk gets the README and tests workflows (its README step speaks of
a new row where the task changes an existing row's locale list), finishing
with `npm run lint; npm test`. The README's table place is never found (a
markdown file's top level has no block to find it by), so no README code is
shown. ulid got only two workflows before a fix made on this check: cue
phrases didn't match where the task's text breaks a line inside them ("add\n
tests"); they are now matched with whitespace folded (no pick of any
excalidraw task changes).

## Runs

Both memories handed over by the `workflows-split` setup (local first, the
finish in one command, up to two parts), against no memory. One change to the
hand-over since the option-2 measurement: the finish now says to keep the last
60 lines of the one command's output (two of its runs ran the command bare,
Claude Code saved the long test output to a file, and they spent a turn
reading it). 3 runs of each
held-out task per setup: 24 runs, about $8. Claude Code 2.1.286, Sonnet 5.5 at
medium effort, as everywhere in this session.

## What counts, for each of (a) and (b)

1. **Success**: memory's runs fail no more often than no memory's, give or
   take one run of six.
2. **Cheaper**: memory's median tokens below no memory's on both held-out
   tasks, and its median dollars no more than 10% above no memory's on either.

Reported, not ruled on: what the cues picked for each held-out task (nothing,
the right workflows, or wrong ones), which places shown the runs edited, the
turns before the first edit and after the last. A held-out task the cues give
nothing is reported as such: memory then hands over nothing, and the run is a
run without memory.

## Results (b): validator.js (2026-10-06)

All 12 counted runs ran and passed, $1.18 ($0.59 each setup); the seeds cost
$0.57, memory's model calls $0.13. Every memory run got its hand-over (ulid
4.8k characters, postal-code-pk 2.8k, one part each, no hook error). Scores
with `node examples/score-phases.ts no-memory=runs/validator/held-out/nomem
memory=runs/validator/held-out/memory -v`.

| Task | Setup | Tokens | Dollars | Turns | Before the first edit | After the last |
|---|---|---|---|---|---|---|
| ulid | no memory | 185k | $0.11 | 6 | 2 (49k, 6 lookups) | 3 |
| ulid | memory | 203k | $0.10 | 7 | 2 (52k, 5 lookups) | 3 |
| postal-code-pk | no memory | 220k | $0.09 | 8 | 3 (74k, 6 lookups) | 2 |
| postal-code-pk | memory | 222k | $0.09 | 8 | 4 (104k, 8 lookups) | 2 |

| Rule | Result | |
|---|---|---|
| 1. Success no worse | 0 of 6 failed in each | holds |
| 2. Tokens below no memory on both, dollars at most +10% | ulid +9% tokens / -7% dollars; postal-code-pk +1% / -2% | fails |

**Memory didn't help here, and didn't hurt beyond noise.** These tasks are
small: without memory an agent finds the four places in two or three turns
(the validators are one file each, the README table and the test file are
easy to search). Memory's hand-over then costs about what it saves: its text
is reread every turn, and the agent reads the files anyway. The variant
(postal-code-pk) got a README step written for a new row where it had to edit
an existing row's locale list, and no step for the validator's own locale map;
its runs looked as long as without memory. The spread within each setup
(131k-244k without memory) is wider than the difference between them.

## Results (a): bug fixes in excalidraw (2026-10-06)

All 12 counted runs ran and passed, $2.18 ($1.13 without memory, $1.05 with);
the seeds cost $1.36 (the eraser seed took 28 turns and $0.46-0.49 without
memory), the learning round $0.64. Scores with `node examples/score-phases.ts
no-memory=runs/excalidraw/bugfix/nomem-lane2
memory=runs/excalidraw/bugfix/memory,runs/excalidraw/bugfix/memory-lane2 -v`.

| Task | Setup | What memory handed over | Tokens | Dollars | Turns |
|---|---|---|---|---|---|
| save-as-in-text | no memory | | 396k | $0.21 | 12 |
| save-as-in-text | memory | nothing (no cue matched) | 398k | $0.17 | 12 |
| dropdown-outside-click | no memory | | 374k | $0.17 | 12 |
| dropdown-outside-click | memory | the wrong workflow: a Preferences toggle (5.7k characters) | 302k | $0.18 | 9 |

| Rule | Result | |
|---|---|---|
| 1. Success no worse | 0 of 6 failed in each | holds |
| 2. Tokens below no memory on both, dollars at most +10% | save-as +0% tokens / -15% dollars; dropdown -19% / +5% | fails |

**Memory didn't reach the held-out bugs.** The learning round made each seed
bug into workflows of its own ("guard a tool shortcut while a line is being
drawn", "fix the linear editor's selection with bound text"), cued by that
bug's words. The save-as bug matched no cue, so its memory runs were runs
without memory: their difference from the runs without memory is noise. The
dropdown bug matched "main menu", a cue for adding a toggle to Preferences;
its agents ignored that workflow (none touched Preferences) and fixed the bug where runs without memory did (the outside-click hook). Their tokens (272k, 302k, 410k) sit inside the spread of the runs without memory (282k-454k).

What bug fixes in one repository share (reproducing the bug in a test with
the repository's helpers, checking just the test file it touches) didn't
become a workflow of its own: from two bugs in different places, the model
kept what each did, not what both did.
