# Handoff: Procedural Memory Graph for a Coding Agent

Last updated 2026-10-07, in the ninth session. Start here, then see
README.md for commands and CLAUDE.md for how the code is written.

## Status: long tasks measured: memory -78% / -63%, and -39% / -38% when it knows half the changes (2026-10-07, ninth session)

The user called the numbers good and asked for long tasks next: a task X
with parts A, B, C and D in one prompt, A and C alike; does local v1 do
better than no memory? **Yes, by a wide margin** (8 runs, $4.29, all
passed; results at the end of `examples/excalidraw/PREREGISTRATION-v1-long.md`):
no memory 1,902k tokens / $0.81 / 28.5 turns (median), memory 423k / $0.30 /
9.5 turns; the runs don't overlap. Both pre-registered rules hold. Memory's
saving grew against the same four changes asked one per session (there 50%
of tokens, 34% of dollars): with the places in hand its runs edited all four
changes within 2-3 turns and paid the looking and the finish once. In all 8
runs the agent did the two alike toggles side by side, memory or not. Part of
the gap is again the keyboard trap (all 4 runs without memory fell in; 1 of
4 with memory, briefly); against the cheapest run without memory memory is
still -64% / -49%.

Found in the runs and fixed: the two task-start hooks of `workflows-split`
both write `subjects.json` when the repo's path is new (lane 2's workspace),
through the same temporary file, so one run got only part 1 of its
hand-over. Every store write now has its own temporary file and retries a
refused rename (`src/local/Files.ts`). `npm test`: 211 passed. Nothing
committed.

How it was prepared:

- **The task**: `long-four-changes` (`examples/excalidraw/long.toml`, its own
  file only for an hour and $6 a run): toggle-rulers, midpoint-snap-n,
  toggle-presenter and stats-shortcut-k as a numbered list. Their hidden
  tests side by side; the four reference solutions merged pass them all, and
  at the base commit 16 of 19 hidden tests fail.
- **Found by the free preview, and fixed**: v1 filled each blank with the
  first value of its kind anywhere in the prompt, so every change got the
  rulers field and the stats change was told Alt+N. A task that lists
  several changes is now picked and filled change by change
  (`partsChoice` in `src/workflows/Cues.ts`; shown once per workflow, with
  each change's values and which changes need it). One-change hand-overs are
  unchanged. `npm test`: 209 passed.
- **The measurement**: `examples/excalidraw/PREREGISTRATION-v1-long.md`, 8 runs
  (4 without memory, 4 with the `v1-finish` memory, `workflows-split`),
  estimated at $12-16 (it cost $4.29: no run worked change by change),
  `run-long-measurement.sh`, scored by `score-long.ts` (also per change). The bar: memory at least 20% fewer tokens and 10% fewer dollars
  than no memory, no more failures. Asked one per session, memory saved 50%
  of tokens and 34% of dollars on these four changes.

**Then a long task memory only half knows: -39% tokens, -38% dollars** (8
runs, $4.15, all passed; results at the end of
`examples/excalidraw/PREREGISTRATION-v1-long-mixed.md`). That long task was
memory's best case (all four changes of kinds it knows); `long-mixed-changes`
(`long.toml`) swaps two of them for bug fixes memory never saw: rulers, the
save-as bug, presenter, and a YouTube live-link bug (upstream `974f054b`, new
to the suite), at `d29d8648`, where both bugs exist and the toggles' files
are the same. No memory 1,287k / $0.64 / 21.5 turns (median), memory 788k /
$0.40 / 15 turns; the runs don't overlap; the same bar holds. The saving
(499k tokens) is about what memory saves on the two toggles alone asked one
per session (514k): the bug fixes cost the same with memory or without,
nothing was handed over for them, by mistake or otherwise. Memory's runs
fixed the bugs first, then both toggles in one or two turns. Every memory
run got both parts of its hand-over (the race fix holds).

So far, then: memory's saving in a long session is what it saves on the
changes it knows, and nothing is lost on the ones it doesn't. Next, my
recommendation: the bug fixes are where the remaining cost is; what memory
could carry for them (how a bug is reproduced and checked in this repo) is
the open question from the eighth session.

## Status: the three next steps, built and measured (2026-10-06, eighth session)

The user asked for all three "ways on" of the seventh session, one by one,
with results for 2 and 3. Nothing is committed (the user hasn't asked); the
code is on `local-memory`, uncommitted. Detail in HANDOFF-v1.md and the
pre-registrations.

1. **The finish in one command** (`src/workflows/Finish.ts`, `workflows
   finish`): the chosen workflows' checks folded into one line, the snapshot
   files earlier runs regenerated (learned from their diffs, no model), no
   checks under each workflow. Measured inside A below.
2. **Learning what runs still looked up** (`src/workflows/Lookups.ts`, in
   `workflows evolve`): the refining model reads every read and search a run
   made before its first edit, against memory's places and what the
   hand-over showed of them; it rewrites steps to carry that knowledge and may
   show a place as one whole entry. Cues are written again after the round and
   the gate replays with them. Two bugs found and fixed on the way: a round
   dropped memory's pitfalls (runs that avoided a mistake left no detours to
   support it), and cue phrases missed tasks whose text breaks a line inside
   them.
   - **Found while doing it:** Claude Code cuts each hook's text at 10,000
     characters, and the local-first hand-over for the toggle tasks is ~13.5k,
     so the measured runs got 3 lines of code per place. The `workflows-split`
     setup carries it in two parts from two task-start hooks (both arrive
     whole).
   - **Measured** (`examples/excalidraw/PREREGISTRATION-v1-lookups.md`, 12
     runs, $2.90, held-out toggles rulers and presenter): A = the sealed memory
     with the one-command finish, in two parts; B = A after the learning
     round. A against local first: rulers -11% tokens / -8% dollars,
     presenter -31% / -18%, fewer turns after the last edit. B against A:
     looking before the first edit fell on both (2 vs 4 turns, 3 vs 4); no
     run failed; presenter $0.13 a run against $0.26, but rulers rose (+22%
     tokens): its runs ran the one command without trimming the output, and
     reading the file Claude Code saved it to cost 1-2 turns. **The
     pre-registered cost rule fails on rulers.** The hand-over now says to
     keep the last 60 lines.
3. **New kinds of task and a second repository**: bug fixes in excalidraw
   (four real upstream fixes, two learned from, two held out) and validator.js
   (`examples/validator/`, four real upstream changes, two learned from, two
   held out), pre-registered in `examples/PREREGISTRATION-v1-new-kinds.md`.
   All 24 counted runs passed. **Memory didn't help either, and the rule
   fails for both.** validator.js: ulid +9% tokens / -7% dollars,
   postal-code-pk +1% / -2%; the tasks are small and an agent without memory
   finds the places in 2-3 turns. Bug fixes: the learning round made each
   seed bug a workflow of its own, cued by its own words; the held-out save-as
   bug got nothing (+0% tokens), the dropdown bug got a wrong workflow ("main
   menu" cues a Preferences toggle), which its agents ignored (-19% tokens,
   +5% dollars, within the spread).

Spent this session: $10.79 ($9.0 of agent runs, $1.8 of model calls that
built memory). Next step, my recommendation: memory has helped only where a
task repeats a past one's procedure across many places (toggles); before more
mechanisms, decide what memory should carry for one-off work like bug fixes,
where what tasks share is how to reproduce and check, not where to edit.

## Status: the local-first memory is sealed (2026-10-04, seventh session)

The user sealed v1 without a model call at task start as **the local-first
memory**: tag `memory-local-first`. What changed from v1 as measured, and
nothing else:

- **Picking makes no model call.** Each workflow carries cues: phrases that
  say a task needs it ("right-click menu", "add a test"), cues for its
  conditional steps ("view mode"), and where a task states its blanks' values
  (the name in backticks, the key combination, the word after "default").
  They are written once, when memory is built (`workflows cues`, one model
  call and a retry, $0.09 for the seed memory; `src/workflows/CueWriter.ts`,
  checked against the tasks memory learned from), and matched exactly at task
  start with the task's negated clauses left out (`src/workflows/Cues.ts`).
- **Blanks the task states are filled in**: "Add `rulersEnabled: false,` to
  the default app state". The rest stay blanks for the agent.
- Local first is the default: the hook and `workflows handover` pick by cues
  (words when memory has none); `SINGULARITY_SELECTOR=model` or `--pick model`
  brings the model call back. The `workflows` eval setup still sets it, so it
  stays v1 as measured; `workflows-cues` is the local-first setup.
- The sealed memory: `runs/excalidraw/memory/v1-cues`, version 2 (v1-seed's
  version 1 plus cues), sha256 of `versions/000002.json`
  `04b51cbb42a63bcc013b79440e8de22f7fd639e6e75198ef236bd78c105ec1f9`. `runs/`
  isn't in git; the hash says it's unchanged.

**How it did** (pre-registered in `examples/excalidraw/PREREGISTRATION-v1-cues.md`,
18 runs, $3.73, scores with `score-v1.ts cues`): no failed run (v1: 1 of 24 on
these tasks); tokens below v1 on 5 of 6 tasks (minimap -17%, rulers -26%,
midpoint -23%, page breaks -13%, stats -2%; presenter +40%), dollars within a
few cents. Rule 2 (within +15% on 5 of 6 tasks) failed, 4 of 6: stats' dollars
came from two runs starting at the same moment in the two lanes (both paid to
write the prompt cache), presenter's tokens from the App.tsx import edit that
fails in every setup. The user took it as v1 not needing the model call.

**Before it, also from this session** (results in `PREREGISTRATION-v1.md`):
an existing example at each place didn't help; the change drafted at task
start saved tokens but not dollars. The user dropped the drafted change and
any idea of memory writing or applying code: memory helps the agent do the
task, it doesn't do it.

**Known weaknesses of the local-first memory:**

- Cues come from two tasks: "toggle it" picks the "create a toggle action"
  workflow for a task whose action exists (midpoint snapping: 4 places it
  didn't need, in the free check and the runs).
- A build or a learning round (`workflows build`, `workflows evolve`) writes
  workflows without cues; run `workflows cues` after it. `evolve`'s gate still
  replays with a model pick.
- Labels aren't filled (the cue model left them to the agent).
- Measurement runs of the same task shouldn't start at the same moment in two
  lanes: the first to reach the prompt cache pays for it.

## Status: the change drafted at task start was tested on v1: fewer tokens, more dollars (2026-10-04, seventh session)

With the user's go: a second model call at task start writes the change itself
from the chosen workflows and the code, checked against the files before the
agent gets it (`src/workflows/Draft.ts`, setup `workflows-draft`; plain
`workflows` unchanged). 9 runs on the toggle tasks, $3.17 (results at the end
of `PREREGISTRATION-v1.md`): tokens -4% against v1 (rulers -29%), all passed,
no icons, but $0.36-0.39 a run against $0.29-0.33, since the drafting call
costs about what the agent saves. The agent still read around each edit
before making it and ran the finishing steps one per turn. The options this
leaves are at the end of `HANDOFF-v1.md`, for the user to decide. Not
committed yet.

## Status: an example to copy was tested on v1, and doesn't help (2026-10-04, seventh session)

The fix proposed in the next section ran with the user's go: at every place,
one whole entry of a single existing thing, read from the code at task start
(zen mode: its action file, its Preferences item, its help row, its line in
each list). 9 runs on the toggle tasks, $2.99, Claude Code 2.1.286, the same
memory (`run-v1-measurement.sh examples`, `score-v1.ts examples`; results at
the end of `PREREGISTRATION-v1.md`). No better: minimap 432k (v1 441k), rulers
584k (531k), presenter 621k (385k); all 9 passed; the first edit no earlier.
Every run searched the repository for the example and read its other wiring,
and all 3 rulers runs copied its icon. Reverted; the change is kept in
`runs/excalidraw/v1ex-toggles/example-change.patch`.

So the diagnosis below was wrong in its last step: the turns don't go to
finding an example. The agent checks and completes whatever the hand-over
leaves open; the exact script's runs edit everything in turn 2 because it is
the complete change in concrete lines. The options this leaves are at the end
of `HANDOFF-v1.md`, for the user to decide.

## Status: v1 measured; its goal isn't met, and the runs say why (2026-10-04, seventh session)

The comparison of `PREREGISTRATION-v1.md` ran with the user's go (71 runs,
$11.36; results at its end; scores with `examples/excalidraw/score-v1.ts`).
v1 and the pre-registration were committed before the first counted run
(`ae287ee`); the results and these notes are not committed yet.

- Rule 3 holds: v1 is never worse than no memory (-4% to -85% on all nine
  tasks), and its warnings worked (doubled flag 0 of 33, `handleKeyboardGlobally`
  5 of 5, no unasked tests).
- Rules 1, 2 and 4 fail: +41% against the exact script on repeats and twins
  (rulers +184%), 1 of 4 similar tasks won (stats, within noise), and 1 of 33
  runs failed (a rulers run labelled its setting "Toggle rulers"; the hidden
  test looks for "Rulers"). Against v0 (with its code at the places), v1 is
  +11% (median per task), worse on the toggle tasks.
- Why: turns. v1's places were right in its own runs (rulers 19 of 19), but on
  the toggle tasks it took more turns (rulers 12, v0 8, exact script 5) and
  4-5 turns before its first edit (v0 2-3, exact 1), with a longer hand-over
  each turn. It shows where to edit but, for what must be copied (a new action
  file, a Preferences item, a help-dialog row), only sibling names or the end
  of a list; v0 handed over a whole sibling file and the neighbouring lines.
  The agent reads an example first.
- Next, for the user to decide: show one complete sibling at each place (the
  last whole member of the list) and the shortest sibling file whole for new
  files, both read from today's code, with shorter step text; check it on the
  toggle tasks (a few paid runs). Learning from results (`evolve` on these 33
  runs) is the other lever, untested in paid runs.

## Status: v1 built and checked for free; the paid comparison is drafted, then run (2026-10-04, seventh session)

**Built** (not committed yet; `npm test`: 176 passed, typecheck clean), all in
`src/workflows/` apart from the eval setup and CLI:

- `Places.ts`: a place is the chain of blocks around an edit (`class App ›
  getContextMenuItems = ( › if (type === "canvas") { › return [`), from
  indentation, lifted to each statement's first line; a block's opening line
  joined with its attributes tells look-alike blocks apart; a changed row among
  look-alike rows stands for its list; top-level additions are a group of
  statements that start alike (`PreferencesToggle…`, keywords aside) or the
  imports. `resolvePlace` finds a place in today's code among the direct
  children of each block, exactly, else by first words.
- `Edits.ts`, `Evidence.ts`: a run's diff as edits with their places, in the
  order the run made them (from its log), new files with the siblings they
  are named like, detours, checks, and the task's own values (what the prompt
  quotes, and names the change brought that the repo didn't have before, by
  `git grep`).
