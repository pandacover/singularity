# singularity

> Procedural memory for coding agents. It learns workflows from a repository's past Claude Code, Codex and Hermes Agent sessions and hands them to the next session at task start, so repeated kinds of change take fewer turns and tokens. It never writes the change itself.

Source: https://github.com/pandacover/singularity (MIT license)

## What it does

1. Record: when a Claude Code, Codex or Hermes Agent session commits a change after its checks pass (tests, a typecheck, a build or a lint; docs need none), memory keeps a record of that change: what changed, where, which commands ran, what went wrong. Records stay on the machine.
2. Learn: after a few records in a repository, memory learns workflows from them: steps with blanks, where each kind of change goes, how it is checked, and the phrases in a task that call for it. Learning calls a model.
3. Hand over: at task start, workflows whose phrases appear in the task are picked by plain text matching (no model call), their blanks filled from the task, and their places found in the code as it is that day. The agent gets steps, places and warnings, and still writes every line itself.
4. Catch repeats: during a task, when a known mistake happens again, its fix arrives with the error.

## Before installing

Ask your user first. Setup changes agent settings, and by default lets memory learn on its own with the model of one of their agents (Claude Code, Codex or Hermes Agent), on their account with it: about $0.25 a round, at most $1 a day. Ask them:

- which of their agents should get memory (default: every one found), passed as `--agent <id>` once per agent;
- whether memory may learn on its own, and what daily limit, passed as `--daily-limit <dollars>` (`--daily-limit 0` means it learns only when they run `singularity learn`);
- if they have more than one of Claude Code, Codex and Hermes Agent, which one learning should use, passed as `--learn-with <claude|codex|hermes>`.

Your shell has no terminal for setup to ask in, so setup asks nothing there and takes the defaults for anything not passed: every agent found, learning on its own up to $1 a day, Claude Code first. It never spends on learning during setup.

Needs git. Needs Node.js 24 or later; without it, the installer fetches its own copy into `~/.singularity/node` and changes nothing else. Learning needs Claude Code, Codex or Hermes Agent.

## Install

macOS, Linux, WSL or Git Bash, with the user's answers as flags after `sh -s --`:

```
curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh -s -- --yes --daily-limit 1
```

