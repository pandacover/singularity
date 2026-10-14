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
| `setup/` | daily use: setup, status, the agents memory knows and what each gets, hook files, the skill, the `singularity` command, learning on its own, which agent learns (`Learner.ts`) and with which model (`LearnerModel.ts`), Codex hook trust (`CodexHooks.ts`), updating to the latest code with what setup put in place kept current (`Update.ts`) |
| `workflows/` | memory v1, the memory daily use runs: inducing workflows, cues, the hand-over at task start, learning from results, storing commits, learning repo by repo |
| `records/` | workflow records: what a finished change shows, read from its session and its diff |
| `traces/` | reading session logs: Claude Code's, and Codex's and Hermes Agent's as Claude Code's |
| `eval/` | the eval harness and its memory setups, and the model calls memory makes: through Claude Code (`Llm.ts`), Codex (`CodexLlm.ts`) or Hermes Agent (`HermesLlm.ts`), picked by `ModelCall.ts` |
| `local/` | the memory home and git |
| `handover/`, `memory/`, `search/` | memory v0 (tag `memory-v0`), kept for comparison |
| `graph/` | the procedural graph of the first graph setup |
| `layer/`, `web/` | one API for every kind of agent, and memory for computer use (experimental) |

Tests mirror it under `apps/cli/test`.

## Memory v1, by hand

Daily use runs these for you (`singularity learn`, and learning on its
own). The commands are the parts it is made of, as the eval suites use
them; their model calls go through Claude Code. Commands for eval work take
`--home runs/eval-home`, so that eval memory never mixes with your own.

```
node apps/cli/src/cli.ts workflows build [--task ID ...] [--repo DIR] [--fresh]       # induce from the records (one model call or two)
node apps/cli/src/cli.ts workflows show [AT] [--json]                                 # print it
node apps/cli/src/cli.ts workflows cues [--repo DIR]                                  # write cues, so tasks are picked without a model (one model call or two)
node apps/cli/src/cli.ts workflows finish [--repo DIR]                                # learn what each workflow's checks rewrite (no model)
node apps/cli/src/cli.ts workflows handover TASK... --cwd REPO [--at COMMIT] [--pick cues|words|model] [--parts 2] [--draft]  # preview a task's hand-over
node apps/cli/src/cli.ts workflows evolve [--task ID ...] [--setup S ...] [--records-from HOME] [--repo DIR] [--dry-run]       # learn from new runs
node apps/cli/src/cli.ts workflows common --task ID --task ID ... [--kind WORDS] [--repo DIR] [--dry-run]                     # what runs of different tasks of a kind did alike
node apps/cli/src/cli.ts workflows candidates                                         # proposals and what became of them
```

What they make:

- **Workflows** are small sub-routines written with blanks (`{field}`,
  `{key}`), learned from runs, with a graph whose edges say when one leads to
  another, and pitfalls with exact triggers. A step's place is kept as the
  blocks that enclose the edit (`class App › getContextMenuItems › if
  (this.state.viewModeEnabled) › return [`), never as code. At task start
  the hooks (`workflows/hook.ts`) find each place in the code as it is (in
  the file it moved to, if it moved) and hand it over with current line
  numbers. After each tool call, a trigger's words are looked for in plain
  JavaScript first (`HookFilter.ts`); the modules that match triggers load
  only when they appear.
- **Cues** pick workflows with no model call: phrases that say a task needs
  a workflow and where a task states its blanks' values, written once by
  `workflows cues` (`CueWriter.ts`) and matched exactly at task start, with
  negated clauses ("don't add a shortcut") left out (`Cues.ts`). A task that
  lists several changes is picked and filled change by change. A workflow
  picked brings in what it `TRIGGERS` along the graph's edges, marked "only
  if" when an edge has a condition; between workflows handed over, the
  hand-over says what their edges say (how to go on, what to avoid), and it
  names a few branches with conditions it didn't hand over (`Render.ts`). A build
  writes workflows without cues: run `workflows cues` after it (a learning
  round on memory with cues writes them itself). `--pick model` has a model
  call pick instead, as v1 was first measured.