- `Induce.ts`: one Sonnet call (high effort) reads the evidence and proposes
  workflows with blanks, edges with conditions, pitfalls with exact triggers;
  checks drop what names a task's values, places one run used or a task's own
  file (one of many files named alike, edited by one task), triggers that
  don't single out their mistake; problems go back once. A workflow learned
  from unasked work is `only_if_asked`.
- `Select.ts` (one Sonnet call at task start, thinking off, about $0.02),
  `Locate.ts` (places found in the working tree or at a commit; a place whose
  file no longer has it is looked for where its outermost block's first line
  now is), `Render.ts` (workflows in graph order, each place with current line
  numbers and a short excerpt, under 9,800 characters), `Start.ts`.
- Hooks: `src/workflows/hook.ts` with `HookStart.ts`, `HookTool.ts`
  (pitfall triggers), `HookEnd.ts` (session record with `Feedback.ts`: which
  shown places a run edited, which it left alone, where it went instead).
  Eval setup `workflows` (`src/eval/WorkflowsMemory.ts`), tested end to end
  with the fake claude. v0's code is untouched.
- `Evolve.ts`: learning from results: new runs' results (what memory showed
  or would have shown, against where they edited), a refinement by the
  inducing model with rejected revisions in view, and a gate that replays
  current and revised memory over all runs and keeps the revision only if
  shown-and-edited minus shown-and-unused doesn't drop.
- CLI `workflows build|show|candidates|handover|evolve`; checks
  `examples/excalidraw/check-v1-places.ts` and `check-older-code.ts`.

**The seed memory** `runs/excalidraw/memory/v1-seed` (version 1; the six seed
records, as v0's): 8 workflows (add an app-state field, create a toggle
action, give an action a keyboard shortcut, change an action's shortcut, add
to the right-click menu with the view-mode list conditional, add a
Preferences toggle, update snapshots, and a keyboard test only if asked, with
the `handleKeyboardGlobally` pitfall), 20 places, 4 pitfalls; $0.14. Three
builds before it, each fixing something the previous showed: a step at zen's
own file, the keyboard pitfall's wrong cause (the model now sees the edits
that fixed a detour), the shortcut workflow split in two (workflows must be
complete for their purpose), and the test workflow handed to tasks that only
"update" tests (`only_if_asked`).

**Free checks** (tables in `examples/excalidraw/PREREGISTRATION-v1.md`):

- Held out (`check-v1-places.ts`, selections about $0.25 a pass): rulers 18
  of 18 places shown, presenter 17 of 17 without the view-mode list,
  page-breaks 7 of 7 plus 4 it didn't need (it made no action; memory only saw
  minimap, which needed one), midpoint 4 of 7 (v0: 0), shortcut tasks 3 of
  4-5 with nothing extra. Weak: the old suite's tool-shortcut tasks (rectangle
  R→M) get the action-shortcut workflow and 3 useless places; the picker
  can't tell a tool from an action by words, thinking or not. Learning from
  such a run is the cure.
- Older code (`check-older-code.ts`): over 7 and 17 months v0's lines and v1's
  places hold equally (both 19 places, 13 of the March 2026 commit's
  additions in a known place); across excalidraw's move of its files (2023,
  2022) v0 finds nothing, v1 finds 11 and 7 places in the files they moved to.
  So v1's advantage here is fitting other tasks, and surviving moves; not
  months of ordinary change, which v0's lines survived too.

**Learning from results, tried for free-ish** ($0.52, in a copy of the seed
memory at `C:\singularity-workspaces\_v1-evolve-test`): one `workflows evolve`
round with the 10 no-memory runs of `page-breaks` and `midpoint-snap-n` as
new runs. Replayed over all 16 runs, the revision shows 122 of the 140 places
they edited (the seed memory 118) and 4 places they left alone (23); the gate
kept it. It learned, in general words, that a Preferences-only setting needs
no action (the item can set the field itself), and that giving an existing
action a shortcut also shows it on the action's existing menu item. On tasks
it didn't learn from, the held-out check is about the same (rulers one place
fewer, within the selection's noise). The real seed memory is unchanged.

**Next:** the user approves (or changes) `PREREGISTRATION-v1.md` and its spend
(71 runs, about $16, or 41 runs, about $9, without new v0 runs); then commit
it, smoke and gate, run. Spent this session on model calls: about $1.85.

## Status: memory v0 frozen, v1 being built from scratch (2026-10-04, seventh session)

**Why.** The user rejected the direction of the sessions before
(2026-10-03): memory that stores copies of the repo (the lines next to past
edits) goes stale when the repo changes, and work on detecting that change
was "tunnel visioning". Address the root, not the side effect. The same root
makes memory fit only twins: a copy of one task's lines fits that task at
that commit.

**The user's vision**, from two papers they named as the memory layer's two
main components: "from the AWM paper we establish atomic workflows and from
Procedural Graphs we establish graphs of those atomic workflows."

- Agent Workflow Memory (https://arxiv.org/html/2409.07429v1): small reusable
  workflows induced from past runs, the task's specifics replaced by blanks
  ({product-name}), filled from the environment the agent is in. In its tests
  abstract workflows beat concrete past examples (agents lean toward what
  they were shown), and workflows run as fixed macros broke when the page
  changed.
- Procedural Graphs (https://arxiv.org/html/2609.09153v1, the reference
  paper): a graph whose edges say when to take a transition (condition,
  guidance, pitfalls), evolved from results by a refiner, every candidate
  checked before commit, rejected edits remembered. It repaired a hand-made
  graph that had made the agent worse.

**v0 and v1** (confirmed by the user, 2026-10-04):

- v0, the memory up to the sixth session, frozen as commit tag `memory-v0`
  with its memory homes in `runs/excalidraw/memory/` (`local-seed`,
  `local-zen`, `local-seed-spots`): a route of steps per kind of past task,
  steps pointing to exact lines copied from past runs, rebuilt by hand, never
  learning whether its advice worked.
- v1, built from scratch: small reusable workflows written with blanks, no
  copied code (the blanks are filled from the code as it is when used); a
  graph connecting them, with when to take each transition and the traps;
  learning from results (keep what helped, fix or drop what misled, check
  every change before keeping it).
- The same in both: the goal (correct results for fewer tokens, tool calls
  and dollars) and memory arriving by itself: a hook hands it over or the
  agent looks it up. The harness never pastes it into the prompt.
- The user's correction: surviving code changes is one risk v1 handles, not
  its purpose. The purpose stays correct results at lower cost.

**The comparison** (agreed in principle, to be pre-registered with its cost
for the user's go): no memory, exact script (saved-scripts), v0 and v1,
measured as always (does the task come out right; tokens, tool calls,
dollars). Kinds of task:

- exact repeat: the very same task again (minimap twice);
- twin: the same task with only names and values changed, same steps at the
  same places (rulers after minimap);
- similar: shares only some steps (page breaks, a subset; presenter, other
  rules; the midpoint shortcut, a mix of two past tasks);
- code that changed: memory learned on one version of excalidraw, used on
  another.

The win: v1 close to the exact script on exact repeats and twins, better than
it on similar tasks and changed code, and never worse than no memory (the
user's "yes"). Order: build v1, the free checks (a task held out of memory;
older code), then the pre-registered paid runs.

The sixth session's open question (rework what a place is) is replaced by v1.

## Status: the code at the route's places was tested; it helps a twin task and is too targeted (2026-10-03, sixth session)

**Where things stand.** With the route, the hook now hands over the code at
its places (built, tested, described in the next section). A 3-run test on
`toggle-rulers` cut the tokens by 46% but failed its own rule on reading
turns, and a free check showed the places fit only a task that is the twin of
the one memory learned from, as the user suspected. A rework of what a place
is was proposed to the user (below) and is **not yet answered**; nothing more
should be built or run before they answer. Nothing of this session is
committed. Spent in the session: $0.65 on the 3 runs and about $0.13 on route
selections for previews.

**The test ran** (3 runs of `toggle-rulers`, $0.65, all passed; results at the
end of `examples/excalidraw/PREREGISTRATION-local-memory.md`):

- Tokens 328k (225-400k) against 604k, turns 8 (6-10) against 14, and no
  failed edit in any run (3 of 3 before). The hand-over arrived whole.
- Its rule 1 fails: 3 turns before the first edit (2-3), not 2. The agent
  reads lines it was shown again (in one run, 10 of the 12 files), reads
  other toggles than the one handed over, and looks through the icons.
- Stage 4's bar on this task (215k) isn't met; the best run was 225k.

**The user's doubt, and what the logs say** (`examples/excalidraw/check-places.ts`,
no runs). The user asked whether these results aren't too targeted, as the
ideas before them were too naive. Holding each task out (memory from the
seed tasks only, compared with where the task's own no-memory runs edited):

- `toggle-rulers`, minimap's twin: 16 of its 17 additions go where memory
  shows; 1 of 19 places shown is left alone.
- `toggle-presenter`: all 16, but 7 at other lines of the same list; the
  view-mode menu is shown in every run, and the task must leave it alone.
- `page-breaks`: all 7, 6 at other lines; 9 of the 16 places shown are
  things the task says not to do (key table, action, right-click menus).
- `midpoint-snap-n`: none of its 7; memory has no place for it.
- With every other task in memory it gets worse for rulers (13 of 17): runs
  agree on the list an edit goes into, not on the line, so fewer places
  reach agreement.

So the test measured the best case.

**Proposed to the user, waiting for their answer** (not built):

- A place becomes the list or block an edit goes into (the storage config,
  the menu), not the lines next to one task's edit.
- A place is required or conditional, learned by comparing the tasks that
  used it with those that didn't, as optional steps already are. The four
  toggle-like tasks' runs are there to learn from (`toggle-minimap`,
  `toggle-rulers`, `toggle-presenter`, `page-breaks`).
- The hold-one-out check is the free test, before any paid run. Target:
  presenter is no longer shown the view-mode menu, `page-breaks` no longer
  its nine places, and rulers keeps 16 of 17.
- Only then a paid run, on presenter and `page-breaks`: the tasks that can
  show whether it holds beyond a twin.

**Also seen, not proposed yet:**

- Since the agent reads again what it is shown in most runs, line ranges
  alone (which file, which lines, looked up at task start) may do what the
  code does for a sixth of the characters. Not tested.
- A place shown should say which list it is: all three runs read from ten
  lines above the menus in `App.tsx`, where the view-mode condition is, and
  one searched `en.json` for the section its lines were in.

**The size limit** (the user asked how to deal with it; nothing decided).
Claude Code cuts a hook's text at 10,000 characters. For rulers everything
found fits. The answer given:

- It is partly a limit we would want: everything handed over is reread each
  turn, so 10,000 characters cost about 17k tokens over a 6-turn task, under
  half a turn, and 20,000 about a whole turn. More text pays only if it
  removes a turn.
- First choice: spend the room by evidence. A run's log says what was shown
  and its transcript what the agent read anyway; a place it read again was
  wasted room, a file it had to open was missing.
- For more room: a second hook for the same event (each hook's text is
  measured on its own and the agent gets all of them; they run in parallel,
  so the second must wait for the first's choice of route, and their order
  isn't documented; needs a check in a real session).
- As a fallback: put what doesn't fit in a file named at the end of the
  hand-over, which costs the agent one read when it needs it.
- No help: rewriting the prompt (hooks can't), squeezing the text, or the
  system prompt (only in eval runs).

## Built in the sixth session: the code at the route's places

**What the logs said** (`examples/excalidraw/check-turns.ts`, no new runs).
The user asked about another session's idea (`examples/excalidraw/why-14-turns.html`:
add "do it like grid mode" pointers to the route) and judged it as naive as a
saved diff. The logs agree, on the toggle tasks:

- Every run without a saved diff (27 of 27: no memory, the graph, the seed
  memory) searches for an existing toggle by name in its first turn. A
  pointer hands over what the agent already has.
- It then takes 5-7 turns before its first edit, reading the places a few at
  a time (about 10 files). With a saved diff: 1 turn, since the diff shows
  the lines around every edit.
- An edit to `App.tsx` fails in 8 of 9 seed-memory runs and in 8 of 9
  no-memory runs, nearly always the import list, though all 9 seed-memory
  runs were warned ("the name appears twice, include neighbouring lines").
  The agent never read the import list, so it guesses the neighbouring line.
  Advice about lines it hasn't seen can't be followed.

So the agent lacks the lines at the places, not the pattern.

**The user's decision** (2026-10-03): go ahead with the hook reading those
lines from the working tree at task start, with memory keeping only where to
look. This is close to the exact locations the user ruled out in step 2, and
was put to them as such. What memory keeps: the existing lines just above and
below where runs added their own (never the new lines), handed over only
where two runs of the kind, and most of them, agree.

**Built** (not committed; `npm test`: 151 passed; typecheck clean):

- `src/records/Spots.ts`: a record's spots, from its diff. Only pure
  additions to files that were there; changed or removed lines were the
  task's own target. Records keep them (`spots`); for records built before,
  a graph build reads them from the run's diff (`withSpots` in `Merge.ts`).
- The graph: a step's place gets `spots` (with the records behind each; none
  in a task's own files or naming its values) and `examples` (for a step
  that writes a new file: files next to it that its runs read and left alone).
- `src/handover/Excerpts.ts`: at task start each spot is looked up in the
  working tree, as a pair of lines (one line alone only where it is the single
  one of its kind in the file). Close ones are one place; a place counts with
  two runs of the task's kind and 60% of those that took the step. It shows a
  line on each side, a small list around it whole, and a small block a spot's
  line opens. A step that writes a new file gets the file most of its runs
  read first, whole if small. A file whose lines are shown isn't listed with
  its step as well.
- **Claude Code cuts a hook's text at 10,000 characters** (its docs: over
  that it hands the agent a file path and the first 2,000). So the hand-over
  has a budget (9,800): places first, largest files first, then the file to
  read first, then whole blocks.
