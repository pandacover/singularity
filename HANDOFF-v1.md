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
5. **Ends with one command** (Finish.ts, memory that knows what its checks
   rewrite): the chosen workflows' checks in one line, formatters first and
   tests last, with `git status --short` when snapshots change, and the
   snapshot files that every earlier run of those workflows regenerated
   (learned from their diffs, no model). No checks under each workflow; a
   finishing workflow (no step at a place, leading only to the end) is folded
   into it. `workflows finish` adds this to memory built before.
6. **In up to two parts** (the `workflows-split` setup,
   `SINGULARITY_HANDOVER_PARTS=2`): Claude Code cuts each hook's text on its
   own, so a second task-start hook doubles the room. Both hooks compute the
   same hand-over (cues, no model); the first keeps the session, the second
   prints the rest. The local-first hand-over for the toggle tasks is about
   13.5k characters, so in one part it was cut to 3 lines of code per place.
   A place can also be shown as **one whole entry** (`show: "entry"`, learned
   from results): its last component or tag with its attributes, or for new
   files the shortest existing one.

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
   memory, would have shown it), against where its edits went; and, for runs
   that had memory, **what they still looked up before their first edit**
   (Lookups.ts): every read and search of those turns, told against memory's
   places as found at the run's base commit and the lines of them its
   hand-over showed ("read DefaultItems.tsx 615-709, around place p-0141a9dc,
   of which the hand-over showed 2 of 230 lines"; "read an existing file of
   the kind place p-4eb1f0bc creates").
2. **Refine**: the inducing model revises the current memory from the new
   runs, those results, and the revisions rejected before. It is told to give
   knowledge for the lookups, never code to copy: what a step's existing
   example would have shown, that the listed places are all of them, where to
   see what a step depends on; and which places to show as a whole entry
   (`entries`). Memory's own pitfalls stay unless runs show them wrong: runs
   that no longer hit a pitfall show it works (a first round dropped them all,
   since its new runs had no such detours).
3. **Cues** are written again for the revision, from every task memory has
   learned from, when memory is picked by cues.
4. **Gate**: current and revised memory are replayed over all runs (the
   picking step for each task, by cues for memory with cues, then the places
   shown against the places edited); the revision is kept if
   places-shown-and-edited minus places-shown-and-left-alone doesn't drop.
   Otherwise it is rejected, with the reason, for next time.

### 7. What tasks of a kind share (tenth session)

Learned task by task, two bug fixes became a workflow each, cued by that
bug's words: no other bug could use them. What bug fixes in one repository
share is how a bug is reproduced in a test and the fix checked. `workflows
common --task A --task B ...` (`Common.ts`) reads the runs of several tasks
of one kind and keeps only what runs of at least two of the tasks did: each
workflow, and each place a step names, must come from two tasks' runs. The
workflows carry the kind (`kind: "fixing a bug"`) and join memory next to
the per-task ones; a later pass for the kind replaces them; their checks join
the one command, their steps are never folded into it.

Its places include **places runs read** in code they didn't change
(`Reads.ts`): a `Read` with a range, `sed -n`, `head`, or a search in one file
that printed lines, placed in the outermost block of up to 600 lines that
holds them (`class Keyboard` in the test helpers; in `class App`, the member).
The hand-over shows one as an outline: the block's first line and its
members' first lines, from the code at task start, never code to copy.
Learning from results doesn't count one as shown and left alone.

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
| `Render.ts` | the hand-over text and its budget, in one part or two |
| `Finish.ts` | the finish in one command: the checks folded, the snapshot files expected |
| `Lookups.ts` | what a run looked up before its first edit, told against memory's places |
| `Start.ts` | task start: pick, find, render, keep the session's state |
| `Session.ts` | the session's state, fired pitfalls, the hand-over log |
| `hook.ts`, `HookStart.ts`, `HookTool.ts`, `HookEnd.ts` | the hooks (entry point and one module per event) |
| `Feedback.ts` | what became of each piece of memory a run got |
| `Evolve.ts` | learning from results: results, refinement, the gate |
| `Common.ts` | what runs of different tasks of a kind did alike: the prompt, the two-task checks, joining memory |
| `Reads.ts` | the parts of files a run read, from its tool calls |
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
node src/cli.ts workflows cues [--repo DIR]          # after a build (a learning round writes them itself)
node src/cli.ts workflows finish [--repo DIR]        # memory built before: learn what the checks rewrite
node src/cli.ts workflows show [AT] [--json]
node src/cli.ts workflows handover "the task" --cwd REPO [--at COMMIT] [--pick cues|words|model] [--parts 2]
node src/cli.ts workflows evolve [--task ID ...] [--setup S ...] [--records-from HOME] [--repo DIR] [--dry-run]
node src/cli.ts workflows candidates
node src/cli.ts eval run SUITE.toml --setup workflows-split --memory HOME --frozen
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

### The three next steps (2026-10-06, eighth session)

The user asked for the three "ways on" below, one by one, with results for
the second and third. Pre-registered in
`examples/excalidraw/PREREGISTRATION-v1-lookups.md` (1 and 2) and
`examples/PREREGISTRATION-v1-new-kinds.md` (3), all runs on Claude Code
2.1.286; scores with `examples/score-phases.ts`.

**1 and 2 on the held-out toggles** (12 runs, $2.90; A = the sealed memory
with the one-command finish, in two parts; B = A after a learning round on
what 12 local-first runs looked up):

| Task | Setup | Tokens | Dollars | Turns before the first edit | After the last |
|---|---|---|---|---|---|
| rulers | local first | 394k | $0.25 | 3 | 3 |
| rulers | A | 350k | $0.23 | 4 | 2 |
| rulers | B | 426k | $0.28 | 2 | 4 |
| presenter | local first | 538k | $0.32 | 4 | 4 |
| presenter | A | 372k | $0.26 | 4 | 3 |
| presenter | B | 288k | $0.13 | 3 | 3 |

- The finish in one command (A): fewer turns after the last edit, and with
  room for the code, cheaper than local first on both tasks.
- Learning what runs looked up (B): the first edit came earlier on both
  tasks; presenter's dollars halved; rulers got dearer. The pre-registered
  cost rule failed on rulers. Three B runs ran the one command bare and paid
  1-2 turns reading the test output Claude Code saved to a file; the hand-over
  now says to keep the last 60 lines. A follow-up of 3 rulers runs with that
  fix: the finish took 1-2 turns, yet rulers still cost 410k / $0.30, because
  its runs read the places they edit between edits instead of before.

**3, a second repository (validator.js)**: memory built from two seed tasks'
runs (4 workflows); on the held-out tasks, 12 runs, all passed: ulid +9%
tokens / -7% dollars, postal-code-pk +1% / -2% against no memory. The rule
(tokens below on both) fails. These tasks are small (2-3 turns of looking
without memory), so the hand-over costs about what it saves.

**3, bug fixes in excalidraw** (12 runs, all passed): the learning round
turned each seed bug into workflows of its own, cued by that bug's words
("multi-point", "bound text"). The held-out save-as bug got nothing (+0%
tokens: its memory runs were runs without memory); the dropdown bug got the
wrong workflow (its "main menu" cues adding a Preferences toggle), which its
agents ignored (-19% tokens, +5% dollars, inside the spread of runs without
memory). The rule fails. What bug fixes share (reproducing the bug in a test,
checking the one test file) didn't become a workflow: from two bugs in
different places, the model kept what each did, not what both did.

### A long task (8 runs, $4.29, 2026-10-07, ninth session)

Four changes in one prompt, done in one session, two of them alike:
toggle-rulers, midpoint-snap-n, toggle-presenter and stats-shortcut-k as a
numbered list (`examples/excalidraw/long.toml`). Pre-registered in
`examples/excalidraw/PREREGISTRATION-v1-long.md`: 4 runs without memory, 4
with the `v1-finish` memory in two parts; the bar is at least 20% fewer
tokens and 10% fewer dollars than no memory. Scores with
`examples/excalidraw/score-long.ts` (also change by change).

| Setup | Tokens | Dollars | Turns | Before the first edit |
|---|---|---|---|---|
| no memory | 1,902k (1,190k-2,241k) | $0.81 | 28.5 | 8.5 |
| memory | 423k (293k-498k) | $0.30 | 9.5 | 3.5 |

All 8 passed; both rules hold (-78% tokens, -63% dollars). Asked one per
session, memory saved 50% of tokens and 34% of dollars on these four; in one
session it saved more, since its runs edited all four changes within 2-3
turns and paid the looking and the finish once. Every run, memory or not,
edited the two alike toggles side by side. All 4 runs without memory fell
into the keyboard-test trap (1 of 4 with memory, fixed two turns later), so
part of the gap is the trap; against the cheapest run without memory,
memory is still -64% / -49%.

**A long task memory only half knows** (8 runs, $4.15): the same toggles
with two bug fixes memory never saw in place of the shortcut changes
(`long-mixed-changes`, at `d29d8648`;
`examples/excalidraw/PREREGISTRATION-v1-long-mixed.md`).

| Setup | Tokens | Dollars | Turns |
|---|---|---|---|
| no memory | 1,287k (1,039k-1,423k) | $0.64 | 21.5 |
| memory | 788k (671k-920k) | $0.40 | 15 |

All 8 passed; the same rules hold (-39% tokens, -38% dollars). The saving
(499k tokens) is about what memory saves on the two toggles asked one per
session (514k): the bug fixes cost the same with memory or without, and
nothing was handed over for them. Memory's runs fixed the bugs first, then
both toggles in one or two turns.

The free preview first showed a flaw in task start: blanks were filled with
the first value of their kind anywhere in the prompt (every change got the
rulers field; the stats change was told Alt+N). A task that lists several
changes is now picked and filled change by change (`partsChoice`, Cues.ts).

## Known weaknesses

- **Exploration isn't removed** (the measurement): see above. This is the
  main open problem. Learning what runs looked up moved the first edit
  earlier, but on rulers the reading moved into the editing turns rather than
  going away.
- **Workflows from one bug don't reach other bugs.** Learned from two bug
  fixes, memory made a workflow of each, cued by that bug's own words; other
  bugs get nothing, or a workflow of another kind whose cue matches by chance
  ("main menu").
- **Small tasks gain nothing**: where the agent finds everything in two or
  three turns (validator.js), the hand-over costs about what it saves.
- **The one command's output** is long; the hand-over says to keep its last
  60 lines, since a bare run makes Claude Code save it to a file the agent
  then reads.
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

Ways on, from the seventh session, all three done in the eighth (results
above): the finish in one command; learning what runs still looked up; bug
fixes and a second repository.

Open after the eighth session (nothing started):

- **What memory carries for one-off work.** v1 helped where a task repeats a
  past one's procedure across many places (toggles: up to half the dollars).
  On bug fixes and on small tasks in a second repository it handed over
  nothing useful. What bug fixes share is how to reproduce and check (the
  test helpers, which test file, the keyboard-test trap), and induction from
  two bugs kept each bug's specifics instead. A deliberate "what do these
  runs have in common" pass, or workflows learned across tasks of a kind
  rather than per task, would be the thing to try.
- **Look-alike cues**: a cue phrase ("main menu") picks a workflow for a task
  of another kind. Cues written from seven tasks still misfire.
- **Reading moves rather than goes**: with the learned knowledge, rulers runs
  edit sooner and read between edits. Whether any hand-over can stop the
  reading short of the finished change is still the open question.
