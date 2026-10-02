# Handoff: Procedural Memory Graph for a Coding Agent

Last updated 2026-10-03, in the fourth session. Start here, then see
README.md for commands and CLAUDE.md for how the code is written.

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

**Build order, proposed (2026-10-03); not started, because the user asked to
wait.** Each stage rests on the one before. Paid runs and model calls only
after an explicit go.

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

## What's built

All code is TypeScript + Effect 4 under `src/`, with tests under `test/`.
Run things with `node src/cli.ts ...` (see README.md).

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

## Next steps

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

- For the hosted version: where it runs, which graph database, and whether
  agents pull memory through an MCP tool or a hook injects it at task start.
- Whether to add a curated mid-size repo alongside excalidraw later.

## Working notes

- Commit only when the user asks, and work on a feature branch (currently
  `graph-setup`), not `main`.
- Runs cost real money on the user's account. Use `--dry-run` first, and set
  `max_budget_usd` in suites.
- Keep heavy folders (workspaces, target repos' node_modules) out of this repo
  folder.
  - This repo's own `node_modules` is inside it.
  - OneDrive wasn't running on this machine (checked 2026-10-01). If it
    starts syncing the folder, move the repo out of OneDrive.
- The user needs their computer during runs: keep the vitest cap and the
  below-normal priority.