- `runs/excalidraw/memory/local-seed-spots`: a copy of the seed memory, its
  graph (version 2) the same plus spots and examples. `local-seed` is
  unchanged, and with it the hand-over is byte for byte the one measured.
- Previews for all nine tasks: `runs/excalidraw/previews-local-memory/spots-*.md`.
  `toggle-rulers` gets the same 8 steps and 3 warnings, 18 places in 11
  files (the key table whole, both right-click menus, the import list's two
  spots, a whole Preferences item) and `actionToggleObjectsSnapMode.tsx`
  whole: 9,376 characters (2,867 before). The shortcut tasks get the key
  table (2k characters).

**Its test** was pre-registered at the end of
`examples/excalidraw/PREREGISTRATION-local-memory.md` and run with the user's
go (`run-local-memory-measurement.sh spots 0 2`, output in
`runs/excalidraw/hooks-spots-1`); the status above has the results.
`check-turns.ts` scores runs by turns; `check-places.ts` holds each task out
and compares the places memory would show with where its runs edited.

**Known weak spots**: the file handed over whole has details of its own (snap
mode's action also turns the grid off and has an icon; one run of three added
an icon); the route still says "(browser only)" and "CODES lacked M", from
the seed tasks; a place shown starts at its list, without the line that says
which list it is (all three runs read above the menus in `App.tsx` to see the
view-mode condition).

## Status: stage 4 measured, its goal isn't met (2026-10-03)

The measurement ran (50 runs, $12.02, 15:09–17:56 at normal priority, at the
user's request). Full results at the end of
`examples/excalidraw/PREREGISTRATION-local-memory.md`; scores with
`examples/excalidraw/score-local-memory.ts`, run checks with `check-runs.ts`.

- **The goal isn't met.** Rule 1 fails: +132% tokens against saved-scripts on
  the six existing tasks (the graph was +82%). Rule 2 fails on one cell of 12:
  the zen-only memory on `toggle-rulers` (+72% against no memory), though that
  memory handed nothing over there, so it is variance among runs that behaved
  like no memory. Rule 3 holds: no failed run.
- **Turns make the gap**: every setup reads 30–45k tokens per turn. On the
  toggle tasks the route's runs took 13–14 turns, as many as no memory,
  against saved-scripts' 5–8: the route names steps and files but not how to
  write the edits, so the agent reads existing toggles first.
- **What worked**: the warnings handed over at the start (the doubled flag in
  0 of 33 seed-memory runs; `handleKeyboardGlobally` avoided in 5 of 5 stats
  runs, −46% against saved-scripts); no unasked test step was handed over (2
  of 11 runs wrote one on their own, as without memory).
- **What missed**: a trigger tied to one file. A snap run wrote an unasked
  test in a new file without `handleKeyboardGlobally` and lost about 900k
  tokens; the trigger watches only `excalidraw.test.tsx`.
- The gate passed (+4% and −1% against the earlier runs), so the comparisons
  are between runs of the same Claude Code version and are clean.
- Not committed: the results, amendment 4 (normal priority, `--priority
  normal`), `check-runs.ts` and `score-local-memory.ts`.

Next: decide with the user, from what failed. The data points at the route's
missing "how" for multi-file steps, and at triggers that watch the mistake
rather than one file. (The sixth session took up the first: see the status
at the top. The second is untouched.)

### How the measurement was prepared

The user asked whether runs had been made and whether they could be compared
cleanly with the earlier ones. None had: the fifth session built memory from
the old runs and checked it by replaying them, which is free. Comparing new
runs cleanly needed the same evidence (memory from the seed runs only) and the
same conditions (Claude Code had moved to 2.1.288). The user then said to
prepare the paid measurement (build stage 4) for them to read before anything
is spent.

- **The pre-registration**: `examples/excalidraw/PREREGISTRATION-local-memory.md`
  (memory, runs, the gate, the rules), committed by the user as `832ea34`
  before any counted run.
- **A `hooks` setup** (`src/eval/HooksMemory.ts`): the local memory handed
  over by its own hooks during the run (`--settings`), from a copy of a frozen
  memory home in the run's directory; the route selection's cost counts toward
  the run. Tested end to end: the fake claude runs the real hook scripts.
- **Frozen memories** from the seed runs only, each built in a home of its own:
  `runs/excalidraw/memory/local-seed` (zen and minimap) and `local-zen` (zen
  only, for the partial-overlap test). Hashes are in the pre-registration.
- **The same conditions**: Claude Code keeps earlier versions in
  `~/.local/share/claude/versions/`, so every run uses its baselines' version
  (2.1.286 for the existing tasks, 2.1.287 for the new ones) from pinned
  copies in `C:\singularity-workspaces\_claude`. Runs never update Claude Code
  (`DISABLE_AUTOUPDATER=1`). A gate of 6 runs checks that nothing else moved.
- **Two fixes** found while building the seed memories (the pre-registration's
  amendments): a trigger may not contain the task's own values (it could never
  fire on another task), and a task's own files (`actionToggleZenMode.tsx`)
  don't count as where a step happens.
- `npm test`: 131 passed. `npm run typecheck`: clean.

## Status (fifth session): the local version is built

The user asked to build the local setup first (2026-10-03): stores in
`~/.singularity`, a CLI and hooks for storing and for exact and word search,
and graph building, keeping the model call at task start and leaving the
cloud steps for later. All of it is built, on branch `local-memory` (from
`main` after PR #3 was merged), committed as `835c8de`. `npm test`: 126
passed. `npm run typecheck`: clean.

What exists now, with what it showed on the excalidraw runs:

- **The store** (`~/.singularity`, tenant `local`, subject `excalidraw`
  recognized by its root commit). Records, the memory graph and session
  state are JSON files behind `RecordStore` and `MemoryStore` interfaces,
  each with its own layer, like `GraphStore`.
- **Records, the mechanical part** (stage 1a, free): all 146 runs under
  `runs/excalidraw` are records (145 successes, 1 failure). Known answers:
  every run in which the doubled `--watch=false` actually ran has a detour
  for it (in 3 the fix was another test command, so the detour doesn't name
  the flag; in one the command never ran). The `handleKeyboardGlobally`
  debugging shows as test-failure detours: 842k and 856k tokens in the two
  zen runs that wrote their own test, 34k–639k in the five saved-scripts
  stats runs.
- **Records, the model part** (stage 1b): 55 records read (up to 4 per task,
  runs without memory first), $2.44 plus about $0.2 of trial readings.
  Known answer: the zen runs' unrequested test step comes out as "chosen".
  Of 52 lessons, 42 came with a trigger that held up against the log. 32
  check commands were dropped by a check that was too strict (a typecheck
  chained with the failing doubled-flag command); the check is fixed for
  future readings.
- **Search**: `search` (word) and `search --exact`, over records, task
  kinds, steps and warnings.
- **The graph** (stage 2): version 6, 4 task kinds, 25 steps, 15 warnings.
  The replay over the 55 read tasks: 0 steps handed over unneeded, 0 needed
  steps missing, every task matched to its kind, warnings reach all 52
  detours with a lesson, 0 false alarms. Known answer: the "add a keyboard
  test" step is optional, "only when the task explicitly asks for a new
  test", so no shortcut task is handed it unasked; a build that made it
  required is rejected (`test/memory/build.test.ts`).
- **Warnings that matter**: the doubled flag (trigger `test:update` +
  `--watch=false`, on the snapshot step) and `handleKeyboardGlobally`
  (trigger: an edit to `excalidraw.test.tsx` writing `fireEvent.keyDown(document`
  and `altKey` without `handleKeyboardGlobally`, on the keyboard-test step,
  median cost 653k tokens). `memory triggers` (the free check) replays the
  recorded runs, each warning only against runs it wasn't learned from: the
  `handleKeyboardGlobally` warning would have arrived before the mistake in
  3 of 5 such runs (1,016k tokens of detour); the doubled flag's arrives at
  the failing call itself, as predicted, so it is also handed over at the
  start with its step.
- **The hand-over** (stage 3, local): `handover TASK` shows what a task
  would get. The stats task gets 9 steps including the keyboard test and the
  `handleKeyboardGlobally` warning; the zen task gets 7, without the test
  step ("the task doesn't ask for a new test"). About $0.03 and 7 s.
- **Hooks**, checked end to end with real Claude Code 2.1.288 (Haiku, a tiny
  repo with seeded memory, hooks passed with `--settings`, $0.05): the route
  arrived at the first prompt and the trigger warning after `npm test`, both
  as `hook_additional_context`; the session was recorded at its end (commit
  plus passing tests), with feedback that the warning was followed and both
  steps' files were changed. Not installed in the user's own settings: that
  is the user's call (`hooks install`).

## Redesign in progress (from 2026-10-02, at the user's request)

The user paused the experiments to rethink the design from the ground up, one
step at a time, each the foundation for the next:

1. Lessons from the experiments (done).
2. What to extract from runs, from which runs, and when (agreed).
3. The workflow record and its interface (agreed).
4. The graph: how workflows connect, and its interface (agreed).
5. Retrieval and the abstract layer: the interface the agent sees, and all
   the ways it could get what it needs (agreed).
6. Multi-repo: sharing across repos without losing accuracy (agreed: one
   tenant, many subjects).

**Step 1, the lessons:**

- Turns, not tool calls, drive tokens: each turn rereads about 24k tokens of
  Claude Code's own prompt plus everything read so far. The agent's own
  output, thinking included, is about 1.3% of a run's tokens.
- Knowing where each edit goes saves the most. Steps without locations send
  the agent searching. The user's own run 6 reached its first edit in 3
  calls, against 18–25 with a prose note or a graph.
- Warnings from mistakes work and are followed (0 of 39 runs with the warning
  doubled the test flag, against 20 of 21 without). They come from detours,
  so costly runs are useful input.
- Wrong or extra advice is followed too (unrequested tests; the zen-only graph
  was 42% worse than no memory). A wrong hint costs more than a missing one.
- Memory records false facts unless they're checked against the code and the
  commands' results (the masked failing command, the user's
  `actionProperties.tsx` link, wrong search strings in their v2 record).
- Savings need room: cheap tasks gain little; traps gain most.
- Tasks that combine parts of several past tasks are unsolved.
- Runs vary a lot: medians with ranges, 5 runs on risky tasks, rules first.

Added in the sixth session, from the logs and its test:

- The agent lacks the lines at the places, not the pattern. On the toggle
  tasks every run finds an existing toggle to copy from in its first turn
  (27 of 27), then spends 5-7 turns reading the places. Pointing it to an
  example hands over what it has.
