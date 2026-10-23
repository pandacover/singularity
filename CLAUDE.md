# singularity

Procedural memory for coding agents: learn from past Claude Code sessions so
repeated and similar tasks take fewer tokens. `HANDOFF.md` has the design,
decisions, results and next steps; read it first. `HANDOFF-v1.md` describes
memory v1 on its own. `README.md` is for users (keep it about using
singularity, not a log of work); the reference for the code's parts and the
eval harness is `docs/development.md` and `docs/evaluation.md`. The code is
MIT licensed (`LICENSE`).

## Stack

- A Turborepo monorepo with npm workspaces. `apps/cli` is the command line,
  hooks, memory and eval harness (`@singularity/cli`); `apps/landing` is the
  landing page (`@singularity/landing`, Vite and React, every dependency a
  dev one so the installer's `npm ci --omit=dev` never fetches them).
  `packages/*` is for shared code, when there is some.
- The CLI: TypeScript 7 and Effect 4.0, run directly by Node 24 (no build
  step): `node apps/cli/src/cli.ts ...` from the repo root, or
  `npm run cli -- ...`. Commands, eval scripts and docs run from the repo
  root, where `runs/` stays.
- From the root, through turbo: `npm test` (vitest 5 with `@effect/vitest`),
  `npm run typecheck`, `npm run build` and `npm run dev` (the landing page).
  One workspace: `npx turbo run test --filter=@singularity/cli`.
- Versions are pinned exactly in each workspace's `package.json`. Don't bump
  them casually: agents' knowledge of Effect lags its releases, and pinning
  keeps the APIs that the code and the docs below describe in sync.
- Paths in `HANDOFF.md` and `HANDOFF-v1.md` from before the monorepo
  (2026-10-08) are relative to `apps/cli`, except `runs/`.

Layout of `apps/cli` (paths from here to the end are relative to it, except
`node_modules/`, `runs/` and the install scripts, at the root): `src/traces/`
(Claude Code log parser and metrics; what the person wrote in a prompt,
without what tools add: `Prompts.ts`), `src/eval/` (the eval harness and its
setups: no memory and saved scripts), `src/cli.ts` (the whole command line,
run from the repo), `src/singularity.ts` (the `singularity` command setup
installs: the eight daily commands only, so nothing user-facing may point users
or agents at another one), `src/local/` (the memory home in `~/.singularity`,
and git), `src/records/` (records of committed changes: extraction, where
edits went, the store; whether a call failed: `Outcome.ts`), `src/commands/`
(CLI commands), `src/facts/` (facts: traps and checks from the records, one index
per repo written at store time; the hook hands over only its card of check
scripts). Memory is saved scripts, `src/scripts/`: at a prompt that
starts a task (one that asks for something, `src/traces/Requests.ts`: the
session's first such, then the first after each commit, `src/scripts/Cycle.ts`)
the hook (`src/workflows/hook.ts`, which calls `src/scripts/Hook.ts`)
points to the stored commit most like the task (its hash, what it was for,
its files; no diff), found by its commit message (`src/records/Task.ts`), or
picked by a model the person chose at setup, in a background hook
(`src/scripts/Pick.ts`), read from git, with no learning step, then adds the repo's card of check scripts earlier sessions
ran, still on disk, once a session (`src/facts/Lookup.ts`); and when the agent
reads a stored commit with `git show` or `git log`, the tool-call hook adds
what git doesn't show about it, once a session: the request, the project
commands its session ran, its mistakes (`src/scripts/History.ts`). On this branch everything else was
removed: memory v0 (`src/memory/`, `src/search/`, most of `src/handover/`,
`src/hook.ts`; tag `memory-v0`), memory v1's learning and hand-over (the rest
of `src/workflows/`; tag `memory-local-first`), the graph setup (`src/graph/`
keeps only `Similarity.ts` and the store errors), `src/layer/`, `src/web/`,
and learning in daily use. A second repository's suite is
`examples/validator/`. Tests mirror it under `test/`.

Daily use, for anyone (`singularity setup | status | changes | visualise |
recall | store | update | uninstall`, `src/commands/Setup.ts`; what memory
stored, listed or one in full: `src/setup/Changes.ts`; drawn for a
terminal: `src/setup/Visualise.ts`): `install.sh` and `install.ps1` clone
the code into `~/.singularity/app` and run setup, which lives in
`src/setup/`: the agents memory can be set up in and what each gets
(`Agents.ts`: Claude Code, Codex and Hermes Agent store and hand over, their
sessions read as Claude Code's by `src/traces/Codex.ts` and
`src/traces/Hermes.ts`; Codex, Gemini CLI and Droid hand over through hooks
in Claude Code's format; Hermes Agent through a plugin of memory's own that
runs the same hook script, `HermesPlugin.ts`, enabled by an edit of its
`config.yaml` that touches only `plugins.enabled`; Cursor and OpenCode get
the skill), their hook files
(`HookFiles.ts`; Codex runs a hook only once the user trusts it, which setup
offers and status checks through `codex app-server`, `CodexHooks.ts`), the skill (`Skill.ts`), the
`singularity` command on PATH (`Launcher.ts`), storing in the background
(`Background.ts`, one run at a time under `store.lock`),
the recall note, a marked block in the user-level instruction file of
Claude Code (`CLAUDE.md`), Codex and OpenCode (`AGENTS.md`) that tells the
agent it can run `singularity recall` mid-task (`Instructions.ts`; other
agents' files aren't confirmed, so they get only the skill),
the onboarding itself (`Setup.ts`), and updating (`Update.ts`: the clone
fetched and its dependencies installed, then the new code, as `update
--no-fetch`, rewrites hooks, plugin, skill, note and command where setup put them,
asking nothing again; the installer, run again where memory is set up, does
that second step instead of setup). In daily use memory stores a change
when it is committed, one record per commit (or per command that made
several), with the part of the session's log since its previous commit
(`src/workflows/Commits.ts`, `run.segment` in a record; `records/Segment.ts`
reads that part back): the tool-call hook starts it after a committing
command (`src/workflows/StoreTrigger.ts`), and task start and session end
sweep for commits made outside the agent, which go to the session whose
edits they hold. Commits left out are logged with the reason
(`skipped.jsonl`), and status shows them. Which sessions ran in a repo, in
any of its worktrees, is `src/workflows/Transcripts.ts`; `singularity store`
(once `learn --past`) and setup store what earlier sessions committed.

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
  Except git (`runQuick` in `src/eval/Proc.ts`): after any nonzero exit,
  Effect's spawner waits for `taskkill /T` on Windows, about 200 ms a call,
  and git answers no often (a grep that finds nothing); that tripled a
  recall's time. Agents and checks keep `runProcess`, which kills their tree.
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
  came from git checkouts or old runs (see `src/workflows/Commits.ts`); write files byte-exact.

## Data compatibility

The code was ported from Python and verified against it (identical metrics on
120 real transcripts, identical reports, a byte-identical graph store, an
identical saved-scripts memory). `src/eval/PyFormat.ts` (Python's float
formatting, which rounds ties to even) keeps old and new reports comparable;
keep it. (`src/graph/PythonCompat.ts` went with the graph store.)

Everything written to disk keeps the snake_case keys the Python version used:
`results.jsonl`, saved-scripts memory entries, graph store files. Old runs in
`runs/` stay readable and comparable, so TypeScript types for persisted
records use those keys.

## Working rules

- Commit only when the user asks. Work on a feature branch, not `main`.
- Before committing a change to the installers, setup, update or anything
  else singularity prints, try it with `scripts/try-install.ps1` (or `.sh`),
  then give the user that command to try it themselves, and wait for their go.
  It installs this checkout, uncommitted changes included, in a sandbox home
  (`%TEMP%\singularity-try`) and keeps setup off PATH (`--no-path`): on
  Windows PATH lives in the registry, outside any home.
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
- Hooks run in the user's own sessions once installed, in every agent setup
  wired (other agents send Claude Code's format with their own event and tool
  names). They must never break a session (errors go to
  `~/.singularity/hook-errors.log`, exit 0), and the tool-call hook runs
  after every call, so `src/workflows/hook.ts` loads modules only for the
  event at hand and only when the call may have committed or read a
  commit. Keep it fast (about 0.1 s a call). Tests use a temporary `SINGULARITY_HOME`, never the
  real one.
- Two memory homes. `~/.singularity` is our own: the memory of the sessions
  we work in, with singularity set up in our Claude Code. Evals and
  benchmarks have `runs/eval-home` (`EVAL_HOME` in `src/local/Home.ts`): the
  records of eval runs and the memory built from them; runs measure frozen
  copies of it under `runs/<suite>/memory/`. Commands for eval work take
  `--home runs/eval-home`, or run as `npm run cli:eval -- ...`; never record
  or build eval memory in `~/.singularity`. Runs work with singularity
  installed: the harness sets `SINGULARITY_HOOKS=off`, which silences the
  installed hooks (a hook started with `--eval-run` would fire anyway).
- Claude Code cuts a hook's text at 10,000 characters and hands the agent a
  file path instead. The task-start hand-over is a pointer and a card
  of at most 700 characters of facts; a change shown in full (`recall`,
  `changes`) stays under `MAX_HANDOVER_CHARS` (`src/scripts/Render.ts`), and
  anything added to it takes room from the diff it shows.
- Tests never run setup against the real
  home or the real agents' settings: they pass a temporary home and an
  environment without agents on PATH.