Windows PowerShell, with the user's answers as flags at the end:

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1))) --yes --daily-limit 1
```

A person at a terminal can run the short forms, which ask the questions themselves: `curl -fsSL https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh` or `irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex`.

The installer clones the code into `~/.singularity/app`, installs its dependencies, then runs `singularity setup`. WSL keeps its own agents: for agents that run on Windows, run the PowerShell command on Windows too.

Setup flags: `--yes` (`-y`) takes every default and asks nothing; `--agent <claude|codex|gemini|droid|hermes|cursor|opencode>` sets up only that agent (repeatable); `--learn-with <claude|codex|hermes>` picks the agent whose model learns; `--learn-model <model>` picks the Codex or Hermes Agent model it learns with (setup checks that the model answers with one tiny call); `--daily-limit <dollars>` sets what learning on its own may spend a day; `--no-path` leaves the `singularity` command off PATH.

## After installing

The `singularity` command is on PATH only in terminals opened after setup. In the shell you installed from, run it by its full path: `~/.singularity/bin/singularity` (Windows: `~\.singularity\bin\singularity.cmd`).

1. Check it: `singularity status` lists the agents that have memory and what memory knows per repository.
2. Codex runs new hooks only once the user trusts them. Setup trusts them when a person answers yes at its terminal; from your shell it can't, so tell the user to open Codex and type `/hooks`. `singularity status` says whether Codex trusts them.
3. Agents running now get memory from their next start.
4. In a repository with earlier sessions, `singularity learn --past` stores what those sessions committed (no model call). Learning from them is a separate step that costs money; see Commands.

## What setup changes

| Agent | What memory does there | Files |
|---|---|---|
| Claude Code | hands over at task start, warns during the task, learns from sessions | hooks in `~/.claude/settings.json`, skill |
| Codex | hands over, warns, learns from sessions (once its hooks are trusted) | hooks in `~/.codex/hooks.json`, skill |
| Gemini CLI | hands over, warns | hooks in `~/.gemini/settings.json`, skill |
| Droid | hands over, warns | hooks in `~/.factory/hooks.json`, skill |
| Hermes Agent | hands over, warns, learns from sessions | plugin in `~/.hermes/plugins/singularity` (`%LOCALAPPDATA%\hermes` on Windows), enabled in its `config.yaml`; skill |
| Cursor, OpenCode, agents that read `~/.agents/skills` | when asked | skill |

It never touches the rest of an agent's settings, and keeps a copy of each file it changes (`<file>.before-singularity`). It also writes the `singularity` command into `~/.singularity/bin` and adds that folder to PATH (the user's Path on Windows; a marked line in the shell's startup file elsewhere). Hooks never break a session: errors go to `~/.singularity/hook-errors.log`.

## Commands

```
singularity status                  # which agents have memory, what it knows per repo, how learning goes
singularity recall "<task>"         # what a task here would be handed (no model call); --cwd <repo> for another repo
singularity learn --dry-run         # what a round would learn, and about what it would cost (no model call)
singularity learn                   # learn now from this repo's stored changes (costs money)
singularity learn --past            # first store what this repo's earlier sessions committed
singularity setup                   # set up again, to change the answers (takes the same flags as at install)
singularity update                  # the latest version, keeping every answer
singularity uninstall [--purge]     # take memory out of every agent (memory stays unless --purge)
```

`learn` also takes `--all` (every repository memory has new changes for), `--repo <path>` and `--with <claude|codex|hermes>` (another agent's model, this once). From your shell it asks nothing and spends right away: tell the user the price `--dry-run` gives and wait for their yes first.

Memory usually arrives on its own at task start; you don't need `recall` for every task.

## Update

```
singularity update
```

It fetches the latest code into `~/.singularity/app`, installs its dependencies when they changed, and then brings what setup put in place up to date with the new code: hooks, Hermes Agent's plugin, the skill and the command, only in the agents that already have memory. It asks nothing again and keeps every answer; agents left out stay out. It says when it is already the latest. While memory is learning in the background it stops without changing anything; run it again when `singularity status` shows the round done. Running the install command again does the same once memory is set up (with flags, it runs setup instead). An agent installed since setup gets memory from `singularity setup`.

## Uninstall

```
singularity uninstall
```

It takes memory's hooks, plugin and skill out of every agent (the user's own settings stay), removes the `singularity` command and takes its folder off PATH. Memory itself stays in `~/.singularity`, so setting up again later picks up where it left off.

To delete memory too (every record and workflow, and the installed code), ask the user first, then run `singularity uninstall --purge --yes`. Without `--yes`, your shell has no terminal to confirm in and memory is kept.

## Where things are

`~/.singularity`, or `$SINGULARITY_HOME` when set:

| Path | What it is |
|---|---|
| `app/` | the code (a git clone that `singularity update` updates) |
| `node/` | the Node.js the installer fetched, only when the machine had none new enough |
| `bin/` | the `singularity` command |
| `config.json` | the answers: `learn.auto`, `learn.max_usd_per_day`, `learn.with`, `learn.model` |
| `tenants/local/subjects.json` | the repositories memory knows |
| `tenants/local/records/` | one record per stored change |
| `tenants/local/workflows/` | what memory learned |
| `tenants/local/skipped.jsonl` | commits memory left out, and why (`singularity status` sums them up) |
| `learn.log`, `store.log` | what background learning and storing did |
| `hook-errors.log` | hook errors; they never break a session |

Change answers with `singularity setup` rather than by editing `config.json`.

## When something is off

- Memory knows nothing in a repository: it stores changes as sessions commit them with checks passing. `singularity status` shows what it kept and left out; `singularity learn --past` looks through earlier sessions.
- Learning fails: `singularity status` shows the last failure. With Codex or Hermes Agent, a model their plan refuses is the usual cause: `singularity setup --learn-model <model>` picks another.
- Codex hands nothing over: its hooks aren't trusted yet; the user opens Codex and types `/hooks`.
- Hooks failing: `~/.singularity/hook-errors.log`, also counted in `singularity status`.

## Results

Medians of 3 to 4 pre-registered runs per side, one pinned Claude Code version, hidden tests; all 40 runs passed.

- A task asking for four changes to excalidraw, every kind learned: 28.5 turns to 9.5, 1.90M tokens to 423k, $0.81 to $0.30.
- Two of its four kinds learned: 30% fewer turns, 39% fewer tokens.
- Tasks whose kind memory hadn't learned: turns moved between 25% fewer and 17% more.

## Limits

- It helps with kinds of change it has learned from earlier sessions in the same repository; on a new kind it mostly costs what no memory costs.
- Small samples, on two repositories (excalidraw, validator.js).
- Results are compared only within one Claude Code version.

## References

- Agent Workflow Memory, arXiv:2409.07429
- Procedural Graphs: Self-Evolving Execution Structures for LLM Agents, arXiv:2609.09153