- Advice about lines the agent hasn't seen can't be followed: the warning
  about the import list didn't change how often that edit failed (8 of 9
  with it, 8 of 9 without). Showing the lines did (0 of 3).
- Shown the code, the agent often reads it again before editing, at the very
  line ranges it was given. Line numbers get used.
- A file handed over as an example is copied in its details too (an icon
  nobody asked for).
- Runs of different tasks agree on the list an edit goes into, not on the
  line. What one task's runs agree on is that task's choice.
- A result on a task that is the twin of the one memory learned from says
  nothing about other tasks. Holding a task out, for free, before a paid
  run, tells how targeted a memory is.

**Step 2, so far:**

- Agreed: extract from successful runs (path and detours), from failed runs
  only verifiable mistakes, and from runs that used memory whether each piece
  helped. Build a record per run right after it succeeds, mostly
  mechanically; merge records into the graph in batches, since one run can't
  tell a needed step from the agent's own extra (the unrequested-test step
  came from two zen runs that wrote a test on their own).
- **The user rejects exact locations** (the existing line an edit sits next
  to): that memorizes one solution, and a file per task would do the same.
  Proposed instead: **landmarks**, facts about the codebase that several tasks
  share ("a setting appears in two right-click menus in `App.tsx`, one for
  view mode"). Proposed rule: a fact earns its place only if more than one
  kind of task can use it, or if it's a warning. Not yet agreed.
  - Revisited in the sixth session (2026-10-03), after stage 4: the user
    agreed to memory keeping the existing lines edits went between, looked up
    in the code at task start (see the status at the top).
- Storing many facts is cheap; handing over ones that don't apply is not,
  because the agent acts on them. So nodes can hold a lot, as long as
  retrieval hands over only what applies (step 5).
- Retrieval means finding memory (workflows, nodes, edges), by three methods:
  exact string (commands, paths, errors), similarity (shared words) and
  semantic (meaning, through embeddings or a model reading conditions). Each
  piece of memory carries the keys it should be found by. Exact matching is
  cheap enough to run on every command during a task, so warnings can arrive
  when they apply. One method proposes and another confirms, since wrong
  matches get followed.

**Step 3, proposed (2026-10-03): the workflow record**, one per run, built
once the run counts as successful, and never changed afterwards. It is the
evidence; the graph is what changes, and points back to its records.

- Parts: the run (repo, starting commit, cost, outcome, a pointer to the raw
  log, which stays where the run happened); the task (its kind in general
  words, what it asked for and ruled out, task-specific values marked as
  such); the path (each step's purpose, whether the task asked for it or the
  agent chose it, its landmarks, files touched, and the command that checked
  it); detours (trigger, symptom, fix, cost); verified facts (commands that
  worked, false leads, which tests cover what); and, for runs that used
  memory, what each piece of memory did.
- Every piece carries retrieval keys: exact strings, its text, its meaning.
- No new code, no exact lines, nothing unverified unless marked as such.
- Built mechanically where possible (the log against the final diff and the
  commands' results), with a model naming steps and judging asked-for versus
  chosen; every claim about the code is checked against the code.
- Failed runs get a record with only their verifiable mistakes.
- Interface: build a record from a finished run; add feedback when a run
  used memory; find records by repo, task kind, step or key.
- Agreed by the user (2026-10-03), landmarks included.

**The user's abstract layer (clarified 2026-10-03)** is the interface the
agent actually sees and uses. It hides the memory layer's complexity and
hands over exactly what the agent needs. It is step 5, not part of the graph.

**Step 4, agreed (2026-10-03): the graph**, the hidden memory layer behind
that interface: what the records add up to, in three layers:

- Task kinds: typical routes through the steps, such as "change an action's
  shortcut", with the conditions that change the route.
- Steps and transitions: each step merged from many records, with its
  landmarks per repo, its checks and its warnings; transitions carry
  conditions.
- Records at the bottom: every item points to the records behind it.
- Merging, in batches: match a record's steps to existing ones by exact keys
  first, then by meaning, with a model confirming close calls. Steps shared
  across task kinds become one node (the user's implicit skills, such as
  "give an action a shortcut": key table, label, help dialog). A step is
  required if every successful run of its kind took it or the task asked
  for it, otherwise optional and handed over only when asked for. Detours
  merge into warnings by trigger. Conditions come from comparing tasks that
  took a transition with those that didn't.
- Accuracy: every merge is a candidate. A free replay check comes first: for
  each past task, would the new graph hand over what it needed and nothing
  else? That would have caught the unrequested test step. Landmarks are
  checked against the current code; feedback from runs that used memory
  moves confidence; rejected changes are remembered.
- Where it should pay off: tasks like `midpoint-snap-n`, which match no
  single past task but reuse a shared sub-route.
- Interface: merge a batch as a candidate; check, then commit or reject;
  read task kinds, routes, steps and warnings by any key, with evidence;
  trace any item to its records.

**Step 5, agreed (2026-10-03): the abstract layer**, the interface the
agent sees. It hands memory over at two moments, and only what applies:

- At task start: the route for this task (its steps, where each happens,
  how each is checked) and the warnings on those steps. Found by
  similarity or meaning on the task text, confirmed by a model reading the
  conditions. No records, counts or other task kinds.
- During the task: a warning when its exact trigger appears (a command, a
  file, an error). Example: when the agent writes a keyboard test that
  renders `<Excalidraw>` without `handleKeyboardGlobally`, it is told right
  then, instead of debugging for about 24 calls.
  - Caveat from the data: a warning saves a turn only if it arrives before
    the mistake is made. The doubled `--watch=false` fails at once, so
    blocking that command still costs the retry turn; that warning belongs
    at task start (it worked there: 0 of 5). Just-in-time suits traps that
    are expensive to discover later.
- Delivery, the open decision: an MCP tool is pull (the agent must ask, and
  each question usually costs a turn of 25–50k tokens). Claude Code hooks
  are push (a script at session start or before and after each tool call,
  no asking). Both can query the hosted server. Proposed: hooks for the two
  moments, plus an MCP tool for when the agent is stuck.
  - CLI or MCP for the pull (checked in Claude Code's docs, 2026-10-03):
    the same per question. MCP needs no install (a URL and a login) and
    fits the hosted plan; a CLI must be installed and kept up to date on
    every machine. Claude Code defers MCP tools by default (tool search):
    the agent searches before its first call, one extra turn, unless the
    server is marked `alwaysLoad` ("Exempt a server from deferral" in the
    MCP docs). Bash is always loaded, so a CLI has no such turn.
  - Hooks don't need a CLI: a hook can be a shell command, an HTTP POST
    (`"type": "http"`) or a call to an MCP tool (`"type": "mcp_tool"`).
    Text a hook returns in `additionalContext` reaches the model next to
    the tool result (or before the first prompt, at session start), so it
    costs no extra turn. Hooks run in `claude -p` too.
  - A `PreToolUse` hook can also deny a command with a reason, or rewrite
    it before it runs (`updatedInput`). Rewriting would save the doubled
    flag's retry turn, but then memory acts instead of advising: an open
    question for later.
- Local and cloud, the user's split (2026-10-03): the CLI stores records
  and does lexical and exact search (local, no model). Semantic search is
  cloud-only and reached through MCP. The user doesn't want semantic search
  in the CLI.
  - API or MCP for embedding and semantic search, proposed: an API on the
    server does both. Embedding is machine work (a record when it is
    stored, the task text when it is searched); the agent never needs a
    vector, so it gets no tool for it. The MCP tool is a thin door on that
    API for the agent; hooks (`"type": "http"`) and the CLI call the API
    directly.
  - The split fits how often each search runs: exact triggers are checked
    on every tool call, so they stay local and fast; semantic search runs
    once at task start, so a cloud round trip is fine. At task start one
    call returns the route, its warnings and their exact triggers; the CLI
    keeps them for the session so later hooks match locally.
  - The agent still gets one answer, never a choice between two searches:
    the task-start hook merges local and cloud results.
  - The task-start hook is `UserPromptSubmit`, which fires with the task
    text (confirm its input field when building; its default timeout is
    30 s). `SessionStart` fires before the prompt and doesn't receive it.
- Every handover is logged, so the run's record can say what each piece of
  memory did (step 3's feedback).
- Agreed by the user (2026-10-03), with the API under the MCP tool.

**Step 6, agreed (2026-10-03): many repos.** One graph for all repos.
Every item in it has a reach, and the agent gets only the items whose reach
includes its repo:

- Tenants and subjects (decided by the user): the product is multi-tenant,
  and a tenant holds several subjects (repos). Memory can be shared between
  subjects in a tenant, never between tenants. For now: one tenant with
  several subjects. Everything below happens inside one tenant; every item
  still carries its tenant, so isolation is there from the start.
- Reach: this subject; subjects that use the same tools (recognized by exact
  checks, such as `vitest` in `package.json`); or every subject in the
  tenant (lessons about the agent's own tools).
- Everything starts in its own repo and reaches further only on evidence:
  the same lesson learned independently in another repo (matched by exact
  keys first, then by meaning), or tried there and found to hold. A model
  may propose a wider reach, but it stays a proposal until then. Why: wrong
  advice gets followed (step 1), and our learner mixed the two before
  (excalidraw's `handleKeyboardGlobally` trap sat in the shared warnings,
  while the general lesson that the test runner's name filter is a pattern
  sat in excalidraw's facts).
- Never shared: landmarks, paths and commands. They're checked against each
  repo's code anyway (step 4), so another repo's can't pass.
- Low risk to try early in other repos: warnings with exact triggers, since
  they appear only when the trigger does. Example: "an edit fails when its
  text appears twice; quote more lines" fires on that error in any repo.
  Riskier: routes, which arrive at task start with no trigger. They reach
  another repo only as shapes (steps and order, no locations), only after
  holding in more than one repo, and only with conditions that can be
  checked there ("if the app has a help dialog listing shortcuts").
- A new repo's first tasks get only the wider items. Each successful run
  adds that repo's landmarks, so later tasks there get full routes.
- Accuracy: the replay check (step 4) runs in every repo an item reaches,
  and feedback is kept per repo, so an item can be right in one repo and
  wrong in another.
- To test it: a second repo with a few tasks of its own, with memory built
  from excalidraw runs only. Compare no memory and shared memory on the new
  repo. The rule: shared memory never makes a task worse than no memory.
- This replaces "one graph per repo for now" under Decisions.

**Build order (2026-10-03).** Each stage rests on the one before. Paid runs
and model calls only after an explicit go. On 2026-10-03 the user asked for
the local version first (stores in `~/.singularity`, CLI and hooks for
storing and for exact and word search, graph building), with the model call
at task start kept and the cloud steps deferred, and allowed model readings
of real records. Stages 1–3 are built locally, without the cloud parts
(semantic search, embeddings, the API and the MCP tool); see the status at
the top and "Local memory" under What's built. Stages 4 and 5 wait for a go.

1. Records.
   - a. The mechanical part (free): build a record from a finished run with
     no model. The run (tenant, subject, commit, cost, outcome, a pointer to
     its log), files touched (`diff.patch`), commands and whether they
     worked (`reportsFailure`), detours (a failing call, what fixed it, and
     the tokens spent in between) and checks (`checks.log`). A record store
     behind its own interface, JSON files for now. Input: the 145 successful
     runs under `runs/excalidraw`. Known answers to check it against: the
     doubled `--watch=false` detour in the 51 runs counted earlier (20
     saved-scripts, 31 no-memory) and in none of the 39 that had the
     warning; the `handleKeyboardGlobally` debugging where
     `check-warnings.ts` found it.
   - b. The model part (a few cents per run): a model names the steps and
     the task kind, marks each step asked-for or chosen, and proposes
     landmarks. Every claim is checked against the code at the run's
     commit, and claims that fail are dropped. Known answer: the zen runs'
     unrequested test step comes out as chosen.
2. The graph: merge records in batches into task kinds, steps, transitions
   and warnings, each with its reach and evidence. Every batch is a
   candidate, and the replay check decides commit or reject. Known answer:
   no shortcut task is handed a test step it didn't ask for.
3. The handover, on the user's machine first: the API (exact, lexical and
   semantic search, embeddings), the `UserPromptSubmit` hook (route and
   warnings at task start), `PreToolUse`/`PostToolUse` hooks (exact
   triggers), the MCP tool for when the agent is stuck, and the local CLI.
   Free check: replay recorded sessions through the trigger matcher and
   count the warnings that would have arrived before their mistake. Open:
   which embedding provider.
4. The measurement on excalidraw (paid, pre-registered first): the new
   memory against the saved-solutions baseline and no memory. Goal: tokens
   close to the baseline, success no worse.
5. Then a second subject (paid, pre-registered: a few tasks in another
   repo, memory from excalidraw only; shared memory must never make a task
   worse than no memory), and then hosting (the API and a graph database on
   the user's cloud, a tenant on every item).

The old pipeline (the per-run learner and the graph setup) stays until
stage 4 shows the new one is better; no-memory and saved-scripts stay as
baselines.

## Status (fourth session)

- **Branch `graph-setup`** (from `ts-effect-port`, which was merged into
  `main` as PR #2 on 2026-10-01), with a PR against `main`.
  - `2e74208` pre-registers three new task kinds and the win thresholds
    (`examples/excalidraw/PREREGISTRATION.md`), committed before any graph
    existed. The user had reread the claim and said to move on to the graph.
  - The next commit adds the graph setup's code (below), the
    pre-registration's amendments, the measurement script and docs, freezing
    the design before any measurement run.
  - `npm test`: 72 passed. `npm run typecheck`: clean.
- **The graph is built:** `runs/excalidraw/memory/graph`, version 6, 13 steps
  and 22 transitions, learned from the 6 seed runs for $0.53. Inspect it with
  `node src/cli.ts graph show runs/excalidraw/memory/graph`.
- **The measurement is done** (2026-10-02, 01:42–06:24 local time, 77 runs,
  $18.21). **The claim doesn't hold:** the graph won 1 of the 4 kinds of task
  (3 were needed) and used 82% more tokens than saved-scripts on the 6
  existing tasks. Full results and observations are at the end of
  `examples/excalidraw/PREREGISTRATION.md`.
  - It won only on the lesson-from-failures task (`stats-shortcut-k`, −49%
    against saved-scripts, within run-to-run noise by the rules, but all 5
    runs stayed at 234k–289k tokens against saved-scripts' 218k–833k).
  - Why it lost: a checklist leaves the edits to the agent, while a saved
    diff can be copied. And the selector handed over the "add a keyboard
    test" step to every shortcut task, so the agent wrote tests no prompt
    asked for (this made it worse than no memory twice).
  - Ran in two lanes (two clones at once: `LANE=2` in the script, outputs
    suffixed `-lane2`), about 4h40m instead of about 6–7 hours. No agent
    command reached its time limit (longest 441 s of 600 s), so no run was
    rerun. Reports take both lanes' dirs, e.g. `runs/excalidraw/graph-1-new*`.
- **What the warnings could add to saved-scripts** (from existing logs, no
  new runs; 2026-10-02; counts from `examples/excalidraw/check-warnings.ts`):
  - `yarn test:update --watch=false` fails (the script already passes the
    flag). Of the runs that ran `test:update`, saved-scripts runs made this
    mistake in 20 of 21, no-memory runs in 31 of 44, and graph runs, whose
    steps carried the pitfall, in 0 of 34. Each costs a turn and a full suite
    run (about 40k tokens, 13–20% of a toggle or page-breaks run).
  - The `handleKeyboardGlobally` trap on `stats-shortcut-k`: all 5
    saved-scripts runs wrote their first test without it, and 4 of them lost
    126k–615k tokens finding out why. All 5 graph runs used it from the start.
  - **Saved-scripts bug (fixed):** the minimap entry listed
    `yarn test:typecheck ... && yarn test:update --watch=false 2>&1 | tail -40`
    as a command that worked, because the pipe into `tail` hid the failure.
    So the memory taught the mistake.
  - Other covered detours were small (a duplicate-match Edit retry, a
    prettier check). `midpoint-snap-n` runs lost up to ~250k tokens on
    contextmenu snapshot failures, which the warnings cover only loosely.
- **The follow-up check passed** (2026-10-02, 20:36–21:13 local time, 13
  runs, $1.27): `saved-scripts-warnings`, the closest saved solution plus the
  graph's warnings, with no checklist. Pre-registered at the end of
  `examples/excalidraw/PREREGISTRATION.md`, with its rules and results.
  - All four rules held, and all 13 runs passed. Against saved-scripts:
    `stats-shortcut-k` −62% (187k), `page-breaks` −41% (180k),
    `altkey-zen-m` −2% (118k). Every run followed both warnings it needed,
    and it beat the graph too.
  - **The user's call (2026-10-02):** copying a past run's finished code is
    an anti-pattern for them. Saved solutions, with or without warnings, are
    the baseline; the product is the step graph, to be improved until it
    gets close to them.
  - **Where the graph's gap comes from** (existing logs, the 6 old tasks):
    graph runs take 1–4 more turns (usually 3) than saved-scripts runs, and
    each turn rereads 30–55k tokens. On `toggle-rulers` the saved run made
    all 19 edits in its second turn, since the diff showed the exact text to
    change. The graph run spent three turns reading files to find where each
    edit goes (`App.tsx` among them, which made every later turn bigger),
    then lost two more to an edit whose text matched three places. On the
    shortcut tasks it also wrote a test nobody asked for, two more turns.
  - Lanes: `warnings 0 1` and `LANE=2 warnings 2 4` in
    `run-graph-measurement.sh`. Logs: `runs/excalidraw/warnings-lane*.log`.
  - Not committed yet: the fix, the new setup, the check script, the
    pre-registration's follow-up section and these notes.
  - `npm test`: 75 passed. `npm run typecheck`: clean.
- **Where the time goes** (measured on earlier runs): each run is about 5
  minutes, about 3½ of which is the agent's own full test suite (excalidraw's
  `CLAUDE.md` says to always run `yarn test:update`; 4 workers make it ~185 s
  instead of ~100 s). Our scoped checks take ~½ minute and the model ~½–1.
  Telling the agent to run targeted tests was rejected: it would break
  comparability with earlier runs and cause snapshot failures unrelated to
  memory, and the full run costs time, not tokens.
- **The user asked for shorter replies** (2026-10-02): one thread, plain
  words, one example, then the next step.

## Status (end of the third session)

- PR #1 (`procedural-memory`, the Python version up to `53dacd2`) was merged
  into `main` on 2026-10-01 (merge commit `7244ca8`). The TypeScript port is
  on branch `ts-effect-port`, with a PR against `main`.
  - `017370d`, `d95d508`: graph storage, session-log parser, eval harness,
    toy suite (all in Python then).
  - `a5fdd53`: excalidraw suite v1, workspaces outside the home folder,
    workspaces hide later commits.
  - `ede0ae0`: suite v2 (scoped checks, toggle-action family), the
    `files_changed` and `shell_writes` metrics.
  - `cff66e7`: saved-scripts setup, `learn`, `report --compare`.
  - `53dacd2`: vitest worker cap and below-normal priority for eval runs.
  - Branch `ts-effect-port` (from `53dacd2`): the port to TypeScript +
    Effect 4 (below), which removes the Python code. Merged into `main` as
    PR #2 (merge commit `4954db1`).
- **The codebase is now TypeScript 7 + Effect 4.0**, run directly by Node 24.
  `npm test`: 59 passed. `npm run typecheck`: clean.
  - The port was checked against the Python version before Python was
    deleted:
    - identical metrics on 120 real transcripts (2,880 tool calls, 169M
      tokens);
    - byte-identical `report` and `report --compare` output;
    - identical CLI output (dry run, trace summary and JSON);
    - a graph store that reads the Python-written store identically and
      writes byte-identical files;
    - a saved-scripts memory rebuilt identically from the baselines,
      injected notes included.
  - Two real smoke runs through the new harness passed, in
    `runs/*/ts-smoke-1/`. Their records have the same keys as the Python
    ones.
    - toy `delete-graph`: Haiku, $0.10.
    - excalidraw `altkey-viewmode-j`: Sonnet, $0.17, 17 tool calls.
- **Results so far:** saved-scripts clearly beats no memory; see "Results so
  far" below. That's the bar the graph has to clear.
- **Next:** the graph setup. The user is rereading the proposed claim (see
  "Next steps"); the rest of the plan is agreed.

## Goal

Build a procedural memory graph from coding agent session traces, so repeated or similar tasks take less time and fewer tokens. Today the agent spends about the same effort on a repeated task as it did the first time.

## Reference paper

"Procedural Graphs: Self-Evolving Execution Structures for LLM Agents" (arXiv 2609.09153). Read it before starting: https://arxiv.org/pdf/2609.09153

Summary of the paper's design:

- The graph stores (procedure, relation, procedure) triplets. Nodes are tool calls, reasoning steps, or states. Edges carry three text fields: condition (when to take it), guidance (how), and pitfalls (what to avoid).
- Online: the agent's last action is matched to a node, the 2-hop neighborhood is pulled, and a separate guidance LLM call turns it into advice for the next step.
- Offline: after a batch of tasks, a refiner LLM compares failed and successful traces and proposes edits (add/delete nodes and edges). An edit is kept only if score on a held-out validation set stays the same or improves. Rejected edits are logged so the refiner avoids repeating them.
- Graphs stay small (mostly 7 to 17 nodes in their experiments).

### Checked against the paper's text

WebFetch can't read the PDF. To read it, download it and run `pdftotext` (available in Git Bash).

- The token figures below are on GDPval and ALFWorld. Solver steps fell from 28.20 to 18.57 and from 21.84 to 18.80, but total tokens were still 33.4% and 55.4% higher.
- The 17.23 to 3.08 tool-call drop is per simulated month, in their finance simulation.
- If no node matches, retrieval falls back to the full graph. Sending only the 2-hop neighborhood instead of the full graph cut tokens by 70.9% (ALFWorld), 18.1% (GDPval) and 14.8% (MultiChallenge). So even when we retrieve only once at task start, send a subgraph, not the whole graph.
- Graphs have 7–17 nodes and 7–27 triplets. The exception is BFCL v3, with 131 nodes, one per function.
- Relation types: LEADS_TO, TRIGGERS, PROVIDES_INPUT_FOR, CONVERGES_TO. The refiner outputs `add_nodes`, `delete_nodes`, `add_edges` and `delete_edges`, and deletes are applied first.
- **The paper's refiner prompt conflicts with our design, so it has to be rewritten, not reused.**
  - Rule 1 requires ACTION nodes to be tool names, but we want semantic nodes.
  - Rule 5 demands "high-level conceptual descriptions" with no details from individual traces, but we want concrete paths and commands.
  - Our resolution: general advice goes in condition/guidance/pitfalls, and concrete details go in per-repo `facts` on edges.

## Important caveat from the paper

The paper optimizes for accuracy, and its approach uses MORE tokens. The authors state that guidance increases token use even when it reduces solver steps (33.4% and 55.4% more tokens on two benchmarks). The cost comes from the per-step guidance LLM call.

It did reduce wasted actions: in one experiment, tool calls per cycle dropped from 17.23 to 3.08. So the structure helps, but the delivery must be cheaper for our goal.

## Design direction (adapted for our goal)

1. **No per-step guidance call.** Retrieve the relevant subgraph once at task start, or only when the agent seems stuck, and inject it as plain text.
2. **Semantic nodes.** Coding agent tools are generic (read, edit, bash), so matching on the raw tool name gives little signal. Use nodes like "run tests" or "find config file", possibly keyed by command pattern.
3. **Store concrete details on edges.** Besides condition/guidance/pitfalls, add fields for exact file paths, commands that worked, and dead ends to skip. This is where most repeat-task savings should come from.
4. **Link nodes to saved scripts or skills.** For fully repeated sub-steps (e.g. environment setup), a node can point to a script instead of describing the steps. The graph handles order and decisions; scripts handle exact repeats.
5. **Success signal.** The evolution loop needs a score per run. Candidates: tests passing, user accepting the change, no rework needed. Keep a held-out set of tasks for validation gating.
6. **Task matching.** Need a way to pick which graph or subgraph fits a new task (e.g. embeddings on the task description).

## Evaluation plan

Measure tokens, wall time, and success rate from day one, across three setups:

- No memory (current agent)
- Simple baseline: successful traces saved as scripts or skills
- Procedural graph

Test on both exact repeats and similar-but-different tasks. The graph should be clearly better than the simple baseline on similar tasks, and not much worse on exact repeats. If not, its overhead is too high.

## Decisions so far

- **Agent and traces:** Claude Code and its JSONL session logs. (Proposed; the
  user didn't object.)
- **Storage (decided by the user):**
  - The graph sits behind the `GraphStore` interface, with a JSON-file backend
    for now.
  - The user expects a graph database later: easier to maintain, shareable
    across machines through the cloud, and no need to load the whole graph into
    memory.
  - So keep every storage API query-shaped, and keep versioning (candidates,
    commit, reject) in the interface rather than relying on git.
  - Don't re-argue JSON versus graph database.
  - A natural way to version in a graph database: stamp each node and edge with
    the versions it is valid for. A commit ends replaced items and adds new ones
    in one transaction, and a candidate is a stored edit set applied at read
    time.
- **Evaluation repo (decided by the user):** their local excalidraw clone at
  `C:\Users\luvma\OneDrive\Desktop\singularity\experiment\excalidraw`. They
  left the choice of task areas, the model and the workspace location to us.
- **Workspaces** live at `C:\singularity-workspaces` (outside the home folder,
  so the One CLI `CLAUDE.md` isn't loaded into runs). Override with
  `SINGULARITY_WORKSPACES` or `--workspaces`.
- **Model (recommended, the user asked for a recommendation):** Sonnet 5.5 at
  `medium` effort. Haiku would likely fail often on excalidraw, which makes
  success rates noisy. Opus costs twice as much ($4/$20 per million tokens,
  versus $2/$10) and leaves less headroom for memory to show savings.
- **Success:** a task succeeds when its check commands (tests) pass. Hidden tests
  are copied in after the agent finishes (`check_files`). (Proposed and built;
  the user didn't object.)
  - Outside evals (decided by the user, 2026-10-02): a session counts as
    successful once its change is committed and its tests pass.
- **Stack (decided by the user):** TypeScript + Effect 4, replacing Python.
  - The user doesn't write the code and only wants to follow the concepts,
    so the choice weighs agent experience over their own familiarity with
    Effect.
  - Effect 4.0.0 was released on the day of the port. Its package ships agent
    docs (`node_modules/effect/AGENTS.md`, `ai-docs/`), and CLAUDE.md tells
    agents to use them rather than remembered Effect 3 APIs.
- **Eval checks must be controlled (from the user):** scoped test files and a
  capped number of workers, never a repo's full suite on every core. The user
  needs their machine during runs.
- **Graph setup, agreed so far:**
  - An LLM builds the graph from recorded runs ("the accuracy is worth some
    pennies").
  - One graph per repo for now. (Replaced by redesign step 6: one graph per
    tenant, shared between its subjects.)
  - The refiner loop comes after the first static-graph measurement.
  - 5 runs per new task is fine (about $15–20 for the measurement).
  - The claim and thresholds: the user reread them and moved on (2026-10-02);
    they're fixed in `examples/excalidraw/PREREGISTRATION.md`.
- **Graph setup, decided in the fourth session (by Claude, from the existing
  tasks only, before any measurement):**
  - Learner: Sonnet at high effort, one recorded run per call, through
    `claude -p --json-schema` with no tools and our own system prompt. About
    $0.05–0.12 per run.
  - Retrieval: word overlap finds entry steps; Sonnet with thinking off
    decides which nearby steps apply, reading their conditions (about $0.01
    per run, added to the run's cost and tokens). Word overlap alone gave the
    alt-shortcut tasks the toggle-setting steps too. Haiku was cheaper but
    dropped needed steps, or thought for 8k tokens with thinking on.
  - The zen-only graph for the partial-overlap test is version 3 of the same
    store (after the zen runs, before minimap), not a separate build.
- **Local memory, decided in the fifth session (by Claude, within the
  agreed design):**
  - One record per session, id `<subject>-<first 8 of the session id>`;
    records change only to get the model's reading (once) and feedback.
  - Triggers are plain substrings in three forms (command, edit, error),
    never regular expressions, so whoever reads one knows what it matches.
  - The task-start hook acts at a session's first prompt only; later
    prompts are follow-ups. There is no `PreToolUse` hook: its
    `additionalContext` arrives with the tool's result, like `PostToolUse`'s,
    and denying or rewriting is still the user's open question.
  - A session counts as successful if its HEAD moved since the task started
    (or it committed while running) and its last test command passed.
  - The hook entry point is a separate script that loads only what each
    event needs: the tool-call hook takes about 0.1 s without memory for the
    session and 0.4 s with it, against 1.3 s for the full CLI.
- **The code at the route's places, sixth session:**
  - Decided by the user (2026-10-03): the hook reads the lines at a route's
    places from the working tree at task start, and memory keeps only where
    to look. They were told it is close to the exact locations they had
    ruled out. After its test they doubted it as too targeted, and the logs
    agreed; whether to rework it is theirs to decide (status at the top).
  - Decided by Claude within it: a spot is the pair of existing lines above
    and below an added block, since one line can stand in several places;
    only pure additions count; a place needs two runs of the task's own kind
    and 60% of those that took the step, counted over that kind's records
    only; one line of context, small lists and blocks whole; the hand-over
    stays under 9,800 characters and gives room first to places, then to
    the file to read first, then to whole blocks; a file whose lines are
    shown isn't listed with its step.
  - Records keep spots from now on; older records get them from their run's
    diff when a graph is built, and are not rewritten.

## What's built

All code is TypeScript + Effect 4 under `src/`, with tests under `test/`.
Run things with `node src/cli.ts ...` (see README.md).

### Local memory (the redesign, fifth session; places added in the sixth)

- **`src/local/`**: `Home.ts` (`~/.singularity` or `$SINGULARITY_HOME`, the
  tenant in `config.json`, created with tenant `local`), `Git.ts` (a repo's
  identity: root commits, normalized remotes, HEAD; a file at a commit).
- **`src/records/`**, the workflow record (step 3):
  - `Models.ts`: the record (run, task, files, files read, commands,
    detours, checks, memory use, the model's reading), snake_case on disk.
  - `Shell.ts`: command lines split into segments (quotes, heredocs and
    PowerShell here-strings respected), each with a key (`yarn test:update`,
    `git diff`); filters after a pipe don't count; checks classified (test,
    typecheck, lint, build).
  - `Extract.ts`: the mechanical part. A detour is a failing call (not a
    read, search or read-only command) and the later call that shows it
    fixed: the same command running without its old error (even if
    something else then fails), a passing test run that covers the failing
    tests (not one filtered by test name), a passing typecheck, the next
    edit of the same file. Failures on the way join the detour. In a run
    that succeeded, an open test failure closes at the last passing check of
    its kind. Cost: the tokens of the turns after the failure, up to the fix.
  - `Triggers.ts`: exact triggers (`command`, `edit`, `error`), plain
    substrings; edit triggers also match shell commands that write files.
  - `Annotate.ts`: the model's reading (Sonnet, medium effort) with the
    tenant's kind and step names as vocabulary, then the checks: step files
    must be changed files, checks commands that worked, landmark and
    false-lead anchors present at the base commit (only a file the run
    created can be proven by its added lines), triggers specific and
    matching the failure (an edit trigger: an edit before it) but not the
    fix, and free of the task's own values (`triggerValue`). Dropped claims
    are listed in the record.
  - `Spots.ts` (sixth session): where a run's edits went, from its diff: for
    each block added to a file that was there, the nearest existing lines
    above and below that say something (not `});`), within three lines.
    Blocks next to changed or removed lines don't count, nor new files or
    snapshots. Kept in the record as `spots` (absent in older records).
  - `RecordStore.ts` (interface), `JsonRecordStore.ts`, `Subjects.ts`
    (subjects matched by root commit, remote, then path), `Build.ts`,
    `FromRuns.ts` (eval run dirs), `Keys.ts` (exact keys and text for search).
- **`src/memory/`**, the graph (step 4):
  - `Build.ts` (pure): kinds from the readings, every run of one task in the
    kind most of them were given; steps by name across kinds; a route step is
    required if every run of the kind took it and none as its own choice;
    files and landmarks counted per subject; warnings merged from lessons and
    from log-only triggers (a command that worked once flags were dropped, an
    edit whose text matched twice) by the same trigger, a trigger that fits
    the other's detour (a command trigger only claims command errors, an
    edit trigger only failing tests and type errors) or similar words in the
    same step; of a warning's triggers the one that fits the most of its
    detours wins; false leads need two runs; text that names one task's
    values (from the reading) is rewritten with the values' names, and a
    file named after them (`actionToggleZenMode.tsx`) doesn't count as where
    a step happens.
  - `Aliases.ts`: close calls between step names (no run took both, same
    files, similar names), decided once by a model and kept in
    `aliases.json`.
  - `Conditions.ts`: a model writes conditions for optional steps, from the
    tasks that took them against those that didn't.
  - `Replay.ts`: the replay check and the commit rule (no unasked step, not
    more extra or missing steps, not more false alarms, not fewer warned
    detours unless false alarms fell). `TriggerReplay.ts`: the free trigger
    check, leaving each warning's own runs out.
  - `MemoryStore.ts`, `JsonMemoryStore.ts`: versions and candidates, like
    `GraphStore`, with reads by subject and reach. `Merge.ts`: build,
    replay, propose, commit or reject.
  - Places (sixth session): `Build.ts` gives a step, per subject, its `spots`
    (each with the records behind it; none in a task's own files, none whose
    lines name its values) and its `examples` (for a step whose runs created
    a file: files in the same directory that they read and didn't change).
    Both keys are left out when empty, so other steps read as before.
    `Merge.ts` (`withSpots`) reads the spots of older records from their
    run's `diff.patch`, or from the session's two commits.
- **`src/search/`**: BM25 over words (identifiers split, plural `s`
  dropped), exact substring search, over records and graph items.
- **`src/handover/`** (step 5, local part):
  - `TaskStart.ts`: word search proposes up to three kinds (each sharing two
    words, or 10% of the weighted wording, with the task); a model (Sonnet,
    thinking off) picks the kind and decides step by step; without a model,
    the best kind's required steps and those most runs needed. Landmarks are
    re-checked against the working tree; files are listed only if at least
    60% of the step's runs (and two) edited them; checks only if two runs
    used them; warnings of the chosen steps and kind come along. The
    warnings with triggers that reach the subject are kept in the session's
    state, and every hand-over is logged in `handovers.jsonl`.
  - `Excerpts.ts` (sixth session): the code at the route's places, looked up
    in the working tree at task start and appended to the route. A spot is
    found where its two lines stand (the lower within four lines of the
    upper; found in more than three places, it marks none); a spot with one
    line only where that line is the single one of its kind in the file.
    Spots within a few lines are one place, kept with two runs of the task's
    kind and 60% of those that took the step. A place shows a line on each
    side of the spots enough runs agree on; then, as room allows, the file
    most runs read before writing a new one (whole up to 1,600 characters,
    else by name), a small block a spot's line opens, and the small list
    around a place (each up to 700 characters). `TaskStart.ts` keeps the
    whole hand-over under `MAX_HANDOVER_CHARS` (9,800), drops a file from
    its step's "Usually edits" when its lines are shown, and logs what was
    shown (`excerpts`, `examples`, `left_out`). A memory without spots gives
    the same hand-over as before, byte for byte.
  - `OnTool.ts`: a warning per trigger, once a session. `SessionEnd.ts`:
    the record of a session whose HEAD moved and whose last test run passed,
    with what became of its memory (a step whose usual files changed was
    followed; a warning whose trigger matched again was ignored).
  - `Install.ts` and `src/hook.ts`: the hooks (`UserPromptSubmit`,
    `PostToolUse` and `PostToolUseFailure` for shell commands and edits,
    `SessionEnd`), merged into a settings file without touching anything
    else (a backup is kept as `settings.json.before-singularity`).
- **`src/commands/`**: `record`, `search`, `memory`, `handover`, `hooks`.
- The eval harness sets `SINGULARITY_HOOKS=off` for the agent and for
  memory's own model calls (a task-start hook inside the task-start model
  call would call itself), except in its `hooks` setup
  (`src/eval/HooksMemory.ts`), which turns them on for the agent with
  `--settings`, against a copy of a memory home in the run's directory, and
  records what they handed over and what the route selection cost.

### Graph storage: `src/graph/`

- **`Models.ts`:**
  - `Node` has a type, a description, optional `command_patterns`
    (JavaScript regexes used to tell which node the agent is at), and an
    optional `script`.
  - `Edge` has a relation, condition/guidance/pitfalls, and `facts` keyed by
    repo (paths, commands, dead ends).
  - `EditSet` is the paper's four arrays. Adding an item that already exists
    replaces it.
  - Also `Candidate`, `GraphInfo` and `Graph`.
- **`GraphStore.ts`** is the interface, a `Context.Service`.
  - Reads: `getNodes`, `matchNodes(command)`, `neighborhood(nodes, {hops,
    direction})` and `snapshot`.
  - Every read takes `{at}`: undefined for the current version, a number for
    a past version, or a candidate id. Validation runs can therefore use a
    candidate before it is committed.
  - Evolution: `propose` (validates the edits), `commit` (fails with
    `Conflict` if someone else committed first), `reject(reason)` (kept as
    rejection memory), `candidates(status)` and `diff`.
- **`JsonGraphStore.ts`:** `JsonGraphStore.layer(root)`.
  - One directory per graph, a snapshot file per version, one file per
    candidate.
  - Writes within one store run one at a time (a semaphore). There's no
    locking across processes.
- **`Ops.ts`:** apply, diff, neighborhood and matching for graphs in memory.
- **Tests:** `test/graph/store.test.ts` is a contract suite run once per
  backend in its `backends` list. A graph database backend gets added there.
  The suite also reads a store written by the old Python version
  (`test/graph/fixtures/`) and checks the results match.
- **Not done:**
  - The paper's check that every node can reach an END node.
  - Edges are keyed by (source, target), so a pair of nodes can have only one
    edge.

### Graph setup: `src/eval/Graph*.ts`, `src/eval/StepSelector.ts`

- **`GraphLearner.ts`:** turns one recorded run into graph edits. Claude sees
  the current graph (this repo's facts only), the task, the outcome, the
  source diff and a condensed transcript (`src/traces/Condense.ts`), and
  answers in the paper's edit format plus a rationale. Edits go through
  `propose` and `commit`; if the store refuses them, Claude gets the errors and
  one retry. General advice goes in condition/guidance/pitfalls, file paths
  and commands in per-repo `facts`.
- **`GraphMemory.ts`:** the `graph` setup.
  - `beforeRun`: `searchNodes` (word overlap; start and end don't count) finds
    up to 6 entry steps; the candidates are everything within 2 steps of them
    and of the start, in either direction; `StepSelector` picks the steps that
    apply; the agent gets them as a numbered checklist in graph order.
  - A step shows the advice on edges from chosen steps into it, and its
    conditions only if every such edge has one.
  - If the selector call fails, every candidate is handed over and the error
    is recorded.
  - `afterRun` learns unless frozen. It logs each call to `learn-log.jsonl`
    and saves each prompt in `learn-prompts/`.
  - Records carry `injection.sources` (tasks learned from) and
    `injection.nodes` (steps handed over), which `report --compare` uses to
    tell exact repeats from similar tasks.
- **`Llm.ts`:** one-shot structured calls through `claude -p --json-schema`.
  The JSON Schema comes from the Effect schema that decodes the answer.
  Thinking can be turned off with
  `--settings '{"alwaysThinkingEnabled":false}'`.
- **`Injection.spent`:** what preparing memory cost. The runner adds it to
  the run's `cost_usd` and `tokens` and records it as `memory_spent`.
- **Store:** `GraphStore.searchNodes(text)` ranks nodes by description (a
  database would use a full-text index). Word similarity moved to
  `src/graph/Similarity.ts`.
- **CLI:** `eval inject` shows what a setup hands over for each task without
  running it; `graph show` prints a graph; `report --compare --baseline X`;
  `eval run --first-rep N` adds passes to an existing output dir;
  `--graph-version N` reads an earlier graph version.
- **`saved-scripts-top2`:** up to the two best saved runs, each above 0.35.
  Its notes differ from top-1's only for `midpoint-snap-n`.
- **`saved-scripts-warnings`:** the saved-scripts notes, then the graph's
  warnings (`renderWarnings`): every pitfall and dead end on the edges into
  the candidate steps, under each step, with the edge's condition when it has
  one. No checklist and no selector call; on this graph every task gets all 13
  steps' warnings, about 1,400 tokens.
  - Built with `combine` (`Setups.ts`) from saved-scripts and the graph setup
    with `handOver: "warnings"`. Its info nests the graph's under `warnings`,
    so `report --compare` classifies its runs by the saved solution.
  - CLI: `--memory` is the saved-scripts store, `--warnings` the graph store.
    It learns into both unless frozen.
- **Saved-scripts keeps only commands that worked:** no error, and no
  failure in their output (`reportsFailure`: a nonzero exit code, `npm ERR!`,
  a TypeScript error, failed tests). The memory rebuilt with the fix is
  `runs/excalidraw/memory/saved-scripts-2`; the old one stays for the old runs.

### Session-log parser: `src/traces/`

- `parseSession(path)` returns a `Trace`: prompts, model responses with token
  usage, tool calls with results and errors, subagents, and Claude Code's
  `cost-state` totals.
  - Parsing is lenient: a field of an unexpected shape counts as missing, and
    only non-JSON lines are skipped.
- `traceMetrics` counts tool calls, failed calls, shell commands, searches,
  files edited, and reads versus distinct files read. Repeat reads are a rough
  measure of wasted effort.
  - `files_edited` covers only the edit tools. Agents often edit through Bash
    (`sed -i`, heredocs), which `shell_writes` counts with a regex heuristic.
  - The run record's `files_changed`, taken from the diff, is the ground truth
    for which files changed.
- CLI: `node src/cli.ts traces <session id or path> [--json]`.

### Eval harness: `src/eval/`

- **`Suite.ts`:** the TOML suite format, documented in the module comment.
  Unknown keys are errors (Schema with `onExcessProperty: "error"`).
- **`Workspace.ts`:**
  - A clone of the source repo at `<workspaces>/<suite>`, with no remote.
  - Before each run it is reset to the task's base commit, and `git clean`
    deletes everything except the `keep` paths. `keep` paths must be
    gitignored, or the diff capture will stage them.
  - After each reset it deletes every ref and reflog entry, leaving only the
    detached base commit. Without that, an agent could run `git log --all`
    and see later commits, including the toy suite's hidden tests and the
    user's hand-written excalidraw maps.
- **`Agent.ts`:** builds the `claude -p` command. It removes the parent
  session's environment variables, turns auto-memory off, and passes the prompt
  on stdin.
- **`Proc.ts`:** runs a process with a timeout via `effect/process`.
  - On timeout or interruption, Effect's Node spawner kills the whole process
    tree (`taskkill /T` on Windows). Checked: no leftover processes.
  - The CLI lowers its own priority at startup, and Windows passes that down
    to everything it starts.
- **`Setups.ts`, `Memory.ts`:** the `MemorySetup` interface, `NoMemory`, and
  `makeSetup(name, memoryDir, frozen)`.
  - `beforeRun(task, workspace)` returns an `Injection`, which is passed to
    Claude with `--append-system-prompt-file`.
  - `afterRun(outcome)` is where a setup learns.
- **`SavedScripts.ts`:** the simple baseline (see "Results so far").
- **`Learn.ts`:** feeds recorded runs into a setup (`eval learn`), so memory
  can be built from baselines without new agent runs.
- **`Runner.ts`:**
  - Each run: reset the workspace, run setup commands (not timed),
    `beforeRun`, the agent, copy the session log, save the diff, copy in
    `check_files`, run the checks, then `afterRun`.
  - Output: `results.jsonl` plus a `runs/<id>/` directory per run with the
    session log, diff, agent output and command logs.
  - Order: each pass runs every task once before the next pass starts.
  - Token and cost figures come from the CLI's result JSON, which includes side
    calls. If that's missing, they fall back to `cost-state`, then to the
    session log.
- **`Report.ts`:**
  - `report` gives median (min–max) per setup and task.
  - `report --compare` sets each memory setup against no-memory, split into
    exact repeats and similar tasks.
  - `PyFormat.ts` keeps the number formatting identical to the Python
    version's.
- **`examples/toy/`:** two similar tasks, `delete-graph` and `rename-graph`,
  against this repo at `017370d` (when it was Python), with hidden pytest
  tests. They still work, because each run checks out that old commit.
- **`test/eval/fixtures/fake-claude.ts`:** stands in for `claude`, so the tests
  cover the whole pipeline at no cost.

### Excalidraw suite: `examples/excalidraw/`

- **Base commit:** `84e3f5a4`, the last upstream commit before the user's own
  `procedural` commits (`f1ab362c`, `d813fc7a`, `b1dff4fe`). Those commits hold
  the user's manual experiment with this same idea: a v1 Markdown map, v2/v3
  JSON "procedure records" and a replay script for rectangle r→m. They're
  useful prior art for the graph setup.
  - One fact in their v1 map is wrong: it lists `actionProperties.tsx` as a
    hidden coupling for the rectangle key, but the `keyBinding: "r"` there is
    the arrowhead picker's hotkey. Memory can record false facts, so the
    refiner needs a way to drop them.
- **Suite v2: two families, three tasks each.** The first task in each family
  is the seed (memory is built from it, then it's repeated exactly), and the
  other two are variants.
  - `alt-shortcut`: zen mode Alt+Z→Alt+M, view mode Alt+R→Alt+J, snap to
    objects Alt+S→Alt+U. Touches `CODES` in keys.ts, the action's `keyTest`,
    `actions/shortcuts.ts` and `HelpDialog.tsx`, which spells the shortcut out
    separately.
  - `toggle-action`: a "Minimap" toggle (`minimapEnabled`, Alt+M, local storage
    only), "Rulers" (`rulersEnabled`, Alt+U, local storage and exports) and
    "Presenter mode" (`presenterModeEnabled`, Alt+J, never stored, not offered
    in view mode). Each touches about 11 files:
    - the appState type, its default and `APP_STATE_STORAGE_CONF`;
    - a new action file, which is only registered if `actions/index.ts`
      exports it (`register()` runs as an import side effect, and an action
      nobody imports silently never registers);
    - the `ActionName` and `ShortcutName` unions, a `CODES` key, the shortcut
      map and an `en.json` label;
    - two context-menu lists in `App.tsx` (view mode has its own list);
    - `HelpDialog.tsx`;
    - three places in `main-menu/DefaultItems.tsx`.
    It also changes snapshots in `contextmenu`, `history`, `regressionTests`
    and `packages/utils`' `export` test. This mirrors upstream commit
    `437595fa` (the arrow binding and midpoint snapping toggles).
  - Dropped after baseline-1: `tool-shortcut` (R→M, D→J, O→U) and
    `appstate-field`. Both were solved in 6–24 calls, so memory had little to
    save. They remain at `a5fdd53`.
- **Checks (scoped):** the hidden test (copied in as
  `packages/excalidraw/tests/hidden-check.test.tsx`), plus the test files the
  change can break, plus files agents tend to add tests to. vitest runs with
  `--minWorkers=1 --maxWorkers=4`, followed by `yarn tsc` (about 15 s).
  - The affected files were found by applying the reference fix without
    updating any tests, running the full suite once and keeping the files that
    failed.
  - The scoped vitest run takes about 14 s for the alt family. v1 ran the full
    suite on all 16 cores (101 s per run), which maxed out the user's CPU for
    the whole baseline and pulled in a flaky snapshot
    (`MermaidToExcalidraw.test.tsx`).
  - Checks run without `CI=true`, so a snapshot that doesn't exist yet is
    written and passes.
- **Validation (a scratch script, not kept):** the hidden test fails at
  the base commit, and the suite's own checks pass on a reference solution.
  The reference patches, including regenerated snapshots, are in
  `examples/excalidraw/reference/`.
- **Setup:** `yarn install --frozen-lockfile --prefer-offline`, keeping
  `node_modules`. The first install in a fresh workspace takes about 3
  minutes; after that it takes about a second.

### Baseline findings (baseline-1, no memory)

- **Cost:** the median run cost $0.12, made 14 tool calls, used 234k tokens
  (mostly cache reads) and took 144 s. Sonnet 5.5 at medium effort is
  efficient: it often makes every edit with one chained `sed -i` or a burst of
  Edit calls.
- **zen mode, the one task with headroom:** a median of 36 calls ($0.46),
  ranging from 13 to 39.
  - In 2 of 3 runs the agent made the fix in about 12 calls, then added its
    own Alt+M test to `excalidraw.test.tsx`. That file renders `<Excalidraw />`
    without `handleKeyboardGlobally`, so the key never fires. The agent then
    spent about 24 calls debugging, including temporary `console.log`s in the
    action and reading `App.tsx` and `actions/manager.tsx`.
  - The view-mode runs added their test to `viewMode.test.tsx`, which already
    sets `handleKeyboardGlobally`, so they never hit the trap.
  - This is the kind of pitfall an edge should carry, with a condition: "when
    adding a keyboard test in a file without `handleKeyboardGlobally`".
- **Variance:** the cost of one task can swing 4× depending on a single
  choice, such as whether the agent writes its own test. Compare medians with
  the min–max range shown, and use more than 3 runs per setup on high-variance
  tasks.
- **False leads:** agents search for `"r"` and land on the arrowhead picker's
  `keyBinding: "r"` in `actionProperties.tsx`, the same false fact the user's
  v1 map recorded.
- **Wall time** from the third pass is inflated, because the user was running
  a game at the same time and the CPU sat at 100%. Tokens, cost and tool
  calls weren't affected.


## Results so far

Run `node src/cli.ts eval report --compare runs/excalidraw/baseline-1
runs/excalidraw/baseline-2-toggle runs/excalidraw/saved-scripts-1`.
All figures are medians of 3 runs; tokens include cache reads.

| Task | Kind | Tokens | Cost | Tool calls |
|---|---|---|---|---|
| altkey-zen-m | exact repeat | 1,165k → 120k (−90%) | $0.46 → $0.07 | 36 → 8 |
| altkey-viewmode-j | similar | 315k → 140k (−56%) | $0.18 → $0.07 | 19 → 10 |
| altkey-snap-u | similar | 213k → 180k (−15%) | $0.13 → $0.10 | 15 → 10 |
| toggle-minimap | exact repeat | 787k → 312k (−60%) | $0.40 → $0.18 | 49 → 35 |
| toggle-rulers | similar | 563k → 187k (−67%) | $0.32 → $0.16 | 45 → 24 |
| toggle-presenter | similar | 673k → 221k (−67%) | $0.35 → $0.17 | 48 → 24 |

- **Per-task medians:** tokens fell 75% on exact repeats and 61% on similar
  tasks; cost fell 70% and 50%.
- **saved-scripts** (`src/eval/SavedScripts.ts`) works like this:
  - It keeps the cheapest successful run for each prompt. An entry holds the
    prompt, the files changed, the source diff (snapshot files are listed,
    not included) and the shell commands that succeeded.
  - It retrieves the best match by cosine similarity of the prompts' words,
    with a threshold of 0.35. Within a family prompts score 0.76–0.87; across
    families they score 0.12–0.24.
  - It injects about 0.7k tokens for zen mode and about 3k for minimap.
  - The memory was built for free from the baselines' successful runs with
    `learn`, and stored in `runs/excalidraw/memory/saved-scripts/`.
- **This is the bar the graph has to clear.** It didn't, in the 2026-10-02
  measurement (see Status). Findings that matter for its design:
  - **Exact repeats have a floor.** The agent replays the saved diff one Edit
    per hunk (minimap: 19 Edits plus tests, about 35 calls). Only a real
    script (apply the patch in one command) would do better, so guidance
    can't beat saved diffs on exact repeats. The graph has to win on similar
    tasks.
  - **Tool calls are a weak metric.** One saved-scripts run did presenter
    mode in 3 calls by writing a single 4,000-character Python script. Use
    tokens and cost as the headline metrics.
  - **Similar tasks gain least when they're already cheap** (snap to objects,
    −15% tokens). Showing a full diff from a different task also costs
    tokens.
  - **Wall time** barely moves, because the agent's own full-suite test runs
    dominate it. The user was also running a game during the runs.
- **CPU (done after saved-scripts-1):**
  - The suite's `env` table caps vitest at 4 workers
    (`VITEST_MIN/MAX_FORKS`, `VITEST_MIN/MAX_THREADS`) for the agent's own
    test runs as well as the checks.
  - The harness also starts the agent and all commands below normal priority.
    Windows passes the priority down to child processes; this was checked on
    real vitest workers (4 workers, all BelowNormal).
  - Wall times from runs before the cap aren't comparable with later ones.
    Tokens and cost are.

## Facts verified about Claude Code 2.1.286 on this machine

These come from inspecting real session logs and the CLI binary
(`C:\Users\luvma\.local\bin\claude.exe`).

- **Session logs** are at `~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>/<session id>.jsonl`. The harness passes `--session-id` and searches for that id, so the naming rule doesn't matter.
- **Subagent logs** are at `<session id>/subagents/**/agent-<id>.jsonl`. This comes from the CLI's code. No run has used a subagent yet, so the parser's handling is only unit-tested.
- **Token counting:** each model response is logged as one line per content block, and every line repeats the same `usage`. Count it once per `message.id`. On the test run, the parser's total matched the CLI's own `modelUsage` exactly.
- **`cost-state` lines** are running totals. They include side calls that never appear as responses, e.g. WebFetch summaries on Haiku. They are written only occasionally, so they lag behind.
- **Failed API calls** are logged as assistant lines with `isApiErrorMessage: true` and model `<synthetic>`.
- **Auto-memory** is turned off by the environment variable `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (the harness uses this) or the setting `autoMemoryEnabled: false`.
- **Flags:**
  - Two flags that work but aren't in `--help`: `--append-system-prompt-file <file>` and `--max-turns <n>`.
  - Useful listed flags: `--session-id`, `--max-budget-usd`, `--effort`, `--permission-prompts none` and `--strict-mcp-config`.
  - `--bare` would give the cleanest runs (no CLAUDE.md, hooks, plugins or auto-memory). But it only accepts `ANTHROPIC_API_KEY`, not the user's subscription login.
- **Parent-session variables:** a parent Claude Code session sets `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, a messaging socket and token, `CLAUDE_EFFORT=max`, and more. The harness removes them (the list is in `src/eval/Agent.ts`). Otherwise runs started from inside a session would inherit max effort.
- **Home-folder CLAUDE.md:** runs in workspaces under the home folder load `C:\Users\luvma\CLAUDE.md` (the One CLI instructions) as project instructions. This is confirmed in the toy run's log, and it's why workspaces now default to `C:\singularity-workspaces`. Excalidraw's own `CLAUDE.md`/`AGENTS.md` are part of the repo and are still loaded, which is realistic.
- **Result JSON:** the harness reads these fields from `--output-format json`: `subtype`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `modelUsage` and `permission_denials`.
- **Log cleanup:** Claude Code deletes old session logs after a while, so the harness keeps a copy of each run's log.
- **Hook text** (sixth session; from Claude Code's hooks documentation, read 2026-10-03, and the three `hooks-spots-1` runs):
  - A hook's `additionalContext` (and its plain stdout) is cut at 10,000 characters. Over that, Claude Code saves it to a file and hands the model the path and the first 2,000 characters; it doesn't ask the model to read the file. No setting raises the limit.
  - Each hook's text is measured on its own, even when several hooks run for one event. They run in parallel, and the model receives all of their texts; the order isn't documented.
  - A `UserPromptSubmit` hook can add context or block the prompt. It can't rewrite it.
  - In 2.1.286 a hand-over of 9,376 characters arrived whole in all three runs; the transcript keeps it as an attachment of type `hook_additional_context` (`check-turns.ts` compares it with what was handed).
- **Edit without Read** (sixth session): the Edit tool's description says a file must be read first, but 2.1.286 doesn't enforce it. One run made 20 edits in one turn, 16 of them in 11 files it had never read, none failing, as the saved-scripts runs did. The model still reads first in most runs.

## Next steps

**From the sixth session on:**

1. **Wait for the user's answer** on reworking what a place is (the status at
   the top): the list an edit goes into instead of the lines next to it, and
   required or conditional by comparing tasks. If they agree: build it, then
   run `check-places.ts` (free) until presenter isn't shown the view-mode
   menu, `page-breaks` isn't shown what it must leave alone, and rulers
   keeps what it needs. Only then pre-register and run presenter and
   `page-breaks` (paid, needs a go).
2. **Smaller things the test showed**, to fold into that work or decide with
   the user: say which list a place is (the line that opens it); line ranges
   instead of code, since the agent often reads again; the file handed over
   whole brings details of its own.
3. **The size limit**: spend the room by what runs show was used; a second
   hook or an overflow file only if a real task doesn't fit.

**From the fifth session** (still open):

1. **The measurement on excalidraw** (build stage 4): done; the goal (tokens
   close to saved-scripts, success no worse) isn't met. The sixth session's
   test on `toggle-rulers` came to 328k against the bar of 215k.
2. **Read more records** if the measurement needs them: 91 records have no
   model reading yet (`record annotate --all --per-task N`). Re-reading the
   55 read ones would also restore the check commands the first, too strict
   check dropped.
3. **A second subject, then hosting** (build stage 5): the cloud steps,
   deferred by the user: semantic search with embeddings, the API, the MCP
   tool, a graph database behind `MemoryStore` and `RecordStore`.

Known weak spots: detours are found by rules over command lines, which can
misattribute a failure inside a chained command; some step purposes and
landmarks still name one feature (the "update snapshots" step's purpose
speaks of a new appState field); the model's kinds sometimes split one
family in two ("add a keyboard shortcut to an existing setting toggle" next
to "change an action's keyboard shortcut"), which the model at task start
copes with, since it reads both.

**Older items:**

0. **Saved-scripts plus the graph's warnings** (the user agreed on
   2026-10-02; done, the check passed): saved-scripts for what to do, plus
   only the graph's pitfalls for what to avoid, with no checklist. That keeps
   what each did best.
1. **Next: bring the step graph close to saved solutions** (the user's
   goal), without storing the finished code. Paused for the redesign above,
   which replaces this plan. Of what was proposed here, exact-line anchors
   were rejected by the user. A read list of files worth reading up front,
   dropping the unrequested test step and keeping the warnings carry over
   into the redesign's discussion. Target as before: within about 15% of
   saved-scripts' tokens.
2. **Then the hosted version.** The user wants the memory served from their
   own cloud through an MCP server, once the memory works. Open choices for
   the user: where it runs, which graph database, and whether the agent
   pulls memory with a tool call or a hook injects it at session start.
   Pulling differs from injecting at task start, so it needs its own
   measurement.
3. **The graph setup** (the plan as of the third session; done, and
   measured: the claim doesn't hold).
   - **The claim to test (the user reread it and moved on).**
     - Saved-scripts remembers whole tasks; the graph remembers steps.
     - On exact repeats and close variants a saved diff is near optimal. So
       the graph must win where tasks reuse *parts* of past work, or where
       *mistakes* from past runs matter.
     - This revises the plan's "clearly better on similar tasks".
     - Proposed thresholds, at the same success rate:
       - within about 15% of saved-scripts' tokens on the 6 existing tasks;
       - at least about 25% fewer tokens than the better saved-scripts
         variant on most of the new kinds of task.
   - **New kinds of task**, 5 runs each. Write, validate and commit them
     *before* the graph is built, so they can't be picked to suit it.
     - Recombined: give the existing "Snap to midpoints" setting an Alt+N
       shortcut. Its prompt similarity is 0.38 to zen mode and 0.37 to
       minimap, so saved-scripts only gets an incomplete example.
     - Subset: a "Show page breaks" setting in Preferences only. Similarity to
       minimap is 0.64, and half of minimap's diff is work to skip.
     - Lesson from failures: change the stats shortcut and add a test in
       `excalidraw.test.tsx`. Similarity to zen mode is 0.42, but the saved
       zen run never hit the `handleKeyboardGlobally` trap.
     - Partial overlap, with no new tasks: memory from zen mode only, measured
       on the toggle tasks.
     - Also add a stronger saved-scripts variant that injects the top 2
       matches.
   - **Building:**
     - An LLM (Sonnet via `claude -p --json-schema`, which works with the
       user's login) reads each recorded run's diff and transcript plus the
       current graph, and proposes an `EditSet`.
     - Ask it for JavaScript regexes in `command_patterns`.
     - Build from all runs of the seed tasks, so detours become pitfalls.
   - **Retrieval and delivery:** match the prompt against node descriptions,
     take the 2-hop neighbourhood, render a short checklist (about 1k
     tokens), and inject it once at task start.
   - **Refiner loop:** later, after the static graph is measured.
4. **Optional: a stronger script baseline** for exact repeats: offer the saved
   patch as one command.
5. **Later:** a graph database backend for `GraphStore` (part of step 2).

## Open questions for the user

- **Asked in the sixth session, not yet answered:** rework what a place is
  (the list, required or conditional across tasks) and check it for free
  with `check-places.ts` before any paid run?
- Commit the sixth session's work? Nothing of it is committed (see Working
  notes). The follow-up's rule was written before its runs but, unlike the
  first pre-registration, wasn't committed before them.
- Keep handing over code, or line ranges only? And should the file handed
  over whole stay, given it brings details of its own?
- Install the hooks for daily work? `node src/cli.ts hooks install` puts
  them in `~/.claude/settings.json` (every session; a model call of about
  $0.03 at each session's first prompt in a repo memory knows); `--scope
  local --repo DIR` limits them to one repo. `hooks uninstall` takes them out.
- How memory should keep learning: sessions are recorded at their end
  automatically, but the model's reading and graph builds are manual
  (`record annotate --all`, then `memory build --conditions`, a few cents
  each). Run them on a schedule, or after each recorded session?
- The landmark rule ("a fact earns its place only if more than one kind of
  task can use it") is applied when records are read: the model is told to
  give only such facts. Keep it that way?
- `PreToolUse` could deny or rewrite a command a warning knows will fail,
  which would save the doubled flag's retry turn; still open, as before.
- For the hosted version: where it runs, which graph database, and whether
  agents pull memory through an MCP tool or a hook injects it at task start.
- Whether to add a curated mid-size repo alongside excalidraw later.

## Working notes

- Commit only when the user asks, and work on a feature branch (currently
  `local-memory`), not `main`.
  - Not committed, from the fifth session: the stage 4 results, amendment 4,
    `check-runs.ts`, `score-local-memory.ts`, and another session's page
    `why-14-turns.html` (its idea, a pointer to grid mode, rests on a
    premise the logs contradict: see the status at the top).
  - Not committed, from the sixth session: `src/records/Spots.ts`,
    `src/handover/Excerpts.ts` and the changes around them (records, graph
    build, merge, task start, the hooks setup's record of what was shown),
    their tests (`test/records/spots.test.ts`, `test/handover/excerpts.test.ts`,
    `test/memory/merge.test.ts`, and additions to the build and hand-over
    tests), `examples/excalidraw/check-turns.ts` and `check-places.ts`, the
    `spots` mode of `run-local-memory-measurement.sh`, the follow-up and its
    results in `PREREGISTRATION-local-memory.md`, and the notes in README.md,
    CLAUDE.md and here.
  - `runs/` isn't in git: `runs/excalidraw/memory/local-seed-spots`,
    `runs/excalidraw/hooks-spots-1` and the previews exist only on this
    machine.
- `check-places.ts` reads the real memory home (`~/.singularity`, 146
  records, 55 read) without changing it, and needs `--repo` pointed at the
  excalidraw clone for the code at the base commit. The eval workspace's
  tree changes during runs, so don't read code from it while one is going.
- Runs cost real money on the user's account. Use `--dry-run` first, and set
  `max_budget_usd` in suites.
- Keep heavy folders (workspaces, target repos' node_modules) out of this repo
  folder.
  - This repo's own `node_modules` is inside it.
  - OneDrive wasn't running on this machine (checked 2026-10-01). If it
    starts syncing the folder, move the repo out of OneDrive.
- The user needs their computer during runs: keep the vitest cap and the
  below-normal priority.
