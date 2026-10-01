# Handoff: Procedural Memory Graph for a Coding Agent

Last updated 2026-10-01, during the third session. Start here, then see
README.md for commands.

## Status

- Work is on branch `procedural-memory` (off `main`, not pushed). Remote:
  github.com/pandacover/singularity.
  - `017370d`: graph storage, `src/singularity/graph/`.
  - `d95d508`: session-log parser, eval harness, toy suite and their tests.
  - `a5fdd53`: excalidraw suite v1, workspaces moved out of the home folder,
    workspaces hide later commits.
  - `ede0ae0`: suite v2 (scoped checks, toggle-action family),
    `files_changed` and `shell_writes` metrics.
  - The commit after that: saved-scripts setup, `learn` and
    `report --compare`, absolute output dirs.
- `python -m pytest -q`: 48 passed.
- **First memory comparison is done.** It covers suite v2's 6 tasks: the
  no-memory baselines (baseline-1 for the alt family, baseline-2-toggle for
  the toggle family) against saved-scripts with frozen memory
  (`runs/excalidraw/saved-scripts-1/`, 18 runs, $2.24). Every run passed in
  both setups. See "Results so far" below.
- **Next:** design and build the graph setup. The user wants to discuss the
  design first.

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

## What's built

### Graph storage: `src/singularity/graph/`

- **`models.py`:**
  - `Node` has a type, a description, optional `command_patterns` (regexes used
    to tell which node the agent is at), and an optional `script`.
  - `Edge` has a relation, condition/guidance/pitfalls, and `facts` keyed by
    repo (paths, commands, dead ends).
  - `EditSet` is the paper's four arrays. Adding an item that already exists
    replaces it.
  - Also `Candidate` and `Graph`.
- **`store.py`** defines the `GraphStore` interface.
  - Reads: `get_nodes`, `match_nodes(command)`, `neighborhood(nodes, hops,
    direction)` and `snapshot`.
  - Every read takes `at=`: None for the current version, an int for a past
    version, or a candidate id. Validation runs can therefore use a candidate
    before it is committed.
  - Evolution: `propose` (validates the edits), `commit` (raises `Conflict` if
    someone else committed first), `reject(reason)` (kept as rejection memory),
    `candidates(status)` and `diff`.
- **`json_store.py`:** one directory per graph, with a snapshot file per
  version and one file per candidate. There is no file locking.
- **`ops.py`:** apply, diff, neighborhood and matching for graphs held in
  memory.
- **Tests:** `tests/test_store.py` is written against the interface. To test a
  future database backend, add it to the `store` fixture.
- **Not done:**
  - The paper's check that every node can reach an END node.
  - Edges are keyed by (source, target), so a pair of nodes can have only one
    edge.

### Session-log parser: `src/singularity/traces/`

- `parse_session(path)` returns a `Trace`: prompts, model responses with token
  usage, tool calls with results and errors, subagents, and Claude Code's
  `cost-state` totals.
- `TraceMetrics` counts tool calls, failed calls, shell commands, searches,
  files edited, and reads versus distinct files read. Repeat reads are a rough
  measure of wasted effort.
  - `files_edited` covers only the edit tools. Agents often edit through Bash
    (`sed -i`, heredocs), which `shell_writes` counts with a regex heuristic.
  - The run record's `files_changed`, taken from the diff, is the ground truth
    for which files changed.
- CLI: `python -m singularity.traces <session id or path> [--json]`.

### Eval harness: `src/singularity/eval/`

- **`suite.py`:** the TOML suite format, documented in the module docstring
  (see `examples/toy/suite.toml`). Unknown keys are errors.
- **`workspace.py`:**
  - A clone of the source repo at `~/.singularity/workspaces/<suite>`, with no
    remote.
  - Before each run it is reset to the task's base commit, and `git clean`
    deletes everything except the `keep` paths.
  - `keep` paths must be gitignored, or the diff capture will stage them.
- **`agent.py`:** builds the `claude -p` command. It removes the parent
  session's environment variables, turns auto-memory off, and passes the prompt
  on stdin.
- **`proc.py`:** runs a subprocess with a timeout. On timeout or Ctrl+C it kills
  the whole process tree.
- **`setups.py`:** the `MemorySetup` interface.
  - `before_run(task, workspace)` returns an `Injection(system_prompt, info)`;
    the text is passed with `--append-system-prompt-file`.
  - `after_run(Outcome)` is where a setup learns from the run.
  - Only `NoMemory` exists. Register new setups in `SETUPS`.
- **`runner.py`:**
  - Each run: reset the workspace, run setup commands (not timed),
    `before_run`, the agent, copy the session log, save the diff, copy in
    `check_files`, run the checks, then `after_run`.
  - Output: `results.jsonl` plus a `runs/<id>/` directory per run with the
    session log, diff, agent output and command logs.
  - Order: each pass runs every task once before the next pass starts.
  - Token and cost figures come from the CLI's result JSON, which includes side
    calls. If that's missing, they fall back to `cost-state`, then to the
    session log.
