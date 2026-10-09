# singularity

Procedural memory for coding agents: learn from past Claude Code sessions so
repeated and similar tasks take less time and fewer tokens. See `HANDOFF.md`
for the design, decisions and results, and `CLAUDE.md` for how the code is
written.

## Install

One command. It checks your machine, puts singularity in `~/.singularity`,
and walks you through setting memory up in the coding agents it finds.

macOS, Linux, WSL or Git Bash:

```
curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh
```

Windows PowerShell:

```
irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex
```

You need git. Without Node.js 24 or later on your PATH, the installer
fetches its own copy into `~/.singularity/node` (checked against nodejs.org's
checksums) and changes nothing else. Memory learns from Claude Code sessions,
and with Claude Code's model calls, so have Claude Code too. WSL keeps its own
agents: for agents you run on Windows, run the PowerShell command on Windows.
(`--connect-timeout` makes curl move on quickly from a GitHub address your
network can't reach, instead of waiting minutes.)

| Agent | What memory does there | What setup adds |
|---|---|---|
| Claude Code | hands over at task start, warns during the task, learns from sessions | hooks in `~/.claude/settings.json`, skill |
| Codex | hands over at task start, warns during the task (trust the hooks once with `/hooks`) | hooks in `~/.codex/hooks.json`, skill |
| Gemini CLI | hands over at task start, warns during the task | hooks in `~/.gemini/settings.json`, skill |
| Droid | hands over at task start, warns during the task | hooks in `~/.factory/hooks.json`, skill |
| Hermes Agent | hands over at task start, warns during the task | a plugin in `~/.hermes/plugins/singularity` (`%LOCALAPPDATA%\hermes` on Windows), named in `plugins.enabled` of its `config.yaml`; skill |
| Cursor, OpenCode, other agents that read `~/.agents/skills` | when you ask for it | skill |

Setup also puts the `singularity` command on your PATH and asks whether
memory may learn on its own (about $0.25 a round on your Claude account, at
most $1 a day). It never touches the rest of an agent's settings, and keeps a
copy of each file it changes (`<file>.before-singularity`).

How memory gets to know a repo: a Claude Code session that ends with its
change committed and its tests passing becomes a record. After a few records
in a repo, memory learns workflows from them (where each kind of change goes,
how it is checked, the mistakes made on the way). From then on, a task that
needs them gets them with its first prompt, found in the code as it is that
day. In a repo with earlier Claude Code sessions, setup offers to start from
those.

```
singularity status              # which agents have memory, and what it knows per repo
singularity recall "<task>"     # what a task here would be handed (no model call)
singularity learn [--past]      # learn now; --past starts from this repo's earlier sessions
singularity setup               # again, to update or change your answers
singularity uninstall [--purge] # take memory out of every agent (memory stays unless --purge)
```

From a clone instead: `npm install`, then `node apps/cli/src/cli.ts setup`.

## Develop

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
npm run cli -- <args>  # the command line, same as node apps/cli/src/cli.ts <args>
```

Commands in this README run from the repo root, where eval runs go
(`runs/`).

## Summarize a session

```
node apps/cli/src/cli.ts traces <session id or path to .jsonl> [--json]
```

Reads Claude Code's transcript (including subagents) and prints tokens, tool
calls, failed calls, and repeated file reads.

## Local memory

Memory lives in `~/.singularity` (or `$SINGULARITY_HOME`). It belongs to one
tenant, named in its `config.json`, and is about subjects: repos, recognized
by their root commits and remotes, so every clone of a repo is the same
subject.

**Workflow records**, one per finished run, are the evidence:

```
node apps/cli/src/cli.ts record import runs/excalidraw/*/ [--task ID ...]   # eval runs (of some tasks only)
node apps/cli/src/cli.ts record session SESSION_ID              # a session that committed its change with passing tests
node apps/cli/src/cli.ts record annotate --all --per-task 4     # a model's reading, a few cents a record
node apps/cli/src/cli.ts record list | show ID
```

A record holds what the log and the diff show without any model: files
changed, where in them the run added its lines (the existing lines just above
and below, never the new ones), every shell command and whether it worked,
and detours (a call that failed, the later call that fixed it, and the tokens
in between). The model's
reading adds the task's kind, its steps (each asked for, needed, or the
agent's own choice), landmarks in the code, and what each detour teaches, with
an exact trigger. Every claim is checked against the code at the run's commit
and against the log, and dropped if it doesn't hold.

**The memory graph** is built from the records: task kinds with their routes
(required and optional steps, with the condition for each optional one),
steps with where they happen in each repo, and warnings with their triggers.

```
node apps/cli/src/cli.ts memory build --conditions   # merge the records; a replay check commits or rejects
node apps/cli/src/cli.ts memory show [VERSION]
node apps/cli/src/cli.ts memory replay | triggers | candidates
```

Each build is a candidate. The replay check asks, for every past task,
whether the graph would hand it what it needed and nothing else, and whether
its triggers fire on commands that worked; a build that hands a task a step
it never asked for is rejected. `memory triggers` replays recorded runs
through the warnings' triggers, to see which would have arrived before their
mistake. `--conditions` has a model write the conditions of optional steps
and decide which near-identical step names are one step (a few cents).

**Search**, exact and by words (search by meaning is for the hosted version):

```
node apps/cli/src/cli.ts search help dialog shortcut
node apps/cli/src/cli.ts search --exact handleKeyboardGlobally [--type record|kind|step|warning]
```

**Hand-over**, through Claude Code hooks:

```
node apps/cli/src/cli.ts handover --cwd REPO "Change the zen mode shortcut to Alt+M"   # what a task would get
node apps/cli/src/cli.ts hooks install [--scope user|project|local]                   # or `hooks print`, for claude --settings
node apps/cli/src/cli.ts hooks status | uninstall
```

At a session's first prompt, the hook hands over the route for the task and
the warnings on its steps: word search proposes up to three task kinds, and a
model confirms one and picks its steps (about $0.03 and a few seconds). With
the route comes the code at its places: the hook looks up, in the working
tree, the lines that earlier runs of the kind made each step's edits next to,
and hands over what is around them now, so the agent can edit without reading
for the places first. Memory holds which lines to look for, not the code. It
all stays under 10,000 characters, where Claude Code cuts a hook's text. After
each shell command or edit, a warning whose exact trigger appears is handed
over, once a session. When a session ends with a committed change and passing
tests, it becomes a record. `SINGULARITY_HOOKS=off` turns the hooks off; the
eval harness sets it, so installed hooks stay out of measurement runs.

That memory is v0 (tag `memory-v0`); `hooks install` installs its hooks.
Memory v1 is what `singularity setup` installs for daily use (above), and
lives in the same home, under `tenants/<tenant>/workflows/`. Setup replaces
v0's hooks if it finds them. In daily use v1 learns repo by repo
(`apps/cli/src/workflows/Learn.ts`): a repo's memory is learned alone and merged back,
so one repo never replaces another's, and ids two repos share get the second
repo's id appended. The commands below are the parts it is made of, as the
eval suites use them:

```
node apps/cli/src/cli.ts workflows build [--task ID ...] [--repo DIR] [--fresh]       # induce from the records (one model call or two)
node apps/cli/src/cli.ts workflows show [AT] [--json]                                 # print it
node apps/cli/src/cli.ts workflows cues [--repo DIR]                                   # write cues, so tasks are picked without a model (one model call or two)
node apps/cli/src/cli.ts workflows finish [--repo DIR]                                 # learn what each workflow's checks rewrite (no model)
node apps/cli/src/cli.ts workflows handover TASK... --cwd REPO [--at COMMIT] [--pick cues|words|model] [--parts 2] [--draft] # preview a task's hand-over
node apps/cli/src/cli.ts workflows evolve [--task ID ...] [--setup S ...] [--records-from HOME] [--repo DIR] [--dry-run] # learn from new runs
node apps/cli/src/cli.ts workflows common --task ID --task ID ... [--kind WORDS] [--repo DIR] [--dry-run] # learn what runs of different tasks of a kind did alike
node apps/cli/src/cli.ts workflows candidates                                         # proposals and what became of them
```

Since the tenth session: **what tasks of a kind share** (`workflows common`,
`apps/cli/src/workflows/Common.ts`). Learned task by task, two bug fixes became a
workflow each, which no other bug can use. This pass reads the runs of
several tasks of one kind (bug fixes) and keeps only what runs of at least two
different tasks did: how a bug is reproduced in a test here, how the fix is
checked (the test failing without it, with `git stash`), the mistakes made on
the way. Its places include blocks runs **read** without changing them
(`apps/cli/src/workflows/Reads.ts`), such as the test helpers' `Keyboard` class, which
the hand-over shows as an outline: the block's first line and its members',
from the code at task start. Run `workflows cues` after it.

Since the eighth session: the hand-over ends with **one command** that runs
every check its workflows need, with the snapshot files earlier runs
regenerated (`apps/cli/src/workflows/Finish.ts`); `evolve` also reads **what each run
still looked up before its first edit** (`apps/cli/src/workflows/Lookups.ts`;
`--dry-run` prints it), writes the cues again and replays with them; and the
`workflows-split` setup carries a hand-over longer than one hook can (Claude
Code cuts each at 10,000 characters) in two parts, from two task-start hooks.

v1 keeps small workflows written with blanks (`{field}`, `{key}`), learned
from runs, and a graph of them whose edges say when one leads to another. A
step's place is kept as the blocks that enclose the edit (`class App ›
getContextMenuItems › if (this.state.viewModeEnabled) › return [`), never as
code; at task start its hooks (`apps/cli/src/workflows/hook.ts`) pick the workflows the
task needs, find each place in the code as it is (in the file it moved to, if
it moved) and hand them over with current line numbers. `evolve` revises
memory from what new runs did and what it showed them, and keeps the revision
only if, replayed over the runs, it shows more of the places they edited and
fewer they left alone.

**Local first** (tag `memory-local-first`): picking makes no model call. Each
workflow carries cues, phrases that say a task needs it and where a task
states its blanks' values, written once by `workflows cues`
(`apps/cli/src/workflows/CueWriter.ts`); at task start they are matched exactly against
the task, its negated clauses ("don't add a shortcut") left out, and the
blanks the task states are filled in (`apps/cli/src/workflows/Cues.ts`). That is the
hook's default and `workflows handover`'s; memory without cues is picked by
words. `SINGULARITY_SELECTOR=model` (or `--pick model`) has a model call pick
instead, as v1 was first measured. A build writes workflows without cues: run
`workflows cues` after it (a learning round on memory with cues writes them
itself). A task that lists several changes (a numbered or bulleted list) is
picked and filled change by change: each item, with what the task says of
all of them, states its own values; a workflow several changes need is shown
once, with each change's values and the changes it is for.

Tested and dropped (the user's call: memory helps the agent do the task, it
doesn't do the task): with `--draft` (and in the `workflows-draft` setup), a
second model call at task start fills the blanks the only way that leaves nothing open: it writes
the change itself for this task, from those workflows and the code at their
places (about 5-10 cents, half a minute). Each edit is checked against the
code before it is handed over (its old lines are in their file exactly once),
and the agent gets the complete change instead of the steps
(`apps/cli/src/workflows/Draft.ts`). Memory still keeps no code.

## Run an evaluation

```
node apps/cli/src/cli.ts eval run apps/cli/examples/excalidraw/suite.toml --reps 3 [--task ID ...] [--dry-run]
node apps/cli/src/cli.ts eval report runs/excalidraw/<run dir> [more dirs...] [--compare]
```

A suite (TOML, see `apps/cli/examples/excalidraw/suite.toml` and `apps/cli/src/eval/Suite.ts`)
names a source repo, agent settings, and tasks. Each task has a base commit, a
prompt, and check commands that decide success. `check_files` can add hidden
tests after the agent finishes, so the agent can't edit them to pass.
`apps/cli/examples/excalidraw/` is the real evaluation suite (two task families against
a local excalidraw clone); `apps/cli/examples/toy/` is a small, cheap one against this
repo's history.

Every run starts from a clean clone of the repo at the task's base commit, in
`<workspaces>/<suite>`. Workspaces default to `C:\singularity-workspaces` on
Windows (outside the home folder, so a CLAUDE.md there isn't loaded into runs)
and `~/.singularity/workspaces` elsewhere; set `SINGULARITY_WORKSPACES` or pass
`--workspaces` to change it. The clone has no remote, so the source repo is
never touched, and no branches, tags or reflog, so later commits (which may
hold hidden tests) stay out of the agent's sight.

Claude Code runs headless with its auto-memory off and no MCP servers. The
harness runs everything below normal priority (`--priority normal` when
nothing else needs the machine), and a suite's `env` table can cap test
workers, so the machine stays usable. Each run records cost, tokens,
wall time, tool calls, and check results to `results.jsonl`, and saves the
transcript and diff alongside. Use `--dry-run` to see the exact `claude`
command without running anything.

## Memory setups

`--setup` picks what the agent is given:

- `no-memory`: nothing (the baseline).
- `saved-scripts`: the closest past successful run (its prompt, files, source
  diff and working commands), matched by prompt similarity.
- `saved-scripts-top2`: up to the two closest past runs, each similar enough.
- `graph`: the procedural graph. Steps whose descriptions share words with
  the prompt mark where the task enters the graph; Sonnet then reads the task
  and the nearby steps with their conditions and decides which apply (about
  $0.01, counted in the run's cost). The chosen steps are handed over once as a
  checklist: when each applies, how, what to avoid, and the files and commands
  involved. Learning asks Sonnet to turn each run into graph edits (see
  `apps/cli/src/eval/GraphLearner.ts`). Both calls go through `claude -p --json-schema`
  with your login. `--graph-version N` uses an earlier version.
- `saved-scripts-warnings`: the closest past run, as `saved-scripts` gives it,
  plus the graph's warnings: the mistakes and dead ends recorded on its steps,
  without the checklist. `--memory` is the saved-scripts store and
  `--warnings` the graph store.
- `hooks`: the local memory, handed over by its own hooks as in daily use.
  `--memory` is a memory home (a `SINGULARITY_HOME`), copied into each run's
  directory, so it never changes. Claude Code gets the hooks through
  `--settings`: the route at the first prompt, a warning when its trigger
  appears. The route selection's model call runs the same Claude Code as the
  agent, and counts toward the run. Preview what a task gets with
  `handover --home HOME --cwd WORKSPACE "the prompt"`.
- `workflows`: memory v1, handed over by its own hooks the same way:
  `--memory` is a memory home with v1 memory, copied into each run's
  directory; the workflows arrive at the first prompt, a pitfall's warning when
  its trigger appears, and the selection's model call counts toward the run.
  Each run keeps its hand-over log (what was shown, at which lines), which
  `workflows evolve` learns from. Preview with `workflows handover`.
  This setup keeps v1 as it was measured: a model call picks the workflows.
- `workflows-cues`: the local-first memory: the same hooks, with no model call
  at task start; memory's cues pick the workflows and fill the blanks the task
  states (`workflows handover --pick cues`).
- `workflows-split`: `workflows-cues` with a hand-over longer than one hook can
  carry sent in two parts, from two task-start hooks
  (`workflows handover --parts 2`).
- `workflows-draft` (tested and dropped): the same, but the agent gets the
  change itself, drafted at task start from the workflows and the code
  (`workflows handover --draft`); the drafting call counts toward the run too.

Setups other than `no-memory` need `--memory DIR`; add `--frozen` for
measurement runs so memory doesn't change while it's being measured.

`--claude PATH` runs another Claude Code, e.g. a pinned copy of an earlier
version (`~/.local/share/claude/versions/` keeps a few), so a run is compared
with baselines from the same version. Runs never update Claude Code.

Build memory from runs already recorded, without running the agent again:

```
node apps/cli/src/cli.ts eval learn apps/cli/examples/excalidraw/suite.toml runs/excalidraw/baseline-1 \
  --setup saved-scripts --memory runs/excalidraw/memory/saved-scripts --task altkey-zen-m
```

See what a setup would hand the agent for each task, and inspect a graph:

```
node apps/cli/src/cli.ts eval inject apps/cli/examples/excalidraw/suite.toml --setup graph --memory runs/excalidraw/memory/graph
node apps/cli/src/cli.ts graph show runs/excalidraw/memory/graph
```

`report --compare --baseline saved-scripts` compares setups against
saved-scripts instead of no memory.

New setups implement `MemorySetup` in `apps/cli/src/eval/Setups.ts`.
