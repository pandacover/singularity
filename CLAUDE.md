# singularity

Procedural memory for coding agents: learn from past Claude Code sessions so
repeated and similar tasks take fewer tokens. `HANDOFF.md` has the design,
decisions, results and next steps; read it first.

## Stack

- TypeScript 7 and Effect 4.0, run directly by Node 24 (no build step):
  `node src/cli.ts ...`.
- Tests: `npm test` (vitest 5 with `@effect/vitest`). Typecheck: `npm run typecheck`.
- Versions are pinned exactly in `package.json`. Don't bump them casually:
  agents' knowledge of Effect lags its releases, and pinning keeps the APIs
  that the code and the docs below describe in sync.

Layout: `src/traces/` (Claude Code log parser and metrics), `src/graph/` (the
procedural graph store of the first graph setup), `src/eval/` (the eval
harness and memory setups), `src/cli.ts` (the command line). The local memory
from the redesign: `src/local/` (the memory home in `~/.singularity`, and git),
`src/records/` (workflow records: extraction, where edits went, the model's
reading, the store), `src/memory/` (the memory graph: build, replay, store),
`src/search/` (exact and word search), `src/handover/` (task start and the
code at its places, triggers, session end, hook settings), `src/commands/` (their CLI commands) and `src/hook.ts` (the
hook entry point). That local memory is v0, frozen at tag `memory-v0`.
Memory v1 is `src/workflows/`: workflows with blanks induced from runs, a graph
of them that learns from results, places kept as the blocks around an edit
and found in the code at use, its own hooks (`src/workflows/hook.ts`) and eval
setup (`src/eval/WorkflowsMemory.ts`). Keep v0 and v1 apart: v1 reuses the
records and the plumbing, never v0's memory. Tests mirror it under `test/`.

## Writing Effect 4 code

Before writing Effect code, read `node_modules/effect/AGENTS.md`. Its examples
in `node_modules/effect/ai-docs/src/` are the source of truth for the API; the
library's source is in `node_modules/effect/src/`. Effect 4 changed a lot from
Effect 3, so don't rely on remembered v3 APIs.

Conventions in this repo:

- **Services:** `class X extends Context.Service<X, {...}>()("singularity/<dir>/X")`,
  with a `static readonly layer`. Swap implementations by providing a
  different layer. When an interface will have several implementations (the
  `GraphStore`: JSON files now, a graph database later), keep each one in its
  own module with its own layer, so the interface never imports a driver.
- **Errors:** `Schema.TaggedError`. Return them with `return yield* new MyError(...)`.
- **Functions** that return effects: `Effect.fn("name")(function*(...) {...})`.
- **Parsing untrusted data** (Claude Code logs, suite files, LLM output,
  files on disk): always with `Schema`, never hand-written checks. Use the
  `Predicate` module instead of writing `isString`-style helpers.
- **Files and processes:** `FileSystem` and `Path` from `effect`, child processes
  from `effect/process`, with `NodeServices.layer` from `@effect/platform-node`.
- **Pure logic** (similarity, report formatting, graph traversal) stays plain
  TypeScript functions. Use Effect where there's I/O, failure or resources.
- **Imports** use the `.ts` extension. Only erasable TypeScript syntax: no
  `enum`, `namespace` or constructor parameter properties.
- **Tests:** `it.effect` from `@effect/vitest`, in `test/`. Effect's default
  config provider copies `process.env` once, so a test that changes
  environment variables must run through the `run` helper in
  `test/eval/helpers.ts`, which provides a fresh one.
- **Line endings:** this machine has `core.autocrlf=true`, and the Python
  version wrote text files with CRLF. Normalize `\r\n` when reading text that
  came from git checkouts or old runs (see `Learn.ts`); write files byte-exact.

## Data compatibility

The code was ported from Python and verified against it (identical metrics on
120 real transcripts, identical reports, a byte-identical graph store, an
identical saved-scripts memory). Two helpers exist for that:
`src/eval/PyFormat.ts` (Python's float formatting, which rounds ties to even)
and `src/graph/PythonCompat.ts` (Python's JSON layout, sort order and
`repr()`). Keep them unless they get in the way; they keep old and new data
comparable.

Graph `command_patterns` are JavaScript regular expressions. Prompts that ask
an LLM to write them must say so. Warning triggers in the memory graph are
plain substrings, never regular expressions, and prompts say that too.

Everything written to disk keeps the snake_case keys the Python version used:
`results.jsonl`, saved-scripts memory entries, graph store files. Old runs in
`runs/` stay readable and comparable, so TypeScript types for persisted
records use those keys.

## Working rules

- Commit only when the user asks. Work on a feature branch, not `main`.
- Eval runs spend real money on the user's Claude account. Use `--dry-run`
  first and keep `max_budget_usd` set in suites.
- Compare runs only with runs of the same Claude Code version: it updates
  itself, and each turn rereads its own prompt. Pin a measurement with
  `--claude` and a copy of the version its baselines used (Claude Code keeps
  a few in `~/.local/share/claude/versions/`); runs never update it.
- The user needs their computer during runs: suites cap vitest workers and the
  harness runs everything below normal priority. Keep it that way; `eval run
  --priority normal` only when the user asks for it.
- Heavy folders (workspaces, node_modules of target repos) live outside this
  repo, in `C:\singularity-workspaces`.
- Hooks run in the user's own sessions once installed. They must never break
  a session (errors go to `~/.singularity/hook-errors.log`, exit 0), and the
  tool-call hook runs after every call, so `src/hook.ts` checks the session
  file with plain `node:fs` and loads modules only for the event at hand.
  Keep it fast (about 0.1 s without memory, 0.4 s with). Tests use a temporary
  `SINGULARITY_HOME`, never the real one.
- Claude Code cuts a hook's text at 10,000 characters and hands the agent a
  file path instead. The hand-over at task start stays under
  `MAX_HANDOVER_CHARS` (`src/handover/TaskStart.ts`); anything added to it
  takes room from the code it shows.
- Model calls that build memory (`record annotate`, `memory build
  --conditions`) cost a few cents each; run them on a few records first.
