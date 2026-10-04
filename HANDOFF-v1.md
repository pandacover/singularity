# Handoff: memory v1

Memory v1 for coding agents: what it is, the problem it takes on, how it
works, how it is built, and how it did on the benchmarks. Written 2026-10-04.
Code, tests and the measurement plan are in commit `ae287ee` on branch
`local-memory`; the measurement's results are written up in
`examples/excalidraw/PREREGISTRATION-v1.md`. The local-first version, which
picks without a model call at task start, is sealed as tag
`memory-local-first` (its measurement: `PREREGISTRATION-v1-cues.md`).

## In one paragraph

v1 is procedural memory for a coding agent (Claude Code) in one repository.
From the agent's past runs it learns small, reusable **workflows** written
with **blanks** ("add a field to the app state: `{field}`, with the storage
rules the task asks for"), connects them in a **graph** whose edges say when
one leads to another ("give the action a shortcut, if the task asks for
one"), and keeps the **pitfalls** past runs paid for ("`yarn test:update`
already passes `--watch=false`"). When a new task starts, its own hooks pick
the workflows the task needs, with no model call (local first: phrases memory
keeps for each workflow, matched against the task), fill in the blanks the
task states, find each step's place in the code as it is that day, and hand
them over with current line numbers; during the task, a pitfall's warning
arrives when its exact trigger appears. After runs, it revises itself from
what those runs did, and keeps a revision only if it fits the runs better.

## The problem it takes on

An agent given a task it, or another agent, has done before in a repository
spends about as much as the first time: it searches for where things go,
reads them a few files at a time, and repeats mistakes it has made before.
Every turn rereads its whole context (about 30-45k tokens here), so turns are
what cost. Memory should cut that, with these constraints:

- **The goal**: correct results for fewer tokens, tool calls and dollars, on
  tasks like ones done before, and never worse than no memory.
- **Not copies of past code.** Handing the agent a past run's finished code
  works only for near-copies of that task. Memory should carry the procedure,
  so it also helps tasks that share only some of the steps.
- **Not stale.** The repository changes after memory learns from it. Memory
  should never state facts about the code that can go out of date: whatever it
  says about the code is looked up in the code at the moment of use.
- **Learning from results**: memory improves from what its runs show, and
  checks every change before keeping it.

## The idea: two papers

The user named two papers as the memory layer's two components: "from the AWM
paper we establish atomic workflows and from Procedural Graphs we establish
graphs of those atomic workflows."

- **Agent Workflow Memory** (arXiv 2409.07429): induce small sub-routines from
  past runs, replacing each run's specific values with variables
  (`{product-name}`), and let the agent fill them from the environment it is
  in. Abstract workflows beat concrete past examples, which agents copy too
  closely.
- **Procedural Graphs** (arXiv 2609.09153): a graph of procedure steps whose
  edges carry when to take them (condition), how (guidance) and what to avoid
  (pitfalls), evolved by a refiner from successful and failed runs; a revision
  is kept only if it scores at least as well on validation runs, and rejected
  revisions are remembered so they aren't proposed again.

## How it works

### 1. Evidence from runs

Every successful run (an eval run, or a session whose change was committed
with passing tests) is a record. v1 reads from each: its diff, as edits with
the place each went (below), in the order the run made them (from its log);
the files it created, and the files of the same kind it read before writing
them; the commands that checked its work; its detours (a call that failed and
what fixed it, with the edits in between and the tokens it cost); and the
task's own values: what the prompt quotes or names (`minimapEnabled`,
`Alt+M`), and names the change brought that the repository didn't have
before (checked with `git grep`). Those values are what memory must never
carry.

### 2. Places: where an edit goes, kept as structure, not code

A place is the chain of blocks that enclose an edit, from the top of the file
inward, read from indentation. A new item in the canvas right-click menu sits
at:

    class App extends React.Component<AppProps, AppState> {
     › private getContextMenuItems = (
     › if (type === "canvas") {
     › return [

The view-mode menu, one level deeper, is another place
(`› if (this.state.viewModeEnabled) { › return [`). Every task that adds to
that list has the same place, whatever neighbour it sits next to, and the
chain outlives edits elsewhere in the file. Other rules:

- A block's opening line is lifted to the start of its statement (a tag's
  `>` to its `<ShortcutIsland`, `}) => {` to its `export const … = ({`), and
  look-alike blocks are told apart by their full opening (a tag with its
  attributes).
- A changed line among look-alike rows (one `<Shortcut … />` of many) stands
  for the list: which row is the task's own business.
- Additions at a file's top level belong to a group of statements that start
  alike (`PreferencesToggle…`, keywords aside) or to the imports.
- New files are a directory and how their siblings are named
  (`packages/excalidraw/actions/actionToggle….tsx`).

At use, a place is found in the code as it is: each block among the direct
children of the one before, by its first line (exactly, else by its first
words). If its file no longer has it, v1 searches the repository for files
containing the outermost block's first line (code moves between files) and
looks there. A place it can't find is left out quietly: memory says less, not
something wrong. Memory never stores lines of code.

### 3. Workflows, the graph and pitfalls: induction

One model call (Sonnet, high effort, $0.14 for six runs) reads the evidence
and proposes:

- **Workflows**: sub-routines finer than a task, each complete for its
  purpose, with blanks for task values; each step says what to do and at
  which place (or `null`: the spot is the task's own, such as the action's own
  file), and when it applies if not always ("only if the setting is also
  offered in view mode"). A workflow learned from what runs did unasked (a test
  nobody asked for) is marked `only_if_asked`.
- **Edges** from `start` to `end`, with conditions ("if the task asks for a
  shortcut").
- **Pitfalls** from detours, in general words, with an exact trigger where
  one exists: plain substrings matched against commands, edits or errors
  (`yarn test:update` and `--watch=false`).

Then the answer is checked mechanically: no text may name a task's own values;
a step's place must be one runs edited, by at least two runs, and not one
task's own file (one of many files named alike that only one task edited); a
trigger must match the call that failed and not the one that fixed it; every
workflow is reachable from `start` and leads to `end`. Problems go back to the
model once with its answer; what still fails is dropped and reported.

### 4. The hand-over at task start

The `UserPromptSubmit` hook, at a session's first prompt:

1. **Picks** the workflows the task needs, and the conditional steps that
   don't apply, with no model call (local first, `Cues.ts`). Each workflow
   carries cues: phrases of which a task's text says at least one when it
   needs the workflow ("right-click menu", "add a test"), phrases that rule it
   out, and the same for conditional steps ("view mode"). They are matched
   exactly, in any case, against the task with its negated clauses taken out
   ("Don't add a keyboard shortcut", "but not in view mode"). A model writes
   the cues once, when memory is built (`workflows cues`, `CueWriter.ts`),
   from the tasks memory learned from, and they are checked: no cue names a
   task's own value, and on those tasks the cues pick exactly the workflows
   the model says each needs. Memory without cues is picked by shared words.
   As first measured, a model call (Sonnet without thinking, about
   $0.005-0.02) picked instead; `SINGULARITY_SELECTOR=model` brings it back.
2. **Fills** the blanks the task states as written, from where the cues say
   they are: the name in backticks (`{field}` = `rulersEnabled`), the key
   combination (`{shortcut}` = `Alt+U`), the word after "default". A value a
   task doesn't state as written (the action's name, its label key) stays a
   blank for the agent.
3. **Finds** each chosen step's place in the working tree (above).
4. **Hands over** the workflows in graph order: each step with its place as
   `file:from-to`, the blocks around it, and a short excerpt with current line
   numbers (the block's first line, its last entries, its closing line), the
   checks, and the pitfalls once. It stays under 9,800 characters (Claude Code
   cuts a hook's text at 10,000), shortening excerpts to fit.

### 5. During and after the task

- **During**: after each shell command or edit, a pitfall whose trigger
  appears is handed over, once per session.
- **After**: when a session ends with a committed change and passing tests,
  it becomes a record, with what each piece of memory did: places shown and
  edited, shown and left alone, edited but not shown; workflows used; pitfalls
  followed or not.

### 6. Learning from results

`workflows evolve` takes new runs (records memory hasn't learned from):

1. **Results**: for each, what memory showed it (or, for a run that had no
   memory, would have shown it), against where its edits went.
2. **Refine**: the inducing model revises the current memory from the new
   runs, those results, and the revisions rejected before.
3. **Gate**: current and revised memory are replayed over all runs (the
   picking step for each task, then the places shown against the places
   edited); the revision is kept if places-shown-and-edited minus
   places-shown-and-left-alone doesn't drop. Otherwise it is rejected, with
   the reason, for next time.

## How it is built

TypeScript 7 and Effect 4, run by Node 24 (no build step); conventions in
`CLAUDE.md`.

**Code** (`src/workflows/`):

| Module | What it does |
|---|---|
| `Places.ts` | places from indentation; finding them in code; describing them |
| `Edits.ts` | a diff as edits (added, changed, removed, new files, snapshots) with their places |
| `Evidence.ts` | the evidence of records, places pooled across runs, task values |
| `Induce.ts` | the induction prompt, the answer's schema, the checks |
| `Models.ts` | places, workflows, edges, pitfalls, as stored (snake_case JSON) |
| `WorkflowStore.ts`, `JsonWorkflowStore.ts` | versions and candidates, JSON files |
| `Cues.ts` | picking workflows at task start without a model, by their cues; filling the blanks the task states |
| `CueWriter.ts` | writing the cues once, when memory is built: the prompt, the answer's schema, the checks |
| `Select.ts` | picking workflows by a model call, or by shared words |
| `Locate.ts` | finding places in the working tree or at a commit, moved files included |
| `Render.ts` | the hand-over text and its budget |
| `Start.ts` | task start: pick, find, render, keep the session's state |
| `Session.ts` | the session's state, fired pitfalls, the hand-over log |
| `hook.ts`, `HookStart.ts`, `HookTool.ts`, `HookEnd.ts` | the hooks (entry point and one module per event) |
| `Feedback.ts` | what became of each piece of memory a run got |
| `Evolve.ts` | learning from results: results, refinement, the gate |
| `Describe.ts` | memory in words |

Also: `src/eval/WorkflowsMemory.ts` (the eval setups: `workflows-cues`, the
local-first memory, and `workflows`, v1 as first measured with a model pick;
both hand v1 over through its own hooks with `--settings`, against a copy of a
memory home in each run's directory, and record what was shown and what any
model call cost), `src/commands/Workflows.ts` (the CLI), and the shared plumbing it
reuses: records (`src/records/`), session logs (`src/traces/`), the eval
harness (`src/eval/`), the memory home and git (`src/local/`).

**Data**: in a memory home (`~/.singularity`, or `$SINGULARITY_HOME`), under
`tenants/<tenant>/workflows/`: `workflows.json` (head), `versions/` (each
committed memory, whole), `candidates/` (each proposal with its rationale, the
records it learned from, what checked it, and why it was kept or rejected),
`sessions/` and `handovers.jsonl` (what each session was handed). Records are
in `tenants/<tenant>/records/`.

**Commands**:

```
node src/cli.ts workflows build [--task ID ...] [--repo DIR] [--fresh]
node src/cli.ts workflows cues [--repo DIR]          # after every build or learning round
node src/cli.ts workflows show [AT] [--json]
node src/cli.ts workflows handover "the task" --cwd REPO [--at COMMIT] [--pick cues|words|model]
node src/cli.ts workflows evolve [--task ID ...] [--setup S ...] [--records-from HOME] [--repo DIR]
node src/cli.ts workflows candidates
node src/cli.ts eval run SUITE.toml --setup workflows-cues --memory HOME --frozen
```

**Hooks** are not installed in the user's own Claude Code settings; eval runs
pass them per run. `SINGULARITY_HOOKS=off` turns them off. A hook never
breaks a session: errors go to `<home>/hook-errors.log` and it exits 0.

**Tests**: `test/workflows/` (places on real code shapes, the answer checks,
picking, rendering, feedback, the store, moved files, the gate, and an end-to-
end run through the eval harness with a stand-in Claude Code that runs the
real hooks, for the model pick, the cues and the dropped draft). `npm test`:
193 passed.

## The memory measured: `runs/excalidraw/memory/v1-seed`

Built from six successful runs without memory of two seed tasks in the user's
excalidraw clone: change zen mode's shortcut from Alt+Z to Alt+M
(`altkey-zen-m`), and add a "Minimap" toggle setting end to end
(`toggle-minimap`). 8 workflows, 20 places, 4 pitfalls, 16 edges; $0.14:

- add a persisted field to the app state (type, default, storage rules);
- create a toggle action (the action file, its name, its export, its label);
- give an action a keyboard shortcut (key code, keyTest, shortcut name and map,
  help dialog);
- change an existing action's keyboard shortcut;
- add an action to the canvas right-click menu (the view-mode list only when
  the task wants it there; the context-menu test's expected names);
- add a toggle to Preferences in the main menu;
- update test snapshots and verify;
- add a test that the shortcut toggles the action (only if asked), with the
  pitfall that a test rendering `<Excalidraw />` without
  `handleKeyboardGlobally` never receives its key presses.

Pitfalls with triggers: the doubled `--watch=false`, and an edit whose text
matches twice. Hash for the measurement:
`3b3a719b6bd7758b1470e90fa26d3ce96ae451a76164fcc22eaf3048f000f7fd`.

## Benchmarks

The tasks are the excalidraw suite (`examples/excalidraw/suite.toml`), each
checked by a hidden test, the test files the change can break, and the
typecheck. By how they relate to what memory learned from:

| Kind | Tasks |
|---|---|
| exact repeat | `altkey-zen-m`, `toggle-minimap` |
| twin (same steps, other names) | `altkey-viewmode-j`, `altkey-snap-u`, `toggle-rulers` |
| similar (some steps shared) | `toggle-presenter` (other rules: not stored, not in view mode), `page-breaks` (a subset: Preferences only), `midpoint-snap-n` (a shortcut for an existing action), `stats-shortcut-k` (a shortcut change plus a test, with its trap) |

### Free checks (no agent runs)

**Tasks held out** (`examples/excalidraw/check-v1-places.ts`; about $0.25 for
the picking calls): memory from the seed tasks picks the workflows for each
task, and the places it would show are compared with where that task's own
runs without memory edited. Medians per task:

| Task | Places edited | Shown | Edited, not shown | Shown, left alone |
|---|---|---|---|---|
| `toggle-rulers` | 18 | 18 | 0 | 1 |
| `toggle-presenter` | 17 | 17 | 0 | 1 (not the view-mode list) |
| `page-breaks` | 7 | 7 | 0 | 4 (an action it didn't make) |
| `midpoint-snap-n` | 7 | 4 | 3 (the action's own file, a menu item) | 0 |
| `altkey-viewmode-j` | 5 | 3 | 2 (the action's own file, its test) | 0 |
| `altkey-snap-u` | 4 | 3 | 1 (the action's own file) | 0 |
| `stats-shortcut-k` | 5 | 3 | 2 (the action's own file, the test it was asked to write) | 1 |
| older tasks: add an app-state field (3 tasks) | 3-5 | 3 | 0-2 | 0 |
| older tasks: change a *tool's* shortcut (3 tasks) | 4-9 | 0 | 4-9 | 3 |

The tool-shortcut tasks are the weak spot: memory has never seen one, and the
picking step takes "change the rectangle tool's shortcut" for "change an
action's shortcut", showing 3 places of no use.

**Older code** (`examples/excalidraw/check-older-code.ts`, free): memory
learned from September 2026 code is looked up in the code just before four
past excalidraw commits that added a setting, where the edits went is known:

| Commit | Places found | The commit's additions in a known place |
|---|---|---|
| 2026-03 arrow binding is a preference | 19 of 19 | 13 of 41 (16 in files memory knows) |
| 2025-05 switch between basic shapes | 16 of 19 | 0 of 20 |
| 2023-09 snapping (files moved since) | 11 of 19, all in the files they moved to | 10 of 58 |
| 2022-04 element locking | 7 of 19, all moved | 1 of 38 |

**Learning from results, tried once** ($0.52, in a copy of the memory): the
10 runs without memory of `page-breaks` and `midpoint-snap-n` as new runs.
Replayed over all 16 runs, the revision shows 122 of the 140 places they
edited (118 before) and 4 places they left alone (23 before); the gate kept
it. It learned, in general words, that a setting offered only in Preferences
needs no action, and that giving an existing action a shortcut also shows it
on that action's menu item. On tasks it didn't learn from, the held-out check
stayed about the same. The memory measured below is the one before this.

### The measurement (71 runs, $11.36, 2026-10-03)

Pre-registered in `examples/excalidraw/PREREGISTRATION-v1.md` and committed
before the first counted run; run by `examples/excalidraw/run-v1-measurement.sh`;
scored by `examples/excalidraw/score-v1.ts`. Sonnet 5.5 at medium effort,
Claude Code pinned to the versions the baselines used (2.1.286 for the six
existing tasks, 2.1.287 for the three new ones); 3 runs per existing task, 5
per new one. A gate of 6 runs repeating earlier setups landed within ±15% of
them (+4%, -1%), so the earlier runs of the baselines count: **no memory**,
and the **exact script** (the closest past run's finished diff and commands).

Median tokens per task (memory's own model call included), with median turns:

| Task | v1 | Exact script | No memory | v1's cost |
|---|---|---|---|---|
| `altkey-zen-m` | 172k, 5 turns | 120k, 4 | 1,165k, 25 | $0.11 |
| `altkey-viewmode-j` | 163k, 5 | 140k, 5 | 315k, 10 | $0.13 |
| `altkey-snap-u` | 203k, 6 | 180k, 6 | 213k, 7 | $0.13 |
| `toggle-minimap` | 441k, 10 | 312k, 8 | 787k, 16 | $0.29 |
| `toggle-rulers` | 531k, 12 (1 of 3 failed) | 187k, 5 | 563k, 13 | $0.33 |
| `toggle-presenter` | 385k, 10 | 221k, 6 | 673k, 15 | $0.29 |
| `midpoint-snap-n` | 312k, 9 | 271k (best of two variants), 9 | 386k, 12 | $0.16 |
| `page-breaks` | 255k, 7 | 304k, 8 | 324k, 10 | $0.14 |
| `stats-shortcut-k` | 257k, 8 | 491k, 15 | 801k, 22 | $0.12 |

The pre-registered rules:

| Rule | Result | |
|---|---|---|
| 1. Within +15% of the exact script on exact repeats and twins | +41% (rulers +184%) | fails |
| 2. At least 25% below the exact script on 3 of the 4 similar tasks | 1 of 4 (stats -48%, within run-to-run noise) | fails |
| 3. Never worse than no memory | better on all nine tasks, by 4% (snap) to 85% (zen) | holds |
| 4. No failed run | 1 of 33: a rulers run labelled its setting "Toggle rulers", and the hidden test looks for "Rulers" | fails |

The goal isn't met.

**The pitfalls worked**: the doubled `--watch=false` in 0 of 33 runs (runs
without memory: 16 of 28); all 5 `stats-shortcut-k` runs wrote their test
with `handleKeyboardGlobally` from the start (runs without memory: none of 5);
no run added a test its task didn't ask for.

**Hand-over size**: about 2.9k characters on the shortcut tasks, 3-4k on the
midpoint and stats tasks, 8.9-9.6k on the toggle tasks and page-breaks.

### What the runs show

- **The places were right.** In v1's own runs the places shown were where the
  edits went: rulers 19 of 19, presenter 17 of 18, page-breaks 7 of 7 (plus
  the 4 of the action it didn't need), midpoint 4 of 6, the shortcut tasks 3
  of 4.
- **The cost is turns.** On the toggle tasks v1's runs took 10-12 turns and
  made their first edit in turn 3-6; the exact script's runs mostly in turn 2.
  Each turn also carries the 9k-character hand-over.
- **What the turns went to: what the agent still had to look up.** Every v1
  run on a toggle task began the way runs without memory do: in its first
  turn it read an existing toggle's action file, and it looked for where that
  toggle appears in the repository; then it read the places, a few at a time,
  in wider ranges than shown. The exact script's runs needed none of that: they had the complete
  change. v1's workflows tell where and what in general words, and for the
  larger pieces (a new action file, a Preferences item) a step even says
  "modelled on an existing toggle action", so the agent goes and reads one.
  Every read before the first edit is something memory didn't carry.
- **An example to copy doesn't fix it** (tested after the measurement, 9 runs,
  $2.99). The same memory, with one whole entry of an existing toggle (zen
  mode) shown at every place and its action file whole, read from the code at
  task start: minimap 432k (v1 441k), rulers 584k (531k), presenter 621k
  (385k); all 9 passed; the first edit no earlier. Every run searched the
  repository for the example and read where it appears, including wiring the
  task doesn't need, and all 3 rulers runs copied its icon. Not kept (the
  change is in `runs/excalidraw/v1ex-toggles/example-change.patch`). The
  agent checks and completes whatever the hand-over leaves to it; the exact
  script's runs don't, because it is the complete change in concrete lines.
- **The complete change, drafted at task start, saves tokens but not money**
  (tested next, 9 runs, $3.17, setup `workflows-draft`). A second model call
  writes every edit from the chosen workflows and the code, each checked
  against the files: minimap 421k (v1 441k), rulers 379k (531k), presenter
  394k (385k); all 9 passed, no icons; but $0.36-0.39 a run against v1's
  $0.29-0.33, because the drafting call (4-10 cents) costs about what the
  agent saves. The agent still checked the draft: it read around each edit
  before making it, spread the edits over three turns, and ran the
  workflows' finishing steps one per turn.

### Local first: no model call at task start (18 runs, $3.73, 2026-10-04)

Pre-registered in `examples/excalidraw/PREREGISTRATION-v1-cues.md`, run by
`run-v1-measurement.sh cues 0 2`, scored by `score-v1.ts cues`. Setup
`workflows-cues`, memory `runs/excalidraw/memory/v1-cues` (the measured
memory plus cues, version 2, sha256 of `versions/000002.json`
`04b51cbb42a63bcc013b79440e8de22f7fd639e6e75198ef236bd78c105ec1f9`). The cues
cost $0.09 to write, from the two seed tasks only. 3 runs each, same Claude
Code versions as v1's runs.

Free check first (`check-v1-places.ts --cues`): the cues show the same places
each task needs as the model's picks; places shown that a task left alone
are the same, except midpoint snapping, 4 against 0 ("toggle it" picks the
toggle-action workflow it doesn't need). Plain shared words, for comparison:
page breaks 12, midpoint 8.

| Task | Tokens vs v1 | Dollars vs v1 |
|---|---|---|
| `toggle-minimap` | 364k vs 441k (-17%) | $0.25 vs $0.29 |
| `toggle-rulers` | 394k vs 531k (-26%) | $0.25 vs $0.33 |
| `toggle-presenter` | 538k vs 385k (+40%) | $0.32 vs $0.29 |
| `midpoint-snap-n` | 241k vs 312k (-23%) | $0.16 vs $0.16 |
| `page-breaks` | 221k vs 255k (-13%) | $0.13 vs $0.14 |
| `stats-shortcut-k` | 253k vs 257k (-2%) | $0.16 vs $0.12 |

No run failed (v1: 1 of 24 on these tasks). Rule 2 (within +15% on both, on
5 of 6 tasks) failed, 4 of 6: stats' dollars came from two runs that started
at the same moment in the two lanes and both paid to write the prompt cache
(the third, cached, cost $0.11, like v1's cached runs); presenter's tokens
from the App.tsx import edit that fails in every setup (its clean run: 8
turns, 338k, the cheapest presenter run of any v1 version). The user took it
as v1 not needing the model call, and sealed this as the local-first memory.

## Known weaknesses

- **Exploration isn't removed** (the measurement): see above. This is the
  main open problem.
- **Learning from results sees too little.** It learns only from where runs
  edited, not from what they had to look up or what they cost; its free gate
  replays place fit, not tokens. Turns can only be measured with runs.
- **Look-alike kinds of task**: a kind memory has never seen that is worded
  like a known one (a tool's shortcut, an action's shortcut) gets the wrong
  workflow the first time.
- **Few tasks, narrow lessons**: learned from two tasks, some workflows assume
  what those tasks needed (an action for every setting), until learning from
  results corrects it.
- **Excerpts show a block's end**, not the entry a change task has to edit.
- **Cues come from two tasks.** A phrase one task used can pick a workflow for
  a task that doesn't need it ("toggle it" gives midpoint snapping, whose
  action exists, the create-a-toggle-action workflow). Learning from more
  tasks' runs should narrow them; cues are written again after each round.
- **Builds and learning rounds drop the cues** (`workflows build`, `workflows
  evolve` write workflows without them): run `workflows cues` after each.
  `evolve`'s gate still replays with a model pick, not the cues.
- **Only stated values are filled**: names the agent must derive (the
  action's name, its label key) stay blanks.
- **A place goes quiet** when the block it is in is rewritten or its first
  line changes beyond its first words.
- **One repository at a time**: memory is kept per subject (repository);
  sharing between repositories isn't built.

## Open, for the user to decide

The local-first memory is sealed (tag `memory-local-first`). Settled this
session: memory helps the agent do the task and never writes or applies the
change for it (the drafted change and the example to copy were tested and
dropped; results in `PREREGISTRATION-v1.md`).

Ways on, none started:

- Fold the finishing steps into one check command learned from past runs
  (v1's runs take about 4 turns after their last edit, against 3.7 without
  memory): procedure, no model call.
- Learning from results, taught what each run still had to look up before
  its first edit, and writing cues again after each round. About $1 of model
  calls and $3 of runs to test.
- More kinds of task (bug fixes), and a second repository, to see where the
  workflows and their cues hold beyond settings and shortcuts.