- **Evolve** revises memory from what new runs did and what it showed them,
  including what runs still looked up before their first edit
  (`Lookups.ts`), and keeps the revision only if, replayed over the runs, it
  shows more of the places they edited and fewer they left alone (a place
  it misses counts twice one it shows for nothing). A revision it doesn't
  keep still leaves its pitfalls (new, merged, given triggers or taken out),
  each checked against a run's failure.
  The model reads memory in a compact form and answers with what changes
  only (`RevisionAnswer`); what the checks flag that only it can fix (a
  task's own value written in, a pitfall from no detour of the runs) goes
  back to it alone, in a second, small call.
- **Common** learns, for kinds of task like bug fixes, only what runs of at
  least two different tasks did alike: how a bug is reproduced in a test
  here, how the fix is checked, the mistakes made on the way. Its places
  include blocks runs read without changing (`Reads.ts`), handed over as
  outlines.
- **Finish** ends the hand-over with one command that runs every check its
  workflows need, regenerating the snapshot files earlier runs regenerated.
  It is checked against the repo first: a line that calls a script its
  package.json doesn't have, names a file it doesn't have or uses another
  package manager is left out, so is a check another line already runs; a
  test runner that would wait for changes runs once, and the lines go in
  the order the repo's scripts run them. A repo without a package.json gets
  no command.
- **Two parts.** A hand-over longer than one hook can carry (Claude Code cuts
  a hook's text at 10,000 characters) goes in two parts, from two task-start
  hooks (`--parts 2`).
- **Drafting the change** (`--draft`) was tested and dropped: a second model
  call at task start wrote the change itself (fewer tokens, more dollars),
  and writing the change is the agent's job, not memory's.
- **What a record holds.** Its task is what the person wrote
  (`traces/Prompts.ts`): notices of background tasks (Claude Code's
  `promptSource: "system"`), reminders, slash commands' output, T3's image
  notes and quoted assistant text are left out, a quote keeps the person's
  comment, and pasted text is marked as quoted lines. Stored records are
  read through the same filter; their files stay as they were. A call failed
  when its error status says so (`is_error`, a PostToolUseFailure event); a
  command whose pipe hides its status failed only when its output can't be
  mistaken: its check's own report of failures, a traceback, a missing
  command, as the shell's own line (`records/Outcome.ts`). What a read or a
  search prints is never judged. A detour on a check closes when the same
  check passes; any other when what failed runs again and works, by
  whatever command (`python3 x.py`, then `python x.py`; a file a `sed -i`
  broke, edited by the editor), and only in the same place: a command runs
  in the session's folder moved by each `cd` in its line, and one place is
  inside the other (a scratch copy's tests aren't fixed by this repo's). A
  script an interpreter runs is the same script by its name wherever its
  file is: one copied to where it works fixes its failure.
  The learner reads a detour's cost in turns, at most "30+". Learning reads
  stored records' detours again by these rules.
- **Warnings.** Every pitfall needs a trigger, checked after each tool call
  (`records/Triggers.ts`): an `error` trigger fires on a call that failed
  doing something and printed the mistake's exact message, a `command`
  trigger on the risky command (for what comes before a commit, `git add`),
  never on a read or a search, a helper agent's included. A pitfall may have
  several (`also`), one per way the same mistake shows. A learning round
  checks each against the detours of the runs the pitfall came from, takes
  triggers from the messages a pitfall quotes, and sends one with none back
  to the model once, then drops it (`Induce.ts`). It lets go of pitfalls
  whose mistake hasn't happened in 100 stored changes (about a month here),
  or that name a package script no package.json in the repo has, or a file
  that is neither there nor the end of a tracked file's path; the model
  reads the repo's own CLAUDE.md and AGENTS.md to leave out what they
  already say (`Pitfalls.ts`). A rejected revision's pitfalls stay. The
  hook logs a warning once a session, and a mistake made again after it
  (`moment: "again"` in `handovers.jsonl`); `singularity status --json`
  gives each pitfall's tally.

In daily use memory learns repo by repo (`workflows/Learn.ts`): a repo's
memory is learned alone and merged back, so one repo never replaces
another's. A change is stored when it is committed
(`workflows/Commits.ts`), one record per commit, with the part of the
session's log since its previous commit; learning reads it as its commit
titles and the prompts typed for it, since its first prompt is often no
ask ("commit and open a PR"). A round reads only the new changes, with each
place they edited counting every run that edited it. A round that fails
after a model call is kept as a rejected candidate with what it spent
(`Spent` in `eval/ModelCall.ts` counts every call): it counts toward the
day's limit and isn't tried again until a new change arrives.

## Memory v0

The first local memory, frozen at tag `memory-v0` and kept for comparison.
`singularity setup` replaces its hooks if it finds them.

```
node apps/cli/src/cli.ts record import runs/excalidraw/*/ [--task ID ...]   # records from eval runs
node apps/cli/src/cli.ts record session SESSION_ID                          # a session that committed its change with passing tests
node apps/cli/src/cli.ts record annotate --all --per-task 4                 # a model's reading, a few cents a record
node apps/cli/src/cli.ts record list | show ID
node apps/cli/src/cli.ts memory build --conditions                          # merge the records; a replay check commits or rejects
node apps/cli/src/cli.ts memory show [VERSION]
node apps/cli/src/cli.ts memory replay | triggers | candidates
node apps/cli/src/cli.ts search help dialog shortcut
node apps/cli/src/cli.ts search --exact handleKeyboardGlobally [--type record|kind|step|warning]
node apps/cli/src/cli.ts handover --cwd REPO "Change the zen mode shortcut to Alt+M"
node apps/cli/src/cli.ts hooks install [--scope user|project|local] | print | status | uninstall
```

A v0 record holds what the log and the diff show: files changed, where the
run added its lines (the existing lines around them, never the new ones),
every shell command and whether it worked, and detours (a call that failed,
the call that fixed it, and the tokens in between). The model's reading adds
the task's kind, its steps, landmarks in the code and what each detour
teaches; every claim is checked against the code and the log. The memory
graph built from records holds task kinds with their routes, steps with
where they happen, and warnings with their triggers. At a session's first
prompt v0's hook hands over the route for the task, with a model call to
confirm the kind (about $0.03).

## Summarize a session

```
node apps/cli/src/cli.ts traces <session id or path to .jsonl> [--json]
```

Reads Claude Code's transcript (including subagents) and prints tokens, tool
calls, failed calls and repeated file reads.