- **`report.py`:** median (min–max) for each setup and task, plus totals per
  setup.
- **`examples/toy/`:** two similar tasks, `delete-graph` and `rename-graph`,
  against this repo at `017370d`, each with hidden tests. Only `delete-graph`
  has been run for real.
- **`tests/fake_claude.py`:** stands in for `claude`, so `tests/test_eval.py`
  covers the whole pipeline at no cost.
- **Workspace isolation:** after each reset the workspace deletes every ref and
  reflog entry, leaving only the detached base commit. Without that, an agent
  could run `git log --all` and see later commits. That includes the toy
  suite's own hidden tests and the user's hand-written excalidraw maps.

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
- **Validation (`validate3.py`, a scratch script):** the hidden test fails at
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

Run `python -m singularity.eval report --compare runs/excalidraw/baseline-1
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
- **saved-scripts** (`src/singularity/eval/saved_scripts.py`) works like
  this:
  - It keeps the cheapest successful run for each prompt. An entry holds the
    prompt, the files changed, the source diff (snapshot files are listed,
    not included) and the shell commands that succeeded.
  - It retrieves the best match by cosine similarity of the prompts' words,
    with a threshold of 0.35. Within a family prompts score 0.76–0.87; across
    families they score 0.12–0.24.
  - It injects about 0.7k tokens for zen mode and about 3k for minimap.
  - The memory was built for free from the baselines' successful runs with
    `learn`, and stored in `runs/excalidraw/memory/saved-scripts/`.
- **This is the bar the graph has to clear.** Findings that matter for its
  design:
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
- **CPU:** agents run `yarn test:app` / `yarn test:update` (the full suite on
  all 16 cores), which lags the user's machine. vitest honours
  `VITEST_MAX_FORKS` / `VITEST_MAX_THREADS`, and an `env` option on the
  suite's agent config could cap it. That isn't done yet. Capping makes the
  agent's test runs slower, so rerun the baselines with the same cap if wall
  time matters.

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
- **Parent-session variables:** a parent Claude Code session sets `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, a messaging socket and token, `CLAUDE_EFFORT=max`, and more. The harness removes them (the list is in `agent.py`). Otherwise runs started from inside a session would inherit max effort.
- **Home-folder CLAUDE.md:** runs in workspaces under the home folder load `C:\Users\luvma\CLAUDE.md` (the One CLI instructions) as project instructions. This is confirmed in the toy run's log, and it's why workspaces now default to `C:\singularity-workspaces`. Excalidraw's own `CLAUDE.md`/`AGENTS.md` are part of the repo and are still loaded, which is realistic.
- **Result JSON:** the harness reads these fields from `--output-format json`: `subtype`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `modelUsage` and `permission_denials`.
- **Log cleanup:** Claude Code deletes old session logs after a while, so the harness keeps a copy of each run's log.

## Next steps

1. **Graph setup: discuss the design with the user first.** Then build it
   as a `MemorySetup`, with `learn` building the graph from recorded runs, so
   no new runs are needed to build memory.
   - Turn traces into semantic steps by mapping tool calls to nodes with
     `command_patterns` (e.g. "run tests"). Edits made through Bash
     (`shell_writes`) count too.
   - Pick the graph or subgraph for a new task (for now, the same prompt
     similarity saved-scripts uses). Inject it once at task start as plain
     text.
   - Refiner loop: propose edits by comparing failed and successful traces,
     using a rewritten prompt (see the paper notes above). Validate each
     candidate with the harness on held-out tasks (reading with
     `at=<candidate>`), then `commit` or `reject` it.
2. **Protocol.** Build memory from each family's seed run only. Measure with
   frozen memory on all tasks, and compare by `run_kind` (exact repeat versus
   similar task). Still to decide: held-out validation tasks for the
   refiner's gating. That probably needs a third family.
3. **Optional: a stronger script baseline.** Offer the saved patch as one
   command for exact repeats.
4. **Optional: the CPU cap** for agent test runs (see "Results so far").
5. **Later:** a graph database backend for `GraphStore`.

## Open questions for the user

- The graph design: what nodes are, what edges carry, what gets injected, and
  how it's built and refined (under discussion).
- Whether to cap agents' vitest workers (keeps the machine usable; makes runs
  slower in wall time).
- Whether to add a curated mid-size repo alongside excalidraw later.

## Working notes

- Commit only when the user asks, and work on `procedural-memory`, not `main`.
- Runs cost real money on the user's account. Use `--dry-run` first, and set `max_budget_usd` in suites.
- Keep anything heavy (workspaces, node_modules) out of this repo folder, because it is synced by OneDrive.
