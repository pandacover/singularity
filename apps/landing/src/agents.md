# singularity

> Procedural memory for coding agents. It learns workflows from a repository's past Claude Code, Codex and Hermes Agent sessions and hands them to the next session at task start, so repeated kinds of change take fewer turns and tokens. It never writes the change itself.

Source: https://github.com/pandacover/singularity (MIT license)

## What it does

1. Record: when a Claude Code, Codex or Hermes Agent session commits a change after its checks pass (tests, a typecheck, a build or a lint; docs need none), memory keeps a record of that change: what changed, where, which commands ran, what went wrong. Records stay on the machine.
2. Learn: after a few records in a repository, memory learns workflows from them: steps with blanks, where each kind of change goes, how it is checked, and the phrases in a task that call for it. Learning calls a model.
3. Hand over: at task start, workflows whose phrases appear in the task are picked by plain text matching (no model call), their blanks filled from the task, and their places found in the code as it is that day. The agent gets steps, places and warnings, and still writes every line itself.
4. Catch repeats: during a task, when a known mistake happens again, its fix arrives with the error.

## Before installing

Ask your user first. Setup changes agent settings, and by default lets memory learn on its own with the model of one of their agents (Claude Code, Codex or Hermes Agent), on their account with it: about $0.25 a round, at most $1 a day. Ask them what daily limit they want, and pass it as `--daily-limit <dollars>`; if they have more than one of those agents, ask which one learning should use, and pass it as `--learn-with <claude|codex|hermes>`. Run without a terminal, or with `--yes`, setup asks nothing and takes these defaults (Claude Code first).

Needs git. Needs Node.js 24 or later; without it, the installer fetches its own copy into `~/.singularity/node` and changes nothing else. Learning needs Claude Code, Codex or Hermes Agent.

## Install

macOS, Linux, WSL or Git Bash:

```
curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh
```

Same, asking nothing:

```
curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh -s -- --yes
```

Windows PowerShell:

```
irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex
```

The installer clones the code into `~/.singularity/app`, then runs `singularity setup`. WSL keeps its own agents: for agents that run on Windows, use the PowerShell command on Windows.

Setup flags: `--yes` (`-y`) takes every default and asks nothing; `--agent <claude|codex|gemini|droid|hermes|cursor|opencode>` sets up only that agent (repeatable); `--learn-with <claude|codex|hermes>` picks the agent whose model learns; `--daily-limit <dollars>` sets what learning may spend a day; `--no-path` leaves the `singularity` command off PATH.

## What setup changes

| Agent | What memory does there | Files |
|---|---|---|
| Claude Code | hands over at task start, warns during the task, learns from sessions | hooks in `~/.claude/settings.json`, skill |
| Codex | hands over, warns, learns from sessions (trust the hooks once with `/hooks`) | hooks in `~/.codex/hooks.json`, skill |
| Gemini CLI | hands over, warns | hooks in `~/.gemini/settings.json`, skill |
| Droid | hands over, warns | hooks in `~/.factory/hooks.json`, skill |
| Hermes Agent | hands over, warns, learns from sessions | plugin in `~/.hermes/plugins/singularity` (`%LOCALAPPDATA%\hermes` on Windows), enabled in its `config.yaml`; skill |
| Cursor, OpenCode, agents that read `~/.agents/skills` | when asked | skill |

It never touches the rest of an agent's settings, and keeps a copy of each file it changes (`<file>.before-singularity`). Hooks never break a session: errors go to `~/.singularity/hook-errors.log`.

## Commands

```
singularity status              # which agents have memory, and what it knows per repo
singularity recall "<task>"     # what a task here would be handed (no model call)
singularity learn [--past]      # learn now; --past starts from this repo's earlier sessions
singularity setup               # again, to update or change the answers
singularity uninstall [--purge] # take memory out of every agent (memory stays unless --purge)
```

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
