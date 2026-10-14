# Developing singularity

How the code is laid out, how to run it from a clone, and the commands that
build and inspect memory by hand. How the code is written is in
[`CLAUDE.md`](../CLAUDE.md); running evaluations is in
[`evaluation.md`](evaluation.md), and each measurement, planned before its
runs, is in a `PREREGISTRATION*.md` file under `apps/cli/examples/`.

## The repo

A Turborepo monorepo with npm workspaces:

| Workspace | What it is |
|---|---|
| `apps/cli` | the command line, hooks, memory and eval harness: TypeScript 7 and Effect 4, run directly by Node 24 (no build step) |
| `apps/landing` | the landing page: Vite and React |

```
npm install
npm test               # every workspace's tests (vitest), through turbo
npm run typecheck      # every workspace's tsc
npm run build          # the landing page, into apps/landing/dist
npm run dev            # the landing page's dev server
npm run cli -- <args>  # the whole command line, same as node apps/cli/src/cli.ts <args>
```

Commands here run from the repo root, where eval runs go (`runs/`). There
are two entry points: `apps/cli/src/singularity.ts` is the `singularity`
command setup installs, with the six daily commands only, so nothing
user-facing points anywhere else; `apps/cli/src/cli.ts` is the whole command
line, with those six too, and runs memory's background work. To set memory
up from a clone instead of the installer's copy:
`node apps/cli/src/singularity.ts setup`.

To try the install as a user gets it, with this checkout as it is
(uncommitted changes included), in a sandbox home that leaves your agents and
PATH alone: `scripts/try-install.ps1` on Windows, `scripts/try-install.sh`
elsewhere. The first run installs and runs setup; a run after that updates;
`-Fresh` (`--fresh`) starts over and `-OwnNode` (`--own-node`) makes the
installer fetch its own Node.js. Everything singularity prints, the
installers included, follows one layout, described in
`apps/cli/src/setup/Ui.ts`.

## Where things are

Under `apps/cli/src`:

| Directory | What it holds |
|---|---|
| `setup/` | daily use: setup, status, the agents memory knows and what each gets, hook files, the skill, the `singularity` command, Codex hook trust (`CodexHooks.ts`), updating to the latest code with what setup put in place kept current (`Update.ts`) |
| `scripts/` | memory: at task start, the stored commit most like the task, read from git (`Hook.ts`, `Start.ts`, `Search.ts`, `Render.ts`) |
| `workflows/` | the hook script (`hook.ts`) and storing commits (`Commits.ts`, `StoreTrigger.ts`, `Transcripts.ts`); the hand-over log (`Session.ts`) |
| `records/` | records: what a committed change shows, read from its session and its diff |
| `traces/` | reading session logs: Claude Code's, and Codex's and Hermes Agent's as Claude Code's |
| `eval/` | the eval harness and its memory setups (no memory and saved scripts) |
| `local/` | the memory home and git |
| `handover/` | only `HookInput.ts`, the hook's input |
| `graph/` | only `Similarity.ts` and the store errors records use |

On this branch memory is saved scripts only. Memory v1's learning and
hand-over (the rest of `workflows/`), the learning step (`setup/AutoLearn.ts`,
`Learner.ts`, `LearnerModel.ts`, `Preferences.ts`, the model calls in
`eval/`), memory v0 (`memory/`, `search/`, the rest of `handover/`,
`src/hook.ts`), the graph setup, `layer/` and `web/` were removed; tags
`memory-v0` and `memory-local-first` keep them.

Tests mirror it under `apps/cli/test`.

## Records, by hand

```
node apps/cli/src/cli.ts record import runs/excalidraw/*/ [--task ID ...]   # records from eval runs
node apps/cli/src/cli.ts record commits [--cwd REPO] [--all]                # store the changes sessions committed (the hooks run this)
node apps/cli/src/cli.ts record list | show ID
```

The sections on building memory v1 and v0 by hand were removed with those
designs.

## Summarize a session

```
node apps/cli/src/cli.ts traces <session id or path to .jsonl> [--json]
```

Reads Claude Code's transcript (including subagents) and prints tokens, tool
calls, failed calls and repeated file reads.
