# Handoff: Procedural Memory Graph for a Coding Agent

Last updated 2026-10-01, end of the second session. Start here, then see
README.md for commands.

## Status

- Work is on branch `procedural-memory` (off `main`, not pushed). Remote:
  github.com/pandacover/singularity.
  - **Committed** (`017370d`): graph storage, `src/singularity/graph/`.
  - **Not committed:** trace parser (`src/singularity/traces/`), eval harness
    (`src/singularity/eval/`), `examples/toy/`, `tests/test_traces.py`,
    `tests/test_eval.py`, `tests/fake_claude.py`, README.md, and `.gitignore`
    (adds `runs/`). This file is untracked too. The user hasn't said whether to
    commit these yet, so ask.
- `python -m pytest -q`: 27 passed.
- The eval harness works end to end. One real run so far: toy suite, task
  `delete-graph`, Haiku. The hidden test passed; the run cost $0.09, took 42 s,
  and made 14 tool calls (8 file reads, of only 4 distinct files). Output is in
  `runs/toy/smoke-1/` (gitignored).
- **Waiting on the user:** the path to their local excalidraw clone, which is
  the evaluation repo.

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
- **Evaluation repo (decided by the user):** their local excalidraw clone. They
  said they'd give the path once something worked, and it now does, so ask.
- **Success:** a task succeeds when its check commands (tests) pass. Hidden tests
  are copied in after the agent finishes (`check_files`). (Proposed and built;
  the user didn't object.)

## What's built

### Graph storage: `src/singularity/graph/` (committed)

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

### Session-log parser: `src/singularity/traces/` (uncommitted)

- `parse_session(path)` returns a `Trace`: prompts, model responses with token
  usage, tool calls with results and errors, subagents, and Claude Code's
  `cost-state` totals.
- `TraceMetrics` counts tool calls, failed calls, shell commands, searches,
  files edited, and reads versus distinct files read. Repeat reads are a rough
  measure of wasted effort.
- CLI: `python -m singularity.traces <session id or path> [--json]`.

### Eval harness: `src/singularity/eval/` (uncommitted)

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
- **Home-folder CLAUDE.md:** runs in workspaces under the home folder load `C:\Users\luvma\CLAUDE.md` (the One CLI instructions) as project instructions. This is confirmed in the test run's log. It's the same for every setup, but it adds tokens. Pointing `--workspaces` outside the home folder would avoid it.
- **Result JSON:** the harness reads these fields from `--output-format json`: `subtype`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `modelUsage` and `permission_denials`.
- **Log cleanup:** Claude Code deletes old session logs after a while, so the harness keeps a copy of each run's log.

## Next steps

1. **Excalidraw suite.** Ask the user for the excalidraw path, then write its suite.
   - Read its package.json for the install and test commands. Probably `setup = ["yarn install --frozen-lockfile"]` and `keep = ["node_modules"]`.
   - Design 2–3 task families. Each needs an exact repeat and some similar-but-different variants, with tests that decide success. Use hidden tests via `check_files` where possible.
   - Pin `model` and `effort` in the suite.
2. **Baseline.** Run the no-memory baseline with at least 3 runs per task. Measure how large run-to-run variation is before comparing setups.
3. **Saved-scripts baseline.** Build it as a `MemorySetup`. `after_run` saves successful runs as a script or skill, and `before_run` gives the agent the relevant ones.
4. **Graph setup.**
   - Turn traces into semantic steps by mapping tool calls to nodes with `command_patterns` (e.g. "run tests"). Build or extend a graph from successful traces.
   - Pick the graph or subgraph for a new task (e.g. with embeddings of the task prompt). Inject it once at task start as plain text.
   - Refiner loop: propose edits by comparing failed and successful traces, using a rewritten prompt (see the paper notes above). Validate each candidate with the harness on held-out tasks (reading with `at=<candidate>`), then `commit` or `reject` it.
5. **Protocol.** Define which runs build memory and which measure it, exact repeats versus similar tasks, and the held-out validation tasks used for gating.
6. **Later:** a graph database backend for `GraphStore`.

## Open questions for the user

- The path to the excalidraw clone, and which parts of excalidraw to build tasks around.
- Which model and effort to use for the real evaluation (the toy suite uses Haiku to keep costs low), and the budget per run and overall.
- Whether to commit the uncommitted work listed under Status.
- Whether to keep workspaces under the home folder (which loads the One CLI CLAUDE.md into every run) or move them.

## Working notes

- Commit only when the user asks, and work on `procedural-memory`, not `main`.
- Runs cost real money on the user's account. Use `--dry-run` first, and set `max_budget_usd` in suites.
- Keep anything heavy (workspaces, node_modules) out of this repo folder, because it is synced by OneDrive.
