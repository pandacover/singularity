# One memory layer, many agents: design and the "new job" benchmark

Written 2026-10-09, before anything below was built, at the user's request:
"make sure everything is available via the same API (code, computer, other
future agent)", "even though the memory is built by us please do not go easy
on it - if we fail that's good, if we fail miserably that's even better", and
"add tasks that are like maze and traps as well". Built and run overnight,
unattended; what changed on the way is under "Deviations" at the end.

## Part 1: one API for every agent and every kind of work

### The four calls

| Call | When | What memory does |
|---|---|---|
| `start` | a task begins | picks what it knows for this task (workflows by cues, no model call), fills the blanks the task states, hands it over |
| `step` | after each action | a warning whose trigger appeared, or a pointer to a place now on screen; usually nothing |
| `end` | the session is over | records the session and how it went (success, and feedback when there is some) |
| `learn` | after enough new sessions | a learning round: a first build after 2 sessions of a subject, then a round every 3, each kept only if it fits the runs better |

Code, computer use and any future agent use these same four calls.

### Ways in

All of them reach the same four calls (`src/layer/Api.ts`):

- **Hooks**, for agents that have them: Claude Code, Codex, Gemini CLI, Droid, and Hermes Agent through a plugin that runs the same script. `src/workflows/hook.ts` now routes every event through the API.
- **The CLI**, for anything that can run a command: `singularity memory start|step|end|learn`, a JSON request on stdin and a JSON answer on stdout. A harness or an agent without hooks uses this.
- **MCP**, for agents that call tools: the same calls as tools. Designed here, not built tonight (the hosted service's door, see the storage plan).

The eval harness uses the hooks, like users do. It never takes a shortcut into memory.

### Behind the API: two kinds of plug-in

- **A translator per agent**: its hook events or session log, turned into one form (a tool call: name, input, output, failed or not). Claude Code's format today; the other agents' hooks are already mapped onto it (`HookTool.ts`).
- **A reader per kind of work**: what a session means in that kind of work.
  - What a **subject** is: a repo (by root commit or remote), a web app (by its address).
  - What **evidence** a session gives: for code, its diff and where each edit went; for the web, its actions and the part of the page each acted on, and how it went.
  - What a **place** is: for code, the chain of blocks around an edit; for the web, the chain of page regions around an action (`Orders › region "Actions" › button "More actions"`), with the task's own values left as blanks.
  - How a place is **found at use**: for code, in the working tree at task start; for the web, in the page snapshot when the agent opens that page (the `step` call), so pointers arrive mid-task.
  - What **success** is: for code, committed with passing tests (or the eval's checks); for the web, the task's check and its feedback.
  - What **warnings watch**: for code, commands, edits and errors; for the web, also what the page shows and which control an action targets.

The core never knows which reader it serves: workflows with blanks, the graph between them, pitfalls, cues for picking without a model, the store and its versions, learning rounds with a gate. One memory per tenant holds every subject, code and web.

### What stays the same for code

Code memory moves behind the API unchanged: the same functions run for the same events. Checked by the measured memory (`runs/excalidraw/memory/v1-finish`) giving byte-identical hand-overs before and after, and by every test passing.

### The web reader, concretely

- **Sessions**: the agent drives a browser through Playwright's MCP server. Actions (`browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_navigate`) name a target in the last page snapshot; the reader places each action in that snapshot.
- **Places**: a page pattern (the URL's path, with ids as `{n}` and the task's values as blanks) and the chain of named regions from the top of the snapshot to the target: landmarks, regions, forms, dialogs, menus, tabs, groups with names, and the target's own role and name. Never a snapshot, never a click path to replay.
- **Learning**: one model call per round reads the sessions of a subject (successful and failed, with the check's feedback) and proposes workflows, edges and pitfalls, in the same format as code memory. The same mechanical checks apply: no task's own values in the text, a place counts only where two runs acted, a trigger must be specific. Failed sessions count too: their feedback is where silent rules are learned. Code memory still learns only from successes.
- **Gate**: a revision is replayed over the subject's recorded sessions (cues pick for each task; places shown against places acted on) and kept only if shown-and-used minus shown-and-unused doesn't drop.
- **Hand-over**: at `start`, the picked workflows with each step's place in words; at `step`, when a snapshot shows one of those places, a pointer to it (with the snapshot's current reference), once per place; and pitfalls when their trigger appears.

## Part 2: the benchmark, "a new job"

### Who builds what

- **The benchmark** is built by a separate Claude agent (Opus 5.5) in its own T3 thread, in a folder outside any repository, from a brief. The brief is in the T3 thread `Sealed benchmark builder: "a new job"`; it asks for three internal tools no model has seen, a maze game, about 40 chores, traps, house rules (some silent), a UI update, look-alike chores, an onboarding guide, deterministic checks with a manager's feedback, a self-test, and a runner. It is sealed with a sha256 before any run.
- **I never open it** until every run is done: a `PreToolUse` hook in this project (`.claude/guard-sealed.mjs`) denies any tool call that names its folder, its runtime folder, its session logs or its thread; it was seen to deny one of my own commands. I only use the runner's commands, through a launcher in `C:\singularity-workspaces\new-job-public`. After the runs, an audit searches this project's session logs for those names.
- **The memory's web reader is developed** on a practice app of my own (`apps/cli/examples/practice-web`), never on the benchmark.

### Phases

| Phase | UI | Chores | Memory learns during it |
|---|---|---|---|
| learn | v1 | about 18, including 3 maze games | yes, as in daily use |
| test | v1 | about 15: repeats, new kinds sharing parts, look-alikes, unrelated, 3 maze games | no (frozen after learn, so order can't help) |
| update | v2, unannounced | about 8: moved controls, a changed rule | yes, as in daily use (does it recover?) |

### Conditions

All on the same Claude Code binary, pinned, with Sonnet, browser tools only (no shell, no files), one run per chore and condition:

- **none**: no memory.
- **memory**: this layer, through its hooks, learning on its own.
- **guide**: the company's one-page onboarding guide at the start of every chore (written for v1, so stale after the update, like a real one).
- **awm**: Agent Workflow Memory's way: workflows with variables induced once from the successful learn-phase runs without memory, all handed over at the start of every chore.
- **memory-haiku** (stand-in, if time allows): Haiku with the memory Sonnet's runs built. Not proof that memory carries across agents: same family, one model swapped.

### Measures, harm first

1. **Harm**: chores that fail with memory and pass without it. Reported first, by name.
2. Success rate per condition and phase.
3. Cost per chore: turns, tokens, Claude Code's dollar figure (a subscription pays in limits, not dollars, but the figure compares runs).
4. Traps hit, and traps hit again after memory saw them.
5. After the update: success and cost, and whether memory's cost comes back down over the update phase.
6. Mazes: success and moves against the fewest possible.
7. Look-alikes and unrelated chores, on their own: where memory can only mislead.

### Bars, written before any run

Memory **passes** only if all of these hold:

- no more failures than **none** in any phase;
- in **test**, on repeats and shares-parts chores: median turns at least 20% below **none**, success no lower;
- on look-alikes and unrelated chores: success no lower than **none**, and median turns at most 10% above;
- in **update**: success no lower than **none**, and the last half of update chores costs no more than **none**'s;
- against **guide** and **awm**: reported as is. Losing to a one-page guide means memory saved only the writing of it.

Anything else is a failure, written up as plainly as a pass.

## Deviations

Written as the night went:

- **No Codex.** The user has no Codex subscription, so the benchmark's builder is a Claude agent (Opus 5.5) in its own T3 thread, and the second agent is a stand-in: Haiku with the memory Sonnet's runs built.
- **Snapshots come from one tool.** In Playwright MCP 0.0.83, actions return the page's address and a link to a snapshot file; only `browser_snapshot` returns the page inline. Pointers attach to those snapshots, and actions are placed in the last one the agent read.
- **Hooks for browser tools.** Claude Code runs a `PostToolUse` hook only for the tools its matcher names; the installed hooks name shell and edit tools. The benchmark's memory settings add a matcher for `mcp__playwright__.*`. Setup doesn't install that yet: a web user would need it.
- **Web memory learns from failures; code memory still doesn't.** Failed sessions with the check's feedback are evidence for web memory (that's where silent rules come from). Code memory is unchanged, on purpose.
- **A workflow's pitfalls come with it at the start, triggered or not** (web only): an app's rules are cheap to read and costly to miss. Triggered ones also fire mid-task.
- **Who starts.** At a task's start the code reader runs first, exactly as before; the web reader only when the code reader has nothing and the task names an address.
- **The MCP door is designed, not built.** The CLI door (`singularity layer start|step|end|learn`) is built and tried.
- **A weakness seen in practice, not patched.** On the practice app, the cue writer (shared with code) gave both checkout workflows the cue "loan", so "Renew the loan" was handed the checkout workflows. That is a look-alike misfire; it was left in on purpose, frozen with the rest.
- **The builder was fast**: it sealed after about 27 minutes. I can't judge its work without opening it; the report will say what `reveal` shows about it.
- **Something else edited the landing page** in this working tree at 05:41 (`apps/landing`: `Intro.tsx` deleted, `App.tsx` and others changed), after the user went to sleep. Not this session; left alone.
- **A second pass**, added before any test-phase run because runs took about 30 seconds: memory and no memory ran the test and update phases twice (`PREREGISTRATION.md`, amendment).
- **Two runner crashes** (exit 0xC0000409 on `reset`) cost a few chores; they were run again in order, before anything that depended on them. **A usage-limit pause** stopped everything from 01:19Z to 06:24Z. After it, the second pass ran before the Haiku stand-in.
- **The result:** memory fails the bars. See `apps/cli/examples/new-job/RESULTS.md`.

## The second version of web memory (2026-10-09, afternoon)

Three fixes, one for each way the first version failed, then the same
benchmark again (`apps/cli/examples/new-job/PREREGISTRATION-v2.md`):

- **Every rule of the app at every start**, not only inside a picked workflow.
- **What sessions left alone**: records keep the fields each page opened with
  already set and whether the session changed them; the learning model sees
  them; memory writes a note per page on its own (`src/web/Presets.ts`); and
  the hand-over says its steps are not a script.
- **Learning right after a failure with feedback**; rules kept even when the
  replay turns a revision's workflows down.

The rerun is not a sealed test: I had seen the benchmark's reveal and every
run before writing the fixes. It can show the fixes fix what they aimed at,
not that they carry to apps nobody has seen.

- **Changed on the way, before the freeze** (from the practice app): only
  forms a session sent count; the model is told never to turn "sessions left
  it alone" into "leave it"; options keep their own numbers; text typed into a
  box is never kept.
- **The result:** memory v2 still fails the bars, 3 of 6 holding (the first
  version 2). Harms went from 4 to 2, and it fixed the three failures it was
  aimed at. A new one: a keystroke step learned on the old screens ("ArrowDown
  + Enter") submitted a form on the new ones. Still not faster on repeat work
  (-10% against a -20% bar). See `apps/cli/examples/new-job/RESULTS-v2.md`.
